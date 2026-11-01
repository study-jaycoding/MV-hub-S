// 캔버스 노드 종류 아이콘 — Tab 메뉴의 색 칸과 네비게이터 칸이 같이 쓴다(Jay 2026-11-02 C안).
//  색은 currentColor 라 바탕에 맞는 색은 쓰는 쪽(scene.css)이 정한다.
//  New 는 빈 노드에 보이는 힉스필드 로고(그림 파일을 마스크로 칠한다), Comfy 는 로고의 C 한 글자(파일은 글자가 이어진 워드마크).
import type { ReactNode } from "react";
import type { SceneCardKind } from "../../lib/scenes";

const LINE_ICONS: Record<Exclude<SceneCardKind, "generation" | "comfy">, ReactNode> = {
  model: (
    <>
      <path d="M4 7h9M18 7h2M4 17h2M11 17h9" />
      <circle cx="15.5" cy="7" r="2.5" />
      <circle cx="8.5" cy="17" r="2.5" />
    </>
  ),
  text: <path d="M4 8V5h16v3M12 5v14M8.5 19h7" />,
  set: <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2.5 2.5h7A2.5 2.5 0 0 1 21 10v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17z" />,
  list: <path d="M9 6h12M9 12h12M9 18h12M3.5 6h.5M3.5 12h.5M3.5 18h.5" />,
  render: <path d="M3.5 5.5l8.5 6.5-8.5 6.5zM12.5 5.5L21 12l-8.5 6.5z" />,
  view: (
    <>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  input: <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M3 12h12M11 8l4 4-4 4" />,
  output: <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M9 12h12M17 8l4 4-4 4" />,
  head: <path d="M6 4.5v15M18 4.5v15M6 12h12" />,
  reference: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <circle cx="8.5" cy="9.5" r="1.6" />
      <path d="M21 15.5l-4.8-4.8L6 20" />
    </>
  ),
};

const COMFY_C =
  "M30.5 0H54c3 0 5.3 2.4 4.4 5.5l-2.9 10c-.9 3.3-4 5.5-7 5.5H29c-.8 0-1.4.5-1.7 1.3L22.2 40c-.3 1.1.5 2 1.6 2h18.7c2.9 0 4.7 2.2 3.9 5l-2.9 10c-1 3.5-4 6-7.5 6H13c-2.8 0-4.5-2.2-3.8-4.7l1.8-6.6c.3-1.3-.5-2.5-1.5-2.5H4.3c-2.8 0-4.8-2.2-4.1-5.2L7 19.7C8 16.2 11 14 14.5 14h5.9c.7 0 1.3-.5 1.6-1.3l2.2-7.2C25.2 2.2 27.6 0 30.5 0z";

export function SceneNodeIcon({ kind, size, stroke = 2.4 }: { kind: SceneCardKind; size: number; stroke?: number }) {
  if (kind === "generation") return <span className="scene-node-logo" style={{ width: size, height: size }} />;
  if (kind === "comfy") {
    return (
      <svg viewBox="-2 0 63 63" width={size} height={size} fill="currentColor" aria-hidden="true">
        <path d={COMFY_C} />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {LINE_ICONS[kind]}
    </svg>
  );
}
