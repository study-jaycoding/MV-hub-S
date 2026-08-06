// 배치 API 공용 분할 헬퍼 — 서버 배치 상한(500)을 넘는 선택을 상한 이하 조각으로 나눠
// 순차 전송한다. 분할까지만 공통화한다: 부분 실패 집계·구서버 폴백 규칙은 경로마다 달라
// 각 호출부가 소유한다(합의 설계 — 일괄 추상화 금지).

export const BATCH_LIMIT = 500;

export function chunked<T>(items: T[], size: number = BATCH_LIMIT): T[][] {
  if (items.length <= size) return items.length ? [items] : [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
