// 실패 사유가 비었을 때 보여줄 대체 문구의 규칙을 고정한다.
//  · 아는 상태만 라벨로 설명한다. 모르는 상태에 원인을 지어내면 사용자가 엉뚱한 것을 고치게 된다.
//  · "옛 생성" 처럼 사실이 아닐 수 있는 단정을 쓰지 않는다 — 방금 만든 실패도 사유가 빌 수 있다.
import { describe, expect, it } from "vitest";

import { GENERATION_STATUS_LABEL, generationErrorFallback } from "./generationDisplay";

describe("generationErrorFallback", () => {
  it("뜻이 분명한 상태는 그 라벨로 설명한다", () => {
    expect(generationErrorFallback("nsfw")).toContain(GENERATION_STATUS_LABEL.nsfw);
  });

  it("failed 는 팝업 라벨과 말이 겹치지 않는다", () => {
    expect(generationErrorFallback("failed")).not.toContain("실패 상태");
  });

  it("모르는 상태는 모두 같은 중립 문구 — 원인을 지어내지 않는다", () => {
    const rejected = generationErrorFallback("rejected");
    expect(rejected).toBe(generationErrorFallback("canceled"));
    expect(rejected).not.toContain("rejected");
  });

  it("'옛 생성' 이라고 단정하지 않는다", () => {
    for (const status of ["failed", "nsfw", "rejected"]) {
      expect(generationErrorFallback(status)).not.toContain("옛 생성");
    }
  });
});
