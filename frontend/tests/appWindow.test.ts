// 앱 창 감지(?appwin=1 → sessionStorage 승격) — 닫기 확인창 게이트의 계약.
import { describe, expect, it } from "vitest";
import { isAppWindow } from "../src/lib/appWindow";

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

describe("isAppWindow", () => {
  it("일반 탭(표식 없음)은 false", () => {
    expect(isAppWindow("", fakeStorage())).toBe(false);
  });

  it("?appwin=1 이면 true 이고 storage 로 승격된다", () => {
    const storage = fakeStorage();
    expect(isAppWindow("?appwin=1", storage)).toBe(true);
    // SPA 내비게이션이 쿼리를 지워도 승격된 값으로 유지
    expect(isAppWindow("", storage)).toBe(true);
  });

  it("storage 가 없으면(차단 환경) 조용히 false", () => {
    expect(isAppWindow("", null)).toBe(false);
  });

  it("storage 접근이 예외를 던져도 죽지 않는다", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    // 표식 없는 화면: 읽기 실패 → 조용히 false
    expect(isAppWindow("", throwing)).toBe(false);
    // ?appwin=1 명시: 승격 저장이 실패해도 이번 화면은 앱 창
    expect(isAppWindow("?appwin=1", throwing)).toBe(true);
  });
});
