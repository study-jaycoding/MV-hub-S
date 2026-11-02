import { useId } from "react";

// 폴더 색 — 초록 = 기본·프로젝트 폴더, 파랑 = 직접 등록한 폴더, 빨강 = 찾을 수 없는 폴더(Jay 2026-11-02). 뒤판·앞면 위·앞면 아래 순서.
const TONES = {
  green: ["#4c9260", "#7fd48c", "#53a667"],
  blue: ["#3f73b5", "#83b8f7", "#4f8ddb"],
  red: ["#a8424a", "#ff9090", "#e05a5a"],
} as const;
export type FolderTone = keyof typeof TONES;

/** Assets 폴더 아이콘 — 상단 진입 버튼과 어셋 분리창 머리글 공용(투톤 SVG).
 * width/height 는 아이콘이 차지하는 박스(구 assets-thumb 자리 크기 유지용) — 그림은
 * 비율을 지키며 그 안에 맞춰진다(버튼 크기가 아이콘 교체로 변하지 않게). */
export function FolderIcon({ width = 26, height = 22, tone = "green" }: { width?: number; height?: number; tone?: FolderTone }) {
  // 같은 문서에 두 개 이상 렌더돼도 그라데이션 id가 충돌하지 않게 인스턴스별 id를 쓴다.
  const gradientId = useId();
  const [back, frontTop, frontBottom] = TONES[tone];
  return (
    <svg width={width} height={height} viewBox="0 0 24 19" fill="none" aria-hidden="true">
      <path
        d="M1.5 3.9C1.5 2.7 2.5 1.7 3.7 1.7h5c.6 0 1.2.25 1.6.7l1.3 1.4h8.7c1.2 0 2.2 1 2.2 2.2v9.1c0 1.2-1 2.2-2.2 2.2H3.7c-1.2 0-2.2-1-2.2-2.2V3.9Z"
        fill={back}
      />
      <path
        d="M1.5 7.6h21v7.5c0 1.2-1 2.2-2.2 2.2H3.7c-1.2 0-2.2-1-2.2-2.2V7.6Z"
        fill={`url(#${gradientId})`}
      />
      <defs>
        <linearGradient
          id={gradientId}
          x1="12"
          y1="7.6"
          x2="12"
          y2="17.3"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor={frontTop} />
          <stop offset="1" stopColor={frontBottom} />
        </linearGradient>
      </defs>
    </svg>
  );
}
