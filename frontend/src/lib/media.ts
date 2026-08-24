// 공용 미디어 헬퍼 — History 보드/패널/미니트리에 동일하게 복붙돼 있던 thumbOf 를 통합.
import type { SyntheticEvent } from "react";
import { api } from "../api";
import { getAssetVersion } from "./assetVersions";
import type { Generation } from "../types";

// 썸네일 로드 실패 시 공용 폴백 — 깨진 이미지 아이콘 대신 조용히 숨겨 컨테이너 배경(플레이스홀더)이 보이게.
// media-thumb 프록시가 실패 시 원본으로 리다이렉트하는데 그 원본마저 브라우저에서 막히는 최종 케이스 방어.
export function hideBrokenImg(e: SyntheticEvent<HTMLImageElement>): void {
  e.currentTarget.style.visibility = "hidden";
}

// hideBrokenImg 의 짝 — 숨김은 React 밖에서 직접 건 스타일이라, 이후 src 가 (버전 갱신 등으로)
// 새 URL 로 바뀌어 로드에 성공해도 React 가 안 되돌린다 → 새로고침 전까지 빈 칸으로 남는다.
// onLoad 에 이걸 달아 성공하면 다시 보이게 한다. onError={hideBrokenImg} 인 img 는 반드시 함께 쓸 것.
export function showLoadedImg(e: SyntheticEvent<HTMLImageElement>): void {
  e.currentTarget.style.visibility = "";
}

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
  // OS/브라우저 조합에 따라 파일 드래그 표시는 `Files`의 대소문자가 달라지거나,
  // dragover 시점에 types 대신 items/files 에만 잡힐 수 있다. 한 신호만 믿으면 Chrome이
  // 파일을 앱에 드롭하지 않고 새 탭으로 여는 기본 동작으로 빠질 수 있어 세 경로를 모두 본다.
  if (Array.from(dataTransfer.types || []).some((type) => type.toLowerCase() === "files")) return true;
  if ((dataTransfer.files?.length || 0) > 0) return true;
  return Array.from(dataTransfer.items || []).some((item) => item.kind === "file");
}

export function filesFromDataTransfer(dataTransfer: DataTransfer): File[] {
  // drop 시점의 files 가 표준 경로다. 일부 Chromium/Windows 드래그 소스에서는 이 목록이
  // 비고 items 에만 File이 남으므로 getAsFile 폴백으로 실제 파일을 복원한다.
  const direct = Array.from(dataTransfer.files || []);
  if (direct.length) return direct;

  const files: File[] = [];
  const seen = new Set<File>();
  for (const item of Array.from(dataTransfer.items || [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && !seen.has(file)) {
      seen.add(file);
      files.push(file);
    }
  }
  return files;
}

export function thumbUrl(path: string | null | undefined, size = 256): string | null {
  if (!path) return null;
  // 저장값(생성 ref 의 thumbnail_path 등)에 v 없는 /api/assets/thumb 원시 URL 이 남아 있다 —
  // 과거 빌드가 그 주소로 옛 썸네일을 브라우저에 장기 캐시해 둬서 그대로 쓰면 옛 이미지가 뜬다.
  // project/path 를 꺼내 전역 버전표 기반 URL 로 재생성한다(버전 없으면 b 버스터로 재검증 경로).
  if (path.startsWith("/api/assets/thumb")) {
    try {
      const u = new URL(path, window.location.origin);
      const proj = u.searchParams.get("project");
      const p = u.searchParams.get("path");
      if (proj && p) return api.assetThumbUrl(proj, p, size, getAssetVersion(proj, p));
    } catch {
      /* 파싱 실패 시 원시 URL 그대로(아래 폴백) */
    }
  }
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
    // 전역 버전 표에 최신 버전이 있으면 붙인다 → 원본이 바뀌면 URL 이 바뀌어 새 썸네일을 불러온다.
    return proj && path ? api.assetThumbUrl(proj, path, size, getAssetVersion(proj, path)) : null;
  }
  // /api/assets/file(원본 파일 서빙)는 '이미 프록시'가 아니라 원본 → 에셋 썸네일로 변환(원본 통째 디코딩 방지).
  if (pathOrToken.startsWith("/api/assets/file")) {
    try {
      const u = new URL(pathOrToken, window.location.origin);
      const proj = u.searchParams.get("project");
      const path = u.searchParams.get("path");
      if (proj && path) return api.assetThumbUrl(proj, path, size, getAssetVersion(proj, path));
    } catch {
      /* 파싱 실패 시 아래 폴백 */
    }
  }
  return thumbUrl(pathOrToken, size); // /media·http → 프록시, /api/assets/thumb → 버전표 재생성, /api/media-thumb 등은 raw 유지
}

