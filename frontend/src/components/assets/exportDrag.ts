// 네이티브 OS 드래그-내보내기용 DownloadURL 구성.
// 드롭한 폴더/앱에 파일이 그대로 저장된다(Chrome DownloadURL: "mimetype:filename:url").
// 단일 = 원본 파일 그대로, 다중 = 백엔드가 묶어주는 zip 한 건.
import { assetFileUrl, assetZipUrl } from "../../lib/assetUrls";
import { mimeOf } from "../../lib/media";

// 단일 파일 — 원본을 드롭 위치에 그대로 저장.
export function setSingleFileDrag(dt: DataTransfer, project: string, path: string, name: string) {
  const absUrl = location.origin + assetFileUrl(project, path);
  const mime = mimeOf(name);
  dt.effectAllowed = "copy";
  // ① OS·탐색기·네이티브 앱으로 내보내기(크롬 전용) — 드롭 위치에 원본 파일이 그대로 저장된다.
  dt.setData("DownloadURL", `${mime}:${name}:${absUrl}`);
  // ② 웹앱 드롭존(채팅 입력창·에디터 등)이 읽는 표준 타입도 함께 심는다 — DownloadURL 만 있으면
  //    웹앱은 아무것도 못 받아 드래그가 무시된다. 이미지는 <img> HTML 로(리치 에디터가 그대로 삽입),
  //    공통은 절대 URL 로 넘긴다. 대상 앱이 URL/HTML 드롭을 받으면 그 이미지를 인식한다.
  dt.setData("text/uri-list", absUrl);
  dt.setData("text/plain", absUrl);
  if (mime.startsWith("image/")) {
    const alt = name.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    dt.setData("text/html", `<img src="${absUrl}" alt="${alt}">`);
  }
}

// 여러 파일 — 백엔드 zip 스트리밍 URL. 드롭 시 assets-N.zip 으로 저장.
export function setZipDrag(dt: DataTransfer, project: string, paths: string[]) {
  const url = location.origin + assetZipUrl(project, paths);
  dt.effectAllowed = "copy";
  dt.setData("DownloadURL", `application/zip:assets-${paths.length}.zip:${url}`);
}
