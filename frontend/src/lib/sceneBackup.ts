// 캔버스 씬 DB 백업 — localStorage(원본)의 단방향 미러(로컬→DB) + 캐시 소실 시 복구.
//
// 계약(코덱스 합의 설계 + P1 반영):
//  · 로컬이 항상 정답. saveAll(쓰기 관문) 후 디바운스(2s) → 변경 씬만 벌크 PUT, DB 에만 남은
//    씬은 delete 로 정합(삭제 미러). 실패는 30s 백오프·online 이벤트·다음 변경에서 재시도.
//  · 복구는 '로컬 버킷 키 자체가 없을 때'만(hasSceneBucket) — 빈 배열 버킷(마지막 씬 정상 삭제)은
//    복구하지 않는다. 응답 전 행 검증(하나라도 손상 → 이번 복구 전체 포기 — 부분 복구가 남으면
//    다음 진입의 재복구가 막힌다) + 적용 직전 재확인.
//  · ★순서 불변식: 어떤 sync(특히 삭제 정합)도 그 계정 scope 의 복구 판정이 끝나기 전엔 돌지
//    않는다(ensureInit await). 안 지키면 새 브라우저에서 로컬=[] 를 기준으로 서버 백업 전체를
//    지우는 사고가 난다.
//  · 계정 전환 레이스: 모든 await 뒤·적용 직전에 scope(ns)를 재검사 — 다른 계정 응답을 현재
//    계정에 적용하지 않는다. scope 가 바뀌면 메타·lastPushed·초기화 상태를 폐기하고 새로 시작.
//  · owner 는 서버가 actor_id 로 결정 — 여기서는 계정을 보내지 않는다.
//  · 변경 대조: 서버 data_hash(sha256) vs 로컬 sha256(crypto.subtle). http LAN 등 insecure
//    context 로 subtle 이 없으면 첫 동기화 때 전 씬을 한 번 올린다(누락보다 중복이 안전) —
//    이후는 세션 내 lastPushed 문자열 비교로 변경분만.
import { jsonFetch } from "./http";
import { getAccountNamespace } from "./accountScope";
import { hasSceneBucket, listScenes, saveScenes, subscribeScenesPersisted, type Scene } from "./scenes";

const API = "/api/scenes/backup";
const DEBOUNCE_MS = 2000;
const RETRY_MS = 30_000; // 실패 백오프 — 다음 변경이 없어도 이 간격으로 재시도(성공 시 해제)
const MAX_UPSERTS = 200; // 서버 상한과 동일
const MAX_UPSERT_BYTES = 8 * 1024 * 1024; // 청크당 대략 바이트 상한(서버 총량 20MB 의 여유 하한)
const MAX_DELETES = 500; // 서버 상한과 동일

const ns = getAccountNamespace;

