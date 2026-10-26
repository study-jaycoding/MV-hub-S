// 사이드바 열고 닫기 손잡이(Jay 2026-10-26 시안 C) — 열림 = 사이드바 끝선 위의 동그라미 ‹ · 닫힘 = 창 왼쪽 끝에 붙은 반달 ›.
// 사이드바 바로 오른쪽 칸(도구 줄·에셋 목록) 안에 둔다: 그 칸의 왼쪽 끝이 곧 끝선이라 CSS 의 left:-11px 이 선 위 가운데다(칸은 position: relative).
export function SidebarEdgeToggle({ open, onToggle, title }: { open: boolean; onToggle: () => void; title: string }) {
  return (
    <button type="button" className={"side-edge-toggle" + (open ? " open" : "")} onClick={onToggle}
      title={title} aria-label={title} aria-expanded={open}>
      <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={2.25}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={open ? "M14.5 6.5 9 12l5.5 5.5" : "M9.5 6.5 15 12l-5.5 5.5"} />
      </svg>
    </button>
  );
}
