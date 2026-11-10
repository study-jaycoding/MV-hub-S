export interface AssetServerLocation {
  location_id: string;
  project_id: string;
  owner_uid: string;
  storage_id: string;
  root_revision: string;
  server_origin: string;
}

export interface AssetReferenceIdentity {
  asset_content_id?: string;
  target_project_id?: string;
  server_location?: AssetServerLocation;
}

export interface AssetImportTarget {
  target_project_id?: string;
  target_workspace_id?: string;
}

export interface AssetSyncReceipt extends AssetServerLocation {
  supersedes_location_id?: string;
  asset_content_id: string;
  original_file_path: string;
  file_path: string;
  state: string;
  bytes?: number;
  registry_asset_id?: string;
}

// 내장 관리 폴더 — 백엔드 services/asset_paths.py 의 이름과 같다(내용이 고정된 사본이라 원본 추종 대상이 아니다).
const MANAGED_ASSET_PROJECTS = new Set(["imports", "captures", "imp/cap"]);

/** 프로젝트 폴더 원본 이미지(asset:<project>|<path>) — 같은 이름 덮어쓰기를 따라가므로 판 고정·보관본 승격·기대 지문 대조를 하지 않는다.
 *  영상·오디오·내장 폴더·asset-sync·옛 /api/assets/file 형태는 지금 정책 그대로(2026-11-10 Jay, docs/status/레퍼런스덮어쓰기_최신추종_2026-11-10.md). */
export function isLiveProjectRef(ref: { file_path?: string | null; type?: string | null }): boolean {
  const path = ref.file_path || "";
  if (!path.startsWith("asset:") || (ref.type || "image") !== "image") return false;
  const cut = path.indexOf("|");
  return cut > 6 && !MANAGED_ASSET_PROJECTS.has(path.slice(6, cut));
}

export function managedAssetUrl(token: string): string | undefined {
  const match = /^asset-sync:([a-f0-9-]{32,36})$/i.exec(token);
  return match ? `/api/asset-sync/files/${encodeURIComponent(match[1])}` : undefined;
}

export function assetIdentity(ref: AssetReferenceIdentity): AssetReferenceIdentity {
  return {
    ...(ref.asset_content_id ? { asset_content_id: ref.asset_content_id } : {}),
    ...(ref.target_project_id ? { target_project_id: ref.target_project_id } : {}),
    ...(ref.server_location ? { server_location: ref.server_location } : {}),
  };
}

export function assetIdentityForProject(ref: AssetReferenceIdentity, projectId?: string): AssetReferenceIdentity {
  const identity = assetIdentity(ref);
  if (!projectId) return identity;
  return { ...identity, target_project_id: projectId,
    ...(identity.server_location && identity.server_location.project_id !== projectId ? { server_location: undefined } : {}) };
}

export function promoteAssetReference<T extends AssetReferenceIdentity & { file_path: string; type?: string; content_sha?: string; bytes?: number }>(
  ref: T, receipt: AssetSyncReceipt,
): T {
  if (isLiveProjectRef(ref) || receipt.state !== "ready" || !managedAssetUrl(receipt.file_path)
    || !/^sha256:[a-f0-9]{64}$/.test(receipt.asset_content_id)
    || (ref.asset_content_id || (ref.content_sha ? `sha256:${ref.content_sha}` : "")) !== receipt.asset_content_id
    || ref.target_project_id !== receipt.project_id
    || (ref.bytes && receipt.bytes && ref.bytes !== receipt.bytes)
    || (ref.server_location && (ref.server_location.owner_uid !== receipt.owner_uid
      || ref.server_location.storage_id !== receipt.storage_id
      || ref.server_location.server_origin !== receipt.server_origin
      || (ref.server_location.root_revision !== receipt.root_revision
        && receipt.supersedes_location_id !== ref.server_location.location_id)))) return ref;
  const location: AssetServerLocation = { location_id: receipt.location_id, project_id: receipt.project_id,
    owner_uid: receipt.owner_uid, storage_id: receipt.storage_id, root_revision: receipt.root_revision,
    server_origin: receipt.server_origin };
  if (ref.file_path === receipt.file_path && JSON.stringify(ref.server_location) === JSON.stringify(location)) return ref;
  return { ...ref, file_path: receipt.file_path, asset_content_id: receipt.asset_content_id, server_location: location };
}