async function sha256hex(text: string): Promise<string | null> {
  try {
    if (!crypto?.subtle) return null; // insecure context(http LAN) — 해시 대조 불가
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

// 복구 판정 결과 — sync 진행 가능 여부를 가른다.
//  · restored: DB 에서 복원함 / clean: 복원 불필요(버킷 존재 or 서버 비어있음) → sync 진행 OK
//  · retry: 조회 실패(오프라인·미로그인 401·구백엔드) — 판정 미상. ★이 상태로 sync(특히 삭제
//    정합)를 진행하면 '로컬=[] 기준으로 서버 백업 전량 삭제' 사고가 난다 → sync 차단+백오프 재판정.
//  · blocked: 백업 손상(부분 복구 금지로 전체 포기) — 이 세션에선 sync 도 멈춘다(덮어쓰기 방지).
type InitResult = "restored" | "clean" | "retry" | "blocked";

// ── 상태 (모듈 스코프, 전부 '현재 scope' 소유 — scope 바뀌면 폐기) ────────
let curScope: string | null = null; // 이 상태가 어느 계정 것인지
let initPromise: Promise<InitResult> | null = null; // scope 의 복구 판정 — sync 는 이걸 기다린다
let serverHash: Map<string, string> | null = null; // 서버 메타 캐시 sceneId→data_hash
let lastPushed = new Map<string, string>(); // 마지막으로 밀어올린(또는 복구한) 씬 JSON — 정확 비교
let timer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let syncing = false;
let rerun = false; // 동기화 중 새 변경 — 끝나고 한 번 더

// 복구 알림 — 백그라운드(백오프 재시도) 복구도 현재 탭 UI(씬 목록)에 반영되게 구독을 받는다.
//  같은 탭엔 storage 이벤트가 안 오므로 이 콜백이 유일한 통지 경로다(코덱스 P1).
const restoreSubs = new Set<() => void>();
export function subscribeSceneRestore(fn: () => void): () => void {
  restoreSubs.add(fn);
  return () => restoreSubs.delete(fn);
}

// upsert 청크 분할 — 개수 + ★UTF-8 바이트 기준(서버 총량 검증과 같은 단위. JS 문자열 length 로
//  자르면 한글 등 멀티바이트 씬이 서버 400 에 걸려 같은 청크를 영구 재시도한다 — 코덱스 P1).
export function chunkUpserts<T extends { data: string }>(
  ups: T[],
  maxCount = MAX_UPSERTS,
  maxBytes = MAX_UPSERT_BYTES,
): T[][] {
  const chunks: T[][] = [];
  const enc = new TextEncoder();
  let cur: T[] = [];
  let curBytes = 0;
  for (const u of ups) {
    const b = enc.encode(u.data).byteLength;
    if (cur.length >= maxCount || (cur.length && curBytes + b > maxBytes)) {
      chunks.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(u);
    curBytes += b;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// scope 확정·전환 — 바뀌었으면 이전 계정 상태를 전부 버리고 이 scope 로 다시 시작한다.
function enterScope(): string {
  const s = ns();
  if (curScope !== s) {
    curScope = s;
    initPromise = null;
    serverHash = null;
    lastPushed = new Map();
    rerun = false;
    if (timer) clearTimeout(timer);
    timer = null;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }
  return s;
}

// 복구 판정(스코프당 1회): 버킷 키가 없으면 DB 전체를 받아 원자적으로 복원. sync 의 선행 조건.
// retry(조회 실패)만 캐시하지 않고 다음 기회에 재판정 — 로그인 후 자연 회복.
function ensureInit(scope: string): Promise<InitResult> {
  if (initPromise) return initPromise;
  const p: Promise<InitResult> = (async () => {
    if (hasSceneBucket(null)) return "clean";
    let items: { id: string; data: string }[];
    try {
      const r = await jsonFetch<{ items: { id: string; data: string }[] }>(
        `${API}?project_id=&include_data=1`,
      );
      items = r.items || [];
    } catch {
      return "retry"; // 오프라인·미로그인(401)·구백엔드 — 판정 미상(sync 차단, 백오프 재판정)
    }
    if (ns() !== scope) return "retry"; // 계정 전환 중 응답 — 폐기
    if (!items.length) return "clean"; // 서버도 비어있음(새 사용자) — 복원할 것 없음
    // ★전 행 검증 — 하나라도 손상이면 이번 복구 전체 포기(부분 복구 금지, 코덱스 P1).
    //  이때 sync 도 막는다(blocked) — 진행하면 로컬 공백 기준 정합이 살아있는 백업까지 지운다.
    const scenes: Scene[] = [];
    for (const it of items) {
      try {
        const s = JSON.parse(it.data) as Scene;
        if (!s || typeof s !== "object" || s.id !== it.id || !Array.isArray(s.cards)) return "blocked";
        scenes.push(s);
      } catch {
        return "blocked";
      }
    }
    if (ns() !== scope || hasSceneBucket(null)) return "clean"; // 적용 직전 재확인(요청 중 로컬 변경 우선)
    scenes.sort((a, b) => (a.created_at || 0) - (b.created_at || 0)); // 생성 순서대로 탭 복원
    for (const s of scenes) lastPushed.set(s.id, JSON.stringify(s)); // 복구 에코 방지
    saveScenes(null, scenes);
    restoreSubs.forEach((f) => f()); // 백그라운드 복구 포함 — 열린 캔버스가 즉시 목록을 다시 읽게
    return "restored";
  })();
  initPromise = p;
  void p.then((res) => {
    if (initPromise === p && res === "retry") initPromise = null; // 실패 판정은 캐시 안 함 — 재시도 가능
  });
  return p;
}

async function ensureServerMeta(scope: string): Promise<Map<string, string> | null> {
  if (serverHash) return serverHash;
  try {
    const r = await jsonFetch<{ items: { id: string; data_hash: string }[] }>(
      `${API}?project_id=`,
    );
    if (ns() !== scope) return null; // 계정 전환 중 응답 — 다른 계정 메타를 캐시하지 않는다
    serverHash = new Map(r.items.map((it) => [it.id, it.data_hash]));
    return serverHash;
  } catch {
    return null; // 구백엔드(404)·오프라인 — 이번 회차 건너뜀(백오프가 재시도)
  }
}

async function syncNow(): Promise<void> {
  if (syncing) {
    rerun = true;
    return;
  }
  syncing = true;
  let failed = false;
  const scope = enterScope();
  try {
    // ★복구 판정이 끝나기 전 삭제 정합 금지 — 새 브라우저에서 로컬=[] 로 서버를 지우는 사고 방지.
    const init = await ensureInit(scope);
    if (init === "retry") {
      failed = true; // 판정 미상(미로그인 등) — 백오프로 재판정
      return;
    }
    if (init === "blocked") return; // 손상 백업 — 이 세션은 미러 중단(덮어쓰기·삭제 방지)
    if (ns() !== scope) return;
    const meta = await ensureServerMeta(scope);
    if (!meta) {
      failed = true;
      return;
    }
    if (ns() !== scope) return;
    const local = listScenes(null);
    const upserts: { id: string; name: string; data: string }[] = [];
    for (const s of local) {
      const data = JSON.stringify(s);
      if (lastPushed.get(s.id) === data) continue; // 이 세션에서 이미 올린(또는 복구한) 그대로
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
    const allDeleted = [...meta.keys()].filter((id) => !localIds.has(id));
    if (!upserts.length && !allDeleted.length) return;
    if (ns() !== scope) return; // 변경 적용(PUT) 직전 최종 확인
    // 청크 전송 — upsert 는 개수+UTF-8 바이트, delete 는 개수 기준(서버 상한과 동일).
    const upChunks = chunkUpserts(upserts);
    const delChunks: string[][] = [];
    for (let i = 0; i < allDeleted.length; i += MAX_DELETES) {
      delChunks.push(allDeleted.slice(i, i + MAX_DELETES));
    }
    const rounds = Math.max(upChunks.length, delChunks.length);
    for (let i = 0; i < rounds; i++) {
      if (ns() !== scope) return; // 각 청크 직전 재확인
      const chunk = upChunks[i] || [];
      const dels = delChunks[i] || [];
      await jsonFetch(`${API}`, {
        method: "PUT",
        body: JSON.stringify({ project_id: "", upserts: chunk, deleted_ids: dels }),
      });
      if (ns() !== scope) return; // 응답 후 상태 반영도 같은 scope 일 때만
      for (const u of chunk) {
        lastPushed.set(u.id, u.data);
        // 서버가 재계산한 정확한 해시는 모르지만, 이 ID가 서버에 '존재한다'는 사실은 유지해야 한다.
        // 여기서 지우면 같은 세션에서 로컬 씬을 삭제했을 때 allDeleted가 그 ID를 못 찾아 서버 백업이
        // 남고, 캐시 소실 후 삭제한 씬이 되살아난다. 빈 문자열은 존재 멤버십용 sentinel이며 변경
        // 대조는 lastPushed가 담당한다(내용이 바뀌면 sentinel과 해시가 달라 재업로드됨).
        serverHash?.set(u.id, "");
      }
      for (const id of dels) {
        serverHash?.delete(id);
        lastPushed.delete(id);
      }
    }
  } catch {
    failed = true;
  } finally {
    syncing = false;
    if (ns() === scope && failed) {
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

// 부팅 배선 + 복구 — useSceneCoordination 이 마운트마다 호출(내부는 scope 당 1회).
// 반환: 이번 호출로 복구가 일어났는지(호출부가 씬 목록 재읽기·알림).
let installed = false;
export async function initSceneBackup(): Promise<boolean> {
  if (!installed) {
    installed = true;
    subscribeScenesPersisted(schedule);
    window.addEventListener("online", () => void syncNow());
  }
  const scope = enterScope();
  const res = await ensureInit(scope);
  // 복구 여부와 무관하게 초기 reconcile 1회 — 배포 전부터 있던(수정 안 한) 씬도 미러되게(코덱스 P1).
  // 실패(미로그인 401 포함)는 30s 백오프가 이어받아 로그인 후 자연 회복된다.
  schedule();
  return res === "restored";
}
