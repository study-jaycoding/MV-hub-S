import { describe, expect, it } from "vitest";
import {
  fillUsageTrendBuckets,
  formatUsageTrendBucket,
  getUsagePeriodRange,
  showUsageTrendLabel,
} from "../src/lib/usagePeriod";

describe("usage period", () => {
  const friday = new Date(2026, 7, 7, 12);

  it("calculates day, week, month, and hourly ranges from the selected date", () => {
    expect(getUsagePeriodRange("hour", friday)).toMatchObject({
      bucket: "minute", dateFrom: "2026-08-07", dateTo: "2026-08-07",
      timeFrom: "2026-08-07T12:00:00", timeTo: "2026-08-07T12:59:59",
    });
    expect(getUsagePeriodRange("day", friday)).toMatchObject({
      bucket: "hour", dateFrom: "2026-08-07", dateTo: "2026-08-07",
    });
    expect(getUsagePeriodRange("week", friday)).toMatchObject({
      bucket: "day", dateFrom: "2026-08-03", dateTo: "2026-08-09",
    });
    expect(getUsagePeriodRange("month", friday)).toMatchObject({
      bucket: "day", dateFrom: "2026-08-01", dateTo: "2026-08-31",
    });
  });

  it("fills missing days and hours with zero-valued chart buckets", () => {
    const week = getUsagePeriodRange("week", friday);
    const weekRows = fillUsageTrendBuckets([
      { bucket: "2026-08-07", count: 2, credits: 4 },
    ], week);
    expect(weekRows).toHaveLength(7);
    expect(weekRows[4]).toMatchObject({ bucket: "2026-08-07", count: 2, credits: 4 });
    expect(weekRows[0]).toMatchObject({ bucket: "2026-08-03", count: 0, credits: 0 });

    const hourly = getUsagePeriodRange("hour", friday);
    expect(fillUsageTrendBuckets([
      { bucket: "2026-08-07T12:13", count: 1, credits: 3 },
    ], hourly)).toHaveLength(60);

    const daily = getUsagePeriodRange("day", friday);
    expect(fillUsageTrendBuckets([
      { bucket: "2026-08-07T13:00", count: 1, credits: 3 },
    ], daily)).toHaveLength(24);
  });

  it("formats daily and hourly labels", () => {
    expect(formatUsageTrendBucket("2026-08-07")).toBe("08-07");
    expect(formatUsageTrendBucket("2026-08-07T13:00")).toBe("13:00");
    expect(formatUsageTrendBucket("2026-08-07", "week")).toBe("8.7");
    expect(formatUsageTrendBucket("2026-08-07", "month")).toBe("7");
  });

  it("keeps dense hour, day, and month axes readable", () => {
    expect(Array.from({ length: 60 }, (_, index) => index).filter((index) => (
      showUsageTrendLabel("hour", index, 60)
    ))).toEqual([0, 7, 15, 22, 29, 36, 44, 51, 58]);
    expect(Array.from({ length: 24 }, (_, index) => index).filter((index) => (
      showUsageTrendLabel("day", index, 24)
    ))).toEqual([0, 3, 6, 9, 12, 15, 18, 21]);
    expect(Array.from({ length: 31 }, (_, index) => index).filter((index) => (
      showUsageTrendLabel("month", index, 31)
    ))).toEqual([0, 4, 8, 12, 16, 20, 24, 28]);
  });
});
