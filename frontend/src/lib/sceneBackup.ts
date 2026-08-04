// 캔버스 씬 DB 백업 — localStorage(원본)의 단방향 미러(로컬→DB) + 캐시 소실 시 복구.
//
// 계약(코덱스 합의 설계):
//  · 로컬이 항상 정답. saveAll(쓰기 관문) 후 디바운스(2s) → 변경 씬만 벌크 PUT, DB 에만 남은
//    씬은 delete 로 정합(삭제 미러). 실패는 조용히 두고 다음 변경·online 이벤트·백오프에서 재시도.
//  · 복구는 '로컬 버킷 키 자체가 없을 때'만(hasSceneBucket) — 빈 배열 버킷(마지막 씬 정상 삭제)은
//    복구하지 않는다. 적용 직전 재확인으로 요청 중 생긴 로컬 변경이 이긴다.
//  · owner 는 서버가 actor_id 로 결정 — 여기서는 계정을 보내지 않는다. 계정 전환 시 서버 메타
//    캐시는 ns 로 무효화한다.
//  · 변경 대조: 서버 data_hash(sha256) vs 로컬 sha256(crypto.subtle). http LAN 등 insecure
//    context 로 subtle 이 없으면 세션 첫 동기화 때 전 씬을 한 번 올린다(정확성 우선 — 이후는
//    세션 내 lastPushed 문자열 비교로 변경분만).
import { jsonFetch } from "./http";
import { loadString } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";
import { hasSceneBucket, listScenes, saveScenes, setOnScenesPersisted, type Scene } from "./scenes";

const API = "/api/scenes/backup";
const DEBOUNCE_MS = 2000;
const RETRY_MS = 30_000; // 실패 백오프 — 다음 변경이 없어도 이 간격으로 1회 재시도
const MAX_UPSERTS = 200; // 서버 상한과 동일 — 초과분은 분할 전송

const ns = () => {
  const acct = loadString(STORAGE_KEYS.activeAccount);
  return acct ? `acct:${acct}` : "local";
};

async function sha256hex(text: string): Promise<string | null> {
  try {
    if (!crypto?.subtle) return null; // insecure context(http LAN) — 해시 대조 불가
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

// ── 상태 (모듈 스코프 — 세션 단위) ──────────────────────────────────────
let serverHash: Map<string, string> | null = null; // 서버 메타 캐시 sceneId→data_hash
let metaNs: string | null = null; // 캐시가 어느 계정 것인지 — 전환 시 무효화
let lastPushed = new Map<string, string>(); // 이 세션에서 마지막으로 밀어올린 씬 JSON(정확 비교)
let timer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let syncing = false;
let rerun = false; // 동기화 중 새 변경 — 끝나고 한 번 더

function resetIfAccountChanged(): void {
  const n = ns();
  if (metaNs !== null && metaNs !== n) {
    serverHash = null;
    lastPushed = new Map();
  }
  metaNs = n;
}

async function ensureServerMeta(): Promise<Map<string, string> | null> {
  resetIfAccountChanged();
  if (serverHash) return serverHash;
  try {
    const r = await jsonFetch<{ items: { id: string; data_hash: string }[] }>(
      `${API}?project_id=`,
    );
    serverHash = new Map(r.items.map((it) => [it.id, it.data_hash]));
    return serverHash;
  } catch {
    return null; // 구백엔드(404)·오프라인 — 이번 회차 건너뜀(다음 변경·재시도에서 다시)
  }
}

async function syncNow(): Promise<void> {
  if (syncing) {
    rerun = true;
    return;
  }
  syncing = true;
  let failed = false;
  try {
    const meta = await ensureServerMeta();
    if (!meta) {
      failed = true;
      return;
    }
    const local = listScenes(null);
    const upserts: { id: string; name: string; data: string }[] = [];
    for (const s of local) {
      const data = JSON.stringify(s);
      if (lastPushed.get(s.id) === data) continue; // 이 세션에서 이미 올린 그대로
      if (meta.has(s.id)) {
        const h = await sha256hex(data);
        if (h && h === meta.get(s.id)) {
          lastPushed.set(s.id, data); // 서버와 동일 — 올릴 필요 없음
          continue;
        }
        // 해시 불가(insecure context)면 보수적으로 업로드 — 누락보다 중복이 안전
      }
      upserts.push({ id: s.id, name: s.name, data });
    }
    const localIds = new Set(local.map((s) => s.id));
    const deleted = [...meta.keys()].filter((id) => !localIds.has(id));
    if (!upserts.length && !deleted.length) return;
    for (let i = 0; i < Math.max(upserts.length, 1); i += MAX_UPSERTS) {
      const chunk = upserts.slice(i, i + MAX_UPSERTS);
      await jsonFetch(`${API}`, {
        method: "PUT",
        body: JSON.stringify({
          project_id: "",
          upserts: chunk,
          deleted_ids: i === 0 ? deleted : [], // 삭제는 첫 청크에서 한 번만
        }),
      });
      for (const u of chunk) {
        lastPushed.set(u.id, u.data);
        serverHash?.delete(u.id); // 서버 해시는 미상(서버가 재계산) — 다음 대조는 lastPushed 가 담당
      }
    }
    for (const id of deleted) {
      serverHash?.delete(id);
      lastPushed.delete(id);
    }
  } catch {
    failed = true;
  } finally {
    syncing = false;
    if (failed) {
      serverHash = null; // 실패 후엔 메타 재조회(부분 반영 가능성)
      if (!retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void syncNow();
        }, RETRY_MS);
      }
    } else if (rerun) {
      rerun = false;
      void syncNow();
    }
  }
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void syncNow();
  }, DEBOUNCE_MS);
}

// 캐시 소실 복구 — 캔버스 진입 시 1회. 로컬 버킷 키가 없을 때만 DB 전체를 받아 한 번에 복원.
// 복원했으면 true(호출부가 씬 목록을 다시 읽는다).
export async function restoreScenesIfMissing(): Promise<boolean> {
  if (hasSceneBucket(null)) return false;
  let items: { id: string; data: string }[];
  try {
    const r = await jsonFetch<{ items: { id: string; data: string }[] }>(
      `${API}?project_id=&include_data=1`,
    );
    items = r.items || [];
  } catch {
    return false; // 구백엔드·오프라인 — 복구 없음(다음 진입에서 다시 시도됨)
  }
  const scenes: Scene[] = [];
  for (const it of items) {
    try {
      const s = JSON.parse(it.data) as Scene;
      if (s && typeof s === "object" && s.id === it.id && Array.isArray(s.cards)) scenes.push(s);
    } catch {
      /* 손상 백업 1건은 건너뜀 — 나머지는 복구 */
    }
  }
  if (!scenes.length) return false;
  // 요청 중 사용자가 씬을 만들었으면 그 로컬 변경이 이긴다(코덱스 P1 — 적용 직전 재확인).
  if (hasSceneBucket(null)) return false;
  scenes.sort((a, b) => (a.created_at || 0) - (b.created_at || 0)); // 생성 순서대로 탭 복원
  for (const s of scenes) lastPushed.set(s.id, JSON.stringify(s));
  saveScenes(null, scenes);
  return true;
}

// 부팅 배선 — useSceneCoordination(캔버스 상태 훅)이 1회 호출.
let installed = false;
export function installSceneBackup(): void {
  if (installed) return;
  installed = true;
  setOnScenesPersisted(schedule);
  window.addEventListener("online", () => void syncNow());
}
