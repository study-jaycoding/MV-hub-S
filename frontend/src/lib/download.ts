// 결과물 다운로드 공용 헬퍼 — 카드 그리드·히스토리 보드·에셋 셀이 똑같이 복붙하던 것.
import type { Generation } from "../types";

// 다운로드 — bytes 를 받아 blob 으로 저장한다(파일명 보장 + 크롬 다운로드 목록 표시). 원격 URL
// (cloudfront 등)은 cross-origin 이라 a[download] 가 무시되지만, 힉스필드 CDN 이 CORS(*)를 허용하므로
// 브라우저가 직접 fetch 할 수 있다 → 백엔드 프록시 없이도(서버 재배포 불필요) 받아 저장된다.
// CORS 가 막힌 호스트면 같은 오리진 서버 프록시(/api/download)로, 그래도 안 되면 새 탭으로 폴백.
function _anchor(href: string, name?: string, newTab = false) {
  const a = document.createElement("a");
  a.href = href;
  if (name) a.download = name;
  if (newTab) {
    a.target = "_blank";
    a.rel = "noopener";
  }
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function _saveBlob(res: Response, name: string) {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blobUrl = URL.createObjectURL(await res.blob());
  _anchor(blobUrl, name);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

export async function download(url: string, name: string) {
  // 1) 직접 fetch — 로컬(/...)은 쿠키 동봉, 원격은 CDN CORS(*)로 그대로 받는다.
  try {
    await _saveBlob(await fetch(url, url.startsWith("/") ? { credentials: "include" } : {}), name);
    return;
  } catch {
    /* 로컬 실패 → 직접 다운로드, 원격 CORS 실패 → 프록시 시도 */
  }
  if (url.startsWith("/")) {
    _anchor(url, name);
    return;
  }
  // 2) 원격 CORS 가 막힌 경우 — 같은 오리진 서버 프록시(/api/download)로 받아 저장.
  try {
    await _saveBlob(
      await fetch(`/api/download?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`, {
        credentials: "include",
      }),
      name,
    );
    return;
  } catch {
    /* 프록시도 실패 → 최후로 새 탭 */
  }
  // 3) 최후 폴백 — 새 탭(다운로드 실패 메시지보다 낫다).
  _anchor(url, undefined, true);
}

// 메모리에서 만든 텍스트(예: .md 지시문)를 파일로 저장 — Blob+object URL.
export function downloadText(filename: string, text: string, mime = "text/plain") {
  const blob = new Blob([text], { type: mime + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// 다운로드 파일명 = 레퍼런스로 추가할 때 쓰는 이름(addRefFromGen 과 동일 규칙):
// 소스명(@이름) 우선, 없으면 'img-/vid-{id 앞 8자}'. 경로 금지문자는 _ 로. 타입별 확장자.
export function downloadName(gen: Generation, type: string): string {
  const isVid = type === "video";
  const base = (gen.source_name || `${isVid ? "vid" : "img"}-${gen.id.slice(0, 8)}`)
    .replace(/[\\/:*?"<>|]+/g, "_")
    .trim();
  return `${base || gen.id}.${isVid ? "mp4" : "png"}`;
}

// 여러 건 일괄 다운로드 — 고친 download() 를 순차 호출. 각 건이 fetch→blob 으로 완전히 받아
// 저장된 뒤 다음으로 넘어가고, 짧은 스태거로 브라우저의 '다중 다운로드 차단'을 회피한다.
export async function downloadMany(items: { url: string; name: string }[]) {
  for (const it of items) {
    await download(it.url, it.name);
    await new Promise((r) => setTimeout(r, 250));
  }
}
