import { describe, expect, it } from "vitest";
import {
  generationStatusLabelFor,
  generationStatusTitle,
} from "../src/lib/generationDisplay";

describe("generation execution phase display", () => {
  it("generation status보다 상세 실행 단계를 우선 표시한다", () => {
    expect(generationStatusLabelFor("running", null, "submitting")).toBe("제출 중");
    expect(generationStatusLabelFor("running", null, "tracking")).toBe("생성 중");
    expect(generationStatusLabelFor("running", null, "verifying")).toBe("확인 중");
    expect(generationStatusLabelFor("running", null, "blocked")).toBe("조치 필요");
    expect(generationStatusLabelFor("running", null, "recovery_required")).toBe(
      "복구 확인 필요",
    );
  });

  it("공급자 원시 상태와 확인 시각을 진단 제목에 보존한다", () => {
    const title = generationStatusTitle(
      "running",
      null,
      "verifying",
      "brand_new_provider_state",
      "2026-08-11 00:00:00",
      "2026-08-11 00:00:30",
    );
    expect(title).toContain("단계: 확인 중");
    expect(title).toContain("Higgsfield 상태: brand_new_provider_state");
    expect(title).toContain("마지막 확인:");
    expect(title).toContain("다음 확인:");
  });
});
