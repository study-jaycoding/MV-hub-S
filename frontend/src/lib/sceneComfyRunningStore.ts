// Comfy 노드 '생성중' 표시를 SceneBoard 언마운트(내작업↔구성 탭 전환)에도 유지하는 모듈 store.
//  왜 필요한가: 배치 실행(runPlanComfyCopies)은 실행상태를 persist 하지 않고 메모리(markComfyRunning)로만
//  표시하고, 단독 실행도 async 완료가 옛 SceneBoard 인스턴스에서 난다. 인스턴스 안 state 는 탭 전환으로
//  언마운트되면 사라져, 재마운트 시 '생성중'이 안 보이고 이전 결과가 보였다(사용자 보고 #2).
//  → 인스턴스 밖 모듈 store 에 기록하면 탭을 오가도 실행중 표시가 살아있다. (glow 의 sceneRecentDoneStore 와 동형)
const running = new Map<string, number>(); // cardId → 중첩 실행 카운트(같은 카드 여러 번 on 대비)
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version++;
  for (const l of listeners) l();
}

// markComfyRunning 이 호출 — on=true 진입 시 +1, 완료/실패 finally 에서 -1. 0 이하면 제거.
export function setComfyRunning(ids: string[], on: boolean): void {
  let changed = false;
  for (const id of ids) {
    const cur = running.get(id) || 0;
    const next = cur + (on ? 1 : -1);
    if (next > 0) {
      if (cur !== next) changed = true;
      running.set(id, next);
    } else if (running.has(id)) {
      running.delete(id);
      changed = true;
    }
  }
  if (changed) emit();
}

export function isComfyRunning(id: string): boolean {
  return (running.get(id) || 0) > 0;
}

export function subscribeComfyRunning(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getComfyRunningVersion(): number {
  return version;
}
