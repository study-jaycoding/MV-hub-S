// 캔버스 '방금 생성' 완료 감시 — App 레벨에서 상시 폴링(탭 전환·SceneBoard 언마운트와 무관).
//  · store.watch(미확정 genId)를 폴링해 상태를 observeStatus 로 반영 → 내 작업 탭에 있는 동안 생성이 완료돼도
//    잡아서 recentlyDone 에 넣으므로, 캔버스로 돌아오면 glow.
//  · candidateIds(활성 씬 변형 genId)는 새로고침 등으로 store 가 빈 상태를 보완 — 아직 모르는 것만 1회 발견
//    폴링(tick 당 상한). store 의 baseline 규칙상 '이미 done' 은 glow 안 되고, 'pending' 이면 watch 에 들어간다.
//  · 현재 열린 SceneBoard가 useSceneGenData로 조회하는 id는 coveredIds로 제외해 중복 폴링하지 않는다.
//    다른 씬의 실행은 App watcher가 계속 맡아, 캔버스 안에서 씬을 바꿔도 완료 감지가 멈추지 않는다.
//  · watch 가 비고 발견할 것도 없으면 API 호출 없음(가벼움).
import { useEffect, useRef } from "react";
import { api } from "../api";
import { getWatchIds, isKnownGen, observeStatus } from "./sceneRecentDoneStore";

const POLL_MS = 2500;
const MAX_DISCOVER_PER_TICK = 30; // 대형 씬에서 한 tick 에 몰아 폴링하지 않게(여러 tick 에 걸쳐 발견)

export function buildSceneCompletionPollIds(
  watchIds: readonly string[],
  candidateIds: readonly string[],
  coveredIds: ReadonlySet<string>,
  known: (id: string) => boolean = isKnownGen,
  maxDiscover = MAX_DISCOVER_PER_TICK,
): string[] {
  const ids: string[] = [];
  const added = new Set<string>();
  const add = (id: string) => {
    if (!id || coveredIds.has(id) || added.has(id)) return;
    added.add(id);
    ids.push(id);
  };
  for (const id of watchIds) add(id);

  let discovered = 0;
  for (const id of candidateIds) {
    if (discovered >= maxDiscover) break;
    if (!id || coveredIds.has(id) || known(id)) continue;
    const before = added.size;
    add(id);
    if (added.size > before) discovered++;
  }
  return ids;
}

interface SceneCompletionWatcherOptions {
  enabled?: boolean;
  coveredIds?: readonly string[];
}

export function useSceneCompletionWatcher(
  candidateIds: string[],
  { enabled = true, coveredIds = [] }: SceneCompletionWatcherOptions = {},
): void {
  const candRef = useRef<string[]>(candidateIds);
  candRef.current = candidateIds;
  const coveredSourceRef = useRef<readonly string[]>(coveredIds);
  const coveredRef = useRef<Set<string>>(new Set(coveredIds));
  if (coveredSourceRef.current !== coveredIds) {
    coveredSourceRef.current = coveredIds;
    coveredRef.current = new Set(coveredIds);
  }

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      // 백그라운드 탭에서 2.5초 DB 조회를 계속할 이유가 없다. 복귀 후 다음 tick에 즉시 최신 상태로 수렴한다.
      if (document.visibilityState === "hidden") {
        if (alive) timer = window.setTimeout(tick, POLL_MS);
        return;
      }
      // 현재 SceneBoard가 이미 담당하는 id는 제외하고, 아직 store가 모르는 후보는 상한만큼만 발견한다.
      const ids = buildSceneCompletionPollIds(
        getWatchIds(),
        candRef.current,
        coveredRef.current,
      );
      if (ids.length) {
        try {
          const batch = await api.getGenerationsBatch(ids);
          if (alive) {
            const missing = new Set(batch.missing || []);
            for (const id of ids) {
              const g = batch.items[id];
              if (g) observeStatus(id, g.status);
              else if (missing.has(id)) observeStatus(id, "failed");
            }
          }
        } catch {
          // 일시 오류는 다음 tick에서 배치 1회로 재시도한다.
        }
      }
      if (alive) timer = window.setTimeout(tick, POLL_MS);
    };
    timer = window.setTimeout(tick, POLL_MS);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);
}
