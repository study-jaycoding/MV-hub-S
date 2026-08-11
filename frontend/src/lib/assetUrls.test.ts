import { describe, expect, it } from "vitest";
import { assetThumbUrl, assetTreeUrl } from "./assetUrls";

describe("asset URLs", () => {
  it("같은 경로라도 파일 버전이 바뀌면 다른 썸네일 URL을 만든다", () => {
    const before = assetThumbUrl("demo", "same-name.png", 512, "100-10");
    const after = assetThumbUrl("demo", "same-name.png", 512, "200-10");

    expect(before).not.toBe(after);
    expect(before).toContain("v=100-10");
    expect(after).toContain("v=200-10");
  });

  it("포커스 안전망은 fresh 트리 요청을 만들 수 있다", () => {
    expect(assetTreeUrl("demo", true)).toContain("fresh=1");
  });
});
