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

export function startReleaseUpdate(): Promise<ReleaseUpdateStatus> {
  return jsonFetch<ReleaseUpdateStatus>("/api/release-update/start", {
    method: "POST",
    headers: { "X-MVHub-Update": "1" },
    body: jsonBody({ confirm: true }),
  });
}
