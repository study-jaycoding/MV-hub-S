// 네이티브 OS 드래그-내보내기용 DownloadURL 구성.
// 드롭한 폴더/앱에 파일이 그대로 저장된다(Chrome DownloadURL: "mimetype:filename:url").
// 단일 = 원본 파일 그대로, 다중 = 백엔드가 묶어주는 zip 한 건.
import { api } from "../../api";

// 확장자 → MIME. 미상은 octet-stream(파일명에 확장자가 있어 저장엔 무방).
const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  gif: "image/gif", bmp: "image/bmp",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  mkv: "video/x-matroska", avi: "video/x-msvideo",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
  flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac",
};
function mimeOf(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return MIME[ext] || "application/octet-stream";
}

// 단일 파일 — 원본을 드롭 위치에 그대로 저장.
export function setSingleFileDrag(dt: DataTransfer, project: string, path: string, name: string) {
  const absUrl = location.origin + api.assetFileUrl(project, path);
  dt.effectAllowed = "copy";
  dt.setData("DownloadURL", `${mimeOf(name)}:${name}:${absUrl}`);
}

// 여러 파일 — 백엔드 zip 스트리밍 URL. 드롭 시 assets-N.zip 으로 저장.
export function setZipDrag(dt: DataTransfer, project: string, paths: string[]) {
  const qs = paths.map((p) => `paths=${encodeURIComponent(p)}`).join("&");
  const url = `${location.origin}/api/assets/zip?project=${encodeURIComponent(project)}&${qs}`;
  dt.effectAllowed = "copy";
  dt.setData("DownloadURL", `application/zip:assets-${paths.length}.zip:${url}`);
}
