// 16px — 15px 이면 선이 반 픽셀에 걸려 단추 가운데서 0.5px 아래로 그려졌다(2026-09-22 픽셀 실측).
const TOGGLE_ICON = {
  viewBox: "0 0 24 24",
  width: 16,
  height: 16,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function ListIcon() {
  return (
    <svg {...TOGGLE_ICON}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
    </svg>
  );
}
// 보관 기록 — 뚜껑 있는 상자 안에 시곗바늘(작업 탭 머리글).
export function ArchiveHistoryIcon() {
  return (
    <svg {...TOGGLE_ICON}>
      <rect x="3" y="3.5" width="18" height="4.5" rx="1.5" />
      <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
      <path d="M12 11v3.2l2.2 1.4" />
    </svg>
  );
}
// 꽉 채우기(속 찬 네모)·전체 보기(빈 네모). 글자 ▣ 는 기준선 탓에 1.6px 아래였다(2026-09-22 픽셀 실측).
// 틀은 다른 토글(리스트·그리드)과 같은 18 칸, 채움은 그 안을 거의 메운다 — 5.3px 점은 '꽉 참'으로
// 읽히지 않았다(Jay 2026-09-28).
export function FitIcon({ filled }: { filled: boolean }) {
  return (
    <svg {...TOGGLE_ICON} strokeWidth={1.5}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      {filled && <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />}
    </svg>
  );
}
// 필터 사이드바 열림(빈 네모)·닫힘(오른쪽 세모). 글자 ▢·▷ 는 1.3px 아래였다(2026-09-22 실측). 세모는 네모 칸 가운데.
export function FilterPanelIcon({ open }: { open: boolean }) {
  return (
    <svg {...TOGGLE_ICON} strokeWidth={1.5}>
      {open ? <rect x="3.75" y="3.75" width="16.5" height="16.5" rx="1.5" /> : <path d="M6.5 4.5 17.5 12 6.5 19.5Z" />}
    </svg>
  );
}
// 정보(ⓘ) — 글자 ⓘ 는 폴백 글꼴 탓에 1px 아래였고, 손으로 넣은 padding 보정도 글꼴 따라 틀어졌다(2026-09-22 실측).
export function InfoIcon() {
  return (
    <svg {...TOGGLE_ICON} strokeWidth={1.5}>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16.5" />
      <circle cx="12" cy="7.6" r="0.6" fill="currentColor" />
    </svg>
  );
}
// 빼기·더하기 — 글자 −/+ 는 1.5~2.4px 아래였다(2026-09-22 실측). 기본은 캔버스 카드 배치(굵게), 줌은 8px·선 2.
export function StepIcon({ plus, size = 12, stroke = 3 }: { plus?: boolean; size?: number; stroke?: number }) {
  return (
    <svg {...TOGGLE_ICON} width={size} height={size} strokeWidth={stroke}>
      <line x1="5" y1="12" x2="19" y2="12" />
      {plus && <line x1="12" y1="5" x2="12" y2="19" />}
    </svg>
  );
}
// 닫기 — 글자 ✕·× 는 1.3~1.5px 아래였다(2026-09-22 실측). 크기는 옛 글자의 잉크 높이에 맞춘 값.
export function CloseIcon({ size = 20 }: { size?: number }) {
  return (
    <svg {...TOGGLE_ICON} width={size} height={size} aria-hidden="true">
      <path d="M6 6 18 18M18 6 6 18" />
    </svg>
  );
}
// 창 크게(□)·원래 크기(❐) — 글자는 3.4px 아래였다(2026-09-22 실측).
export function MaximizeIcon({ restore }: { restore?: boolean }) {
  return (
    <svg {...TOGGLE_ICON} width={14} height={14} strokeWidth={1.5} aria-hidden="true">
      {restore ? (
        <>
          <rect x="4" y="8" width="12" height="12" rx="1.5" />
          <path d="M8 8V5.5A1.5 1.5 0 0 1 9.5 4h9A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H16" />
        </>
      ) : (
        <rect x="5" y="5" width="14" height="14" rx="1.5" />
      )}
    </svg>
  );
}
export function GridIcon() {
  return (
    <svg {...TOGGLE_ICON}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}
// 서버에 없음 — 구름에 사선(캔버스의 서버에 없는 레퍼런스 표시, 2026-09-29). 크기는 쓰는 곳의 CSS 가 정한다.
export function CloudOffIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m2 2 20 20" />
      <path d="M5.782 5.782A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.307-.193" />
      <path d="M21.532 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7.008 7.008 0 0 0 10 5.07" />
    </svg>
  );
}

// 연결 안 됨 — 끊어진 고리(판정 보류 레퍼런스, 2026-09-30). 크기는 쓰는 곳의 CSS 가 정한다.
export function LinkOffIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71" />
      <path d="m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71" />
      <path d="M8 2v3" />
      <path d="M2 8h3" />
      <path d="M16 19v3" />
      <path d="M19 16h3" />
    </svg>
  );
}

// 사본 — 겹친 두 장(서버에 같은 이름이 있는 사본 레퍼런스, 2026-09-30)
export function CopyIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="8" y="8" width="14" height="14" rx="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

// 확인 중 — 열린 원(돌지 않는다: 가만히 둔 탭의 CPU 를 쓰지 않게)
export function PendingIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
