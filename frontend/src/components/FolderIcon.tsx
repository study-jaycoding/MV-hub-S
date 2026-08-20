import { useId } from "react";

/** Assets 폴더 아이콘 — 상단 진입 버튼과 어셋 분리창 머리글 공용(투톤 초록 SVG). */
export function FolderIcon({ size = 20 }: { size?: number }) {
  // 같은 문서에 두 개 이상 렌더돼도 그라데이션 id가 충돌하지 않게 인스턴스별 id를 쓴다.
  const gradientId = useId();
  const height = Math.round(size * 0.8);
  return (
    <svg width={size} height={height} viewBox="0 0 24 19" fill="none" aria-hidden="true">
      <path
        d="M1.5 3.9C1.5 2.7 2.5 1.7 3.7 1.7h5c.6 0 1.2.25 1.6.7l1.3 1.4h8.7c1.2 0 2.2 1 2.2 2.2v9.1c0 1.2-1 2.2-2.2 2.2H3.7c-1.2 0-2.2-1-2.2-2.2V3.9Z"
        fill="#4c9260"
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
          <stop stopColor="#7fd48c" />
          <stop offset="1" stopColor="#53a667" />
        </linearGradient>
      </defs>
    </svg>
  );
}
