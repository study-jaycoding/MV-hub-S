import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BeginSceneDrag } from "./useSceneDragSession";
import {
  centerSceneCamera,
  clampSceneZoom,
  clientToScenePoint,
  frameSceneRects,
  panSceneCamera,
  sameSceneViewRect,
  SCENE_LOD_PCT,
  sceneViewRect,
  zoomSceneCameraAt,
  type SceneCamera,
  type SceneViewRect,
  type SceneWorldRect,
} from "./sceneViewport";
import { setSceneZoomPct } from "./sceneZoomStore";
import { swallowPanAuxClick } from "./useSceneCardMove";

const CAMERA_SAVE_DELAY_MS = 400;
const FRAME_TRANSITION_MS = 250;
const FRAME_TRANSITION_CLEAR_MS = 300;
const SETTLE_MS = 150; // 줌을 건너뛴 뒤 휠을 이만큼 쉬면 컬링을 한 번 정리한다
const LOD_SHOW_DELAY_MS = 150; // 25% 를 넘게 확대한 뒤 배율이 이만큼 쉬면 작은 조각(포트·이름표…)을 다시 보인다 — 아래 applyTransform
/** 보드 안에 뜨는 창의 바탕 — 모델·Comfy 설정·글·복구(`.scene-modelmodal-backdrop`) · 생성 결과(`.scene-varpop-backdrop`) · 타임라인 재생(`.vtl-backdrop`).
 *  창 위의 휠·끌어 놓기는 창의 것이다 — 뒤 보드가 받지 않는다(휠은 여기, 놓기는 useSceneClipboardDrop). 창이 늘면 여기에 더한다. */
export const SCENE_WINDOW_SELECTOR = ".scene-varpop-backdrop, .scene-modelmodal-backdrop, .vtl-backdrop";
const WHEEL_OVERLAY_SELECTOR = `${SCENE_WINDOW_SELECTOR}, .sl-dropdown, .sl-dockbar`;

interface ScenePanStartEvent {
  button: number;
  clientX: number;
  clientY: number;
  preventDefault: () => void;
}

interface UseSceneViewportOptions {
  sceneId: string;
  camera?: SceneCamera;
  onCameraChange?: (camera: SceneCamera) => void;
  cullingEnabled: boolean;
  gridSize?: number;
  /** 가운데 버튼으로 끄는 동안(과 손 뗀 직후 정리)·줌(범위 크기 변경) 때 컬링 범위를 다시 확정할지 — 거짓이면 확정값(viewRect)을
   *  그대로 두어 SceneBoard 를 다시 그리지 않는다. 최신 범위(liveView)는 늘 갱신한다. 화면 맞춤 이동·씬 전환 등은 묻지 않고 확정한다. */
  shouldCommitView?: (committed: SceneViewRect | null, next: SceneViewRect) => boolean;
  /** 줌을 건너뛴 뒤 쉬었을 때(SETTLE_MS) 한 번 정리할지 — 컬링 대상 집합이 달라졌으면(들어옴·빠짐) 참. 없으면 범위가 다르면 정리. */
  cullSetChanged?: (committed: SceneViewRect | null, next: SceneViewRect) => boolean;
  /** 지금 카드·그룹을 쥐고 있나 — 참이면 쉼 정리를 미룬다(끄는 중에 판을 다시 그리지 않게). 휠 직후 화면이 갱신되기 전에 끌기를
   *  시작하면 정리 예약이 끌기 시작보다 늦게 걸려 취소로는 못 막는다(독립 리뷰 P2). */
  isInteracting?: () => boolean;
}

/** 점 격자 층을 미는 양 — 한 칸 안(음수 팬도 0..cell), 화면 픽셀로 반올림. */
const gridShift = (v: number, cell: number) => {
  const dpr = window.devicePixelRatio || 1;
  return Math.round((((v % cell) + cell) % cell) * dpr) / dpr;
};

const normalizedCamera = (camera?: SceneCamera): SceneCamera => ({
  z: clampSceneZoom(camera?.z),
  x: camera?.x ?? 0,
  y: camera?.y ?? 0,
});

