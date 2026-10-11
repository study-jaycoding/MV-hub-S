// 단일/더블클릭을 delay(ms) 타이머로 분리하는 공용 훅.
// S 버튼처럼 "한 번 클릭=공유 토글, 두 번 클릭=최종 지정"이 충돌하는 곳에서, 한 번 클릭하면
// delay 후 single() 을 실행하되 그 사이 더블클릭이 오면 타이머를 취소하고 double() 만 실행한다.
// 가드(본인만/잠금 등)는 호출측이 single()/double() 안팎에서 주입한다.
// 카드 그리드와 히스토리 보드가 같은 220ms 분리 로직을 복붙하던 것을 통합 + 언마운트 누수 방지.
import { useCallback, useEffect, useRef } from "react";

export function useClickSeparation(delay = 220) {
  const timer = useRef<number | null>(null);
  const pendingKey = useRef<unknown>(undefined); // 대기 중인 클릭의 대상(여러 대상이 훅 하나를 같이 쓸 때)
  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  // 한 번 클릭: 같은 대상이 이미 대기 중이면(더블 처리 경로) 무시, 아니면 delay 후 single() 실행.
  // key = 누른 대상. 보드(캔버스·계보)는 훅 하나를 모든 카드가 같이 쓴다 — 대상을 가리지 않으면 앞 카드의 대기(220ms) 중에 누른
  //  **다른 카드**의 S 가 '둘째 클릭'으로 버려지고 앞 카드의 확인만 뒤늦게 뜬다(Codex 검토). 다른 대상이면 앞 예약을 버리고 새 대상으로 바꾼다
  //  (확인은 보드에 하나뿐이라 어차피 나중 것이 남는다). key 를 안 주면 전과 같다(카드마다 제 훅을 쓰는 격자).
  const onClick = useCallback(
    (single: () => void, key?: unknown) => {
      if (timer.current) {
        if (pendingKey.current === key) return;
        clear();
      }
      pendingKey.current = key;
      timer.current = window.setTimeout(() => {
        timer.current = null;
        single();
      }, delay);
    },
    [clear, delay],
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
