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
const REFRESH_MS = 30_000; // 다른 브라우저 변경을 새로고침 없이 가져오는 상한
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
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let pushing = false;
let rerun = false;
let pendingRemovals: CardLink[] = [];

const pendingKey = (scope: string) => `ch.sceneCardRemovals.v1.${encodeURIComponent(scope)}`;

function readPending(scope: string): CardLink[] {
  try {
    const raw = JSON.parse(localStorage.getItem(pendingKey(scope)) || "[]");
    if (!Array.isArray(raw)) return [];
    const dedup = new Map<string, CardLink>();
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const link = item as Partial<CardLink>;
      if (!link.scene_id || !link.card_id || !link.generation_id) continue;
      const clean = {
        scene_id: String(link.scene_id),
        card_id: String(link.card_id),
        generation_id: String(link.generation_id),
      };
      dedup.set(keyOf(clean), clean);
    }
    return [...dedup.values()];
  } catch {
    return [];
  }
}

function writePending(scope: string, links: CardLink[]): void {
  try {
    if (links.length) localStorage.setItem(pendingKey(scope), JSON.stringify(links));
    else localStorage.removeItem(pendingKey(scope));
  } catch {
    // 저장공간이 막힌 환경도 현재 세션 메모리 대기열로는 계속 재시도한다.
  }
}

function enqueueRemovals(scope: string, links: CardLink[]): void {
  const merged = new Map(readPending(scope).map((link) => [keyOf(link), link]));
  for (const link of links) merged.set(keyOf(link), link);
  pendingRemovals = [...merged.values()];
  writePending(scope, pendingRemovals);
}

function clearSentRemovals(scope: string, links: CardLink[]): void {
  const sent = new Set(links.map(keyOf));
  const remaining = readPending(scope).filter((link) => !sent.has(keyOf(link)));
  writePending(scope, remaining);
  if (curScope === scope) pendingRemovals = remaining;
}

function applyRemovedToLoadedState(links: CardLink[]): void {
  const removedKeys = new Set(links.map(keyOf));
  const removedAt = new Date().toISOString();
  for (const link of links) known?.add(keyOf(link));
  serverLinks = serverLinks.map((link) =>
    removedKeys.has(keyOf(link)) ? { ...link, removed_at: removedAt } : link,
  );
  const present = new Set(serverLinks.map(keyOf));
  for (const link of links) {
    if (!present.has(keyOf(link))) serverLinks.push({ ...link, removed_at: removedAt });
  }
}

