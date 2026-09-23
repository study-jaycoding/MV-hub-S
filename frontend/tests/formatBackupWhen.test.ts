/** `fmtBackupWhen` 은 **기존 네이티브 표기를 그대로 보존**해야 한다.
 *
 * 왜 시험이 필요한가: 7곳에 흩어져 있던 `new Date(x).toLocaleString()` 을 헬퍼 하나로 모았다.
 * 모으면서 표기가 한 글자라도 바뀌면 백업 목록·복원 확인문의 시각이 달라진다 — 어느 백업인지
 * 고르는 화면이라 연·월·일·시·분·초가 다 보여야 한다.
 *
 * ★`fmtWhen` 으로 합치면 안 된다는 것도 여기서 못 박는다(월/일·시:분만 내고 UTC 보정을 한다).
 */
import { describe, expect, it } from "vitest";
import { fmtBackupWhen, fmtWhen } from "../src/lib/format";

const ISO = "2026-09-23T14:37:51Z";
const SECONDS = Math.floor(Date.parse(ISO) / 1000);

describe("fmtBackupWhen", () => {
  it("ISO 문자열은 옛 코드와 같은 글자를 낸다", () => {
    expect(fmtBackupWhen(ISO)).toBe(new Date(ISO).toLocaleString());
  });

  it("created_at 이 없으면 mtime(초)을 쓰고, 그것도 옛 코드와 같다", () => {
    expect(fmtBackupWhen(null, SECONDS)).toBe(new Date(SECONDS * 1000).toLocaleString());
    expect(fmtBackupWhen(undefined, SECONDS)).toBe(new Date(SECONDS * 1000).toLocaleString());
  });

  it("created_at 이 있으면 mtime 을 무시한다 (옛 삼항과 같은 우선순위)", () => {
    expect(fmtBackupWhen(ISO, 0)).toBe(new Date(ISO).toLocaleString());
  });

  it("★fmtWhen 으로는 대신할 수 없다 — 연도와 초가 사라진다", () => {
    const backup = fmtBackupWhen(ISO);
    const short = fmtWhen(ISO);
    expect(backup).not.toBe(short);
    expect(short.includes("2026")).toBe(false);
  });
});
