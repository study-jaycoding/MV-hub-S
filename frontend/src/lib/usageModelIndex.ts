/** 사용량 대시보드의 모델 행을 키(UID/PID)별로 1회 인덱싱한다.
 *
 * 종전에는 표의 셀마다 전체 배열을 filter() 해서 행 수 × 모델 수만큼 곱으로
 * 재계산됐다. 키 비교는 filter 의 === 의미 그대로(null·빈 문자열·undefined 를
 * 서로 병합하지 않음), 각 버킷은 원본 배열 순서를 보존한다.
 */
export function groupModelRows<T>(
  rows: readonly T[] | undefined,
  keyOf: (row: T) => string | null,
): Map<string | null, T[]> {
  const index = new Map<string | null, T[]>();
  for (const row of rows || []) {
    const key = keyOf(row);
    const bucket = index.get(key);
    if (bucket) bucket.push(row);
    else index.set(key, [row]);
  }
  return index;
}
