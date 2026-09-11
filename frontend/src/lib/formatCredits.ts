/** 크레딧 표시 — 소수를 버리지 않되 부동소수 잡음도 안 보인다.
 *
 * ★힉스필드 크레딧은 소수다(2026-09-11 실측): `Nano Banana 2` −1.5, `Higgsfield Soul V2` −0.12,
 *  `Seedance 2.5` 기본 −32.5, 견적 `seedance_2_0` 22.5. 종전 화면은 `Math.round()` 로 찍어
 *  0.12 를 **0**(공짜로 보임), 1.5 를 **2**(33% 비싸 보임)로 표시했다.
 *  둘째 자리까지 남기면 정확하면서 `0.12 * 3 = 0.36000000000000004` 같은 잡음도 안 나온다.
 */
export function formatCredits(
  value: number | null | undefined,
  fallback = "—",
): string {
  if (value == null || !Number.isFinite(value)) return fallback;
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** 장바구니 합계처럼 곱셈·덧셈을 한 뒤 표시할 때 — 잡음을 둘째 자리에서 정리한다. */
export function roundCredits(value: number): number {
  return Math.round(value * 100) / 100;
}
