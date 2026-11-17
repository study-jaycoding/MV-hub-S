// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { formatBalanceAbsolute, formatBalanceTime } from "../src/lib/format";
import { setLang, t } from "../src/lib/i18n";

afterEach(() => { setLang("ko"); vi.unstubAllEnvs(); });
const at = Date.parse("2026-11-17T08:41:00Z");

it("UTC 브라우저에서도 UTC 문자열을 한국 확인 시각으로 표시한다", () => {
  vi.stubEnv("TZ", "UTC");
  expect(formatBalanceAbsolute("2026-11-17 08:41:00")).toBe("11/17 17:41");
  expect(formatBalanceTime(at, at + 180000)).toBe("11/17 17:41 확인 (3분 전)");
  expect(formatBalanceTime(at, at + 7200000)).toContain("2시간 전");
  expect(formatBalanceTime(at, at + 172800000)).toContain("2일 전");
});

it("확인 시각이 없는 옛 값은 받은 시각과 구별하고 이상 시각은 정상 확인으로 표시하지 않는다", () => {
  expect(formatBalanceTime({ basis: "legacy_snapshot", received_at_ms: at, time_quality: "legacy" }, at + 180000))
    .toBe("확인 시각 미상 · 3분 전 받음");
  expect(formatBalanceTime({ basis: "unavailable", time_quality: "unavailable" })).toBe("잔액 확인 없음");
  expect(formatBalanceTime({ observed_at_ms: at, time_quality: "future" }, at)).toBe("확인 시각 불확실");
  expect(formatBalanceTime({ basis:"conflict",time_quality:"conflict" },at)).toBe("같은 시각 값이 다름");
  expect(formatBalanceTime("invalid")).toBe("잔액 확인 없음");
  expect(formatBalanceAbsolute(null)).toBe("—");
});

it("영어 선택도 같은 확인 시각과 상대 시간을 쓴다", () => {
  setLang("en");
  expect(t("잔액")).toBe("Balance");
  expect(t("같은 시각 값이 다름")).toBe("Different amounts at the same time");
  expect(formatBalanceTime(at, at + 180000)).toBe("Confirmed 11/17 17:41 (3m ago)");
});
