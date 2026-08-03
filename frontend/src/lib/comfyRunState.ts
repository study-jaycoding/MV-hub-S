// comfy 배치 실행의 '판정' 상태기계 — React 무의존 순수 모듈 (R1 분리).
//
// 왜 분리했나: SceneBoard 실행부에서 버그 3건(생성중 표시 유지·undo 유실·생성중 박제)이 모두
// "언제 노드를 done/failed 로 확정하고, 웨이브 해제를 정확히 1회 하는가"의 상태 전이에서 났다.
// 판정 로직만 여기로 빼 테스트로 고정하고, 부수효과(카드 갱신·persist·markComfyRunning·abort 체크)는
// SceneBoard 호출부에 남긴다(전면 hook 추출은 과설계로 보류한 P4 결정 유지).
//
// 소유권 규칙(코덱스 교차검토 반영): 정산(progress)·해제(released)는 이 tracker 가 단독 소유한다.
// SceneBoard 는 FinalizeResult 를 카드에 '투영'만 하고, 저장 여부는 copy overlay 에서 유도한다 —
// 같은 사실을 두 곳이 판단하지 않게.

// 한 copy 의 종료 형태. skipped = 씬 전환(abort)·상류 실패로 실행 자체를 건너뜀 —
// 실패 수(failCount)에는 포함하되 firstError(사용자 표시 메시지)는 실제 failed 만 남긴다.
export type StepOutcome<TOut> =
  | { kind: "success"; outputs: TOut; elapsed: number }
  | { kind: "failed"; error: string }
  | { kind: "skipped" };

// 노드의 '마지막 copy 정산' 시 정확히 1회 반환되는 확정 결과.
// rep = copyIndex 가 가장 큰 성공 복사본(대표) — runComfy 단독 실행·저장 genId(마지막 저장)와 일치.
export type FinalizeResult<TOut> = {
  id: string;
  rep: { copyIndex: number; outputs: TOut; elapsed: number } | null; // 전 실패면 null
  failCount: number;
  firstError?: string;
};

// 동시 실행 상한 식 — 단일 comfy batch 4, comfy 4개 batch 1 은 그대로 4 병렬,
// 큰 보드(노드 많음)만 8개씩 끊어 제출(429·업로드 병목 방지).
export function computeMaxParallel(batch: number, nodeCount: number): number {
  return Math.max(batch, Math.min(8, batch * Math.max(1, nodeCount)));
}

// 동시 실행 제한기(세마포어) — FIFO 대기열. fn 의 reject 는 물론 '동기 throw' 에서도
// 슬롯을 반드시 반환한다(안 하면 대기열이 영원히 안 빠지는 슬롯 누수).
export function createLimiter(maxParallel: number): {
  run: <T>(fn: () => Promise<T>) => Promise<T>;
} {
  const max = Math.max(1, Math.floor(maxParallel) || 1); // 비정상 값은 1 로 안전화
  let active = 0;
  const queue: (() => void)[] = [];
  const pump = () => {
    active--;
    queue.shift()?.();
  };
  const run = <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = () => {
        active++;
        let p: Promise<T>;
        try {
          p = fn();
        } catch (e) {
          pump(); // 동기 throw — 슬롯 반환 후 거부
          reject(e);
          return;
        }
        p.then(resolve, reject).finally(pump);
      };
      if (active < max) start();
      else queue.push(start);
    });
  return { run };
}

// 노드별 copy 완료 집계기 — comfyIds 각 노드가 batch 벌 실행될 때,
// '그 노드의 모든 copy 가 정산된 순간' 정확히 1회 FinalizeResult 를 돌려준다.
export function createBatchTracker<TOut>(
  comfyIds: string[],
  batch: number,
): {
  settle: (id: string, copyIndex: number, outcome: StepOutcome<TOut>) => FinalizeResult<TOut> | null;
  releaseOnce: (id: string) => boolean;
} {
  type Success = { copyIndex: number; outputs: TOut; elapsed: number };
  type Node = {
    settledCopies: Set<number>; // copyIndex 단위 기록 — 같은 copy 의 중복 정산이 조기 finalize 를 못 일으키게
    successes: Success[];
    failCount: number;
    firstError?: string;
    finalized: boolean;
  };
  const b = Math.max(1, Math.floor(batch) || 1);
  const nodes = new Map<string, Node>(
    comfyIds.map((id) => [id, { settledCopies: new Set(), successes: [], failCount: 0, finalized: false }]),
  );
  const released = new Set<string>();

  const settle = (id: string, copyIndex: number, outcome: StepOutcome<TOut>): FinalizeResult<TOut> | null => {
    const n = nodes.get(id);
    if (!n || n.finalized) return null; // 모르는 id·확정 후 늦은 정산은 무시
    if (!Number.isInteger(copyIndex) || copyIndex < 0 || copyIndex >= b) return null; // 범위 밖 무시
    if (n.settledCopies.has(copyIndex)) return null; // 같은 copy 중복 정산 무시
    n.settledCopies.add(copyIndex);
    if (outcome.kind === "success") {
      n.successes.push({ copyIndex, outputs: outcome.outputs, elapsed: outcome.elapsed });
    } else {
      n.failCount++;
      if (outcome.kind === "failed" && !n.firstError) n.firstError = outcome.error;
    }
    if (n.settledCopies.size < b) return null; // 아직 이 노드의 다른 copy 진행 중
    n.finalized = true;
    const sorted = [...n.successes].sort((a, z) => a.copyIndex - z.copyIndex);
    return {
      id,
      rep: sorted[sorted.length - 1] ?? null,
      failCount: n.failCount,
      firstError: n.firstError,
    };
  };

  // 노드당 정확히 1회만 true — 웨이브(markComfyRunning) 해제의 count 균형을 tracker 가 보증.
  const releaseOnce = (id: string): boolean => {
    if (released.has(id)) return false;
    released.add(id);
    return true;
  };

  return { settle, releaseOnce };
}
