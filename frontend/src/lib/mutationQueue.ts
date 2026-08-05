export interface MutationQueue {
  enqueue(operation: () => Promise<unknown>): Promise<void>;
}

/**
 * 낙관적 저장을 입력 순서대로 실행한다.
 * 중간 실패는 뒤에 이미 예약된 변경을 먼저 끝낸 뒤 한 번만 서버 상태와 재동기화한다.
 */
export function createMutationQueue(
  reconcileAfterFailure: (errors: unknown[]) => void | Promise<void>,
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
          if (ticket !== issued || !errors.length) return;
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
