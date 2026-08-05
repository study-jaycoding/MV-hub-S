import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BeginSceneDrag } from "./useSceneDragSession";
import {
  centerSceneCamera,
  clientToScenePoint,
  frameSceneRects,
  panSceneCamera,
  sameSceneViewRect,
  sceneViewRect,
  zoomSceneCameraAt,
  type SceneCamera,
  type SceneViewRect,
  type SceneWorldRect,
} from "./sceneViewport";

const CAMERA_SAVE_DELAY_MS = 400;
const FRAME_TRANSITION_MS = 250;
const FRAME_TRANSITION_CLEAR_MS = 300;
const WHEEL_OVERLAY_SELECTOR =
  ".scene-varpop-backdrop, .scene-modelmodal-backdrop, .sl-dropdown, .sl-dockbar";

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
}

const normalizedCamera = (camera?: SceneCamera): SceneCamera => ({
  z: camera?.z ?? 1,
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
}: UseSceneViewportOptions) {
  const initialCamera = normalizedCamera(camera);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(initialCamera.z);
  const panRef = useRef({ x: initialCamera.x, y: initialCamera.y });
  const minimapUpdateRef = useRef<(() => void) | null>(null);
  const [viewRect, setViewRect] = useState<SceneViewRect | null>(null);
  const viewRectRef = useRef<SceneViewRect | null>(null);
  const cullFrameRef = useRef<number | null>(null);
  const cameraSaveTimerRef = useRef<number | undefined>(undefined);
  const transitionTimerRef = useRef<number | undefined>(undefined);
  const incomingCameraRef = useRef(camera);
  incomingCameraRef.current = camera;
  const onCameraChangeRef = useRef(onCameraChange);
  onCameraChangeRef.current = onCameraChange;

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

  const applyTransform = useCallback(() => {
    const current = getCamera();
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.style.transform = `translate(${current.x}px, ${current.y}px) scale(${current.z})`;
    }

    const board = scrollRef.current;
    if (board) {
      const cell = gridSize * current.z;
      board.style.backgroundSize = `${cell}px ${cell}px`;
      board.style.backgroundPosition = `${current.x}px ${current.y}px`;
    }
    minimapUpdateRef.current?.();

    if (!cullingEnabled || cullFrameRef.current !== null) return;
    cullFrameRef.current = requestAnimationFrame(() => {
      cullFrameRef.current = null;
      const viewport = scrollRef.current?.getBoundingClientRect();
      if (!viewport) return;
      const next = sceneViewRect(getCamera(), {
        width: viewport.width,
        height: viewport.height,
      });
      if (sameSceneViewRect(viewRectRef.current, next)) return;
      viewRectRef.current = next;
      setViewRect(next);
    });
  }, [cullingEnabled, getCamera, gridSize]);

  useLayoutEffect(applyTransform);

  useEffect(() => {
    if (!cullingEnabled) return;
    const board = scrollRef.current;
    if (!board) return;
    const observer = new ResizeObserver(applyTransform);
    observer.observe(board);
    applyTransform();
    return () => {
      observer.disconnect();
      if (cullFrameRef.current !== null) {
        cancelAnimationFrame(cullFrameRef.current);
        cullFrameRef.current = null;
      }
    };
  }, [applyTransform, cullingEnabled]);

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
      const next = frameSceneRects(
        rects,
        { width: viewport.width, height: viewport.height },
        maxZoom,
      );
      if (!next) return;
      replaceCamera(next);

      const canvas = canvasRef.current;
      if (canvas) {
        canvas.style.transition = `transform ${FRAME_TRANSITION_MS / 1000}s ease`;
        if (scrollRef.current) {
          scrollRef.current.style.transition =
            `background-position ${FRAME_TRANSITION_MS / 1000}s ease, ` +
            `background-size ${FRAME_TRANSITION_MS / 1000}s ease`;
        }
        if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
        transitionTimerRef.current = window.setTimeout(() => {
          transitionTimerRef.current = undefined;
          if (canvasRef.current) canvasRef.current.style.transition = "";
          if (scrollRef.current) scrollRef.current.style.transition = "";
        }, FRAME_TRANSITION_CLEAR_MS);
      }

      applyTransform();
      persistCamera();
    },
    [applyTransform, persistCamera, replaceCamera],
  );

  const beginPan = useCallback(
    (event: ScenePanStartEvent, beginDrag: BeginSceneDrag) => {
      if (event.button !== 1) return false;
      event.preventDefault();
      const start = getCamera();
      const startX = event.clientX;
      const startY = event.clientY;
      const move = (moveEvent: MouseEvent) => {
        const next = panSceneCamera(
          start,
          moveEvent.clientX - startX,
          moveEvent.clientY - startY,
        );
        panRef.current = { x: next.x, y: next.y };
        applyTransform();
      };
      const finish = () => {
        scrollRef.current?.classList.remove("panning");
        persistCamera();
      };
      scrollRef.current?.classList.add("panning");
      beginDrag(move, finish, finish);
      return true;
    },
    [applyTransform, getCamera, persistCamera],
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

  useEffect(() => {
    if (cameraSaveTimerRef.current) {
      clearTimeout(cameraSaveTimerRef.current);
      cameraSaveTimerRef.current = undefined;
    }
    replaceCamera(normalizedCamera(incomingCameraRef.current));
    applyTransform();
  }, [sceneId, applyTransform, replaceCamera]);

  useEffect(
    () => () => {
      if (cameraSaveTimerRef.current) clearTimeout(cameraSaveTimerRef.current);
      if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
      if (cullFrameRef.current !== null) cancelAnimationFrame(cullFrameRef.current);
    },
    [],
  );

  return {
    scrollRef,
    canvasRef,
    zoomRef,
    panRef,
    minimapUpdateRef,
    viewRect,
    getCamera,
    toCanvas,
    navigateTo,
    frameRects,
    beginPan,
  };
}
