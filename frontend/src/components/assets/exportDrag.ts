// 네이티브 OS 드래그-내보내기용 DownloadURL 구성.
// 드롭한 폴더/앱에 파일이 그대로 저장된다(Chrome DownloadURL: "mimetype:filename:url").
// 단일 = 원본 파일 그대로, 다중 = 백엔드가 묶어주는 zip 한 건.
import { assetFileUrl, assetZipUrl } from "../../lib/assetUrls";
import { mimeOf } from "../../lib/media";

// 단일 파일(영상·오디오) — OS/탐색기로 내보내기 + URL 을 받는 웹앱용.
//  ※ 이미지 단건은 이 함수를 쓰지 않는다. 크롬 '네이티브 이미지 드래그'(img 가 소스일 때 크롬이
//    로컬 이미지를 직접 실어줌)에 맡겨야 외부 웹앱(클로드 대화창)이 파일로 받는다. 우리가 여기서
//    DownloadURL/html 로 dataTransfer 를 덮어쓰면 그 네이티브 이미지가 깨진다.
export function setSingleFileDrag(dt: DataTransfer, project: string, path: string, name: string) {
  const absUrl = location.origin + assetFileUrl(project, path);
  const mime = mimeOf(name);
  dt.effectAllowed = "copy";
  // OS·탐색기·네이티브 앱으로 내보내기(크롬 전용) — 드롭 위치에 원본 파일이 그대로 저장된다.
  dt.setData("DownloadURL", `${mime}:${name}:${absUrl}`);
  // URL 을 받는 웹앱/에디터용 표준 타입(로컬 URL 이라 원격 앱이 못 가져올 수 있음 — 보조).
  dt.setData("text/uri-list", absUrl);
  dt.setData("text/plain", absUrl);
}

// 여러 파일 — 백엔드 zip 스트리밍 URL. 드롭 시 assets-N.zip 으로 저장.
export function setZipDrag(dt: DataTransfer, project: string, paths: string[]) {
  const url = location.origin + assetZipUrl(project, paths);
  dt.effectAllowed = "copy";
  dt.setData("DownloadURL", `application/zip:assets-${paths.length}.zip:${url}`);
}
