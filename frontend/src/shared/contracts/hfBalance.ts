/** Read-only balance responses. Amounts ending in _c are integer hundredths. */
export interface BalanceMeta {
  workspace_id?: string;
  credits_c?: number | null;
  credits?: number | null;
  observation_id?: string | null;
  source?: string | null;
  basis?: string;
  observed_at_ms?: number | null;
  received_at_ms?: number | null;
  time_basis?: string;
  time_quality?: string;
  precision_kind?: string | null;
  precision_error_c?: number | null;
  age_ms?: number | null;
  stale?: boolean;
  reason_codes?: string[];
}

export interface BalancePartialTotals {
  known_subtotal_c?: number;
  unknown_workspace_count?: number;
  legacy_workspace_count?: number;
  stale_workspace_count?: number;
  complete?: boolean;
  fresh?: boolean;
}

export interface BalancesResponse {
  balance_protocol: number;
  as_of_ms: number;
  balances: BalanceMeta[];
}

export type LedgerState = "numeric_match" | "residual_present" | "api_pending" | "observation_uncertain" | "comparison_unavailable";
export interface LedgerEvidence {
  candidate: string;
  code: string;
  workspace_id?: string;
  refunded_c?: number;
  credits_c?: number;
  residual_c?: number;
  plan_revision?: number | string | null;
}
export interface BalanceInterval {
  from_observation_id: string;
  to_observation_id: string;
  start_ms: number;
  end_ms: number;
  opening_c: number | null;
  closing_c: number | null;
  delta_c: number | null;
  api_created_net_c: number | null;
  residual_c: number | null;
  tolerance_c: number | null;
  state: LedgerState;
  candidate_classification: string;
  candidate_evidence: LedgerEvidence[];
  candidate_count: number;
  reason_codes: string[];
}
export interface BalanceChartPoint {
  observation_id: string;
  observed_at_ms: number;
  credits_c: number;
  quality: string;
}
export interface BalanceDay {
  day: string;
  net_c: number | null;
  charged_c: number | null;
  refunded_c: number | null;
  complete: boolean;
  collected_at_ms: number | null;
  actual_start_ms: number | null;
  actual_end_ms: number | null;
  reason_codes: string[];
  window_versions: { window_id: string; snapshot_version: number }[];
}
export interface DailyBalance {
  day: string;
  observation_count: number;
  time_uncertain_count: number;
  opening_c: number | null;
  closing_c: number | null;
  delta_c: number | null;
}
export interface BalanceLedgerResponse {
  balance_protocol: number;
  workspace_id: string;
  timezone: string;
  requested_start_ms: number;
  requested_end_ms: number;
  as_of_ms: number;
  content_read_at_ms: number;
  manage_read_at_ms: number;
  basis_signature: string;
  api_state: string;
  reason_codes: string[];
  api_window_versions: { window_id: string; snapshot_version: number }[];
  plan_revision: number | string | null;
  chart_points: BalanceChartPoint[];
  chart_gaps: { start_ms: number; end_ms: number }[];
  intervals: BalanceInterval[];
  daily_api: BalanceDay[];
  daily_balances: DailyBalance[];
  returned_count: number;
  has_more: boolean;
  next_cursor: string | null;
}