function enterScope(): string {
  const s = ns();
  if (curScope !== s) {
    curScope = s;
    known = null;
    serverLinks = [];
    loadPromise = null;
    rerun = false;
    pendingRemovals = readPending(s);
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

/** 최초 서버 소속 읽기(실패 시 다음 기회에 재시도). 성공하면 known 을 채운다. */
function ensureLoaded(scope: string): Promise<boolean> {
  return load(scope, false);
}

function sameLinks(a: CardLink[], b: CardLink[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((link, index) => {
    const other = b[index];
    return keyOf(link) === keyOf(other) && (link.removed_at || null) === (other.removed_at || null);
  });
}

/**
 * 서버 소속 읽기. 최초 백필은 캐시를 쓰고, 화면 복귀·주기 갱신은 force=true 로 다시 읽는다.
 * 진행 중인 GET은 공유해 느린 서버에서 중복 요청이 쌓이지 않게 한다.
 */
function load(scope: string, force: boolean): Promise<boolean> {
  if (!force && known !== null) return Promise.resolve(true);
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
    const changed = !sameLinks(serverLinks, items);
    serverLinks = items;
    known = new Set(items.map(keyOf)); // ★뺀 표시가 된 것도 넣는다(백필이 되살리지 않게)
    if (changed) loadedSubs.forEach((fn) => fn()); // 화면이 합치기를 돌리게
    return true;
  })();
  loadPromise = p;
  const clearLoad = () => {
    if (loadPromise === p) loadPromise = null;
  };
  void p.then(clearLoad, clearLoad);
  return p;
}

/** 다른 브라우저에서 바뀐 카드 소속을 명시적으로 다시 읽는다. */
export function refreshSceneCardLinks(): Promise<boolean> {
  const scope = enterScope();
  return load(scope, true);
}

/** 마지막으로 읽은 서버 소속(합치기용). 아직 못 읽었으면 빈 배열. */
export function serverCardLinks(sceneId?: string): CardLink[] {
  return sceneId ? serverLinks.filter((l) => l.scene_id === sceneId) : serverLinks;
}

// 서버 소속을 처음 읽었을 때 알림 — 화면(useSceneCoordination)이 그때 합치기를 돌린다.
const loadedSubs = new Set<() => void>();
export function subscribeCardLinksLoaded(fn: () => void): () => void {
  loadedSubs.add(fn);
  return () => loadedSubs.delete(fn);
}

/**
 * 서버가 아는 소속을 씬에 합친다 — 다른 브라우저에서 담은 결과가 이 브라우저에도 보이게.
 *
 *   카드의 생성물 = (로컬에 있는 것 ∪ 서버에 있는 것) − (서버가 뺐다고 한 것)
 *
 * 바뀐 게 없으면 null 을 돌려준다(그대로 저장하면 저장→알림→합치기 고리가 돈다).
 * 서버에만 있는 카드 번호는 무시한다 — 카드 자체(위치·크기)는 씬이 소유하므로 여기서 못 만든다.
 * 변경 없으면 원본 배열·객체를 그대로 재사용한다(React 참조 비교로 불필요한 재렌더 방지).
 */
export function mergeCardLinksIntoScenes<
  S extends { id: string; cards: { id: string; kind: string; genId?: string | null; genIds?: string[] }[] },
>(scenes: S[], links: CardLink[]): S[] | null {
  if (!links.length) return null;
  const byCard = new Map<string, CardLink[]>();
  for (const link of links) {
    const key = `${link.scene_id}|${link.card_id}`;
    const list = byCard.get(key);
    if (list) list.push(link);
    else byCard.set(key, [link]);
  }
  let touched = false;
  const next = scenes.map((scene) => {
    let sceneTouched = false;
    const cards = scene.cards.map((card) => {
      // 결과가 쌓이는 카드만 — 다른 종류에 소속이 끼면 화면 규칙이 깨진다.
      if (card.kind !== "generation" && card.kind !== "comfy") return card;
      const mine = byCard.get(`${scene.id}|${card.id}`);
      if (!mine?.length) return card;
      const removed = new Set(mine.filter((l) => l.removed_at).map((l) => l.generation_id));
      const local = variantIds(card);
      const merged = local.filter((id) => !removed.has(id));
      for (const link of mine) {
        if (!link.removed_at && !merged.includes(link.generation_id)) merged.push(link.generation_id);
      }
      const sameOrder =
        merged.length === local.length && merged.every((id, i) => id === local[i]);
      if (sameOrder) return card;
      sceneTouched = true;
      // 대표가 빠졌으면 남은 것 중 마지막(가장 최근에 담긴 것)으로 — 빈 카드로 보이지 않게.
      const genId =
        card.genId && !removed.has(card.genId) ? card.genId : merged[merged.length - 1] ?? null;
      return { ...card, genIds: merged, genId };
    });
    if (!sceneTouched) return scene;
    touched = true;
    return { ...scene, cards };
  });
  return touched ? next : null;
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
    // 사용자가 명시적으로 뺀 기록이 자동 백필보다 항상 먼저다. 실패하면 로컬 대기열을 지우지 않아
    // 온라인 복귀·앱 재시작 뒤에도 재시도된다. 추가와 같은 직렬화 안에서 보내 race로 되살아나지 않는다.
    const removals = [...pendingRemovals];
    if (removals.length) {
      try {
        await send([], removals);
      } catch {
        scheduleRetry();
        return;
      }
      clearSentRemovals(scope, removals);
      if (ns() !== scope) return;
      applyRemovedToLoadedState(removals);
    }
    if (!(await ensureLoaded(scope))) {
      scheduleRetry();
      return;
    }
    if (ns() !== scope || !known) return;
    // ensureLoaded가 직전에 받은 낡은 응답으로 known/serverLinks를 교체했더라도, 이번 요청에서 서버가
    // 수락한 제거 의도를 다시 덮어씌운다. 그래야 바로 뒤의 자동 추가가 같은 소속을 되살리지 않는다.
    if (removals.length) applyRemovedToLoadedState(removals);
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
  enqueueRemovals(scope, links); // 네트워크보다 먼저 기록 — 실패·재시작에도 제거 의도를 잃지 않는다.
  await pushNew();
}

function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    const refresh = hidden ? Promise.resolve(false) : refreshSceneCardLinks();
    void refresh.then(scheduleRefresh, scheduleRefresh);
  }, REFRESH_MS);
}

function refreshOnReturn(): void {
  const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  if (!hidden) {
    scheduleRefresh(); // 복귀 직후 읽었으면 다음 주기는 지금부터 30초 뒤 — 연속 GET 방지
    void refreshSceneCardLinks().catch(() => false);
  }
}

/** 부팅 배선 — useSceneCoordination 이 마운트마다 호출(내부는 scope 당 1회). */
let installed = false;
export function initSceneCardLinks(): void {
  if (!installed) {
    installed = true;
    subscribeScenesPersisted(schedule);
    window.addEventListener("online", () => {
      scheduleRefresh();
      void refreshSceneCardLinks().then(pushNew, pushNew);
    });
    window.addEventListener("focus", refreshOnReturn);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", refreshOnReturn);
    }
    scheduleRefresh();
  }
  enterScope();
  schedule(); // 초기 백필 — 서버에 없는 소속을 한 번 올린다(멱등이라 매번 돌아도 무해)
}
