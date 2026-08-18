// 화면 어디서 끌기 시작해도 그 화면의 '드래그 선택'(빈 곳을 끌어 여러 개 고르기)이 시작되게 한다.
//
// 카드가 몇 개 없으면 화면 대부분이 격자 밖(상단바·툴바 줄·사이드바 여백)이라, 거기서 끌기
// 시작하면 아무 일도 일어나지 않았다. 격자 안에서만 시작할 수 있다는 건 사용자가 알 길이 없다.
//
// 문서 캡처 단계에서 잡는다 — 상단바·사이드바에는 팝업 닫기 감시자처럼 이벤트를 중간에서
// 멈추는(stopPropagation) 핸들러가 있어, 위쪽 컨테이너에 붙이면 애초에 도달하지 않는다.
import { useEffect, useRef } from "react";

// 여기서는 시작하지 않는다 — 원래 기능이 우선인 자리.
//  · 조작 요소: 탭 전환·폴더 클릭·툴바 조작·검색 입력이 드래그 선택에 먹히면 안 된다.
//  · 떠 있는 창·패널: 그 안의 드래그는 그쪽 것(관리창 이동, 팝업 내부 선택 등).
export const DRAG_SELECT_SKIP = [
  "button",
  "input",
  "label",
  "select",
  "textarea",
  "a",
  "[contenteditable]",
  '[role="button"]',
  '[role="dialog"]',
  ".manage-float",
  ".info-popup",
  ".sl-dockbar",
  ".preview-wrap",
  ".cmp-window",
].join(", ");

/**
 * @param insideSelector 이 화면의 격자·보드 자체(그 안에서 시작한 드래그는 각 화면 핸들러가 처리)
 * @param start 바깥에서 시작했을 때 부를 '드래그 선택 시작' 함수
 * @param enabled 이 화면이 보일 때만 켠다(분리창·탭 전환에서 서로 겹치지 않게)
 */
export function useOutsideDragSelect(
  insideSelector: string,
  start: (event: MouseEvent) => void,
  enabled = true,
): void {
  // 시작 함수는 매 렌더 새로 만들어지므로 ref 로 최신값을 읽는다(리스너 재등록·낡은 상태 방지).
  const startRef = useRef(start);
  startRef.current = start;

  useEffect(() => {
    if (!enabled) return;
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      if (!target?.closest) return;
      if (target.closest(insideSelector) || target.closest(DRAG_SELECT_SKIP)) return;
      startRef.current(event);
    };
    document.addEventListener("mousedown", onMouseDown, true);
    return () => document.removeEventListener("mousedown", onMouseDown, true);
  }, [insideSelector, enabled]);
}
