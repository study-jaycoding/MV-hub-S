// 뷰어와 타임라인 사이의 손잡이(Jay 2026-10-23, 다빈치처럼) — 위아래로 끌어 타임라인 칸의 높이를 정한다. 트랙 높이(Shift+휠)는 이 칸
//  안에서 바뀌고 칸은 그대로다(칸 안에서 위아래로 스크롤). 높이는 편집 화면 뿌리의 --ed-tl-h 로 주고 이 브라우저에 기억한다 —
//  끄는 동안은 그 값만 바로 고치고(렌더 없음) 놓을 때 정한다. 더블클릭 = 기본(기억 지움). 끈 뒤의 초점은 ResizableSidebar 처럼 되돌린다.
import { useRef, type RefObject } from "react";
import { useT } from "../../lib/i18n";

export const TL_MIN = 120; // 눈금자·컷 줄·트랙 한 줄 남짓
const TOP_MIN = 160; // 위쪽(풀·뷰어)이 이만큼은 남는다
const BAR_H = 44; // 도구 막대(.ed-bar)
const KEY_STEP = 16;

export function EditSplit({
  rootRef,
  height,
  onHeight,
}: {
  rootRef: RefObject<HTMLElement>; // 편집 화면 뿌리(.ed-root) — --ed-tl-h 를 여기에 단다
  height: number | null; // 정한 높이(px) — null = 기본(CSS 의 비율)
  onHeight: (height: number | null) => void; // 놓았을 때·키·더블클릭 — 부르는 쪽이 기억에 적는다
}) {
  const t = useT();
  const drag = useRef<{ pointerId: number; startY: number; startH: number; h: number; focusBefore: HTMLElement | null } | null>(null);
  const timeline = () => rootRef.current?.querySelector<HTMLElement>(".ed-tl") ?? null;
  const clamp = (value: number) => {
    const room = (rootRef.current?.clientHeight ?? 0) - BAR_H - TOP_MIN;
    return Math.round(Math.max(TL_MIN, Math.min(Math.max(TL_MIN, room), value)));
  };
  const show = (value: number) => rootRef.current?.style.setProperty("--ed-tl-h", `${value}px`);
  const finish = (target: HTMLElement, cancel: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    target.classList.remove("resizing");
    if (target.hasPointerCapture(current.pointerId)) target.releasePointerCapture(current.pointerId);
    if (document.activeElement === target) {
      const back = current.focusBefore;
      if (back && back.isConnected && back !== document.body) back.focus({ preventScroll: true });
      else target.blur();
    }
    if (cancel || current.h === current.startH) {
      if (height === null) rootRef.current?.style.removeProperty("--ed-tl-h");
      else show(height);
      return;
    }
    onHeight(current.h);
  };
  return (
    <div className="ed-split" role="separator" tabIndex={0} aria-orientation="horizontal"
      aria-label={t("타임라인 높이 조절")} aria-valuemin={TL_MIN} aria-valuenow={height ?? undefined}
      title={t("드래그하여 타임라인 높이 조절 · 더블클릭하여 기본 높이로 복원")}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary || drag.current) return;
        event.preventDefault();
        event.stopPropagation();
        const focusBefore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        const startH = timeline()?.offsetHeight ?? height ?? TL_MIN;
        drag.current = { pointerId: event.pointerId, startY: event.clientY, startH, h: startH, focusBefore };
        event.currentTarget.classList.add("resizing");
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        current.h = clamp(current.startH + current.startY - event.clientY); // 위로 끌면 커진다
        show(current.h);
      }}
      onPointerUp={(event) => { if (drag.current?.pointerId === event.pointerId) finish(event.currentTarget, false); }}
      onPointerCancel={(event) => { if (drag.current?.pointerId === event.pointerId) finish(event.currentTarget, true); }}
      onLostPointerCapture={(event) => { if (drag.current?.pointerId === event.pointerId) finish(event.currentTarget, true); }}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        rootRef.current?.style.removeProperty("--ed-tl-h");
        onHeight(null);
      }}
      onKeyDown={(event) => {
        const step = event.key === "ArrowUp" ? KEY_STEP : event.key === "ArrowDown" ? -KEY_STEP : 0;
        if (!step) return;
        event.preventDefault();
        event.stopPropagation(); // 편집 화면의 ↑↓(편집점 이동)로 가지 않게 — Tab 으로 손잡이에 온 키보드 조절이다
        const next = clamp((timeline()?.offsetHeight ?? height ?? TL_MIN) + step);
        show(next);
        onHeight(next);
      }}
    />
  );
}
