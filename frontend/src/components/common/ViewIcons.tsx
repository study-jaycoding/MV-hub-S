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
// 계정(머리·어깨) — 계정 메뉴의 Manage Account 앞(Jay 2026-10-22, 모의 이미지 후보 ②).
export function AccountIcon() {
  return (
    <svg {...TOGGLE_ICON} width={14} height={14} className="acct-action-icon" aria-hidden="true">
      <circle cx="12" cy="7" r="4" />
      <path d="M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" />
    </svg>
  );
}
// 톱니·문+나가는 화살표 — 계정 메뉴 Setting·Sign Out 앞. 사람 아이콘과 같은 14px 선 그림이라 세 줄의 글자 시작점이 같다(Jay 2026-10-22 B안).
export function SettingIcon() {
  return (
    <svg {...TOGGLE_ICON} width={14} height={14} className="acct-action-icon" aria-hidden="true">
      <path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
export function SignOutIcon() {
  return (
    <svg {...TOGGLE_ICON} width={14} height={14} className="acct-action-icon" aria-hidden="true">
      <path d="M14 8v-2a2 2 0 0 0 -2 -2h-7a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2 -2v-2" />
      <path d="M9 12h12l-3 -3" />
      <path d="M18 15l3 -3" />
    </svg>
  );
}
// 프롬프트(입력칸 + 커서) — Host 상태줄 끝의 프롬프트 열기·닫기 칸(Jay 2026-10-22).
export function PromptIcon() {
  return (
    <svg {...TOGGLE_ICON} width={15} height={15} aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="3.5" />
      <path d="M8 10v4" />
      <path d="M12 12h5" />
    </svg>
  );
}
// 지우개 — 프롬프트·레퍼런스 비우기 단추(Jay 2026-10-22). 14px, 복사 단추의 CopyIcon 과 같은 선 굵기.
export function EraserIcon() {
  return (
    <svg {...TOGGLE_ICON} width={14} height={14} aria-hidden="true">
      <path d="M19 20h-10.5l-4.21 -4.3a1 1 0 0 1 0 -1.41l10 -10a1 1 0 0 1 1.41 0l5 5a1 1 0 0 1 0 1.41l-9.2 9.3" />
      <path d="M18 13.3l-6.3 -6.3" />
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

// 생성 정보 창 머리줄 단추 앞 — 13px 선 그림(Jay 2026-10-28 모의 그림 확정). 수정 둘은 같은 틀+연필에 속만 다르다.
export function ImageEditIcon() {
  return (
    <svg {...TOGGLE_ICON} width={13} height={13} aria-hidden="true">
      <path d="M11 20H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v4" />
      <path d="M15 8h.01" />
      <path d="M4 15l4-4c.93-.89 2.07-.89 3 0l3 3" />
      <path d="M18.42 15.61a2.1 2.1 0 0 1 2.97 2.97L18 22h-3v-3z" />
    </svg>
  );
}
export function VideoEditIcon() {
  return (
    <svg {...TOGGLE_ICON} width={13} height={13} aria-hidden="true">
      <path d="M11 20H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v4" />
      <path d="M10 8.5v5l4-2.5z" />
      <path d="M18.42 15.61a2.1 2.1 0 0 1 2.97 2.97L18 22h-3v-3z" />
    </svg>
  );
}
// 히스토리 — 되감는 시계
export function HistoryIcon() {
  return (
    <svg {...TOGGLE_ICON} width={13} height={13} aria-hidden="true">
      <path d="M12 8v4l2 2" />
      <path d="M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5" />
    </svg>
  );
}
// 캔버스 — 선으로 이은 노드 셋
export function CanvasIcon() {
  return (
    <svg {...TOGGLE_ICON} width={13} height={13} aria-hidden="true">
      <rect x="2.5" y="9.5" width="6" height="5" rx="1.2" />
      <rect x="15.5" y="3.5" width="6" height="5" rx="1.2" />
      <rect x="15.5" y="15.5" width="6" height="5" rx="1.2" />
      <path d="M8.5 12H12M12 6v12M12 6h3.5M12 18h3.5" />
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
