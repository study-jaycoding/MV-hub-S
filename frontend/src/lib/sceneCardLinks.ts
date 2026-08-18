// 캔버스 카드 소속 DB 기록 — "이 카드에 이 생성물이 담겨 있다"를 로컬 DB(내 PC)에 남긴다.
//
// 왜 씬 백업(sceneBackup.ts)으로 부족한가: 그쪽은 씬을 통째로 덮어쓰는 미러라 늦게 저장한
// 브라우저가 이긴다. 실측(2026-08-18) 결과 카드-생성물 57건 중 서버가 기억하는 건 1건뿐이라,
// 브라우저 캐시가 날아가면 나머지 56건은 어느 카드 것이었는지 알 방법이 없었다.
//
// 계약:
//  · 자동으로 보내는 건 **추가뿐**. 화면에서 사라졌다고 제거를 보내지 않는다 — 다른 브라우저가
//    방금 담은 것을 이 브라우저의 낡은 목록이 지워버리는 사고가 난다.
//  · 제거는 사용자가 실제로 비운 순간에만 명시적으로(markRemoved) — 현재는 comfy 워크플로 교체.
//  · known 은 서버가 이미 아는 소속. **뺀 표시가 된 것도 known 에 넣는다** — 안 그러면 백필이
//    그걸 다시 담아 되살린다.
//  · 계정 전환 레이스: 모든 await 뒤 scope 재검사(sceneBackup 과 같은 규칙).
//  · 팀 서버로 가지 않는다 — 개인 편집물(백엔드 _proxy._LOCAL_PREFIXES '/api/scenes').
import { getAccountNamespace } from "./accountScope";
import { jsonFetch } from "./http";
import { listScenes, subscribeScenesPersisted, variantIds } from "./scenes";

const API = "/api/scenes/cards";
const DEBOUNCE_MS = 2000;
const RETRY_MS = 30_000;
const MAX_PER_REQUEST = 1000; // 서버 상한(2000)의 절반 — 추가+제거가 한 요청에 섞여도 안전

export interface CardLink {
  scene_id: string;
  card_id: string;
  generation_id: string;
  removed_at?: string | null;
}

const ns = getAccountNamespace;
const keyOf = (l: { scene_id: string; card_id: string; generation_id: string }) =>
  `${l.scene_id}|${l.card_id}|${l.generation_id}`;

// ── 상태 (전부 '현재 scope' 소유 — scope 바뀌면 폐기) ─────────────────
let curScope: string | null = null;
let known: Set<string> | null = null; // 서버가 아는 소속(뺀 표시 포함). null = 아직 못 읽음
let serverLinks: CardLink[] = []; // 마지막으로 읽은 서버 소속 — 2단계(합치기)가 읽는다
let loadPromise: Promise<boolean> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let pushing = false;
let rerun = false;

function enterScope(): string {
  const s = ns();
  if (curScope !== s) {
    curScope = s;
    known = null;
    serverLinks = [];
    loadPromise = null;
    rerun = false;
    if (timer) clearTimeout(timer);
    timer = null;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }
  return s;
}

/** 지금 브라우저에 있는 씬 전체의 카드 소속. 생성 카드·comfy 카드 모두(결과가 쌓이는 카드). */
export function localCardLinks(): CardLink[] {
  const out: CardLink[] = [];
  for (const scene of listScenes(null)) {
    for (const card of scene.cards || []) {
      for (const gid of variantIds(card)) {
        if (gid) out.push({ scene_id: scene.id, card_id: card.id, generation_id: gid });
      }
    }
  }
  return out;
}

/** 서버 소속 읽기(scope 당 1회, 실패 시 다음 기회에 재시도). 성공하면 known 을 채운다. */
function ensureLoaded(scope: string): Promise<boolean> {
  if (loadPromise) return loadPromise;
  const p = (async () => {
    let items: CardLink[];
    try {
      const r = await jsonFetch<{ items: CardLink[] }>(API);
      items = r.items || [];
    } catch {
      return false; // 오프라인·미로그인(401)·구백엔드 — 판정 미상. known 을 비워두면 백필이 안 돈다
    }
    if (ns() !== scope) return false; // 계정 전환 중 응답 — 폐기
    serverLinks = items;
    known = new Set(items.map(keyOf)); // ★뺀 표시가 된 것도 넣는다(백필이 되살리지 않게)
    return true;
  })();
  loadPromise = p;
  void p.then((ok) => {
    if (!ok && loadPromise === p) loadPromise = null; // 실패는 캐시하지 않음
  });
  return p;
}

