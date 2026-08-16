import { describe, expect, it } from "vitest";
import { AUTH_STATE_HEADER, shouldInvalidateAuth } from "../src/lib/http";

function response(status: number, authState?: string): Response {
  return new Response("{}", {
    status,
    headers: authState ? { [AUTH_STATE_HEADER]: authState } : undefined,
  });
}

describe("401 인증 상태 보존", () => {
  it("세션이 유효한 요청별 401은 로그인 토큰을 지우지 않는다", () => {
    expect(shouldInvalidateAuth(response(401, "preserved"), "/api/manage/summary")).toBe(false);
  });

  it("확정 만료 401은 다시 로그인을 요구한다", () => {
    expect(shouldInvalidateAuth(response(401, "invalid"), "/api/manage/summary")).toBe(true);
  });

  it("헤더 없는 구버전 401은 기존의 안전한 로그아웃 동작을 유지한다", () => {
    expect(shouldInvalidateAuth(response(401), "/api/manage/summary")).toBe(true);
  });

  it("로그인 API의 401은 전역 세션을 지우지 않는다", () => {
    expect(shouldInvalidateAuth(response(401, "invalid"), "/api/auth/login")).toBe(false);
  });

  it("401이 아닌 오류는 인증 상태를 바꾸지 않는다", () => {
    expect(shouldInvalidateAuth(response(403), "/api/manage/summary")).toBe(false);
    expect(shouldInvalidateAuth(response(502), "/api/manage/summary")).toBe(false);
  });
});
