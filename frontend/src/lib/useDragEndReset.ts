import { useEffect, useRef } from "react";

/**
 * 놓기 대상의 강조(끌어 올린 동안의 표시)를 끌기가 어디서 끝나든 끈다.
 * 대상은 dragleave·drop 에서 강조를 끄는데, 그 위에서 끌기를 취소하면 대상에는 dragleave 가 오지 않고 끈 쪽에 dragend 만 온다
 * (2026-10-11 격리 실측 5/5: 라이브러리 카드를 사이드바 폴더 줄 위에서 취소하면 줄의 강조가 남았다). dragend 는 창까지 올라온다.
 * 강조가 켜져 있는 동안만 듣는다 — 대상(폴더 줄)이 수백 개여도 가만히 있을 때는 리스너가 없다.
 * 다른 창·탐색기에서 시작한 끌기는 이 창에 dragend 가 오지 않는다(그쪽은 전처럼 dragleave·drop 에 기댄다).
 */
export function useDragEndReset(lit: boolean, reset: () => void): void {
  const resetRef = useRef(reset);
  resetRef.current = reset;
  useEffect(() => {
    if (!lit) return;
    const onEnd = () => resetRef.current();
    window.addEventListener("dragend", onEnd, true);
    return () => window.removeEventListener("dragend", onEnd, true);
  }, [lit]);
}
