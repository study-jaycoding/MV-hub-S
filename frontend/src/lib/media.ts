// 공용 미디어 헬퍼 — History 보드/패널/미니트리에 동일하게 복붙돼 있던 thumbOf 를 통합.
import { api } from "../api";
import type { Generation } from "../types";

export type ReferenceMediaType = "image" | "video" | "audio";

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"] as const;
export const VIDEO_EXTENSIONS = ["mp4", "mov", "webm", "mkv", "avi"] as const;
export const AUDIO_EXTENSIONS = ["mp3", "wav", "ogg", "flac", "m4a", "aac"] as const;

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
};

function extOf(name: string): string {
  return name.split(".").pop()?.toLowerCase() || "";
}

export function mimeOf(name: string): string {
  return MIME_BY_EXT[extOf(name)] || "application/octet-stream";
}

export function referenceMediaTypeFromName(name: string): ReferenceMediaType | null {
  const ext = extOf(name);
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return "image";
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(ext)) return "video";
  if ((AUDIO_EXTENSIONS as readonly string[]).includes(ext)) return "audio";
  return null;
}

export function referenceMediaTypeFromFile(file: File): ReferenceMediaType | null {
  const mt = (file.type || "").toLowerCase();
  if (mt.startsWith("image/")) return "image";
  if (mt.startsWith("video/")) return "video";
  if (mt.startsWith("audio/")) return "audio";
  return referenceMediaTypeFromName(file.name);
}

export function dataTransferHasFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes("Files");
}

export function thumbUrl(path: string | null | undefined, size = 256): string | null {
  if (!path) return null;
  return api.thumbOrRaw(path, size);
}

// display 전용 썸네일 URL — '볼 때'는 작은 캐시본으로 빠르고 안 깨지게. 저장값(원본)은 그대로 두고
// 렌더 시점에만 프록시화한다(원칙: display=캐시썸네일 / 실제사용·다운로드=원본).
//  · asset:proj|path 토큰 → 에셋 썸네일(백엔드 리사이즈, 영상은 첫 프레임 포스터)
//  · /media·http(s) → media-thumb 프록시(리사이즈+디스크캐시+same-origin) — 원격 만료·교차출처 깨짐 방지
//  · 이미 프록시(/api/…) URL 이면 그대로(중복 래핑·옛 저장값 호환), 오디오/빈값 → null
export function displayThumb(pathOrToken: string | null | undefined, size = 256): string | null {
  if (!pathOrToken) return null;
  if (pathOrToken.startsWith("asset:")) {
    const [proj, path] = pathOrToken.slice(6).split("|");
    return proj && path ? api.assetThumbUrl(proj, path, size) : null;
  }
  // /api/assets/file(원본 파일 서빙)는 '이미 프록시'가 아니라 원본 → 에셋 썸네일로 변환(원본 통째 디코딩 방지).
  if (pathOrToken.startsWith("/api/assets/file")) {
    try {
      const u = new URL(pathOrToken, window.location.origin);
      const proj = u.searchParams.get("project");
      const path = u.searchParams.get("path");
      if (proj && path) return api.assetThumbUrl(proj, path, size);
    } catch {
      /* 파싱 실패 시 아래 폴백 */
    }
  }
  return thumbUrl(pathOrToken, size); // /media·http → 프록시, /api/assets/thumb·/api/media-thumb 등은 raw 유지
}

// 생성본의 대표 썸네일 URL(없으면 null). 로컬 /media·공유받은 원격 URL 모두 리사이즈 썸네일로 변환.
export function thumbOf(g: Generation, size = 256): string | null {
  const a = g.assets[0];
  const raw = a?.thumbnail_path || (a?.type !== "video" ? a?.file_path : null) || null;
  return thumbUrl(raw, size);
}
