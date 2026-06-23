// 결과물 다운로드 공용 헬퍼 — 카드 그리드·히스토리 보드·에셋 셀이 똑같이 복붙하던 것.
import type { Generation } from "../types";

// 같은 출처(/...) 로컬 보관본은 실제 파일로 내려받고, 원격 URL 은 download 속성이 무시되므로
// 새 탭으로 연다(앱 이탈 방지).
export function download(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  if (url.startsWith("/")) {
    a.download = name;
  } else {
    a.target = "_blank";
    a.rel = "noopener";
  }
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
