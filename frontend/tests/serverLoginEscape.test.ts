import { describe, expect, it } from "vitest";
import { HttpError, isUpstreamUnreachable } from "../src/lib/http";

// 로그인 화면의 '서버 주소 변경' 패널은 자격증명 오류가 아니라 '서버에 못 닿음'일 때만
// 자동으로 펼쳐진다. 비밀번호를 틀렸는데 주소를 의심하게 만들면 안 된다.
describe("공유 서버 도달 실패 판정", () => {
  it("로컬 허브가 올린 502(공유 서버 연결 실패)는 도달 실패", () => {
    expect(isUpstreamUnreachable(new HttpError(502, "502: 공유 서버 연결 실패"))).toBe(true);
    expect(isUpstreamUnreachable(new HttpError(504, "504: timeout"))).toBe(true);
  });

  it("자격증명·권한 오류는 주소 문제가 아니다", () => {
    expect(isUpstreamUnreachable(new HttpError(400, "400: 공유 서버 로그인 실패"))).toBe(false);
    expect(isUpstreamUnreachable(new HttpError(401, "401: 만료"))).toBe(false);
    expect(isUpstreamUnreachable(new HttpError(403, "403: 이 PC 전용"))).toBe(false);
  });

  it("HTTP 응답조차 못 받은 경우(fetch 실패)도 도달 실패로 본다", () => {
    expect(isUpstreamUnreachable(new TypeError("Failed to fetch"))).toBe(true);
  });
});
