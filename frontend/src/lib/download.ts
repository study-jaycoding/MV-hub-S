// 결과물 다운로드 공용 헬퍼 — 카드 그리드·히스토리 보드·에셋 셀이 똑같이 복붙하던 것.
import type { Generation } from "../types";

// 로컬 보관본(/...)은 같은 오리진이라 a[download] 로 바로 받는다. 원격 URL(cloudfront 등)은
// 브라우저가 cross-origin 에서 download 속성을 무시해 '다운로드' 대신 새 탭으로 열리므로,
// 같은 오리진 프록시(/api/download)로 받아 attachment 로 내려받게 한다 → 크롬 다운로드 목록에 표시.
export function download(url: string, name: string) {
  const a = document.createElement("a");
  if (url.startsWith("/")) {
    a.href = url;
  } else {
    a.href = `/api/download?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`;
  }
  a.download = name; // 프록시도 같은 오리진이라 download 속성이 동작(+서버 Content-Disposition)
  document.body.appendChild(a);
  a.click();
  a.remove();
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
