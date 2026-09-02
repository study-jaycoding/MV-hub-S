import { jsonBody, jsonFetch } from "./http";

export type ReleaseUpdateState =
  | "unavailable"
  | "check_failed"
  | "up_to_date"
  | "available"
  | "starting"
  | "checking"
  | "downloading"
  | "installing"
  | "restarting"
  | "complete"
  | "failed";

export interface ReleaseUpdateStatus {
  state: ReleaseUpdateState;
  message: string;
  install_mode: "release" | "server" | "development";
  current_version: string;
  latest_version: string;
  can_update: boolean;
  generation_active: number;
  comfy_active: number;
  resolve_active: number; // 진행 중 Resolve 직접 전송(요청 안에서 준비·반입·저장)
  active_total: number;
  updated_at: string;
  accepted?: boolean;
  percent?: number; // 업데이트 실행기(bat)가 기록하는 전체 진행률 0~100
  // 실패 시 설치 트리 상태(워커가 기록): not_started(앱 무사)·rolled_back(구버전 복원)·
  // new_committed(신버전 커밋됐지만 재시작 실패)·recovery_required(롤백 미완 — 수동 복구 필요)
  recovery?: string;
}

export interface LatestReleaseMetadata {
  version: string;
  file: string;
  sha256: string;
  size: number;
  created_at: string;
}

// 업데이트 실행기(update_release.bat)는 CP949 인코딩 함정 때문에 상태 message를
// 영어(ASCII)로만 기록한다 — 한글이 bat 안에 있으면 표준 한국어 Windows 에서 추출이
// 깨져 업데이트 자체가 죽는다(실측). 화면 한글은 여기서 state 코드로 매핑한다.
const STATE_LABEL_KO: Partial<Record<ReleaseUpdateState, string>> = {
  starting: "업데이트 실행기를 준비하는 중…",
  checking: "최신 릴리스를 확인하는 중…",
  downloading: "업데이트 파일을 내려받는 중…",
  installing: "검증된 새 버전을 설치하는 중…",
  restarting: "새 버전으로 프로그램을 다시 시작하는 중…",
  complete: "업데이트가 완료됐습니다.",
  up_to_date: "최신 버전입니다.",
};

// 상태 문구 — 진행 상태는 한글 라벨(+퍼센트), 실패는 한글 접두 + 원문(영어 디테일 보존).
export function releaseUpdateMessage(status: ReleaseUpdateStatus | null): string {
  if (!status) return "";
  const label = STATE_LABEL_KO[status.state];
  if (label) {
    const pct = typeof status.percent === "number" ? ` (${Math.min(100, status.percent)}%)` : "";
    return label + pct;
  }
  if (status.state === "failed") {
    const raw = status.message || "";
    const text = raw.startsWith("업데이트 실패") ? raw : `업데이트 실패: ${raw}`;
    if (status.recovery === "recovery_required") {
      // 롤백이 끝까지 안 된 유일한 위험 상태 — 재시도보다 로그 확인이 먼저다.
      // 복구 자체는 안전하다: 다음 실행이 백업을 격리 보존한 채 새로 설치한다.
      return (
        text
        + " — 자동 복구가 완료되지 않았습니다. %LOCALAPPDATA%\\MVHub\\updates\\update.log 를 확인한 뒤, 설정의 '강제 업데이트'로 재시도하세요(백업은 보존됩니다)."
      );
    }
    return text;
  }
  return status.message || "";
}

/** 업데이트 중 백엔드 무응답(연속)이 이 시간을 넘으면 멈춘 진행률 대신 정직한 안내로 바꾼다. */
export const UPDATE_UNREACHABLE_WARN_MS = 90_000;

/** 폴링 연속 실패 안내 — 교체·재시작 구간의 짧은 무응답은 null(직전 문구 유지).
 * 업데이터가 아직 롤백·복사 중일 수 있으므로 "직접 실행하라"는 안내는 하지 않는다
 * (사용자가 앱을 띄우면 런타임 파일을 다시 잠가 2차 실패를 만든다 — 코덱스 검토). */
export function pollFailureMessage(firstFailedAt: number | null, now: number): string | null {
  if (firstFailedAt == null) return null;
  if (now - firstFailedAt < UPDATE_UNREACHABLE_WARN_MS) return null;
  return "앱 응답이 90초 넘게 없습니다. 업데이트가 아직 실행 중일 수 있으니 프로그램을 직접 실행하지 말고 잠시 기다려주세요.";
}

export const UPDATE_WAIT_VERSION_KEY = "mvhub.release-update.wait-version";

export function isReleaseUpdateRunning(state: ReleaseUpdateState | undefined): boolean {
  return state === "starting"
    || state === "checking"
    || state === "downloading"
    || state === "installing"
    || state === "restarting";
}

export function getReleaseUpdateStatus(refresh = false): Promise<ReleaseUpdateStatus> {
  return jsonFetch<ReleaseUpdateStatus>(
    `/api/release-update/status${refresh ? "?refresh=true" : ""}`,
  );
}

export function getLatestReleaseMetadata(): Promise<LatestReleaseMetadata> {
  return jsonFetch<LatestReleaseMetadata>("/api/release-update/latest-metadata");
}

/** force=true — 오류 잔여 카드로 '진행 중' 집계가 안 빠질 때 검사를 건너뛰고 강제 시작
 * (폴더의 update_release.bat 직접 실행과 동일). */
export function startReleaseUpdate(force = false): Promise<ReleaseUpdateStatus> {
  return jsonFetch<ReleaseUpdateStatus>("/api/release-update/start", {
    method: "POST",
    headers: { "X-MVHub-Update": "1" },
    body: jsonBody({ confirm: true, force }),
  });
}

/** 업데이트를 막는 진행 중 작업을 사람이 읽는 문구로 — 유료 생성·Comfy 와 Resolve 전송을 나눠 말한다. */
export function updateBlockersText(
  status: Pick<ReleaseUpdateStatus, "active_total" | "resolve_active"> | null | undefined,
): string {
  const active = status?.active_total || 0;
  const resolveActive = status?.resolve_active || 0;
  const generationActive = Math.max(0, active - resolveActive);
  return [
    generationActive > 0 ? `생성 ${generationActive}건` : "",
    resolveActive > 0 ? `Resolve 전송 ${resolveActive}건` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
