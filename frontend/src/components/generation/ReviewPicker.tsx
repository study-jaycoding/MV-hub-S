// S 선택 창(Jay 2026-10-30) — 칸 크기·비율과 상관없이 같은 모양으로 S 옆에 뜨고, 누르면 바로 적용한다. 기록 = docs/status/S_선택창_떠있는창_2026-10-30.md
//  body 로 띄운다 — 카드 안에 두면 카드의 clip 에 잘리고, 캔버스 노드 안에 두면 캔버스 배율에 따라 크기가 달라진다.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import type { ReviewAction } from "../../lib/generationReview";
import { useT } from "../../lib/i18n";
import { useOverlayDismiss } from "../../lib/useOverlayDismiss";
import { useOverlayFocus } from "./ConfirmQuestion";
import { onReviewMenuKey, REVIEW_OPTIONS, ReviewIcon } from "./reviewOptions";

const GAP = 6; // S 와 창 사이
const EDGE = 4; // 화면 끝과 창 사이
const FIRST_ITEM_HALF = 21; // 첫 칸 높이의 절반(generations.css .s-pick-item)

type Box = Pick<DOMRect, "left" | "right" | "top" | "height">;

// S 오른쪽에 놓고 첫 칸 가운데를 S 가운데에 맞춘다. 오른쪽 공간이 모자라면 S 왼쪽 · 화면 아래로 넘치면 위로 올린다.
export function pickerPosition(anchor: Box, width: number, height: number, viewWidth: number, viewHeight: number) {
  const right = anchor.right + GAP;
  const left = right + width > viewWidth - EDGE ? anchor.left - GAP - width : right;
  const top = anchor.top + anchor.height / 2 - FIRST_ITEM_HALF;
  return { left: Math.max(EDGE, left), top: Math.max(EDGE, Math.min(top, viewHeight - EDGE - height)) };
}

interface Props {
  anchorRef: RefObject<HTMLElement | null>; // S 단추
  state: ReviewAction;
  options?: ReviewAction[]; // 보일 항목과 순서(워크스페이스·캔버스). 없으면 공유 탭 — 지금 상태를 뺀 나머지
  allowed: Record<ReviewAction, boolean>;
  onAction: (action: ReviewAction) => void;
  onCancel: () => void;
}

const stop = (event: SyntheticEvent) => event.stopPropagation(); // portal 안의 이벤트도 React 트리로는 카드·노드까지 올라간다

export function ReviewPicker({ anchorRef, state, options, allowed, onAction, onCancel }: Props) {
  const t = useT();
  const panelRef = useOverlayDismiss(onCancel, anchorRef); // S 를 누르는 것은 바깥이 아니다 — 카드의 S 처리가 닫는다
  useOverlayFocus(() => panelRef.current);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    const panel = panelRef.current?.getBoundingClientRect();
    if (anchor && panel) setPosition(pickerPosition(anchor, panel.width, panel.height, window.innerWidth, window.innerHeight));
  }, [anchorRef, panelRef]);
  // 창은 S 의 자리에 고정이다 — 뒤가 움직이면(스크롤·휠 배율·창 크기) S 에서 떨어져 보이므로 닫는다.
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    const close = () => cancelRef.current();
    window.addEventListener("scroll", close, true);
    window.addEventListener("wheel", close, { capture: true, passive: true });
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("wheel", close, { capture: true });
      window.removeEventListener("resize", close);
    };
  }, []);
  const shown = options
    ? options.flatMap((option) => REVIEW_OPTIONS.filter((item) => item.state === option))
    : REVIEW_OPTIONS.filter((option) => option.state !== state);
  return createPortal(
    // 자리를 재기 전에도 초점을 받을 수 있게 화면 밖에 둔다(visibility:hidden 이면 초점을 못 받는다)
    <div className="s-pick" ref={panelRef} role="dialog" aria-label={t("이 결과물을 어떻게 할까요?")} tabIndex={-1}
      style={position ?? { left: -9999, top: 0 }}
      onClick={stop} onAuxClick={stop} onMouseDown={stop} onPointerDown={stop} onDoubleClick={stop} onContextMenu={stop}
      onKeyDown={(event) => onReviewMenuKey(event, ".s-pick-item")}>
      {shown.map((option) => (
        <button key={option.state} type="button" className={`s-pick-item review-${option.state}`} disabled={!allowed[option.state]}
          // 지금 상태 그대로인 항목(일반 카드의 해제)은 바뀔 것이 없어 닫기만 한다
          onClick={() => (option.state === state ? onCancel() : onAction(option.state))}>
          <span className="s-pick-icon" aria-hidden><ReviewIcon state={option.state} /></span>
          <span>{t(option.label)}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
