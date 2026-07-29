import { withQuery } from "./url";

export { withQuery };

export function assetTreeUrl(project: string, fresh = false): string {
  // fresh=true 면 백엔드 10초 트리 캐시를 건너뛰고 다시 훑는다(변경된 파일 버전 즉시 반영 — 창 포커스 재조회).
  return withQuery("/api/assets/tree", fresh ? { project, fresh: 1 } : { project });
}

export function assetFileUrl(project: string, path: string): string {
  return withQuery("/api/assets/file", { project, path });
}

export function assetThumbUrl(
  project: string,
  path: string,
  w = 512,
  version?: string | null,
): string {
  // version(파일 수정시각 나노초+크기)이 있으면 v 로 붙인다 → 원본이 바뀌면 URL 이 바뀌어 새 썸네일 로드.
  // version 이 없으면 고정 버스터 b 를 붙인다 — 과거 빌드가 v 없는 주소로 옛 썸네일을 브라우저에
  // 30일 immutable 캐시해 둔 게 있어, 주소를 바꿔야 그 박제 캐시를 우회해 서버 재검증(no-cache)을 탄다.
  return withQuery(
    "/api/assets/thumb",
    version ? { project, path, w, v: version } : { project, path, w, b: 1 },
  );
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
