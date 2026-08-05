// API JSON 응답을 React state에 반영할 때 내용이 같으면 기존 참조를 유지한다.
// 새 배열/객체를 그대로 setState 하면 실제 변경이 없어도 상위 화면과 SceneBoard가 다시 렌더된다.
// 이 비교기는 JSON에서 올 수 있는 원시값·배열·일반 객체만 대상으로 한다(순환 객체는 대상 아님).
export function isStructurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }

  const leftIsArray = Array.isArray(left);
  if (leftIsArray !== Array.isArray(right)) return false;
  if (leftIsArray) {
    const leftItems = left as unknown[];
    const rightItems = right as unknown[];
    if (leftItems.length !== rightItems.length) return false;
    return leftItems.every((item, index) => isStructurallyEqual(item, rightItems[index]));
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(rightRecord, key)
      && isStructurallyEqual(leftRecord[key], rightRecord[key]),
  );
}

export function reconcileValueState<T>(previous: T, incoming: T): T {
  return isStructurallyEqual(previous, incoming) ? previous : incoming;
}

// 전체 배열이 같으면 배열 참조까지 유지하고, 일부만 달라졌으면 같은 항목의 참조는 재사용한다.
export function reconcileArrayState<T>(previous: T[], incoming: T[]): T[] {
  if (previous.length !== incoming.length) return incoming;
  let changed = false;
  const next = incoming.map((item, index) => {
    if (isStructurallyEqual(previous[index], item)) return previous[index];
    changed = true;
    return item;
  });
  return changed ? next : previous;
}

// 키 삭제·추가를 포함한 완성본끼리 비교한다. 일부 값만 바뀌면 나머지 값 참조는 유지한다.
export function reconcileRecordState<T>(
  previous: Record<string, T>,
  incoming: Record<string, T>,
): Record<string, T> {
  const previousKeys = Object.keys(previous);
  const incomingKeys = Object.keys(incoming);
  let changed = previousKeys.length !== incomingKeys.length;
  const next: Record<string, T> = {};
  for (const key of incomingKeys) {
    if (
      Object.prototype.hasOwnProperty.call(previous, key)
      && isStructurallyEqual(previous[key], incoming[key])
    ) {
      next[key] = previous[key];
    } else {
      next[key] = incoming[key];
      changed = true;
    }
  }
  return changed ? next : previous;
}
