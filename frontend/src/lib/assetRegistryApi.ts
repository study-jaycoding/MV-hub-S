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

export interface AssetRegistryStatus {
  enabled: boolean;
  // 도우미 PC 훑기(서버가 NAS 를 못 읽을 때) — 옛 서버엔 없다
  helper_enabled?: boolean;
  lease?: { project_id: string; name: string; started_at: string } | null;
  interval_min: number;
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
}

export const assetRegistryApi = {
  status: () => jsonFetch<AssetRegistryStatus>("/api/asset-registry/status"),
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
