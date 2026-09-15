// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  generationStatusLabelFor,
  generationStatusTitle,
} from "../src/lib/generationDisplay";
import { setLang } from "../src/lib/i18n";

describe("generation execution phase display", () => {
  it("generation status보다 상세 실행 단계를 우선 표시한다", () => {
    expect(generationStatusLabelFor("pending", null, "preparing")).toBe("요청 준비 중");
    expect(generationStatusLabelFor("running", null, "submitting")).toBe("제출 중");
    expect(generationStatusLabelFor("running", null, "tracking")).toBe("생성 중");
    expect(generationStatusLabelFor("running", null, "verifying")).toBe("확인 중");
    expect(generationStatusLabelFor("running", null, "blocked")).toBe("조치 필요");
    expect(generationStatusLabelFor("running", null, "recovery_required")).toBe(
      "HF 확인 필요",
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

describe("영어로 바꾸면 상태 문구도 영어로 나온다", () => {
  // 설정의 한글/English 는 localStorage 에 남는다 — 다른 시험에 새지 않게 되돌린다.
  afterEach(() => setLang("ko"));

  it("단계 문구 전부가 영어로 바뀐다", () => {
    setLang("en");
    expect(generationStatusLabelFor("pending", null, "preparing")).toBe("Preparing");
    expect(generationStatusLabelFor("pending", null, "pending")).toBe("Queued");
    expect(generationStatusLabelFor("running", null, "claimed")).toBe("Starting");
    expect(generationStatusLabelFor("running", null, "submitting")).toBe("Submitting");
    expect(generationStatusLabelFor("running", null, "tracking")).toBe("Generating");
    expect(generationStatusLabelFor("running", null, "verifying")).toBe("Checking");
    expect(generationStatusLabelFor("running", null, "blocked")).toBe("Action needed");
    expect(generationStatusLabelFor("running", null, "recovery_required")).toBe("Check HF");
    expect(generationStatusLabelFor("done", null, "done")).toBe("Done");
    expect(generationStatusLabelFor("failed", null, "failed")).toBe("Failed");
  });

  it("단계 정보가 없어도, 툴팁 앞말도 함께 영어가 된다", () => {
    setLang("en");
    expect(generationStatusLabelFor("running", null, null)).toBe("Generating");
    expect(generationStatusLabelFor("nsfw", null, null)).toBe("NSFW blocked");
    const title = generationStatusTitle("running", null, "submitting", "queued", null, null);
    expect(title).toContain("Phase: Submitting");
    expect(title).toContain("Higgsfield status: queued");
  });

  it("한글로 되돌리면 한국어로 돌아온다 — 새로고침 없이 바뀌어야 한다", () => {
    setLang("en");
    expect(generationStatusLabelFor("running", null, "submitting")).toBe("Submitting");
    setLang("ko");
    expect(generationStatusLabelFor("running", null, "submitting")).toBe("제출 중");
  });
});
