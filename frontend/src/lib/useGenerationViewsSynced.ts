// "Last viewed" 배지 상태를 구독하면서 서버와 맞춰 두는 훅 — 캔버스(SceneBoard)와 생성 탭(ThumbnailGrid)이 같이 쓴다.
//  · 마운트·씬 변경 때 읽는다.
//  · 생성물 변경 신호(같은 창 appEvents · 다른 창 BroadcastChannel)가 오면 300ms 트레일링 디바운스로 다시 읽는다.
//    휴지통 이동·복원은 서버 조회에서 걸러지므로, 다시 읽어야 화면 배지도 따라간다(코덱스 P2).
//    배치 태깅처럼 신호가 연속으로 오면 1회로 합친다(useSceneGenData 와 같은 값).
//  · generationViews.ts 와 파일을 나눈 이유: 그쪽은 순수 store 라 vitest 가 http 만 목으로 갈아끼운다.
//    BroadcastChannel·DOM 이벤트 구독을 거기 넣으면 테스트 환경이 오염된다.
import { useEffect, useRef } from "react";
import { APP_EVENTS } from "./appEvents";
import { onLibraryChanged } from "./libraryBroadcast";
import { useCustomEvent } from "./useCustomEvent";
import { refreshGenerationViews, useGenerationViews, type SceneViews } from "./generationViews";

export function useGenerationViewsSynced(sceneId = ""): SceneViews {
  const sceneRef = useRef(sceneId);
  sceneRef.current = sceneId;
  useEffect(() => {
    void refreshGenerationViews(sceneId);
  }, [sceneId]);

  const timer = useRef<number | undefined>(undefined);
  const bump = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void refreshGenerationViews(sceneRef.current);
    }, 300);
  };
  useEffect(() => onLibraryChanged(bump), []); // 창 간
  useCustomEvent(APP_EVENTS.libraryChanged, bump); // 같은 창(내 담기·삭제·복원 즉시)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return useGenerationViews(sceneId);
}
