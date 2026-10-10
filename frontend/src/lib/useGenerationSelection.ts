import { useEffect, useRef, useState } from "react";
import { pressStartedCovered } from "./keyGate";
import { toggleSetValue } from "./setUtils";

interface UseGenerationSelectionArgs {
  resetKey: string;
  preserveSelectors?: string;
}

// 격자 밖 누름을 격자에 따로 알린다 — 선택이 이미 비어 있으면 아래에서 바뀌는 상태가 없어, 격자가 Space 로 남겨 둔 초점 카드를 지울
//  계기가 없다(고른 것도 없는데 c·#·Enter·Space 가 그 카드에 실행된다 — 조작 점검 7회 R43-a). '밖'의 판정은 선택 해제와 같은 것 하나를 쓴다.
const outsidePressListeners = new Set<() => void>();
export function onSelectionOutsidePress(listener: () => void): () => void {
  outsidePressListeners.add(listener);
  return () => {
    outsidePressListeners.delete(listener);
  };
}

export function useGenerationSelection({
  resetKey,
  preserveSelectors = ".gen-cell, .gen-grid, .select-bar, .proj-assign, .cmt-panel",
}: UseGenerationSelectionArgs) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const toggleSelect = (id: string) => setSelected((prev) => toggleSetValue(prev, id));
  // 이미 비어 있으면 같은 Set 을 돌려 재렌더를 만들지 않는다 — Esc 마다 App 이 다시 그려지면 같은 Esc 를 기다리던
  // 다른 keydown 리스너가 전달 도중 재구독되며 첫 입력을 놓친다(2026-09-19 실측, useEscapeClose 와 한 쌍).
  const clearSelect = () => setSelected((prev) => (prev.size ? new Set() : prev));

  useEffect(() => {
    // 위에 창·메뉴·확인 창이 떠 있을 때의 클릭은 그것의 몫이다 — 뒤의 선택을 풀지 않는다(바깥을 눌러 닫는 클릭도). 코멘트 패널도 같다.
    //  2026-10-10 실측: 등급 확인 창의 [확인]을 마우스로 누르면 선택이 풀려 '한 번 더 눌러 최종까지'가 끊겼다(Esc·키보드는 유지).
    //  '누르는 순간 떠 있었나'는 lib/keyGate 가 pointerdown 에서 적어 둔다 — 여기(mousedown)서 보면 이미 닫힌 뒤일 수 있다.
    const pressedOutside = (e: MouseEvent) => {
      if (pressStartedCovered()) return false;
      const target = e.target as HTMLElement | null;
      return !!target && !target.closest(preserveSelectors);
    };
    const onDocDown = (e: MouseEvent) => {
      if (selectedRef.current.size > 0 && pressedOutside(e)) setSelected(new Set());
    };
    // 격자에 보내는 알림만은 **잡는 단계**로 듣는다 — 오르는 단계에 기대면 mousedown 전파를 막는 곳 안의 누름을 놓친다. 캔버스 '생성 결과'
    //  창이 그렇다(창 안의 누름을 보드로 올려 보내지 않는다): 창 안 격자에서 Space 로 뺀 뒤 창의 툴바를 눌러도 초점 카드가 남아 c 에
    //  코멘트가 열렸다(Codex 코드 리뷰). 선택 해제는 종전대로 오르는 단계에 둔다 — 전파를 막은 곳 안의 누름에는 선택을 풀지 않던 것까지
    //  바꾸지 않는다. '누르는 순간 떠 있었나'는 이보다 앞선 pointerdown 에서 이미 적혀 있다.
    const onPressCapture = (e: MouseEvent) => {
      if (pressedOutside(e)) outsidePressListeners.forEach((listener) => listener());
    };
    document.addEventListener("mousedown", onPressCapture, true);
    document.addEventListener("mousedown", onDocDown);
    return () => {
      document.removeEventListener("mousedown", onPressCapture, true);
      document.removeEventListener("mousedown", onDocDown);
    };
  }, [preserveSelectors]);

  useEffect(() => {
    setSelected(new Set());
  }, [resetKey]);

  return { clearSelect, selected, selectedRef, setSelected, toggleSelect };
}
