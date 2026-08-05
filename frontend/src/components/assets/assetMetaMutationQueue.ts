export interface AssetMetaMutationQueue {
  enqueue(operation: () => Promise<unknown>): Promise<void>;
}

/**
 * 같은 프로젝트의 낙관적 메타 저장을 입력 순서대로 실행한다.
 * 중간 실패는 뒤에 이미 예약된 변경을 먼저 끝낸 뒤 한 번만 서버 상태와 재동기화한다.
 */
export function createAssetMetaMutationQueue(
  reconcileAfterFailure: () => void | Promise<void>,
): AssetMetaMutationQueue {
  let tail = Promise.resolve();
  let issued = 0;
  let failed = false;

  return {
    enqueue(operation) {
      const ticket = ++issued;
      tail = tail
        .then(operation)
        .catch(() => {
          failed = true;
        })
        .then(async () => {
          if (ticket !== issued || !failed) return;
          failed = false;
          try {
            await reconcileAfterFailure();
          } catch {
            // 재조회 실패는 reloadMeta 자체의 기존 오류 정책에 맡기고 다음 저장은 계속 허용한다.
          }
        });
      return tail;
    },
  };
}
