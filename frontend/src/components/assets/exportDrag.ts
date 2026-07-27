// 네이티브 OS 드래그-내보내기용 DownloadURL 구성.
// 드롭한 폴더/앱에 파일이 그대로 저장된다(Chrome DownloadURL: "mimetype:filename:url").
// 단일 = 원본 파일 그대로, 다중 = 백엔드가 묶어주는 zip 한 건.
import { assetFileUrl, assetZipUrl } from "../../lib/assetUrls";
import { mimeOf } from "../../lib/media";

// ── 원본 파일 프리페치 캐시 ──────────────────────────────────────────────
// dragstart 순간엔 비동기 fetch 를 기다릴 수 없다. 그래서 셀에 마우스를 올리거나(hover) 누를 때
// 원본을 로컬 허브(우리 페이지와 같은 오리진 → 항상 접근 가능)에서 미리 받아 File 로 만들어 둔다.
// 드래그 시작 때 이 File 을 dataTransfer 에 실으면 '진짜 파일 첨부'가 되어, 파일 업로드형
// 드롭존(예: 클로드 대화창)이 그대로 받는다. (원본 경로/파일을 실제로 활용하는 방식)
const originalFileCache = new Map<string, File>();
const inflightPrefetch = new Set<string>();
const PREFETCH_CAP = 8; // 최근 몇 개만 보관(메모리 방어)

function fileKey(project: string, path: string) {
  return project + "\n" + path;
}

// 이미지·오디오만 미리 받는다 — 영상 원본은 커서 hover 마다 받으면 낭비(영상은 DownloadURL/네이티브로).
export function prefetchOriginalFile(project: string, path: string, name: string) {
  const mime = mimeOf(name);
  if (!(mime.startsWith("image/") || mime.startsWith("audio/"))) return;
  const key = fileKey(project, path);
  if (originalFileCache.has(key) || inflightPrefetch.has(key)) return;
  inflightPrefetch.add(key);
  fetch(assetFileUrl(project, path), { credentials: "same-origin" })
    .then((r) => (r.ok ? r.blob() : null))
    .then((blob) => {
      if (!blob) return;
      if (originalFileCache.size >= PREFETCH_CAP) {
        const oldest = originalFileCache.keys().next().value; // 가장 오래된 것부터 제거(삽입순)
        if (oldest !== undefined) originalFileCache.delete(oldest);
      }
      originalFileCache.set(key, new File([blob], name, { type: mime || blob.type }));
    })
    .catch(() => {})
    .finally(() => inflightPrefetch.delete(key));
}

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
  // ③ 미리 받아둔 원본이 있으면 '진짜 파일'로 실어 준다 — 파일 업로드형 드롭존(대화창 등)이 첨부로 받는다.
  //    (hover/누름 때 prefetchOriginalFile 이 채워둔다. 아직 준비 전이면 위 표준 타입으로 폴백.)
  const cached = originalFileCache.get(fileKey(project, path));
  if (cached) {
    try {
      dt.items.add(cached);
    } catch {
      /* DataTransferItemList.add 미지원 브라우저는 무시(표준 타입으로 폴백) */
    }
  }
}

// 여러 파일 — 백엔드 zip 스트리밍 URL. 드롭 시 assets-N.zip 으로 저장.
export function setZipDrag(dt: DataTransfer, project: string, paths: string[]) {
  const url = location.origin + assetZipUrl(project, paths);
  dt.effectAllowed = "copy";
  dt.setData("DownloadURL", `application/zip:assets-${paths.length}.zip:${url}`);
}