/** SceneBoard의 팬·줌·좌표 변환과 카메라 저장 생명주기를 관리한다. */
export function useSceneViewport({
  sceneId,
  camera,
  onCameraChange,
  cullingEnabled,
  gridSize = 22,
  shouldCommitView,
  cullSetChanged,
  isInteracting,
}: UseSceneViewportOptions) {
  const initialCamera = normalizedCamera(camera);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(initialCamera.z);
  const panRef = useRef({ x: initialCamera.x, y: initialCamera.y });
  const minimapUpdateRef = useRef<((slide?: boolean) => void) | null>(null);
  // 캔버스 transform 에 지금 들어 있는 팬 — 가운데 버튼으로 끄는 동안은 여기서부터 translate 로만 민다(slidePan)
  const shownPanRef = useRef({ x: initialCamera.x, y: initialCamera.y });
  const slidingRef = useRef(false);
  // viewRect = 컬링에 쓰는 '확정' 범위(바뀌면 SceneBoard 를 다시 그린다) · liveView = 문턱을 넘을 때마다의 최신 범위(무선 짝 꼬리표 등)
  const [viewRect, setViewRect] = useState<SceneViewRect | null>(null);
  const viewRectRef = useRef<SceneViewRect | null>(null);
  const liveViewRef = useRef<SceneViewRect | null>(null);
  const liveListenersRef = useRef(new Set<() => void>());
  const panEndRef = useRef(false); // 가운데 버튼을 뗐다 — 다음 범위 계산에서 확정이 필요한지만 본다
  const shouldCommitRef = useRef(shouldCommitView);
  shouldCommitRef.current = shouldCommitView;
  const cullSetChangedRef = useRef(cullSetChanged);
  cullSetChangedRef.current = cullSetChanged;
  const isInteractingRef = useRef(isInteracting);
  isInteractingRef.current = isInteracting;
  // 보드 크기 — ResizeObserver 가 배치가 끝난 뒤 적어 둔다. 매 프레임 getBoundingClientRect 로 읽으면 방금 옮긴 화면의 배치를
  //  그 자리에서 강제로 다시 계산했다(2026-11-10 실측: 휠 한 칸·끄는 한 걸음마다 한 번).
  const boardSizeRef = useRef<{ width: number; height: number } | null>(null);
  const settleTimerRef = useRef<number | undefined>(undefined);
  const cullFrameRef = useRef<number | null>(null);
  const cameraSaveTimerRef = useRef<number | undefined>(undefined);
  const transitionTimerRef = useRef<number | undefined>(undefined);
  const lodShowTimerRef = useRef<number | undefined>(undefined); // 작은 조각 다시 보이기 예약(위 LOD_SHOW_DELAY_MS)
  const lodShowZoomRef = useRef(0); // 그 예약을 건 배율 — 같은 배율의 다시 그리기는 예약을 늘이지 않는다
  const incomingCameraRef = useRef(camera);
  incomingCameraRef.current = camera;
  const onCameraChangeRef = useRef(onCameraChange);
  onCameraChangeRef.current = onCameraChange;
  // 카메라 출처 — GPU 판이 듣는다(features/canvas/gpu). 화면을 옮기는 모든 길(applyTransform·slidePan)이 알리고, 저장(persistCamera)과는 따로다.
  //  듣는 쪽이 없으면(GPU 판 꺼짐) 하는 일이 없다 — SceneBoard 를 다시 그리지 않는다. transitionMs = 화면 맞춤의 미끄러짐 시간(없으면 바로).
  const cameraListenersRef = useRef(new Set<(transitionMs: number) => void>());
  const cameraTransitionRef = useRef(0);

  const getCamera = useCallback(
    (): SceneCamera => ({ z: zoomRef.current, x: panRef.current.x, y: panRef.current.y }),
    [],
  );

  const replaceCamera = useCallback((next: SceneCamera) => {
    zoomRef.current = next.z;
    panRef.current = { x: next.x, y: next.y };
  }, []);

  const persistCamera = useCallback(() => {
    onCameraChangeRef.current?.(getCamera());
  }, [getCamera]);

  // 지금 카메라·보드 크기의 범위 — 크기는 ResizeObserver 가 적어 둔 값(없으면 한 번 직접 읽는다)
  const measureView = useCallback((): SceneViewRect | null => {
    let size = boardSizeRef.current;
    if (!size) {
      const viewport = scrollRef.current?.getBoundingClientRect();
      if (!viewport) return null;
      size = { width: viewport.width, height: viewport.height };
    }
    return sceneViewRect(getCamera(), size);
  }, [getCamera]);
  const publishLive = useCallback((view: SceneViewRect) => {
    liveViewRef.current = view;
    for (const listener of liveListenersRef.current) listener();
  }, []);
  const cancelSettle = useCallback(() => {
    if (settleTimerRef.current === undefined) return;
    clearTimeout(settleTimerRef.current);
    settleTimerRef.current = undefined;
  }, []);
  // 줌을 건너뛴 뒤의 쉼 정리 — 예약 때가 아니라 **지금의** 카메라·크기·판정 자료로 범위를 새로 재서, 컬링 대상이 달라졌을 때만 확정한다
  const settleNow = useCallback(() => {
    settleTimerRef.current = undefined;
    if (slidingRef.current) return; // 끄는 중이면 손 뗄 때의 정리가 맡는다
    if (isInteractingRef.current?.()) {
      // 카드·그룹을 쥐고 있다 — 놓은 뒤로 미룬다(놓을 때까지 다시 확인)
      settleTimerRef.current = window.setTimeout(settleNow, SETTLE_MS);
      return;
    }
    const next = measureView();
    if (!next) return;
    const changed = cullSetChangedRef.current
      ? cullSetChangedRef.current(viewRectRef.current, next)
      : !sameSceneViewRect(viewRectRef.current, next);
    if (!changed) {
      if (!sameSceneViewRect(liveViewRef.current, next)) publishLive(next);
      return;
    }
    publishLive(next);
    viewRectRef.current = next;
    setViewRect(next);
  }, [measureView, publishLive]);

  const scheduleCull = useCallback(() => {
    if (!cullingEnabled || cullFrameRef.current !== null) return;
    cullFrameRef.current = requestAnimationFrame(() => {
      cullFrameRef.current = null;
      const next = measureView();
      if (!next) return;
      const panEnd = panEndRef.current;
      panEndRef.current = false;
      const prevLive = liveViewRef.current;
      // 크기가 바뀐 범위 = 줌·창 크기 변경이다(끌어 옮기기는 크기가 그대로) — 끄는 중이거나 막 뗐어도 그 변화는 끄기로 보지 않는다
      const resized = !!prevLive && (Math.abs(next.r - next.l - (prevLive.r - prevLive.l)) > 1 || Math.abs(next.b - next.t - (prevLive.b - prevLive.t)) > 1);
      const panning = (slidingRef.current || panEnd) && !resized;
      const publish = publishLive;
      const liveMoved = !sameSceneViewRect(prevLive, next);
      if (liveMoved) publish(next);
      if (!panning) {
        // 줌·화면 맞춤·창 크기·씬 전환·그 밖의 이동 — **확정값**과 비교한다(끄는 동안 건너뛴 뒤의 줌이 최신 범위와만 비교되어
        //  확정이 낡은 채 남지 않게 — Codex 독립 리뷰 P2)
        const committed = viewRectRef.current;
        if (sameSceneViewRect(committed, next)) return;
        // 줌(크기 변경)도 새로 붙일 카드·선이 없으면 확정하지 않는다 — 휠 한 칸마다 판 전체를 다시 그렸다(2026-11-10 실측).
        //  확대는 빠지기만 하니 대개 건너뛰고, 쉬면 한 번 정리한다(settleNow — 빠진 카드를 떼어 낸다).
        //  크기 변경은 최신 범위뿐 아니라 **확정값**과도 견준다 — 건너뛴 뒤 다른 까닭(선택 등)으로 다시 그려지면 최신 범위와는 크기가
        //  같아 판정 없이 확정됐다(독립 리뷰 P2). 그 다시 그리기는 걸린 예약을 늘이지 않는다(휠 한 칸만 예약을 다시 건다).
        const zoomedSinceCommit = !!committed && (Math.abs(next.r - next.l - (committed.r - committed.l)) > 1 || Math.abs(next.b - next.t - (committed.b - committed.t)) > 1);
        if ((resized || zoomedSinceCommit) && shouldCommitRef.current && !shouldCommitRef.current(committed, next)) {
          if (!liveMoved) publish(next);
          if (resized || settleTimerRef.current === undefined) {
            cancelSettle();
            settleTimerRef.current = window.setTimeout(settleNow, SETTLE_MS);
          }
          return;
        }
        cancelSettle();
        if (!liveMoved) publish(next);
        viewRectRef.current = next;
        setViewRect(next);
        return;
      }
      // 가운데 버튼으로 끄는 동안·손 뗀 직후 — 문턱 비교는 최신 범위와 한다(확정값과 비교하면 건너뛴 뒤 매 걸음 문턱을 넘은 것으로 셌다).
      //  새로 붙일 카드·선이 없으면 확정하지 않는다(다시 그리기 생략, 2026-11-10)
      if (!liveMoved && !panEnd) return;
      const live = liveViewRef.current;
      if (!live || live === viewRectRef.current) return;
      if (shouldCommitRef.current && !shouldCommitRef.current(viewRectRef.current, live)) return;
      viewRectRef.current = live;
      setViewRect(live);
    });
  }, [cullingEnabled, measureView, publishLive, cancelSettle, settleNow]);

  // 최신 범위로 확정한다 — 확정값이 낡은 채 내용이 바뀌어(선택 해제·높이 측정·카드 추가 …) 새로 그려야 할 것이 생겼을 때 SceneBoard 가 부른다
  const commitLiveView = useCallback(() => {
    const live = liveViewRef.current;
    if (!live || live === viewRectRef.current) return;
    viewRectRef.current = live;
    setViewRect(live);
  }, []);
  // 최신 범위 저장소 — 보드마다 하나, 값은 바뀔 때까지 같은 객체다(useSyncExternalStore)
  const liveView = useMemo(
    () => ({
      subscribe: (listener: () => void) => {
        liveListenersRef.current.add(listener);
        return () => {
          liveListenersRef.current.delete(listener);
        };
      },
      getSnapshot: () => liveViewRef.current,
    }),
    [],
  );

  const applyTransform = useCallback(() => {
    const current = getCamera();
    const pct = Math.round(current.z * 100);
    setSceneZoomPct(pct); // 툴바 % — 반올림 % 가 바뀔 때만 알린다
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.style.transform = `translate(${current.x}px, ${current.y}px) scale(${current.z})`;
    }
    shownPanRef.current = { x: current.x, y: current.y };

    const grid = gridRef.current;
    if (grid) {
      // 점 격자는 따로 둔 층을 한 칸 안에서만 민다(음수 팬도 0..cell) — 보드 배경 위치를 바꾸면 보드 전체를
      //  다시 칠했다. 크기는 확대 때만 바꾼다. 층이 사방 64px 넘쳐 있어(scene.css) 미는 동안 빈틈이 없다.
      //  미는 양은 화면 픽셀로 반올림한다 — 소수 픽셀만큼 옮긴 층은 GPU 가 보간해 점이 번진다(0.5px 이하 오차).
      const cell = gridSize * current.z;
      const size = `${cell}px ${cell}px`;
      if (grid.style.backgroundSize !== size) grid.style.backgroundSize = size;
      grid.style.transform = `translate(${gridShift(current.x, cell)}px, ${gridShift(current.y, cell)}px)`;
    }
    if (slidingRef.current) {
      // 가운데 버튼으로 끄는 동안 밀어 둔 translate 를 방금 쓴 transform 으로 접는다 — 같은 프레임이라 화면은 그대로다(slidePan).
      //  끄는 중이 아닐 때는 건드리지 않는다 — 카드 전부 끌기도 캔버스 층을 같은 표식·translate 로 민다(useSceneCardMove).
      slidingRef.current = false;
      for (const layer of [canvas, grid]) {
        if (!layer) continue;
        layer.style.translate = "";
        layer.toggleAttribute("data-layer-move", false);
      }
    }
    const board = scrollRef.current;
    if (board) {
      // 멀리서 볼 때 단순화 — React 가 쓰지 않는 속성이라 className 이 다시 그려져도 남는다.
      //  숨기기(25% 이하로 내려감)는 바로, 다시 보이기(25% 넘게 올라감)는 배율이 LOD_SHOW_DELAY_MS 쉰 뒤 한 번 — 확대 도중 경계를 넘자마자 카드 수백 장의
      //  포트·이름표가 붙어 남은 확대 프레임마다 그만큼 더 칠했다(2026-11-10 격리 실측: 25% 넘는 확대 메인 −22%·33ms 초과 6 → 3).
      //  축소는 바로 숨겨야 칠할 것이 준다(숨기기까지 미루면 축소가 +15% — 같은 실측).
      const low = pct <= SCENE_LOD_PCT;
      if (low || !board.hasAttribute("data-lod-low")) {
        if (lodShowTimerRef.current !== undefined) clearTimeout(lodShowTimerRef.current);
        lodShowTimerRef.current = undefined;
        board.toggleAttribute("data-lod-low", low);
      } else if (lodShowTimerRef.current === undefined || lodShowZoomRef.current !== current.z) {
        if (lodShowTimerRef.current !== undefined) clearTimeout(lodShowTimerRef.current);
        lodShowZoomRef.current = current.z;
        lodShowTimerRef.current = window.setTimeout(() => {
          lodShowTimerRef.current = undefined;
          scrollRef.current?.toggleAttribute("data-lod-low", Math.round(zoomRef.current * 100) <= SCENE_LOD_PCT);
        }, LOD_SHOW_DELAY_MS);
      }
    }
    minimapUpdateRef.current?.();
    scheduleCull();
    for (const listener of cameraListenersRef.current) listener(cameraTransitionRef.current);
  }, [getCamera, gridSize, scheduleCull]);

  // 가운데 버튼으로 끄는 한 걸음 — 화면 전체 레이어를 다시 합치지 않고 합성기만으로 민다. 걸음마다 transform 을 바꾸면 크롬이 그때마다
  //  레이어를 다시 합쳐(Layerize) 느린 PC 에서 끊겼다(2026-11-10 격리 실측, CPU 4배·400장 60걸음: 1.3~1.9초 → 주입 0.24~0.34초).
  //  카드 전부 끌기의 빠른 길과 같은 표식(data-layer-move — 값 0 애니메이션, scene.css)과 translate 를 캔버스·점 격자·미니맵 상자
  //  **셋 다**에 쓴다 — 하나라도 transform 으로 옮기면 합치기가 되살아났다. 카메라 값(panRef)은 걸음마다 맞으므로 toCanvas 는 그대로다.
  //  접는 것은 applyTransform 이다(손 뗌·휠·창 크기·화면 맞춤·씬 전환·보드 스크롤 접기가 모두 그 길).
  const slidePan = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    slidingRef.current = true;
    const pan = panRef.current;
    const shown = shownPanRef.current;
    canvas.toggleAttribute("data-layer-move", true);
    canvas.style.translate = `${pan.x - shown.x}px ${pan.y - shown.y}px`;
    const grid = gridRef.current;
    if (grid) {
      // 칸 나머지의 차이만 민다 — 층이 사방 64px 만 넘쳐 있어 끈 거리만큼 밀면 가장자리가 빈다
      const cell = gridSize * zoomRef.current;
      grid.toggleAttribute("data-layer-move", true);
      grid.style.translate = `${gridShift(pan.x, cell) - gridShift(shown.x, cell)}px ${gridShift(pan.y, cell) - gridShift(shown.y, cell)}px`;
    }
    minimapUpdateRef.current?.(true);
    scheduleCull();
    for (const listener of cameraListenersRef.current) listener(0);
  }, [gridSize, scheduleCull]);

  // 렌더마다 카메라를 다시 적용한다 — 가운데 버튼으로 끄는 중이면 접지 않고 민 채로 둔다. 보이는 범위가 바뀌어 다시 그릴 때마다 접으면
  //  표식이 떨어졌다 붙으며 그 프레임에 화면 전체 정리(PrePaint·레이어 합치기)가 다시 돌았다(2026-11-10 격리 실측).
  useLayoutEffect(() => {
    if (slidingRef.current) slidePan();
    else applyTransform();
  });

  useEffect(() => {
    if (!cullingEnabled) return;
    const board = scrollRef.current;
    if (!board) return;
    // 크기는 지금처럼 getBoundingClientRect 의 폭·높이(같은 기준) — ResizeObserver 콜백은 배치가 끝난 뒤라 강제 계산이 아니다
    const remember = () => {
      const rect = board.getBoundingClientRect();
      boardSizeRef.current = { width: rect.width, height: rect.height };
    };
    const observer = new ResizeObserver(() => {
      remember();
      applyTransform();
    });
    observer.observe(board);
    remember();
    applyTransform();
    return () => {
      observer.disconnect();
      boardSizeRef.current = null;
      cancelSettle();
      if (cullFrameRef.current !== null) {
        cancelAnimationFrame(cullFrameRef.current);
        cullFrameRef.current = null;
      }
    };
  }, [applyTransform, cancelSettle, cullingEnabled]);

  const toCanvas = useCallback(
    (clientX: number, clientY: number) => {
      const viewport = scrollRef.current!.getBoundingClientRect();
      return clientToScenePoint(
        clientX,
        clientY,
        viewport.left,
        viewport.top,
        getCamera(),
      );
    },
    [getCamera],
  );

  const navigateTo = useCallback(
    (worldX: number, worldY: number, commit: boolean) => {
      const viewport = scrollRef.current?.getBoundingClientRect();
      if (!viewport) return;
      replaceCamera(
        centerSceneCamera(
          getCamera(),
          { width: viewport.width, height: viewport.height },
          worldX,
          worldY,
        ),
      );
      applyTransform();
      if (commit) persistCamera();
    },
    [applyTransform, getCamera, persistCamera, replaceCamera],
  );

  const frameRects = useCallback(
    (rects: readonly SceneWorldRect[], maxZoom: number) => {
      const viewport = scrollRef.current?.getBoundingClientRect();
      if (!viewport) return;
      // 하단 프롬프트 도크가 보드를 덮은 만큼은 맞춤 영역에서 뺀다 — 안 빼면 보드 한가운데에 맞춘 카드의 아래쪽이 프롬프트 뒤에 놓인다.
      //  도크의 높이를 그대로 빼지 않고 **보드의 위 끝에서 도크의 위 끝까지**를 쓴다(도크가 보드와 겹치지 않으면 보드 전체, 도크
      //  아래의 여백은 맞출 수 없는 띠라 같이 빠진다). 영역이 위쪽으로 줄 뿐이라 가운데 맞춤 계산은 그대로다.
      //  프롬프트를 접었을 때(.sl-hidden)는 줄이지 않는다 — 오른쪽 아래의 상태 줄 하나만 남아 보드 폭의 한 귀퉁이만 가리는데, 그
      //  높이만큼 전체 폭을 줄이면 잃는 쪽이 더 크다.
      const dockTop = document.querySelector(".sl-dockbar:not(.sl-hidden) .sl-dock")?.getBoundingClientRect().top;
      // 0 이하(도크가 그려지지 않아 자리가 0 이거나 보드를 다 덮었다)면 줄일 영역이 없다 — 보드 전체에 맞춘다
      const clear = dockTop === undefined ? viewport.height : dockTop - viewport.top;
      const next = frameSceneRects(
        rects,
        { width: viewport.width, height: clear > 0 ? Math.min(viewport.height, clear) : viewport.height },
        maxZoom,
      );
      if (!next) return;
      cancelSettle(); // 휠 줌 뒤의 쉼 정리는 이 맞춤의 범위로 다시 판정한다
      // 가운데 버튼으로 끄는 도중이면 지금 보이는 자리를 먼저 전환 없이 접고 그 스타일을 확정한 뒤 미끄러진다 — 밀어 둔 translate 를
      //  지운 채 미끄러지면 끌기 시작 자리로 튀었다가 맞춤 자리로 갔다. CSS 전환은 마지막으로 확정된 스타일에서 출발하므로 접은 뒤
      //  계산된 값을 한 번 읽어 확정해야 그 자리가 출발점이 된다(Codex 묶음 리뷰 P2 두 번, 2026-11-10)
      if (slidingRef.current) {
        const canvas = canvasRef.current;
        if (canvas) canvas.style.transition = "";
        applyTransform();
        if (canvas) void getComputedStyle(canvas).transform;
      }
      replaceCamera(next);

      const canvas = canvasRef.current;
      if (canvas) {
        // 점 격자는 따라 미끄러지지 않고 끝 위치로 바로 간다 — 한 칸 안에서만 미는 층이라 전환이 엉뚱한 쪽으로 돈다.
        canvas.style.transition = `transform ${FRAME_TRANSITION_MS / 1000}s ease`;
        if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
        transitionTimerRef.current = window.setTimeout(() => {
          transitionTimerRef.current = undefined;
          if (canvasRef.current) canvasRef.current.style.transition = "";
        }, FRAME_TRANSITION_CLEAR_MS);
      }

      cameraTransitionRef.current = FRAME_TRANSITION_MS; // GPU 판도 같은 시간 동안 미끄러진다
      applyTransform();
      cameraTransitionRef.current = 0;
      persistCamera();
    },
    [applyTransform, cancelSettle, persistCamera, replaceCamera],
  );

  // 툴바 −/+ — 휠 줌과 같은 한 단계(×1.1) 규칙을 화면 중앙 기준으로 적용.
  const stepZoom = useCallback(
    (dir: 1 | -1) => {
      const viewport = scrollRef.current?.getBoundingClientRect();
      if (!viewport) return;
      const next = zoomSceneCameraAt(
        getCamera(),
        viewport.width / 2,
        viewport.height / 2,
        dir > 0 ? -1 : 1, // deltaY<0 = 확대
      );
      if (next.z === zoomRef.current) return;
      cancelSettle(); // 새 조작 — 지난 휠 줌의 쉼 정리를 거둔다(이 줌이 필요하면 다시 건다)
      replaceCamera(next);
      applyTransform();
      persistCamera();
    },
    [applyTransform, cancelSettle, getCamera, persistCamera, replaceCamera],
  );

  const beginPan = useCallback(
    (event: ScenePanStartEvent, beginDrag: BeginSceneDrag) => {
      if (event.button !== 1) return false;
      event.preventDefault();
      cancelSettle(); // 누르는 순간 — 휠 줌 뒤의 쉼 정리가 끄는 중에 판을 다시 그리지 않게(손 뗄 때의 정리가 맡는다)
      const startX = event.clientX;
      const startY = event.clientY;
      let lastX = startX;
      let lastY = startY;
      let moved = false; // 정지 휠 클릭은 카드 정보(auxclick)다 — 실제로 끌었을 때만 놓는 순간의 auxclick 을 삼킨다
      const move = (moveEvent: MouseEvent) => {
        if (!moved && Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY) > 3) {
          moved = true;
          // 끄는 표시(보드 위 덮개 — scene.css)는 실제로 움직였을 때만 — 누를 때 붙이면 덮개가 정지 휠 클릭(카드 정보)을 가로챈다(계보 보드와 같다).
          //  클래스가 아니라 속성이다 — 보드의 className 은 React 가 그려서(가위 Y·연결선) 끄는 도중 바뀌면 손으로 붙인 클래스가 지워졌다(Codex 리뷰 P2)
          scrollRef.current?.setAttribute("data-panning", "");
        }
        // 지난 걸음에서 움직인 만큼만 지금 카메라에 더한다 — 끄는 도중 다른 길(보드 스크롤 접기·휠 줌·화면 맞춤)이 바꾼 카메라를
        //  덮지 않게. 시작 카메라 + 끈 거리로 다시 셈하면 그 변화만큼 화면이 되튀었다(Codex 묶음 리뷰 P2·P3, 2026-11-10).
        const next = panSceneCamera(getCamera(), moveEvent.clientX - lastX, moveEvent.clientY - lastY);
        lastX = moveEvent.clientX;
        lastY = moveEvent.clientY;
        panRef.current = { x: next.x, y: next.y };
        slidePan();
      };
      const finish = () => {
        scrollRef.current?.removeAttribute("data-panning");
        panEndRef.current = true; // 끄는 동안 건너뛴 확정을 정리 — 새로 그릴 것이 없으면 그대로 둔다
        applyTransform(); // 밀어 둔 화면을 transform 으로 접는다
        persistCamera();
      };
      // 놓는 순간(up)에만 삼킨다 — 놓친 끌기를 다음 누름이 정리할 때(onCancel)는 그 놓기의 auxclick 이 이미 지나갔다(Codex 66회차 리뷰)
      beginDrag(move, () => {
        finish();
        if (moved) swallowPanAuxClick();
      }, finish);
      return true;
    },
    [applyTransform, cancelSettle, getCamera, persistCamera, slidePan],
  );

  useEffect(() => {
    const board = scrollRef.current;
    if (!board) return;
    const onWheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement;
      if (target?.closest?.(WHEEL_OVERLAY_SELECTOR)) return;
      for (
        let node: HTMLElement | null = target;
        node && node !== board;
        node = node.parentElement
      ) {
        const style = getComputedStyle(node);
        const scrollY =
          (style.overflowY === "auto" || style.overflowY === "scroll") &&
          node.scrollHeight > node.clientHeight;
        const scrollX =
          (style.overflowX === "auto" || style.overflowX === "scroll") &&
          node.scrollWidth > node.clientWidth;
        if (scrollY || scrollX) return;
      }

      event.preventDefault();
      const viewport = board.getBoundingClientRect();
      const next = zoomSceneCameraAt(
        getCamera(),
        event.clientX - viewport.left,
        event.clientY - viewport.top,
        event.deltaY,
      );
      if (next.z === zoomRef.current) return;
      replaceCamera(next);
      applyTransform();
      if (cameraSaveTimerRef.current) clearTimeout(cameraSaveTimerRef.current);
      cameraSaveTimerRef.current = window.setTimeout(() => {
        cameraSaveTimerRef.current = undefined;
        persistCamera();
      }, CAMERA_SAVE_DELAY_MS);
    };
    board.addEventListener("wheel", onWheel, { passive: false });
    return () => board.removeEventListener("wheel", onWheel);
  }, [applyTransform, getCamera, persistCamera, replaceCamera]);

  // 보드는 overflow:hidden 이라 손으로는 안 굴러가지만 브라우저는 초점·캐럿을 보이려고 스스로 스크롤한다(화면 아래쪽 글 카드에서 줄을 칠 때 등).
  //  toCanvas 는 그 스크롤을 빼지 않아 붙여넣기·새 노드가 그만큼 위에 놓였다(2026-11-10 격리 실측 121px). 스크롤 양을 팬으로 옮기고 0 으로 되돌린다 —
  //  보이는 자리는 브라우저가 옮긴 그대로(캐럿이 보인다)이고 좌표는 늘 맞다. 저장은 휠처럼 늦춘다.
  useEffect(() => {
    const board = scrollRef.current;
    if (!board) return;
    const onScroll = () => {
      const dx = board.scrollLeft;
      const dy = board.scrollTop;
      if (!dx && !dy) return;
      board.scrollLeft = 0;
      board.scrollTop = 0;
      panRef.current = { x: panRef.current.x - dx, y: panRef.current.y - dy };
      applyTransform();
      if (cameraSaveTimerRef.current) clearTimeout(cameraSaveTimerRef.current);
      cameraSaveTimerRef.current = window.setTimeout(() => {
        cameraSaveTimerRef.current = undefined;
        persistCamera();
      }, CAMERA_SAVE_DELAY_MS);
    };
    board.addEventListener("scroll", onScroll);
    return () => board.removeEventListener("scroll", onScroll);
  }, [applyTransform, persistCamera]);

  useEffect(() => {
    if (cameraSaveTimerRef.current) {
      clearTimeout(cameraSaveTimerRef.current);
      cameraSaveTimerRef.current = undefined;
    }
    replaceCamera(normalizedCamera(incomingCameraRef.current));
    // 씬이 바뀌면 옛 씬의 범위를 버린다 — 카메라가 같은 씬끼리 바꿔도 새로 재서 확정한다(끄는 동안 건너뛴 낡은 확정값이 남지 않게)
    viewRectRef.current = null;
    liveViewRef.current = null;
    panEndRef.current = false;
    cancelSettle();
    // 씬이 바뀌면 작은 조각 표시는 새 씬의 배율로 바로 정한다(다시 보이기 예약을 남기지 않는다)
    if (lodShowTimerRef.current !== undefined) clearTimeout(lodShowTimerRef.current);
    lodShowTimerRef.current = undefined;
    scrollRef.current?.removeAttribute("data-lod-low");
    applyTransform();
  }, [sceneId, applyTransform, cancelSettle, replaceCamera]);

  useEffect(
    () => () => {
      if (cameraSaveTimerRef.current) clearTimeout(cameraSaveTimerRef.current);
      if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
      if (cullFrameRef.current !== null) cancelAnimationFrame(cullFrameRef.current);
      if (settleTimerRef.current !== undefined) clearTimeout(settleTimerRef.current);
      if (lodShowTimerRef.current !== undefined) clearTimeout(lodShowTimerRef.current);
    },
    [],
  );

  const cameraSource = useMemo(
    () => ({
      subscribe: (listener: (transitionMs: number) => void) => {
        cameraListenersRef.current.add(listener);
        return () => {
          cameraListenersRef.current.delete(listener);
        };
      },
      getSnapshot: getCamera,
    }),
    [getCamera],
  );

  return {
    scrollRef,
    canvasRef,
    gridRef,
    zoomRef,
    panRef,
    minimapUpdateRef,
    viewRect,
    liveView,
    cameraSource,
    commitLiveView,
    cancelSettle,
    getCamera,
    toCanvas,
    navigateTo,
    frameRects,
    stepZoom,
    beginPan,
  };
}
