// Windows 원본 파일 드래그와 구형 허브의 단건 URL 폴백. ZIP 드래그는 사용하지 않는다.
import { assetFileUrl } from "../../lib/assetUrls";
import { mimeOf } from "../../lib/media";
import { API_PAUSED_MESSAGE, getApiPause, subscribeApiPause } from "../../lib/http";
import { flashMsg } from "../../lib/flash";
import { api } from "../../api";
import { loadString, saveString } from "../../lib/storage";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import type { SpotlightAssetDragItem } from "../../lib/spotlightAssetRefs";

let nativeDragPending = false;

export function nativeDragBrowserSupported(): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) &&
    /Windows/.test(navigator.userAgent) && /(?:Chrome|Chromium|Edg)\//.test(navigator.userAgent);
}

export function startNativeAssetDrag(event: React.DragEvent, project: string, items: SpotlightAssetDragItem[]): (() => void) | null {
  event.preventDefault(); // Stop browser DownloadURL/img drag before starting the Windows drag.
  if (pausedExport() || nativeDragPending) return null;
  nativeDragPending = true;
  const payload = JSON.stringify(items);
  try { saveString(STORAGE_KEYS.assetsDrag, payload); } catch { /* native custom MIME remains available */ }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const unsubscribePause = subscribeApiPause(() => { if (getApiPause()) cancel(); });
  void api.nativeAssetDrag(project, items.map((item) => item.path), Date.now(), controller.signal)
    .then((result) => {
      if (result.reason === "expired" && !controller.signal.aborted) {
        flashMsg("원본 준비에 시간이 걸려 드래그를 시작하지 않았습니다. 다시 끌어주세요.");
      }
    })
    .catch((error) => { if (!controller.signal.aborted) flashMsg(String(error)); })
    .finally(() => {
      nativeDragPending = false;
      unsubscribePause();
      try {
        if (loadString(STORAGE_KEYS.assetsDrag) === payload) saveString(STORAGE_KEYS.assetsDrag, "");
      } catch { /* storage unavailable */ }
    });
  return cancel;
}

// 단일 파일(영상·오디오) — OS/탐색기로 내보내기 + URL 을 받는 웹앱용.
//  ※ 이미지 단건은 이 함수를 쓰지 않는다. 크롬 '네이티브 이미지 드래그'(img 가 소스일 때 크롬이
//    로컬 이미지를 직접 실어줌)에 맡겨야 외부 웹앱(클로드 대화창)이 파일로 받는다. 우리가 여기서
//    DownloadURL/html 로 dataTransfer 를 덮어쓰면 그 네이티브 이미지가 깨진다.
// 다른 탭 로그아웃 뒤 멈춘 창 — 끌어 내보내기 주소는 브라우저가 직접 받아 fetch 관문을 지나지 않는다. 주소를 싣지 않는다(Jay 결정 4B, Codex 2차).
function pausedExport(): boolean {
  if (!getApiPause()) return false;
  flashMsg(API_PAUSED_MESSAGE);
  return true;
}

export function setSingleFileDrag(dt: DataTransfer, project: string, path: string, name: string) {
  if (pausedExport()) return;
  const absUrl = location.origin + assetFileUrl(project, path);
  const mime = mimeOf(name);
  dt.effectAllowed = "copy";
  // OS·탐색기·네이티브 앱으로 내보내기(크롬 전용) — 드롭 위치에 원본 파일이 그대로 저장된다.
  dt.setData("DownloadURL", `${mime}:${name}:${absUrl}`);
  // URL 을 받는 웹앱/에디터용 표준 타입(로컬 URL 이라 원격 앱이 못 가져올 수 있음 — 보조).
  dt.setData("text/uri-list", absUrl);
  dt.setData("text/plain", absUrl);
}
