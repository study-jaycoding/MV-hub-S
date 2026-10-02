// 에셋 대장(2026-09-30, docs/ASSET_REGISTRY.md) — 관리자 창의 상태·수동 훑기. 로컬 허브에서는 데이터 프록시가
// 공유 서버로 넘긴다(/api/asset-registry 는 로컬 전용 경로가 아니다). 권위는 공유 서버의 대장이다.
import { jsonBody, jsonFetch } from "./http";

export interface AssetRegistryScanRow {
  project_id: string;
  name: string;
  root: string | null;
  state: "ok" | "partial" | "failed" | string;
  started_at: string | null;
  finished_at: string | null;
  complete: number;
  clean: number;
  files: number;
  hashed: number;
  hashed_bytes: number;
  undetermined: number;
  pending: number;
  elapsed_ms: number;
  note: string | null;
}

export type RegistryMode = "server" | "local";

// 자동 훑기 시간(2026-10-02) — 끔·매월(1~28일)·매주(월=0)·매일 + 시(0~23, KST). 서버 DB 에 하나.
export type ScheduleKind = "off" | "month" | "week" | "day";
export interface RegistrySchedule {
  kind: ScheduleKind;
  day: number;
  weekday: number;
  hour: number;
}
export interface RegistryScheduleState {
  schedule: RegistrySchedule;
  next_run_at: string | null;
  schedule_mark: { slot?: string; runner?: string; state?: string } | null; // 마지막으로 맡긴 회차(누가·시작 못 함)
}

export interface AssetRegistryStatus {
  enabled: boolean;
  // 훑는 곳 — 서버 자신 / 관리자 PC(도우미). 관리자 창에서 고르고 서버 DB 에 둔다(2026-09-30 — 그 전 dev 서버엔 없다)
  mode?: RegistryMode;
  lease?: { project_id: string; name: string; started_at: string } | null;
  interval_min: number; // 옛 간격 주기(없앰 — 새 서버는 0)
  // 자동 훑기 시간 — 2026-10-02 전 서버엔 없다(그때는 '서버 업데이트 필요')
  schedule?: RegistrySchedule;
  next_run_at?: string | null;
  schedule_mark?: RegistryScheduleState["schedule_mark"];
  running: boolean;
  current: { project_id?: string; name?: string; phase?: string; started_at?: string; files?: number };
  last: { mode?: string; projects?: number; failed?: number; elapsed_ms?: number; finished_at?: string };
  projects: AssetRegistryScanRow[];
  counts: Record<string, { present?: number; missing?: number }>;
  waiting_large: Record<string, number>;
}

export interface RegistryHelperResult {
  project_id: string;
  name: string;
  state: "ok" | "partial" | "failed" | "aborted" | string;
  note?: string;
  files?: number;
  clean?: boolean;
  kinds?: Record<string, number>;
}

export interface RegistryHelperStatus {
  running: boolean;
  current: { project_id?: string; name?: string; phase?: string };
  last: { projects?: number; failed?: number; elapsed_ms?: number; finished_at?: string };
  results: RegistryHelperResult[];
  abort: string;
  available?: boolean; // 이 PC 가 도우미가 될 수 있나 — 공유 서버에 로그인한 앱만(dev·격리 서버는 자기 자신이 서버)
}

export const assetRegistryApi = {
  status: () => jsonFetch<AssetRegistryStatus>("/api/asset-registry/status"),
  setMode: (mode: RegistryMode) =>
    jsonFetch<{ mode: RegistryMode }>("/api/asset-registry/mode", { method: "POST", body: jsonBody({ mode }) }),
  setSchedule: (schedule: RegistrySchedule) =>
    jsonFetch<RegistryScheduleState>("/api/asset-registry/schedule", { method: "POST", body: jsonBody(schedule) }),
  scan: (projectIds: string[] = []) =>
    jsonFetch<{ started: boolean }>("/api/asset-registry/scan", {
      method: "POST",
      body: jsonBody({ project_ids: projectIds }),
    }),
  // 도우미 PC 훑기 — **이 PC 의 로컬 허브**가 NAS 를 읽어 서버에 올린다(/api/registry-helper 는 로컬 전용 경로)
  helperScan: (projectIds: string[] = []) =>
    jsonFetch<{ started: boolean }>("/api/registry-helper/scan", {
      method: "POST",
      body: jsonBody({ project_ids: projectIds }),
    }),
  helperStatus: () => jsonFetch<RegistryHelperStatus>("/api/registry-helper/status"),
};
