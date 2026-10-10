import { useEffect, useRef } from "react";
import { useT } from "../../lib/i18n";
import { isTypingTarget } from "../../lib/keyGate";

interface Props {
  question: string;
  onYes: () => void;
  onNo: () => void;
  yesDisabled?: boolean;
}

/** 카드 안 덮개의 초점. 막이 없어(옆 카드는 그대로 쓴다) 모달 영역으로 올리지 않고(lib/keyGate '모달의 초점') 덮개가 스스로 한다:
 *  뜨면 target 에 초점을 주고, 걷히면 연 단추로 돌려준다. 전엔 초점이 연 단추(S)에 남아 Tab 이 뒤 카드로만 가고 덮개의 단추에는
 *  닿지 않았다(2026-10-11 실측: Tab 40번 동안 한 번도). 확인 단계(아래)와 검토 메뉴(GenerationReviewOverlay)가 같이 쓴다. */
export function useOverlayFocus(target: () => HTMLElement | null | undefined): void {
  const targetRef = useRef(target);
  targetRef.current = target;
  const openerRef = useRef<Element | null>(null);
  if (openerRef.current === null) openerRef.current = document.activeElement; // 연 단추 — 처음 그릴 때의 초점
  useEffect(() => {
    const opener = openerRef.current;
    // S 를 누르고 덮개가 뜨기까지(한 번·두 번 누름을 가르는 기다림) 그사이 글 칸으로 옮겨 간 초점은 뺏지 않는다 — 적던 글이 끊긴다.
    if (isTypingTarget(opener)) return;
    targetRef.current()?.focus({ preventScroll: true });
    return () => {
      // 덮개와 함께 사라진 초점(BODY)만 돌려준다 — 바깥을 눌러 닫으며 다른 곳으로 간 초점은 뺏지 않는다.
      if (document.activeElement !== document.body) return;
      if (opener instanceof HTMLElement && opener.isConnected && !opener.closest("[inert]")) opener.focus({ preventScroll: true });
    };
  }, []);
}

export function ConfirmQuestion({ question, onYes, onNo, yesDisabled = false }: Props) {
  const t = useT();
  const submittedRef = useRef(false);
  // 뜨면 안전한 쪽(No)에 초점을 주고, Tab 은 Yes ↔ No 만 돈다.
  const actionsRef = useRef<HTMLDivElement>(null);
  useOverlayFocus(() => actionsRef.current?.querySelector<HTMLElement>(".cs-final-no"));
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Tab") {
      e.preventDefault();
      // 꺼져 있는 Yes 는 초점을 받지 않는다 — 그때는 No 에 머문다
      [...e.currentTarget.querySelectorAll("button")].find((button) => button !== e.target)?.focus();
    }
    // Space 는 초점이 놓인 단추(Yes/No)를 누르는 키다 — 뒤 격자까지 올라가면 격자가 기본 동작을 막아(위에 뜬 것이 있을 때 뒤 목록이
    //  밀리지 않게) 단추가 눌리지 않는다. 격자는 'Tab 으로 온 초점'만 단추의 것으로 보는데(규칙 8), 여기 초점은 덮개가 준 것이다.
    else if (e.key === " ") e.stopPropagation();
  };
  return <>
    <span className="cs-final-q">{t(question)}</span>
    <div className="cs-final-actions" ref={actionsRef} onKeyDown={onKeyDown}>
      <button className="cs-final-yes" disabled={yesDisabled} onClick={() => {
        if (submittedRef.current || yesDisabled) return;
        submittedRef.current = true;
        onYes();
      }}>Yes</button>
      <button className="cs-final-no" onClick={onNo}>No</button>
    </div>
  </>;
}
