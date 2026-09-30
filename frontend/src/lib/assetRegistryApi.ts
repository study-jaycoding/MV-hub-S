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
  interval_min: number;
  running: boolean;
  current: { project_id?: string; name?: string; phase?: string; started_at?: string; files?: number };
  last: { mode?: string; projects?: number; failed?: number; elapsed_ms?: number; finished_at?: string };
  projects: AssetRegistryScanRow[];
  counts: Record<string, { present?: number; missing?: number }>;
  waiting_large: Record<string, number>;
}

export const assetRegistryApi = {
  status: () => jsonFetch<AssetRegistryStatus>("/api/asset-registry/status"),
  scan: (projectIds: string[] = []) =>
    jsonFetch<{ started: boolean }>("/api/asset-registry/scan", {
      method: "POST",
      body: jsonBody({ project_ids: projectIds }),
    }),
};