// 레퍼런스(캔버스 카드·프롬프트 트레이·인라인 칩·토큰 알약) 썸네일 URL — 저장된 thumb(버전 고정 URL)
// 대신 asset 소스면 file_path 로 재생성해 전역 버전 표의 최신 버전(v)을 붙인다(원본이 바뀌면 새 썸네일).
// asset: 토큰뿐 아니라 옛 저장분의 /api/assets/file 형태도 asset 원본으로 본다. 그 외(원격 URL 등)만
// 저장 thumb 폴백. 오디오는 썸네일이 없어 undefined(깨진 <img> 방지). SceneBoard·프롬프트 계열 공용.
export function displayRefThumb(
  ref: { file_path?: string | null; thumb?: string | null; type?: string | null },
  size = 256,
): string | undefined {
  if (ref.type === "audio") return undefined;
  const fp = ref.file_path || "";
  const isAssetSrc = fp.startsWith("asset:") || fp.startsWith("/api/assets/file");
  // 원격 영상 원본만 있고 포스터가 없으면 media-thumb가 최대 128MB를 받으려 시도할 수 있다.
  // 그 경우는 undefined로 두어 MediaThumbnail의 Range metadata 폴백을 사용한다. 보존된 /media와
  // 에셋 영상은 서버가 로컬 파일에서 포스터를 싸게 만들 수 있으므로 원본 경로를 썸네일 입력으로 쓴다.
  const videoFallback = fp.startsWith("/media/") || isAssetSrc ? fp : "";
  const raw = ref.type === "video"
    ? ref.thumb || videoFallback
    : isAssetSrc
      ? fp
      : ref.thumb || fp;
  return displayThumb(raw, size) ?? undefined;
}

// 생성본의 대표 썸네일 URL(없으면 null). 로컬 /media·공유받은 원격 URL 모두 리사이즈 썸네일로 변환.
export function thumbOf(g: Generation, size = 256): string | null {
  const a = g.assets[0];
  // 영상도 포스터가 없으면 원본 경로를 media-thumb에 넘긴다. media-thumb는 첫 프레임을
  // JPEG로 디스크 캐시하므로, 카드가 다시 마운트될 때마다 <video preload=metadata>가
  // 원본 Range를 재요청·디코딩하는 비용을 피한다. Generation asset 타입은 이미지/영상만 온다.
  return mediaThumbUrl(a?.file_path, a?.thumbnail_path, a?.type, size);
}

// DB/관리 API가 영상 포스터를 별도 필드에 저장하지 않은 경우에도 동일한 표시 규칙을 쓴다.
// 생성 카드 외의 작업 보드·캘린더 등이 제각각 원본 영상을 직접 읽지 않게 하는 공용 관문.
export function mediaThumbUrl(
  filePath: string | null | undefined,
  thumbnailPath: string | null | undefined,
  type: string | null | undefined,
  size = 256,
): string | null {
  if (type === "audio") return null;
  if (type === "video" && !thumbnailPath && filePath?.startsWith("http")) return null;
  return thumbUrl(thumbnailPath || filePath, size);
}
