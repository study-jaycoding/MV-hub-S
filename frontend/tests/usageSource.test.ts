import { describe, expect, it } from "vitest";
import { creditCoverageText, usageSourceLabel } from "../src/components/manage/usageSource";

describe("usageSourceLabel — 관리 요약 출처 라벨", () => {
  it("팩트(팀 기록 장부) · 매니저 범위면 공유 무관·삭제분 포함을 명시한다", () => {
    expect(usageSourceLabel("facts", "all")).toContain("팀 기록 장부");
    expect(usageSourceLabel("facts", "all")).toContain("공유 무관");
    expect(usageSourceLabel("facts")).toContain("공유 무관"); // scope 없음(구버전 응답)도 매니저 문구
  });
  it("일반 멤버 범위면 '내 작업 전부 + 팀원 공유분'을 명시한다", () => {
    const label = usageSourceLabel("facts", "mine_plus_shared");
    expect(label).toContain("내 작업 전부");
    expect(label).toContain("팀원 공유분");
    expect(label).not.toContain("공유 무관");
  });
  it("구서버(필드 없음)·content 는 종전 라이브러리 집계 문구", () => {
    expect(usageSourceLabel(undefined)).toBe("출처 · 라이브러리 생성물 집계");
    expect(usageSourceLabel(null)).toBe("출처 · 라이브러리 생성물 집계");
    expect(usageSourceLabel("content")).toBe("출처 · 라이브러리 생성물 집계");
  });
});

describe("creditCoverageText — 실제/견적/미상 건수", () => {
  it("구서버 응답(필드 없음)은 null", () => {
    expect(creditCoverageText({})).toBeNull();
  });
  it("미상은 0원이 아니라 '모름'으로 따로 센다", () => {
    expect(creditCoverageText({ credit_real_count: 4, credit_est_count: 1, credit_unknown_count: 148 })).toBe(
      "실제 4 · 견적 1 · 미상 148",
    );
    expect(creditCoverageText({ credit_real_count: 0, credit_est_count: 0, credit_unknown_count: 0 })).toBe(
      "실제 0 · 견적 0 · 미상 0",
    );
  });
});
