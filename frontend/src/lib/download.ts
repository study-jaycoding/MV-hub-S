// 결과물 다운로드 공용 헬퍼 — 카드 그리드·히스토리 보드·에셋 셀이 똑같이 복붙하던 것.
import type { Generation } from "../types";

// 다운로드 — 항상 같은 오리진에서 bytes 를 받아 blob 으로 저장한다(파일명 보장 + 크롬 다운로드
// 목록 표시). 원격 URL(cloudfront 등)은 cross-origin 이라 a[download] 가 무시되므로 서버 프록시
// (/api/download)로 받는다. 프록시가 없거나(미배포) 실패하면 폴백: 원격은 새 탭, 로컬은 직접 다운로드
// — '사이트를 사용할 수 없음' 같은 실패 메시지 대신 최소 동작을 보장한다.
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

export async function download(url: string, name: string) {
  const src = url.startsWith("/")
    ? url
    : `/api/download?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`;
  try {
    const res = await fetch(src, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    _anchor(blobUrl, name);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  } catch {
    // 폴백: 로컬은 직접 a[download], 원격은 새 탭(다운로드 실패 메시지보다 낫다).
    if (url.startsWith("/")) _anchor(url, name);
    else _anchor(url, undefined, true);
  }
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

// 다운로드 파일명: 프롬프트(없으면 id) 앞 40자 + 타입별 확장자. 경로 금지문자는 _ 로.
export function downloadName(gen: Generation, type: string): string {
  const base = (gen.prompt || gen.id).slice(0, 40).replace(/[\\/:*?"<>|]+/g, "_").trim();
  const ext = type === "video" ? "mp4" : "png";
  return `${base || gen.id}.${ext}`;
}
