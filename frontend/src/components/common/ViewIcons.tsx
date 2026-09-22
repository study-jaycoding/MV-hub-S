const TOGGLE_ICON = {
  viewBox: "0 0 24 24",
  width: 15,
  height: 15,
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
    <svg {...TOGGLE_ICON} width={16} height={16}>
      <rect x="3" y="3.5" width="18" height="4.5" rx="1.5" />
      <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
      <path d="M12 11v3.2l2.2 1.4" />
    </svg>
  );
}
// 꽉 채우기(속 찬 네모)·전체 보기(빈 네모). 글자 ▣ 는 기준선 탓에 1.6px 아래였다(2026-09-22 픽셀 실측).
// 16px — 짝수 단추(30px) 가운데에 반 픽셀 없이 놓인다.
export function FitIcon({ filled }: { filled: boolean }) {
  return (
    <svg {...TOGGLE_ICON} width={16} height={16} strokeWidth={1.5}>
      <rect x="3.75" y="3.75" width="16.5" height="16.5" rx="1.5" />
      {filled && <rect x="8" y="8" width="8" height="8" rx="1" fill="currentColor" stroke="none" />}
    </svg>
  );
}
// 필터 사이드바 열림(빈 네모)·닫힘(오른쪽 세모). 글자 ▢·▷ 는 1.3px 아래였다(2026-09-22 실측). 세모는 네모 칸 가운데.
export function FilterPanelIcon({ open }: { open: boolean }) {
  return (
    <svg {...TOGGLE_ICON} width={16} height={16} strokeWidth={1.5}>
      {open ? <rect x="3.75" y="3.75" width="16.5" height="16.5" rx="1.5" /> : <path d="M6.5 4.5 17.5 12 6.5 19.5Z" />}
    </svg>
  );
}
// 정보(ⓘ) — 글자 ⓘ 는 폴백 글꼴 탓에 1px 아래였고, 손으로 넣은 padding 보정도 글꼴 따라 틀어졌다(2026-09-22 실측).
export function InfoIcon() {
  return (
    <svg {...TOGGLE_ICON} width={16} height={16} strokeWidth={1.5}>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16.5" />
      <circle cx="12" cy="7.6" r="0.6" fill="currentColor" />
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
