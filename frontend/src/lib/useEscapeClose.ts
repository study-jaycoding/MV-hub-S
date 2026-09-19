import { useEffect, useRef } from "react";

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
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (consume) {
        e.preventDefault();
        e.stopPropagation();
      }
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, capture);
    return () => window.removeEventListener("keydown", onKey, capture);
  }, [enabled, capture, consume]);
}
