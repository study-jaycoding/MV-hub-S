import { describe, expect, it } from "vitest";
import { shouldLoadSharedServer } from "../src/lib/useHubAuth";

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
