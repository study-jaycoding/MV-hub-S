// 관리 요약(프로젝트 요약 카드·에피소드·시퀀스 표)의 사용량 출처 표시 — 순수 함수.
// 2026-09-09부터 서버는 사용량을 텔레메트리 팩트(team_generation_fact, "팀 기록 장부")에서 센다:
// 공유(발행) 안 한 생성물도 포함, 삭제분(tombstone)도 비용으로 포함, 단 각 PC 허브가 보고한 기록만.
// 구서버(usage_source 없음)는 종전대로 라이브러리(발행분) 집계라 라벨을 그대로 둔다.
import type { ManageProject } from "./types";

export function usageSourceLabel(source?: string | null): string {
  return source === "facts"
    ? "출처 · 팀 기록 장부 (공유 무관 · 삭제분 포함 · 각 PC 보고분)"
    : "출처 · 라이브러리 생성물 집계";
}

/** 크레딧 커버리지 "실제 N · 견적 M · 미상 K". 미상은 0원이 아니라 '모름'(작업자 PC 의 거래 대조 실패).
 *  구서버(필드 없음)는 null — 호출부가 종전 문구만 쓴다. */
export function creditCoverageText(
  p: Pick<ManageProject, "credit_real_count" | "credit_est_count" | "credit_unknown_count">,
): string | null {
  if (p.credit_real_count == null && p.credit_est_count == null && p.credit_unknown_count == null) {
    return null;
  }
  const real = p.credit_real_count || 0;
  const est = p.credit_est_count || 0;
  const unknown = p.credit_unknown_count || 0;
  return `실제 ${real} · 견적 ${est} · 미상 ${unknown}`;
}
