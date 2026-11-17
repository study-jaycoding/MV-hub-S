// 로컬 텔레메트리(매니징) push 상태를 주기 폴링 — 조용히 묻히던 실패를 UI 로 노출.
// failed>0 일 때만 경고를 띄운다(pending 은 정상 backlog 라 노이즈). read-only 관측.
import { useEffect, useState } from "react";
import { api } from "../api";
import { reconcileValueState } from "./stateReconciliation";
import { getAccountNamespace, getConnectionKey } from "./accountScope";
import { getAuthToken } from "./http";

export interface SyncStatus {
  pending: number;
  failed: number;
  last_error: string | null;
  oldest_dirty: string | null;
  last_success_at: string | null;
  account_report_pending: number;
  account_report_failed: number;
  account_report_dead?: number;
  account_report_last_error: string | null;
  account_report_oldest_dirty: string | null;
  account_report_last_success_at: string | null;
  balance_pending?: number;
  balance_failed?: number;
  balance_conflict?: number;
  balance_unsupported?: number;
  balance_oldest_pending_at_ms?: number | null;
  balance_last_success_at_ms?: number | null;
  balance_last_error_code?: string | null;
  balance_write_enabled?: boolean;
  balance_error_code?: string | null;
}

export function syncPendingCount(status: SyncStatus): number {
  return Math.max(0, status.pending || 0) + Math.max(0, status.account_report_pending || 0) + Math.max(0, status.balance_pending || 0);
}

export function syncFailedCount(status: SyncStatus): number {
  return Math.max(0, status.failed || 0)
    + Math.max(0, status.account_report_failed || 0)
    + Math.max(0, status.account_report_dead || 0)
    + Math.max(0, status.balance_failed || 0);
}

export function latestSyncSuccess(status: SyncStatus): string | null {
  const reported = [status.last_success_at, status.account_report_last_success_at]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const candidates = reported
    .map((value) => ({ value, timestamp: Date.parse(value) }))
    .filter((item) => Number.isFinite(item.timestamp));
  if (!candidates.length) return reported[0] || null;
  return candidates.reduce((latest, item) =>
    item.timestamp > latest.timestamp ? item : latest,
  ).value;
}

export function formatTelemetryLastSuccess(value: string | null): string {
  if (!value) return "마지막 성공 기록 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "마지막 성공 시각 확인 불가";
  const formatted = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return `마지막 성공 ${formatted}`;
}

export function useSyncStatus(enabled = true, contextKey = ""): SyncStatus | null {
  const connection = () => `${getAccountNamespace()}\0${getConnectionKey()}\0${getAuthToken() ?? ""}`;
  const connectionKey = connection();
  const scope = `${connectionKey}\0${contextKey}`;
  const [status, setStatus] = useState<{ key: string; value: SyncStatus } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const check = () => {
      if (document.visibilityState === "hidden") return; // 숨은 탭에선 폴링 쉼(복귀 시 아래 리스너가 1회 갱신)
      api
        .syncStatus()
        .then((s) => {
          if (alive && connection() === connectionKey) setStatus((previous) => ({ key: scope,
            value: reconcileValueState(previous?.key === scope ? previous.value : null, s) ?? s }));
        })
        .catch(() => alive && connection() === connectionKey && setStatus(null));
    };
    check();
    const id = window.setInterval(check, 30000); // 30초 — 관측용이라 자주 안 찔러도 됨
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, scope, connectionKey]); // eslint-disable-line react-hooks/exhaustive-deps -- connection reads the current credentials

  return enabled && status?.key === scope ? status.value : null;
}
