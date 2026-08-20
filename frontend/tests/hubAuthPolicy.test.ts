import { describe, expect, it } from "vitest";
import { isAuthResponseCurrent, shouldLoadSharedServer } from "../src/lib/useHubAuth";

describe("공유 서버 인증 조회 정책", () => {
  it("인증 모드를 아직 모를 때는 공유 서버 상태를 조회하지 않는다", () => {
    expect(shouldLoadSharedServer(null)).toBe(false);
    expect(shouldLoadSharedServer(undefined)).toBe(false);
  });

  it("인증 서버 모드에서는 공유 서버 상태를 조회하지 않는다", () => {
    expect(shouldLoadSharedServer(true)).toBe(false);
  });

  it("로컬 허브 모드가 확정된 뒤에만 공유 서버 상태를 조회한다", () => {
    expect(shouldLoadSharedServer(false)).toBe(true);
  });
});

describe("부팅 인증 검증(me)의 늦은 응답 무효화", () => {
  it("토큰이 그대로면 응답을 반영한다(정상 부팅)", () => {
    expect(isAuthResponseCurrent("tok-a", "tok-a")).toBe(true);
  });

  it("그 사이 다른 계정으로 로그인했으면(토큰 변경) 늦은 응답을 버린다", () => {
    // 지연된 A 토큰 검증 도중 워치독이 화면을 풀고 사용자가 B 로 로그인한 시나리오 —
    // 늦은 성공이 A 계정으로 덮거나, 늦은 실패가 B 토큰을 지우면 안 된다.
    expect(isAuthResponseCurrent("tok-a", "tok-b")).toBe(false);
  });

  it("그 사이 로그아웃했으면(토큰 소멸) 늦은 응답을 버린다", () => {
    expect(isAuthResponseCurrent("tok-a", null)).toBe(false);
  });
});
