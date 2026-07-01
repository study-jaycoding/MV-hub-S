import { withQuery } from "./url";

export { withQuery };

export function assetTreeUrl(project: string): string {
  return withQuery("/api/assets/tree", { project });
}

export function assetFileUrl(project: string, path: string): string {
  return withQuery("/api/assets/file", { project, path });
}

export function assetThumbUrl(project: string, path: string, w = 512): string {
  return withQuery("/api/assets/thumb", { project, path, w });
}

export function assetMetaUrl(project: string): string {
  return withQuery("/api/assets/meta", { project });
}

export function assetCommentsUrl(project: string, path: string): string {
  return withQuery("/api/assets/comments", { project, path });
}

export function assetZipUrl(project: string, paths: string[]): string {
  return withQuery("/api/assets/zip", { project, paths });
}
