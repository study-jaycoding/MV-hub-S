// 단일/더블클릭을 delay(ms) 타이머로 분리하는 공용 훅.
// S 버튼처럼 "한 번 클릭=공유 토글, 두 번 클릭=최종 지정"이 충돌하는 곳에서, 한 번 클릭하면
// delay 후 single() 을 실행하되 그 사이 더블클릭이 오면 타이머를 취소하고 double() 만 실행한다.
// 가드(본인만/잠금 등)는 호출측이 single()/double() 안팎에서 주입한다.
// 카드 그리드와 히스토리 보드가 같은 220ms 분리 로직을 복붙하던 것을 통합 + 언마운트 누수 방지.
import { useCallback, useEffect, useRef } from "react";

export function useClickSeparation(delay = 220) {
  const timer = useRef<number | null>(null);
  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  // 한 번 클릭: 이미 대기 중이면(더블 처리 경로) 무시, 아니면 delay 후 single() 실행.
  const onClick = useCallback(
    (single: () => void) => {
      if (timer.current) return;
      timer.current = window.setTimeout(() => {
        timer.current = null;
        single();
      }, delay);
    },
    [delay],
  );
  // 더블클릭: 대기 중인 단일클릭 타이머를 취소하고 double() 실행.
  const onDouble = useCallback(
    (double: () => void) => {
      clear();
      double();
    },
    [clear],
  );
  // 언마운트 시 대기 중 타이머 정리 — 언마운트 후 setState 경고/누수 방지.
  useEffect(() => clear, [clear]);
  return { onClick, onDouble };
}
