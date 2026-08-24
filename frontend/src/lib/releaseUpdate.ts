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
  active_total: number;
  updated_at: string;
  accepted?: boolean;
  percent?: number; // 업데이트 실행기(bat)가 기록하는 전체 진행률 0~100
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
    return raw.startsWith("업데이트 실패") ? raw : `업데이트 실패: ${raw}`;
  }
  return status.message || "";
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

export function startReleaseUpdate(): Promise<ReleaseUpdateStatus> {
  return jsonFetch<ReleaseUpdateStatus>("/api/release-update/start", {
    method: "POST",
    headers: { "X-MVHub-Update": "1" },
    body: jsonBody({ confirm: true }),
  });
}
