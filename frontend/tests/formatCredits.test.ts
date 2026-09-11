import { describe, expect, it } from "vitest";

import { formatCredits, roundCredits } from "../src/lib/formatCredits";

// 값은 전부 2026-09-11 실측이다 — 힉스필드 크레딧은 소수다.
// 종전 화면은 `Math.round()` 로 찍어 0.12 를 0(공짜로 보임), 1.5 를 2(33% 비싸 보임)로 표시했다.
describe("formatCredits", () => {
  it("실측 소수 금액을 그대로 보여 준다", () => {
    expect(formatCredits(1.5)).toBe("1.5"); // Nano Banana 2 — round 면 2
    expect(formatCredits(0.12)).toBe("0.12"); // Higgsfield Soul V2 — round 면 0
    expect(formatCredits(32.5)).toBe("32.5"); // Seedance 2.5 기본 — round 면 32
    expect(formatCredits(0.31)).toBe("0.31"); // Vision Video
  });

  it("정수는 정수로 보여 준다(소수점을 억지로 붙이지 않는다)", () => {
    expect(formatCredits(52)).toBe("52");
    expect(formatCredits(0)).toBe("0"); // 0 은 '무료'라는 정상 값이다
  });

  it("모르는 값은 자리표시자로", () => {
    expect(formatCredits(null)).toBe("—");
    expect(formatCredits(undefined)).toBe("—");
    expect(formatCredits(Number.NaN)).toBe("—");
    expect(formatCredits(null, "∞")).toBe("∞");
  });

  it("셋째 자리는 접는다 — 잔액의 float 잡음이 화면에 새지 않게", () => {
    // 실측 잔액이 5866.47998046875 로 온다(float32 정밀도).
    expect(formatCredits(5866.47998046875)).toBe("5,866.48");
  });
});

describe("roundCredits", () => {
  it("곱셈 잡음을 둘째 자리에서 정리한다", () => {
    // Vision Video(0.31) 3장 — 부동소수로는 0.9299999999999999 가 나온다.
    expect(0.31 * 3).not.toBe(0.93);
    expect(roundCredits(0.31 * 3)).toBe(0.93);
    expect(formatCredits(roundCredits(0.31 * 3))).toBe("0.93");
    expect(roundCredits(1.5 * 4)).toBe(6); // 잡음 없는 곱은 그대로
  });
});
