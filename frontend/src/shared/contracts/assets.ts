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

export function promoteAssetReference<T extends AssetReferenceIdentity & { file_path: string; content_sha?: string; bytes?: number }>(
  ref: T, receipt: AssetSyncReceipt,
): T {
  if (receipt.state !== "ready" || !managedAssetUrl(receipt.file_path)
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
