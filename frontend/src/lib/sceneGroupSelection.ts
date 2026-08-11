/** 그룹 클릭 결과. 일반 클릭은 단일 선택, Ctrl/Shift 클릭은 현재 선택에서 토글한다. */
export function sceneGroupClickSelection(
  current: ReadonlySet<string>,
  groupId: string,
  additive: boolean,
): Set<string> {
  if (!additive) return new Set([groupId]);
  const next = new Set(current);
  if (next.has(groupId)) next.delete(groupId);
  else next.add(groupId);
  return next;
}

/**
 * 그룹을 드래그할 때 함께 움직일 대상.
 * 이미 선택된 그룹을 잡으면 현재 복수 선택 전체를, 새 그룹을 잡으면 그 그룹만 움직인다.
 * Ctrl/Shift로 새 그룹을 바로 잡은 경우에는 기존 선택에 새 그룹을 더해 함께 움직인다.
 */
export function sceneGroupDragTargetIds(
  current: ReadonlySet<string>,
  groupId: string,
  additive: boolean,
): string[] {
  if (current.has(groupId)) return [...current];
  return additive ? [...current, groupId] : [groupId];
}

/** 선택된 그룹의 버튼을 누르면 전체 선택에, 선택 밖 그룹의 버튼은 그 그룹 하나에만 적용한다. */
export function sceneGroupControlTargetIds(
  current: ReadonlySet<string>,
  groupId: string,
): string[] {
  return current.has(groupId) ? [...current] : [groupId];
}
