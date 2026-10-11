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

/**
 * 순서 손잡이(⠿)의 '누르고 있다' 표식을, 손잡이 밖에서 떼거나 누른 채 창을 떠나도 내린다.
 * 손잡이는 누르는 동안만 줄을 draggable 로 만든다(mousedown 에 켜고 손잡이의 mouseup·끌기의 drop·dragend 에 끈다). 그런데 끌기가
 * 시작되기 전에 손잡이 밖에서 떼거나 누른 채 다른 창으로 가면(Alt+Tab) 셋 다 오지 않아 표식이 남고, 그 뒤로는 줄의 이름·본문을 끌어도
 * 순서가 바뀌어 저장됐다(조작 규칙 39 의 '뗀 것을 놓치면 남는 상태'). 켜져 있는 동안만 듣는다.
 * 실제 끌기가 시작되면 브라우저가 mouseup 을 보내지 않는다 — 그쪽은 전처럼 drop·dragend 가 끈다.
 */
export function useHandleRelease(armed: boolean, release: () => void): void {
  const releaseRef = useRef(release);
  releaseRef.current = release;
  useEffect(() => {
    if (!armed) return;
    const onRelease = () => releaseRef.current();
    const onHidden = () => { if (document.hidden) releaseRef.current(); };
    window.addEventListener("mouseup", onRelease, true);
    window.addEventListener("blur", onRelease);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("mouseup", onRelease, true);
      window.removeEventListener("blur", onRelease);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [armed]);
}
