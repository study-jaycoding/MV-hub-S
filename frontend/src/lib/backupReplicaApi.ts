import { jsonBody, jsonFetch } from "./http";

// 서버 백업 복사 위치(관리자 창 · 공유 서버 탭, 2026-10-02 설계 r5) — 공유 서버가 매일 만드는 DB 백업을
// 다른 저장소(NAS)로 한 번 더 복사하는 예약 작업(MVHub BackupCopy)의 위치·결과. 로컬 허브가 이 PC 브라우저에서만
// 받아 공유 서버 /api/admin/backup-replica 로 넘긴다.
export interface BackupReplicaTask {
  exists: boolean;
  enabled: boolean;
  running: boolean;
  matches_install: boolean;
  ignore_new: boolean;
  last_run_at: string | null;
  last_result: number | null;
  next_run_at: string | null;
}

export interface BackupReplicaResult {
  state: string; // success | failed | disabled | no_source | never_run | state_unavailable
  error_code: string | null;
  target_id: string | null; // 그 실행이 실제로 읽은 위치의 지문(옛 기록은 null)
  started_at: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  copied: number;
  skipped: number;
  failed: number;
}

export interface BackupReplicaStatus {
  applicable: boolean;
  target: string | null;
  target_id: string | null;
  source: "file" | "env" | "none";
  editable: boolean;
  lock_reason: string | null;
  target_garbled: boolean;
  target_is_unc: boolean;
  server_account_system: boolean;
  task: BackupReplicaTask | null;
  result: BackupReplicaResult | null;
  audit_warning?: string | null;
}

export interface BackupReplicaRunStart {
  requested_at: string;
  baseline_last_run_at: string | null;
}

export const backupReplicaApi = {
  status: () => jsonFetch<BackupReplicaStatus>("/api/shared-server/backup-replica"),
  save: (target: string, expectedTargetId: string | null, password: string) =>
    jsonFetch<BackupReplicaStatus>("/api/shared-server/backup-replica", {
      method: "PUT",
      body: jsonBody({ target, expected_target_id: expectedTargetId, password }),
    }),
  run: () =>
    jsonFetch<BackupReplicaRunStart>("/api/shared-server/backup-replica/run", {
      method: "POST",
      body: jsonBody({}),
    }),
};

/** UNC 형식만 화면에서 먼저 거른다(진짜 검사는 서버). \\서버\공유 두 칸이 있어야 한다. */
export function looksLikeUnc(value: string): boolean {
  const v = value.trim();
  if (!v.startsWith("\\\\") || v.startsWith("\\\\?\\") || v.startsWith("\\\\.\\")) return false;
  const parts = v.slice(2).split("\\").filter(Boolean);
  return parts.length >= 2;
}

/** [지금 복사] 뒤 '이번 실행이 끝났나' — 실행 전 마지막 실행보다 새 실행이 있고, 지금 안 돌고, 결과가 요청 뒤에 시작됐을 때. */
export function runFinished(status: BackupReplicaStatus, start: BackupReplicaRunStart): boolean {
  const task = status.task;
  const result = status.result;
  if (!task || task.running || !task.last_run_at || !result?.started_at) return false;
  const newRun = !start.baseline_last_run_at || Date.parse(task.last_run_at) > Date.parse(start.baseline_last_run_at);
  return newRun && Date.parse(result.started_at) >= Date.parse(start.requested_at); // 둘 다 서버 시계
}
