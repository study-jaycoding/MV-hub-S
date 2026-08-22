import { describe, expect, it } from "vitest";
import { dayInfoFromEpochSeconds, dayInfoFromUtcString } from "../src/lib/dateGroups";

// 라벨 포맷터를 모듈 1회 생성(Intl.DateTimeFormat 재사용)으로 바꿔도
// 출력 문자열이 toLocaleDateString("en-US", …)과 완전히 같아야 한다.
const label = (d: Date) =>
  d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

describe("date groups", () => {
  it("labels UTC strings exactly like toLocaleDateString", () => {
    const samples = [
      "2026-01-01 00:00:00",
      "2026-02-28 23:59:59",
      "2026-07-04 12:30:00",
      "2026-08-21 09:05:00",
      "2026-12-31 18:00:00",
    ];
    for (const iso of samples) {
      const d = new Date(iso.replace(" ", "T") + "Z");
      expect(dayInfoFromUtcString(iso)).toEqual({
        key: `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`,
        label: label(d),
      });
    }
  });

  it("labels epoch seconds exactly like toLocaleDateString", () => {
    for (let day = 0; day < 40; day++) {
      const mtime = Math.floor(Date.UTC(2026, 0, 1, 6) / 1000) + day * 86_400 * 9;
      const d = new Date(mtime * 1000);
      expect(dayInfoFromEpochSeconds(mtime).label).toBe(label(d));
    }
  });

  it("keeps the fallbacks for missing or invalid dates", () => {
    expect(dayInfoFromEpochSeconds(null)).toEqual({ key: "none", label: "날짜 없음" });
    expect(dayInfoFromEpochSeconds(0)).toEqual({ key: "none", label: "날짜 없음" });
    expect(dayInfoFromUtcString("nope")).toEqual({ key: "nope", label: "nope" });
  });
});
