import type { ReactNode } from "react";

// 머리줄 아이콘 — 24 격자 한가운데(시안을 격리 화면에서 getBBox 로 맞추고 6배 캡처로 잰 값: 치우침 ≤ 0.08px).
// 평소 = 선(20px), 켜짐 = 투톤 채움(22px — 어두운 뒤판 + 밝은 앞면, 옛 초록 폴더 결). 둘 다 그려 두고 CSS(.lit)로 하나만 보인다 — 단추 크기가 흔들리지 않게.
// 머리줄 캡슐의 편집·Assets·관리(TopBar)와 알림 종(NotificationCenter)이 같이 쓴다.
export function TopIcon({ line, lit }: { line: ReactNode; lit: ReactNode }) {
  return (
    <>
      <svg className="top-ic-line" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {line}
      </svg>
      <svg className="top-ic-lit" width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        {lit}
      </svg>
    </>
  );
}

// 앞면 그라데이션 — 같은 문서에 여러 번 그려져도 id 가 겹치지 않게 인스턴스마다(FolderIcon 과 같은 방식).
export function Grad({ id, top, bottom, y1, y2 }: { id: string; top: string; bottom: string; y1: number; y2: number }) {
  return (
    <defs>
      <linearGradient id={id} x1="12" y1={y1} x2="12" y2={y2} gradientUnits="userSpaceOnUse">
        <stop stopColor={top} />
        <stop offset="1" stopColor={bottom} />
      </linearGradient>
    </defs>
  );
}
