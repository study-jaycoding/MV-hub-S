// 네이티브 OS 드래그-내보내기용 DownloadURL 구성.
// 드롭한 폴더/앱에 파일이 그대로 저장된다(Chrome DownloadURL: "mimetype:filename:url").
// 단일 = 원본 파일 그대로, 다중 = 백엔드가 묶어주는 zip 한 건.
import { assetFileUrl, assetZipUrl } from "../../lib/assetUrls";
import { mimeOf } from "../../lib/media";

// 단일 파일 — 원본을 드롭 위치에 그대로 저장.
export function setSingleFileDrag(dt: DataTransfer, project: string, path: string, name: string) {
  const absUrl = location.origin + assetFileUrl(project, path);
  dt.effectAllowed = "copy";
  dt.setData("DownloadURL", `${mimeOf(name)}:${name}:${absUrl}`);
}

// 여러 파일 — 백엔드 zip 스트리밍 URL. 드롭 시 assets-N.zip 으로 저장.
export function setZipDrag(dt: DataTransfer, project: string, paths: string[]) {
  const url = location.origin + assetZipUrl(project, paths);
  dt.effectAllowed = "copy";
  dt.setData("DownloadURL", `application/zip:assets-${paths.length}.zip:${url}`);
}