/** 마지막으로 읽은 서버 소속(2단계 합치기용). 아직 못 읽었으면 빈 배열. */
export function serverCardLinks(sceneId?: string): CardLink[] {
  return sceneId ? serverLinks.filter((l) => l.scene_id === sceneId) : serverLinks;
}

async function send(added: CardLink[], removed: CardLink[]): Promise<void> {
  const strip = (l: CardLink) => ({
    scene_id: l.scene_id,
    card_id: l.card_id,
    generation_id: l.generation_id,
  });
  for (let i = 0; i < Math.max(added.length, removed.length); i += MAX_PER_REQUEST) {
    await jsonFetch(API, {
      method: "PUT",
      body: JSON.stringify({
        added: added.slice(i, i + MAX_PER_REQUEST).map(strip),
        removed: removed.slice(i, i + MAX_PER_REQUEST).map(strip),
      }),
    });
  }
}

/** 로컬에만 있는 소속을 서버로 올린다(=백필이자 평상시 기록). 추가만 보낸다. */
async function pushNew(): Promise<void> {
  if (pushing) {
    rerun = true;
    return;
  }
  pushing = true;
  try {
    const scope = enterScope();
    if (!(await ensureLoaded(scope))) {
      scheduleRetry();
      return;
    }
    if (ns() !== scope || !known) return;
    const fresh: CardLink[] = [];
    const seen = new Set<string>();
    for (const link of localCardLinks()) {
      const k = keyOf(link);
      if (known.has(k) || seen.has(k)) continue;
      seen.add(k);
      fresh.push(link);
    }
    if (!fresh.length) return;
    try {
      await send(fresh, []);
    } catch {
      scheduleRetry(); // 서버 실패 — known 을 안 채우므로 다음 시도에 그대로 다시 올린다
      return;
    }
    if (ns() !== scope || !known) return;
    for (const link of fresh) {
      known.add(keyOf(link));
      serverLinks.push(link);
    }
  } finally {
    pushing = false;
    if (rerun) {
      rerun = false;
      schedule();
    }
  }
}

function scheduleRetry(): void {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void pushNew();
  }, RETRY_MS);
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void pushNew();
  }, DEBOUNCE_MS);
}

/**
 * 카드에서 생성물을 뺐다 — 사용자가 실제로 비운 순간에만 부른다(comfy 워크플로 교체 등).
 * 화면에서 안 보인다고 부르면 안 된다: 다른 브라우저가 방금 담은 걸 지우게 된다.
 */
export async function markCardGenerationsRemoved(
  sceneId: string,
  cardId: string,
  generationIds: string[],
): Promise<void> {
  const links = generationIds
    .filter(Boolean)
    .map((generation_id) => ({ scene_id: sceneId, card_id: cardId, generation_id }));
  if (!links.length) return;
  const scope = enterScope();
  try {
    await send([], links);
  } catch {
    return; // 다음 기회에 사용자가 다시 비우면 반영된다 — 조용히 되살리는 것보다 안전
  }
  if (ns() !== scope) return;
  const removedKeys = new Set(links.map(keyOf));
  // 뺀 것도 known 에 넣는다 — 백필이 다시 담아 되살리지 않게.
  for (const link of links) known?.add(keyOf(link));
  serverLinks = serverLinks.map((l) =>
    removedKeys.has(keyOf(l)) ? { ...l, removed_at: new Date().toISOString() } : l,
  );
}

/** 부팅 배선 — useSceneCoordination 이 마운트마다 호출(내부는 scope 당 1회). */
let installed = false;
export function initSceneCardLinks(): void {
  if (!installed) {
    installed = true;
    subscribeScenesPersisted(schedule);
    window.addEventListener("online", () => void pushNew());
  }
  enterScope();
  schedule(); // 초기 백필 — 서버에 없는 소속을 한 번 올린다(멱등이라 매번 돌아도 무해)
}
