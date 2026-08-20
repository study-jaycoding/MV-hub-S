export interface MutationQueue {
  enqueue(operation: () => Promise<unknown>): Promise<void>;
}

export interface LatestMutationQueue {
  enqueue(operation: () => Promise<unknown>): void;
  whenIdle(): Promise<void>;
}

export interface KeyedMutationQueue<K> {
  enqueue(key: K, operation: () => Promise<unknown>): Promise<void>;
  whenIdle(): Promise<void>;
}

/**
 * 낙관적 저장을 입력 순서대로 실행한다.
 * 중간 실패는 뒤에 이미 예약된 변경을 먼저 끝낸 뒤 한 번만 서버 상태와 재동기화한다.
 */
export function createMutationQueue(
  reconcileAfterFailure: (errors: unknown[]) => void | Promise<void>,
  reconcileAfterSuccess?: () => void | Promise<void>,
): MutationQueue {
  let tail = Promise.resolve();
  let issued = 0;
  let errors: unknown[] = [];

  return {
    enqueue(operation) {
      const ticket = ++issued;
      tail = tail
        .then(operation)
        .catch((error: unknown) => {
          errors.push(error);
        })
        .then(async () => {
          if (ticket !== issued) return;
          if (!errors.length) {
            if (reconcileAfterSuccess) {
              try {
                await reconcileAfterSuccess();
              } catch {
                // 저장은 성공했다. 후속 조회 실패는 다음 sync/focus에서 다시 맞추고 큐는 계속 사용한다.
              }
            }
            return;
          }
          const pendingErrors = errors;
          errors = [];
          try {
            await reconcileAfterFailure(pendingErrors);
          } catch {
            // 재조회 실패는 호출부의 기존 오류 정책에 맡기고 다음 저장은 계속 허용한다.
          }
        });
      return tail;
    },
  };
}

/**
 * 같은 key의 저장은 입력 순서대로 실행하고, 다른 key는 서로 막지 않는다.
 * 한 key의 대기 작업이 끝나면 오류를 한 번만 복구하고 내부 항목을 제거한다.
 */
export function createKeyedMutationQueue<K>(
  reconcileAfterFailure: (key: K, errors: unknown[]) => void | Promise<void>,
  reconcileAfterSuccess?: (key: K) => void | Promise<void>,
): KeyedMutationQueue<K> {
  type Entry = {
    tail: Promise<void>;
    issued: number;
    errors: unknown[];
  };

  const entries = new Map<K, Entry>();
  let idleWaiters: Array<() => void> = [];

  const finishIdle = () => {
    if (entries.size) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  return {
    enqueue(key, operation) {
      let entry = entries.get(key);
      if (!entry) {
        entry = { tail: Promise.resolve(), issued: 0, errors: [] };
        entries.set(key, entry);
      }

      const current = entry;
      const ticket = ++current.issued;
      const run = current.tail
        .then(operation)
        .catch((error: unknown) => {
          current.errors.push(error);
        })
        .then(async () => {
          if (ticket !== current.issued) return;

          const errors = current.errors;
          current.errors = [];
          if (errors.length) {
            try {
              await reconcileAfterFailure(key, errors);
            } catch {
              // 복구 조회가 실패해도 큐를 영구 정지시키지 않는다.
            }
          } else if (reconcileAfterSuccess) {
            try {
              await reconcileAfterSuccess(key);
            } catch {
              // 저장은 성공했다. 후속 조회 실패는 다음 동기화에서 다시 맞춘다.
            }
          }

          // 복구 중 새 작업이 들어왔다면 같은 entry를 유지하고 그 작업이 마지막에 정리한다.
          if (entries.get(key) === current && ticket === current.issued) {
            entries.delete(key);
            finishIdle();
          }
        });
      current.tail = run;
      return run;
    },
    whenIdle() {
      if (!entries.size) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
  };
}

/**
 * 실행 중인 저장은 유지하되 대기 중인 작업은 가장 최신 하나로 교체한다.
 * 전체 상태를 다시 보내는 드래그 순서 저장처럼 중간 스냅샷에 의미가 없는 경로에 사용한다.
 */
export function createLatestMutationQueue(
  reconcileFinalFailure: (error: unknown) => void | Promise<void>,
): LatestMutationQueue {
  let running = false;
  let pending: (() => Promise<unknown>) | null = null;
  let idleWaiters: Array<() => void> = [];

  const finishIdle = () => {
    running = false;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const drain = async () => {
    let finalError: unknown;
    let hasFinalError = false;
    while (true) {
      while (pending) {
        const operation = pending;
        pending = null;
        try {
          await operation();
          hasFinalError = false;
        } catch (error) {
          finalError = error;
          hasFinalError = true;
        }
        // 실행 중 더 최신 작업이 들어왔으면 방금 오류도 최신 전체 상태의 성공 여부로 대체한다.
      }
      if (hasFinalError) {
        try {
          await reconcileFinalFailure(finalError);
        } catch {
          // 실패 복구 자체가 실패해도 큐는 다음 입력을 받을 수 있어야 한다.
        }
        hasFinalError = false;
        if (pending) continue; // 복구 중 들어온 최신 작업도 이어서 저장한다.
      }
      finishIdle();
      return;
    }
  };

  return {
    enqueue(operation) {
      pending = operation;
      if (running) return;
      running = true;
      void drain();
    },
    whenIdle() {
      if (!running && !pending) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
  };
}
