// 로컬 텔레메트리(매니징) push 상태를 주기 폴링 — 조용히 묻히던 실패를 UI 로 노출.
// failed>0 일 때만 경고를 띄운다(pending 은 정상 backlog 라 노이즈). read-only 관측.
import { useEffect, useState } from "react";
import { api } from "../api";
import { reconcileValueState } from "./stateReconciliation";
import { getAccountNamespace, getConnectionKey } from "./accountScope";
import { getAuthToken } from "./http";
import { t } from "./i18n";

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
    + Math.max(0, status.account_report_dead || 0);
}

export function balanceDeliveryNotices(status: SyncStatus): { text: string; title: string }[] {
  const unsupported = Math.max(0, status.balance_unsupported || 0);
  const conflict = Math.max(0, status.balance_conflict || 0);
  const pending = Math.max(0, (status.balance_pending || 0) - unsupported - conflict);
  const failed = Math.max(0, (status.balance_failed || 0) - unsupported - conflict);
  const notices = [];
  if (pending) {
    const code = status.balance_error_code || status.balance_last_error_code || "";
    const reason: Record<string, string> = {
      hub_not_signed_in: "공유 서버에 로그인하면 다시 전달합니다.",
      account_mismatch: "힉스필드 계정과 허브 로그인 계정이 같은지 확인해 주세요.",
      connection_changed: "로그인 계정이나 연결된 서버가 바뀌었습니다. 연결을 확인하면 다시 전달합니다.",
      balance_schema_mismatch: "잔액 확인을 저장할 수 없습니다. 관리자에게 확인해 주세요.",
      agent_key_mismatch: "이 PC의 연결 설정을 확인해 주세요.",
    };
    notices.push({ text: t("잔액 확인 {count}건 서버 전달 대기").replace("{count}", String(pending)),
      title: failed ? t(reason[code] || "서버 저장 확인을 받지 못했습니다. 다음에 다시 전달합니다.") : t("보관한 잔액 확인을 서버에 전달하는 중입니다.") });
  }
  if (unsupported) notices.push({ text: t("잔액 확인 {count}건 서버 업데이트 뒤 전달").replace("{count}", String(unsupported)),
    title: t("서버를 업데이트하면 보관 중인 잔액 확인을 다시 전달합니다.") });
  if (conflict) notices.push({ text: t("잔액 확인 {count}건 전달 내용을 확인해 주세요").replace("{count}", String(conflict)),
    title: t("이미 저장된 잔액 확인과 전달 내용이 다릅니다. 관리자에게 확인해 주세요.") });
  return notices;
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
