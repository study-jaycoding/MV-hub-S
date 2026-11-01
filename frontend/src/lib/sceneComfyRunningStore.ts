// Comfy 노드 '생성중' 표시를 SceneBoard 언마운트(내작업↔구성 탭 전환)에도 유지하는 모듈 store.
//  왜 필요한가: 배치 실행(runPlanComfyCopies)은 실행상태를 persist 하지 않고 메모리(markComfyRunning)로만
//  표시하고, 단독 실행도 async 완료가 옛 SceneBoard 인스턴스에서 난다. 인스턴스 안 state 는 탭 전환으로
//  언마운트되면 사라져, 재마운트 시 '생성중'이 안 보이고 이전 결과가 보였다(사용자 보고 #2).
//  → 인스턴스 밖 모듈 store 에 기록하면 탭을 오가도 실행중 표시가 살아있다. (glow 의 sceneRecentDoneStore 와 동형)
import { shareWindowLive } from "./popupWindows";
import { comfyCardRuntime } from "./comfyRunState";
import type { Scene } from "./scenes";

const running = new Map<string, number>(); // cardId → 중첩 실행 카운트(같은 카드 여러 번 on 대비)
// 이 창의 예약/전송(응답 대기 포함)이 끝나기 전에는 not_found로 정리하지 않는다.
const activeAttempts = new Set<string>();
export function beginComfyAttempt(account: string, attemptId: string): () => void {
  const key = JSON.stringify([account, attemptId]);
  activeAttempts.add(key);
  return () => { activeAttempts.delete(key); };
}
export function isComfyAttemptActive(account: string, attemptId: string): boolean {
  return activeAttempts.has(JSON.stringify([account, attemptId]));
}
// 다른 창(메인 창 ↔ 휠 클릭으로 띄운 캔버스 창)에서 돌고 있는 실행 — 창마다 마지막으로 알린 목록(Jay 2026-10-30, lib/popupWindows 의 실시간 나눔).
//  띄우기 전에 건 실행은 건 창이 끝까지 돌리므로, 이것이 없으면 떠 있는 창에 '생성중'이 안 보여 다시 눌러 두 번 실행됐다.
const remote = new Map<string, Set<string>>();
// 창 사이로는 계정·씬까지 묶어 나눈다 — 카드 id 는 씬 가져오기로 복제되어 다른 씬·다른 계정 창에도 같은 id 가 있다. 범위는 실행을 시작할 때 잡아 켤 때·끌 때 같은 값을 넘긴다(그 사이 씬이 바뀔 수 있다).
const shared = new Map<string, number>(); // 범위+카드 → 중첩 실행 카운트
const sharedKey = (scope: string, id: string) => `${scope}\n${id}`;
export const comfyRunningScope = (account: string, sceneId: string): string => JSON.stringify([account, sceneId]);
let version = 0;
const listeners = new Set<() => void>();
let announce: (() => void) | null = null;

function emit(): void {
  version++;
  for (const l of listeners) l();
}

function shareAcrossWindows(): void {
  if (announce) return;
  announce = shareWindowLive("comfyRunning", {
    read: () => [...shared.keys()],
    apply: (sender, value) => {
      const ids = Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
      if (ids.length) remote.set(sender, new Set(ids));
      else if (!remote.delete(sender)) return;
      emit();
    },
  });
}

// markComfyRunning 이 호출 — on=true 진입 시 +1, 완료/실패 finally 에서 -1. 0 이하면 제거.
export function setComfyRunning(ids: string[], on: boolean, scope: string): void {
  const count = (counts: Map<string, number>, key: string): boolean => {
    const next = (counts.get(key) || 0) + (on ? 1 : -1);
    if (next > 0) counts.set(key, next);
    else if (!counts.delete(key)) return false;
    return true;
  };
  let changed = false;
  for (const id of ids) {
    if (count(running, id)) changed = true;
    count(shared, sharedKey(scope, id));
  }
  if (!changed) return;
  emit();
  shareAcrossWindows();
  announce?.();
}

export function isComfyRunning(id: string, scope: string, scene?: Pick<Scene, "comfyRuns" | "comfyCardRuns">): boolean {
  const runtime = scene && comfyCardRuntime(scene, id);
  if (runtime) return runtime.status === "running";
  const key = sharedKey(scope, id);
  return (running.get(id) || 0) > 0 || [...remote.values()].some((ids) => ids.has(key));
}

/** settleComfyRunning 의 keep — 그 씬에서 지금 도는 카드인가. */
export const comfyRunningIn = (account: string, sceneId: string) => {
  const scope = comfyRunningScope(account, sceneId);
  return (id: string): boolean => isComfyRunning(id, scope);
};

export function subscribeComfyRunning(cb: () => void): () => void {
  shareAcrossWindows(); // 보는 창도 다른 창의 실행을 받는다 — 처음 등록할 때 다른 창들에 묻는다
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getComfyRunningVersion(): number {
  return version;
}
