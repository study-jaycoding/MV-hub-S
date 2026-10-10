import { useEffect, useRef } from "react";
import { backgroundKeysBlocked, closeLayer, isTopLayer, nextLayerSeq, openLayer } from "./keyGate";
import { isKeyHandled, markKeyHandled } from "./keyHandled";

// ── Esc 한 번에 한 겹 ──
//  창·메뉴·확인 창이 겹쳐 있을 때 Esc 는 **맨 위 겹만** 닫는다. 전엔 겹마다 따로 window 에 걸려 같은 Esc 를 각자 처리했다
//  (2026-10-10 실측: 프로젝트 설정 + 달력 → 둘 다 닫혀 입력이 사라짐, 설정 + 옆 패널, 정보 창 + 선택).
//  · 겹의 위아래 = **켜진 렌더의 순서**(lib/keyGate). 부모가 자식보다 먼저 그려지므로 같이 뜬 겹도 안쪽(자식)이 위다 —
//    effect 순서로 세면 자식이 먼저라 뒤집힌다(tests/escapeCloseNesting). 나중에 연 창은 나중에 그려지니 위다.
//  · 맨 위 겹이 받은 Esc 는 '쓴 것'으로 표시한다(lib/keyHandled) — 그 Esc 로 닫히며 다시 켜진 아래 겹도, 뒤 화면도 또 쓰지 않는다.
//  · 닫지는 않지만 Esc 를 가진 겹(적용 중인 확인 창의 빈 콜백)도 맨 위면 Esc 를 삼킨다 — 아래 겹으로 새지 않는다.
//  · 켜져 있는 겹은 뒤 화면의 단축키도 쉬게 한다(lib/keyGate) → 늘 떠 있는 컴포넌트는 enabled 에 열림 상태를 넘길 것.
//  · 뒤 화면의 Esc(선택 해제·폴더 창 닫기)는 겹이 아니다 → useBackgroundEscape.
// ★리스너는 한 번만 등록하고 콜백은 ref 로 읽는다. onClose 가 렌더마다 새 함수면(App 의 인라인 onAdminClose 등)
//  효과가 매번 재구독되는데, 같은 Esc 에서 먼저 돈 다른 keydown 리스너가 재렌더를 일으키면 이 리스너가
//  **전달 도중 제거**돼 그 Esc 를 통째로 놓친다(전달 중 제거된 리스너는 불리지 않는다).
//  2026-09-19 브라우저 실측: 페이지를 연 뒤 처음 연 관리자 창·설정 창이 Esc 한 번에 안 닫혔다.
export function useEscapeClose(
  onClose: () => void,
  enabled = true,
  capture = false,
  consume = false,
) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const token = useRef({}).current;
  const seqRef = useRef<number | null>(null);
  if (!enabled) seqRef.current = null;
  else if (seqRef.current === null) seqRef.current = nextLayerSeq(); // 켜지는 렌더에서 번호를 받는다(위 주석)
  useEffect(() => {
    if (!enabled) return;
    openLayer(token, seqRef.current ?? nextLayerSeq());
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (isKeyHandled(e) || !isTopLayer(token)) return;
      markKeyHandled(e);
      if (consume) {
        e.preventDefault();
        e.stopPropagation();
      }
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, capture);
    return () => {
      closeLayer(token);
      window.removeEventListener("keydown", onKey, capture);
    };
  }, [enabled, capture, consume, token]);
}

/** 뒤 화면의 Esc 를 써도 되나 — 이미 쓴 Esc 가 아니고, 그 위에 떠 있는 것(겹·덮개)도 없을 때만. */
export function backgroundEscapeAllowed(event: Event): boolean {
  return !isKeyHandled(event) && !backgroundKeysBlocked();
}

/** 뒤 화면의 Esc(선택 해제·폴더 창 닫기 등) — 겹이 아니다. 그 위에 무엇이든 떠 있으면 손대지 않는다.
 *  콜백이 false 를 돌려주면 '쓰지 않았다'(다음 뒤 화면 처리가 받는다), 그 밖에는 쓴 것으로 표시한다. */
export function useBackgroundEscape(onEscape: () => boolean | void, enabled = true) {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !backgroundEscapeAllowed(e)) return;
      if (onEscapeRef.current() !== false) markKeyHandled(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
