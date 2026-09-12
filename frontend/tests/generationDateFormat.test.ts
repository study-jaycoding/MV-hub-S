import { afterEach, describe, expect, it, vi } from "vitest";
import { formatGenerationDate, formatGenerationDateTime } from "../src/lib/generationDisplay";

// 카드의 생성일 표시 — **포맷터를 재사용**하되 보이는 글자는 그대로.
//
// ★왜(2026-09-12 실측): `toLocaleDateString(locale, options)` 는 호출마다 포맷터를 새로 만든다.
//  20,000회에 **1201.7ms**, 재사용은 **34.9ms** — 34.4배다. 카드 200장이면 12.02ms -> 0.35ms.
//  같은 고침을 `dateGroups.ts` 에선 이미 했다.
//
// ★표시 동일성은 **손으로 적은 기대값이 아니라 원래 호출을 오라클로** 대조한다.
//  기대값을 베끼면 오라클이 아니라 또 하나의 구현이 된다.

const OPTIONS: Intl.DateTimeFormatOptions = { year: "numeric", month: "long", day: "numeric" };

/** 바꾸기 전 코드가 하던 그대로 — 이 시험의 오라클. */
function oracle(value: string): string {
  let s = value.replace(" ", "T");
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += "Z";
  const d = new Date(s);
  if (isNaN(d.getTime())) return value.slice(0, 10);
  return d.toLocaleDateString("en-US", OPTIONS);
}

afterEach(() => vi.restoreAllMocks());

describe("생성일 표시", () => {
  it("★호출마다 포맷터를 만드는 API 를 쓰지 않는다", () => {
    // ★`Intl.DateTimeFormat` 생성자를 감시하면 **헛돈다** — `toLocaleDateString` 은 V8 내부에서
    //  포맷터를 만들고 그 생성자를 거치지 않는다(되돌려 확인에서 놓쳐서 알아냈다).
    //  그래서 감시 대상을 `Date.prototype.toLocaleDateString` 자체로 바꾼다.
    const perCall = vi.spyOn(Date.prototype, "toLocaleDateString");
    for (let i = 0; i < 200; i++) formatGenerationDate(`2026-09-${(i % 28) + 1} 03:04:05`);
    expect(perCall).not.toHaveBeenCalled();
  });

  it("보이는 글자가 전과 같다 — 400개 전수 대조", () => {
    const mismatches: string[] = [];
    for (let i = 0; i < 400; i++) {
      const y = 2020 + (i % 8);
      const m = String((i % 12) + 1).padStart(2, "0");
      const d = String((i % 28) + 1).padStart(2, "0");
      const value = `${y}-${m}-${d} ${String(i % 24).padStart(2, "0")}:00:00`;
      if (formatGenerationDate(value) !== oracle(value)) mismatches.push(value);
    }
    expect(mismatches).toEqual([]);
  });

  it("시간대 표기가 없으면 UTC 로 읽는다 — 로컬로 오인하지 않는다", () => {
    // 같은 순간을 두 표기로 주면 같은 날짜가 나와야 한다.
    expect(formatGenerationDate("2026-09-12 03:04:05")).toBe(
      formatGenerationDate("2026-09-12T03:04:05Z"),
    );
    // 오프셋이 붙어 있으면 그 오프셋을 존중한다(임의로 Z 를 덧붙이지 않는다).
    expect(formatGenerationDate("2026-09-12T03:04:05+09:00")).toBe(
      formatGenerationDate("2026-09-11T18:04:05Z"),
    );
  });

  it("날짜로 못 읽는 입력은 앞 10글자를 그대로 준다", () => {
    for (const bad of ["", "쓰레기", "not-a-date-at-all", "0000-00-00 00:00:00"]) {
      expect(formatGenerationDate(bad)).toBe(oracle(bad));
    }
    expect(formatGenerationDate("망가진 값입니다 정말로")).toBe("망가진 값입니다 정");  // 앞 10글자
  });

  it("시각까지 보이는 표시는 건드리지 않았다 — 시각이 남아 있다", () => {
    // ★옵션 없는 `new Intl.DateTimeFormat()` 으로 바꾸면 **날짜만** 나온다(실측). 그 회귀를 막는다.
    const shown = formatGenerationDateTime("2026-09-12 03:04:05");
    expect(shown).toBe(new Date("2026-09-12T03:04:05Z").toLocaleString());
    expect(shown).not.toBe(new Intl.DateTimeFormat().format(new Date("2026-09-12T03:04:05Z")));
  });

  it("빈 값과 읽을 수 없는 값은 그대로 돌려준다", () => {
    expect(formatGenerationDateTime("")).toBe("");
    expect(formatGenerationDateTime("쓰레기")).toBe("쓰레기");
  });
});
