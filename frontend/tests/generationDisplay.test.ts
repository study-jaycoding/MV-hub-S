// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  generationStatusLabelFor,
  generationStatusTitle,
} from "../src/lib/generationDisplay";
import { setLang } from "../src/lib/i18n";

describe("실행 단계 계약 — 백엔드 어휘를 빠짐없이 사람 말로 보여준다", () => {
  // 백엔드가 gen_request.status 에 넣거나 살아 있는 단계로 취급하는 값 전부.
  //  출처: backend/app/repo/gen_requests.py(_AMBIGUOUS_ACTIVE_PHASES),
  //       backend/app/repo/trash.py(_NONTERMINAL_REQUEST_PHASES, 'canceled'),
  //       backend/app/repo/generations.py('done'/'failed').
  //  백엔드에 단계가 늘면 이 목록도 늘리고 라벨을 채워야 한다 — 안 그러면 툴팁에 영문이 샌다.
  const BACKEND_PHASES = [
    "preparing", "pending", "claimed", "submitting", "running", "tracking",
    "verifying", "blocked", "recovery_required", "done", "failed", "canceled",
  ];

  it("모든 단계가 내부 값 그대로 노출되지 않는다", () => {
    for (const phase of BACKEND_PHASES) {
      const label = generationStatusLabelFor("running", null, phase);
      expect(label, phase + " 라벨 없음").not.toBe(phase);
      const title = generationStatusTitle("running", null, phase);
      expect(title, phase + " 툴팁에 영문 생값").not.toContain("단계: " + phase);
    }
  });

  it("삭제로 취소된 뒤 복원한 카드는 '취소됨' 으로 보인다", () => {
    // trash.restore_from_trash 는 generation.status 를 failed 로 두고
    //  gen_request.status 는 canceled 로 남긴다 — 실제 종료 사유는 취소다.
    expect(generationStatusLabelFor("failed", null, "canceled")).toBe("취소됨");
    expect(generationStatusTitle("failed", null, "canceled")).toContain("단계: 취소됨");
    setLang("en");
    expect(generationStatusLabelFor("failed", null, "canceled")).toBe("Canceled");
    setLang("ko");
  });
});

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
