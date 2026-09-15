// computeMenuPlacement 를 실제 DOM 에 붙이는 훅 — 경계 수집·재측정 구독을 맡는다.
//  계산 자체는 menuPlacement.ts 의 순수 함수가 한다(시험은 거기서).
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { computeMenuPlacement, intersectRect, type Placement, type Rect } from "./menuPlacement";

const toRect = (r: DOMRect): Rect => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });

/** 메뉴를 실제로 자르는 조상들의 안쪽 영역을 축별로 교차한다(뷰포트에서 시작). */
export function clippingBounds(el: HTMLElement): Rect {
  let bounds: Rect = { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth };
  for (let node = el.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const clipsY = /hidden|clip|auto|scroll/.test(style.overflowY);
    const clipsX = /hidden|clip|auto|scroll/.test(style.overflowX);
    if (!clipsX && !clipsY) continue;
    const box = node.getBoundingClientRect();
    // 테두리 안쪽(표시 영역)을 기준으로 — 테두리 위에 그려지면 이미 잘린 것이다.
    const bt = parseFloat(style.borderTopWidth) || 0;
    const bb = parseFloat(style.borderBottomWidth) || 0;
    const bl = parseFloat(style.borderLeftWidth) || 0;
    const br = parseFloat(style.borderRightWidth) || 0;
    const inner: Rect = {
      top: clipsY ? box.top + bt : bounds.top,
      bottom: clipsY ? box.bottom - bb : bounds.bottom,
      left: clipsX ? box.left + bl : bounds.left,
      right: clipsX ? box.right - br : bounds.right,
    };
    bounds = intersectRect(bounds, inner);
  }
  return bounds;
}

const same = (a: Placement | null, b: Placement) =>
  !!a &&
  a.direction === b.direction &&
  a.top === b.top &&
  a.bottom === b.bottom &&
  a.left === b.left &&
  a.maxHeight === b.maxHeight &&
  a.maxWidth === b.maxWidth;

export function useMenuPlacement(
  open: boolean,
  originRef: RefObject<HTMLElement>,
  anchorRef: RefObject<HTMLElement>,
  menuRef: RefObject<HTMLElement>,
  // 선호 방향 — CSS 사용자 정의 속성 --menu-prefer 가 "down" 이면 아래쪽.
  defaultPrefer: "up" | "down" = "up",
  // 목록·펼침처럼 크기를 바꾸는 값이 오면 다시 잰다.
  deps: unknown[] = [],
): Placement | null {
  const [placement, setPlacement] = useState<Placement | null>(null);
  const frameRef = useRef<number | null>(null);
  const placementRef = useRef<Placement | null>(null);
  placementRef.current = placement;

  const measure = useCallback(() => {
    const origin = originRef.current;
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!origin || !anchor || !menu) return;
    // 내용이 원하는 크기 — max-height 로 눌린 값이 아니라 scroll 크기를 쓴다.
    const style = getComputedStyle(menu);
    const prefer = (style.getPropertyValue("--menu-prefer").trim() || defaultPrefer) as "up" | "down";
    const gap = parseFloat(style.getPropertyValue("--menu-gap")) || 6;
    const vpad = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const vborder = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
    const cap = parseFloat(style.getPropertyValue("--menu-max-height")) || 320;
    const next = computeMenuPlacement({
      anchor: toRect(anchor.getBoundingClientRect()),
      bounds: clippingBounds(menu),
      origin: toRect(origin.getBoundingClientRect()),
      content: {
        // scrollHeight 는 padding 을 포함하고 border 는 제외한다 — 바깥 높이로 맞춘다.
        height: Math.min(cap, menu.scrollHeight + vborder),
        width: menu.getBoundingClientRect().width,
      },
      prefer: prefer === "down" ? "down" : "up",
      gap,
    });
    // 같은 값이면 상태를 건드리지 않는다(관찰 → 재배치 → 관찰 고리 방지).
    if (!same(placementRef.current, next)) setPlacement(next);
    void vpad;
  }, [anchorRef, defaultPrefer, menuRef, originRef]);

  const schedule = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      measure();
    });
  }, [measure]);

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    measure();
    const onScroll = () => schedule();
    window.addEventListener("resize", schedule);
    // 바깥 스크롤도 위치를 바꾼다 — 캡처로 받아 어느 층에서 굴러도 잡는다.
    window.addEventListener("scroll", onScroll, true);
    // 크기 변화(도크 확장·목록 도착·폴더 펼침)는 관찰로 잡는다. 다만 '크기 그대로 위치만
    //  이동'은 관찰로 안 잡히므로 위 scroll/resize 와 아래 deps 재측정이 함께 필요하다.
    const observed = [originRef.current, anchorRef.current, menuRef.current].filter(
      (el): el is HTMLElement => !!el,
    );
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => schedule());
      for (const el of observed) ro.observe(el);
    }
    return () => {
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", onScroll, true);
      ro?.disconnect();
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps 는 호출부가 주는 재측정 신호다
  }, [open, measure, schedule, anchorRef, menuRef, originRef, ...deps]);

  return placement;
}
