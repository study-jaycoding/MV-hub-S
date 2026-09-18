// 소요시간 표기 — 초를 버리지 않는다(Jay 2026-09-18 "초까지 보이게").
// PM 창의 대시보드·사용량·칸반·캘린더·표가 같은 함수를 쓰므로 여기 한 곳만 지키면 된다.
import { expect, it } from "vitest";
import { fmtElapsed } from "../src/lib/format";

it("한 시간이 넘어도 초까지 보인다 — 예전 대시보드는 3661초를 1h1m 으로 잘랐다", () => {
  expect(fmtElapsed(3661)).toBe("1h1m1s");
  expect(fmtElapsed(7325)).toBe("2h2m5s");
});

it("0인 단위는 생략한다", () => {
  expect(fmtElapsed(3600)).toBe("1h");
  expect(fmtElapsed(3605)).toBe("1h5s");
  expect(fmtElapsed(59)).toBe("59s");
  expect(fmtElapsed(90000)).toBe("1d1h");
  expect(fmtElapsed(90061)).toBe("1d1h1m1s");
});

it("값이 없으면 —, 1초 미만은 0s", () => {
  expect(fmtElapsed(0)).toBe("—");
  expect(fmtElapsed(undefined)).toBe("—");
  expect(fmtElapsed(null)).toBe("—");
  expect(fmtElapsed(-5)).toBe("—");
  expect(fmtElapsed(0.4)).toBe("0s");
});
