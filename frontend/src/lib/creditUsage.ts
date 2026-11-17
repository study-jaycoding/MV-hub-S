export interface UsageBasis {
  basis?: "api" | "facts" | "mixed" | "unavailable";
  basis_reason?: string | null;
  as_of_ms?: number | null;
  coverage_end_ms?: number | null;
  collected_at_ms?: number | null;
  period_start_ms?: number | null;
  period_end_ms?: number | null;
  fallback_count?: number;
  components?: UsageBasis[];
  unlinked_api?: number | null;
}

const REASONS: Record<string, string> = {
  not_configured: "조직 사용량 미설정", collection_disabled: "수집 꺼짐", restore_paused: "복원 후 수집 정지",
  missing_day: "수집되지 않은 날짜", incomplete_day: "불완전한 수집 범위", unfinished_day: "끝나지 않은 날짜 수집",
  collection_stale: "수집 지연 60분 초과", tail_gap: "수집 범위 중간 누락", before_api_start: "API 제공 시작 전 기간",
  duplicate_row: "API 행 중복", daily_mismatch: "저장된 대조 불일치", contract_mismatch: "수집 계약 버전 불일치",
  identity_unlinked: "계정 신원 미연결", identity_conflict: "계정 신원 충돌", future_period: "아직 시작하지 않은 기간",
  authentication_unavailable: "공유 서버 인증 필요",
};

export function usageReason(code: string | null | undefined, t: (text: string) => string): string {
  return t(REASONS[code ?? ""] ?? "사용량 기준 확인 필요");
}

export function usageBasisText(value: UsageBasis | null | undefined, t: (text: string) => string): string {
  if (value?.basis === "api") return t("힉스필드 기준");
  if (value?.basis === "mixed") return `${t("일부 MV 기록 기준")} · ${value.fallback_count ?? value.components?.filter(p => p.basis === "facts").length ?? 0}`;
  if (value?.basis === "unavailable") return `${t("확인 불가")}${value.basis_reason ? ` · ${usageReason(value.basis_reason, t)}` : ""}`;
  return `${t("MV 생성 기록 기준")}${value?.basis_reason ? ` · ${usageReason(value.basis_reason, t)}` : ""}`;
}

export function usagePeriodText(value: UsageBasis | null | undefined): string {
  if (value?.period_start_ms == null || value.period_end_ms == null) return "";
  const day = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);
  return `${day(value.period_start_ms)} ~ ${day(value.period_end_ms - 1)} (KST)`;
}
