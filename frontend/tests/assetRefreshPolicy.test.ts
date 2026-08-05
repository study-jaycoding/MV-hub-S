import { describe, expect, it } from "vitest";
import { assetResumeRefreshAction } from "../src/components/assets/assetRefreshPolicy";

describe("Assets 복귀 갱신 정책", () => {
  it("숨김 중 실제 변경이 있으면 포커스 안전망 대신 변경 갱신만 선택한다", () => {
    expect(
      assetResumeRefreshAction({
        hidden: false,
        dirtyWhileHidden: true,
        refreshScheduled: false,
        elapsedMs: 60_000,
      }),
    ).toBe("flush");
  });

  it("변경 갱신이 예약돼 있으면 별도 트리 요청을 추가하지 않는다", () => {
    expect(
      assetResumeRefreshAction({
        hidden: false,
        dirtyWhileHidden: false,
        refreshScheduled: true,
        elapsedMs: 60_000,
      }),
    ).toBe("none");
  });

  it("변경 신호가 없고 30초가 지났을 때만 트리 안전망을 사용한다", () => {
    expect(
      assetResumeRefreshAction({
        hidden: false,
        dirtyWhileHidden: false,
        refreshScheduled: false,
        elapsedMs: 29_999,
      }),
    ).toBe("none");
    expect(
      assetResumeRefreshAction({
        hidden: false,
        dirtyWhileHidden: false,
        refreshScheduled: false,
        elapsedMs: 30_000,
      }),
    ).toBe("tree");
  });

  it("아직 숨겨진 창에서는 어떤 조회도 시작하지 않는다", () => {
    expect(
      assetResumeRefreshAction({
        hidden: true,
        dirtyWhileHidden: true,
        refreshScheduled: false,
        elapsedMs: 60_000,
      }),
    ).toBe("none");
  });
});
