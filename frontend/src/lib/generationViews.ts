// 마지막으로 크게 열어본 생성물 — "Last viewed" 배지의 원천.
//
//  · 상태를 **모듈 store** 에 둔다. SceneBoard 는 구성 탭을 벗어나면 언마운트되므로 컴포넌트
//    상태로 두면 탭을 오갈 때마다 배지가 사라졌다 다시 받아온다.
//  · 기록은 MediaPreview 한 곳에서만 한다. 미리보기 진입점이 10군데라 호출부마다 달면 반드시
//    새는 곳이 생긴다.
//  · 기록(PUT)은 **보낸 순서대로 하나씩** 보낸다. 병렬로 보내면 서버가 B 를 먼저 처리해 순번을
//    B→A 로 매기고, 화면은 B 인데 다시 읽으면 A 가 된다(코덱스 P1). 큐 하나면 서버 채번 순서가
//    곧 사용자의 열람 순서다.
//  · 조회(GET)는 시작 시점의 기록 버전을 적어 두고, 응답이 올 때까지 기록이 성공했으면 그 응답을
//    버리고 한 번 더 읽는다. 안 그러면 옛 조회 응답이 새 기록을 덮어 배지가 뒤로 간다(코덱스 P1).
//  · 캔버스 밖(목록·히스토리) 열람은 sceneId/cardId 없이 보내고, 캔버스 배지를 움직이지 않는다.
//  · 서버가 owner 를 정한다 — 클라이언트는 owner 를 보내지 않는다.
//  · 계정 전환·로그아웃은 페이지를 새로 고치므로(useHubAuth) 모듈 store 가 통째로 다시 만들어진다.
//    별도 clear 는 두지 않는다.
import { useSyncExternalStore } from "react";
import { jsonBody, jsonFetch } from "./http";
import { withQuery } from "./url";

const URL_BASE = "/api/generation-views";

export interface SceneViews {
  /** 그 씬의 묶음(카드)별 마지막 생성물 — 결과 모아보기 팝업 배지 */
  card: Record<string, string>;
  /** 그 씬에서 마지막으로 본 카드 하나 — 캔버스 배지 */
  lastCardId: string | null;
}

const EMPTY: SceneViews = { card: {}, lastCardId: null };

// sceneId('' = 캔버스 밖) → 그 씬의 표시. 같은 값이면 참조를 유지해야 useSyncExternalStore 가 안 튄다.
const store = new Map<string, SceneViews>();
const listeners = new Set<() => void>();
const inFlight = new Map<string, Promise<void>>();

// 성공한 기록마다 +1. 조회는 자기가 시작할 때의 값을 기억해 두고, 달라졌으면 응답을 버린다.
let recordVersion = 0;
// 기록 직렬화 큐 — 앞 요청이 실패해도 뒤는 이어간다.
let recordQueue: Promise<void> = Promise.resolve();

function emit(): void {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function snapshot(sceneId: string): SceneViews {
  return store.get(sceneId) ?? EMPTY;
}

function sameCards(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => a[k] === b[k]);
}

function put(sceneId: string, next: SceneViews): void {
  const prev = store.get(sceneId);
  if (prev && prev.lastCardId === next.lastCardId && sameCards(prev.card, next.card)) return;
  store.set(sceneId, next);
  emit();
}

/** 서버에서 그 씬의 표시를 다시 읽는다. 같은 씬의 중복 요청은 하나로 합친다. */
export function refreshGenerationViews(sceneId = ""): Promise<void> {
  const running = inFlight.get(sceneId);
  if (running) return running;
  const startedAt = recordVersion;
  let stale = false;
  const p = jsonFetch<{ card?: Record<string, string>; last_card_id?: string | null }>(
    withQuery(URL_BASE, sceneId ? { scene_id: sceneId } : {}),
  )
    .then((r) => {
      if (recordVersion !== startedAt) {
        stale = true; // 읽는 사이 기록이 성공했다 — 이 응답은 옛것이라 덮지 않는다
        return;
      }
      put(sceneId, { card: r.card || {}, lastCardId: r.last_card_id ?? null });
    })
    .catch(() => {
      // 배지는 보조 표시다 — 못 읽으면 조용히 없는 상태로 둔다(작업을 막지 않는다).
    })
    .finally(() => {
      inFlight.delete(sceneId);
      if (stale) void refreshGenerationViews(sceneId); // 최신 상태로 한 번 더
    });
  inFlight.set(sceneId, p);
  return p;
}

/** 미리보기에 그 항목이 실제로 표시된 순간 1회. 로컬에 없는 팀 항목은 서버가 거절한다. */
export function recordGenerationView(
  generationId: string,
  scene?: { sceneId: string; cardId: string } | null,
): Promise<void> {
  const sceneId = scene?.sceneId || "";
  const cardId = scene?.cardId || "";
  if (!generationId || Boolean(sceneId) !== Boolean(cardId)) return Promise.resolve();
  const run = async () => {
    try {
      const res = await jsonFetch<{ recorded: boolean }>(URL_BASE, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: jsonBody({ generation_id: generationId, scene_id: sceneId, card_id: cardId }),
      });
      if (!res.recorded) return; // 팀 항목(로컬에 없음) — 서버가 분명히 거절했다
      recordVersion += 1;
      const prev = snapshot(sceneId);
      put(sceneId, {
        card: { ...prev.card, [cardId]: generationId },
        lastCardId: cardId || null,
      });
    } catch {
      // 기록 실패는 화면을 막지 않는다. 다음 조회 때 서버 값으로 맞춰진다.
    }
  };
  recordQueue = recordQueue.then(run, run);
  return recordQueue;
}

/** 훅 밖에서 현재 값을 읽는다(테스트·비 React 코드). */
export function getGenerationViews(sceneId = ""): SceneViews {
  return snapshot(sceneId);
}

/** 그 씬의 배지 상태를 구독한다. sceneId 를 주지 않으면 캔버스 밖 행. */
export function useGenerationViews(sceneId = ""): SceneViews {
  return useSyncExternalStore(
    subscribe,
    () => snapshot(sceneId),
    () => EMPTY,
  );
}

/** 테스트 전용 — 모듈 상태 초기화. */
export function _resetGenerationViewsForTest(): void {
  store.clear();
  inFlight.clear();
  recordVersion = 0;
  recordQueue = Promise.resolve();
}
