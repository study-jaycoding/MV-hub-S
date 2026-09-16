// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  generationIssueFor,
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
      "제출 확인 필요",
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
    expect(generationStatusLabelFor("running", null, "recovery_required")).toBe("Submission check needed");
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

describe("오류 원인 안내는 상태를 바꾸지 않고 필요한 카드에만 표시한다", () => {
  const creditError = "CLI 실패: Error: You've reached your monthly workspace group credit limit. Ask your workspace admin to increase the group limit or wait until it resets. — cmd: generate create seedance_2_5 --mode omni_reference";
  afterEach(() => setLang("ko"));

  it("그룹 사용 한도를 잔액 부족과 구분하고 관리자 조치를 안내한다", () => {
    const issue = generationIssueFor("running", creditError, "recovery_required");
    expect(issue?.code).toBe("group_credit_limit");
    expect(issue?.title).toBe("크레딧 한도 초과");
    expect(issue?.detail).toContain("월간");
    expect(issue?.action).toContain("관리자");
    expect(issue?.action).not.toContain("충전");
    expect(generationStatusLabelFor("running", creditError, "recovery_required")).toBe("크레딧 한도 초과");
  });

  it("실패·차단·제출확인에서만 원인을 표시한다", () => {
    expect(generationIssueFor("failed", creditError)?.code).toBe("group_credit_limit");
    expect(generationIssueFor("running", creditError, "blocked")?.code).toBe("group_credit_limit");
    expect(generationIssueFor("running", creditError, "failed")?.code).toBe("group_credit_limit");
    expect(generationIssueFor("running", creditError)).toBeNull();
    expect(generationIssueFor("pending", creditError)).toBeNull();
    expect(generationIssueFor("unknown", creditError)).toBeNull();
  });

  it("성공·취소·NSFW 상태와 실제 진행 단계는 오래된 오류로 덮지 않는다", () => {
    for (const status of ["done", "canceled", "nsfw"]) {
      expect(generationIssueFor(status, creditError, "recovery_required")).toBeNull();
    }
    expect(generationStatusLabelFor("done", creditError, "recovery_required")).toBe("완료");
    expect(generationStatusLabelFor("nsfw", creditError, "recovery_required")).toBe("NSFW 차단");
    expect(generationStatusLabelFor("failed", creditError, "canceled")).toBe("취소됨");
    for (const phase of ["preparing", "pending", "claimed", "submitting", "tracking", "verifying", "running", "done", "canceled"]) {
      expect(generationIssueFor("failed", creditError, phase), phase).toBeNull();
      expect(generationStatusLabelFor("failed", creditError, phase), phase).not.toBe("크레딧 한도 초과");
    }
  });

  it("원인 안내가 있어도 자동 재실행 중단과 원문을 툴팁에 보존한다", () => {
    const title = generationStatusTitle("running", creditError, "recovery_required", "unknown");
    expect(title).toContain("크레딧 한도 초과:");
    expect(title).toContain("해결 방법:");
    expect(title).toContain("자동 재실행 안 함 · 제출 확인 필요");
    expect(title).toContain("단계: 제출 확인 필요");
    expect(title).toContain("Higgsfield 상태: unknown");
    expect(title).toContain(creditError);
  });

  it("원인을 모르면 기존 실패 표시와 중립적인 제출확인 안내를 유지한다", () => {
    const unknownError = "Unrecognized external error";
    expect(generationIssueFor("failed", unknownError)).toBeNull();
    expect(generationStatusLabelFor("failed", unknownError)).toBe("실패");
    expect(generationStatusLabelFor("running", unknownError, "recovery_required")).toBe("제출 확인 필요");
    expect(generationStatusTitle("running", unknownError, "recovery_required")).toContain("자동 재실행 안 함");
    expect(generationStatusTitle("failed", unknownError)).toBe(unknownError);
  });

  it("각 오류의 안내와 조치가 영어로 바뀌고 한국어로 즉시 돌아온다", () => {
    const cases = [
      [creditError, "Credit limit reached"],
      ["CLI 실패: Error: Insufficient credits", "Insufficient credits"],
      [creditError.replace(" — cmd:", " Insufficient credits. — cmd:"), "Check credit limits"],
      ["CLI 실패: Error: Not authenticated", "Sign-in needed"],
      ["CLI 실패: Error: Forbidden", "Check permissions"],
      ["CLI 실패: Error: Invalid media UUID", "Check inputs"],
      ["CLI 실패: Error: Too many requests", "Rate limit reached"],
      ["CLI 실패: Error: Internal server error", "Service error"],
      ["CLI 실패: Error: connect ETIMEDOUT", "Check connection"],
    ];
    setLang("en");
    for (const [error, expectedTitle] of cases) {
      const issue = generationIssueFor("failed", error);
      expect(issue?.title, error).toBe(expectedTitle);
      expect(issue?.detail, error).not.toMatch(/[가-힣]/);
      expect(issue?.action, error).not.toMatch(/[가-힣]/);
    }
    const title = generationStatusTitle("running", creditError, "recovery_required");
    expect(title).toContain("Suggested action:");
    expect(title).toContain("Auto-retry paused · submission check needed");
    setLang("ko");
    expect(generationIssueFor("failed", creditError)?.title).toBe("크레딧 한도 초과");
  });
});
