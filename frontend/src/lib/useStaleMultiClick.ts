// 두 번 누름의 둘째 누름이 '첫 누름으로 바뀐 화면'에 닿는 것을 막는다(조작 규칙 61, 2026-10-13 33회차).
//  브라우저는 연속 누름 수(detail)를 시간·거리로만 센다 — 첫 누름이 화면을 바꿔 같은 자리에 다른 것이 서 있어도 둘째 누름은 그 새 요소에
//  mousedown·click(detail 2)·dblclick 으로 간다(헤드리스 크롬 실측: A 를 누르면 같은 자리에 B → A:click:1 → B:mousedown:2 · B:click:2 ·
//  B:dblclick:2). 그래서 줄 안의 [열기]를 습관대로 두 번 누르면 들어간 화면의 같은 자리 [폴더로]가 눌려 두 단계를 들어가고, 격자 보기에서는
//  그 자리의 컷이 모아보기로 열리고, [폴더로]로 들어간 낱장 목록에서는 그 자리 카드가 크게 보기로 열렸다.
//  규칙: 둘째 누름(detail ≥ 2)이 왔을 때 **첫 누름 뒤로 자리(place)가 바뀌었거나, 이 격자가 첫 누름을 보지 못했으면**(그 사이에 새로 선 격자)
//  그 누름을 **통째로** 버린다 — 격자 뿌리의 잡는 단계에서 mousedown·click·dblclick·dragstart 를 삼킨다. 누름(mousedown)부터 삼키는 이유:
//  카드는 누름의 잡는 단계에서 '새 항목 확인'을 저장하고(GenerationCard 의 ackTeamFresh), 카드 자체가 끌 수 있는 요소라 누른 채 끌면 그 카드의
//  프롬프트가 실린다 — click 만 막으면 둘 다 샌다(Codex 코드 리뷰). 바깥 누름으로 닫히는 메뉴는 그보다 앞선 pointerdown(잡는 단계)으로 듣는다.
//  자리가 같으면 건드리지 않는다: 같은 카드의 진짜 두 번 클릭, 카드가 빠지며 밀려오는 목록에서 같은 자리를 이어 누르는 작업은 그대로다.
import { useRef, type MouseEvent, type SyntheticEvent } from "react";

const SEQUENCE_MS = 1500; // 이보다 오래된 첫 누름은 이 연속 누름의 것이 아니다(운영체제의 두 번 클릭 간격은 보통 0.5초)

const swallow = (e: SyntheticEvent) => {
  e.preventDefault(); // 초점 옮기기·글자 긁기·끌기 시작 같은 기본 동작도
  e.stopPropagation();
};

/** place = 이 격자가 지금 보여 주는 자리의 열쇠(바뀌면 다른 화면이다). 돌려준 handlers 를 격자 뿌리에 펴 넣는다. */
export function useStaleMultiClick(place: string) {
  const placeRef = useRef(place);
  placeRef.current = place;
  const first = useRef<{ place: string; at: number } | null>(null);
  const stale = useRef(false);
  return {
    // 잡는 단계 — 카드와 그 안의 것보다 먼저 본다(안에서 전파를 막아도 본다)
    onMouseDownCapture: (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (e.detail <= 1) { // 새 누름의 시작(시험·키보드가 만든 0 포함)
        first.current = { place: placeRef.current, at: e.timeStamp };
        stale.current = false;
        return;
      }
      const began = first.current;
      stale.current = !began || began.place !== placeRef.current || e.timeStamp - began.at > SEQUENCE_MS;
      if (stale.current) swallow(e);
    },
    onClickCapture: (e: MouseEvent) => {
      if (stale.current && e.detail > 1) swallow(e); // 키보드가 만든 click(detail 0)·새 누름의 click 은 지나간다
    },
    onDoubleClickCapture: (e: MouseEvent) => {
      if (stale.current) swallow(e);
    },
    // 버린 누름을 쥔 채 끌면 — 카드·끌기 손잡이의 dragstart 가 그 카드의 id 를 싣기 전에
    onDragStartCapture: (e: SyntheticEvent) => {
      if (stale.current) swallow(e);
    },
  };
}
