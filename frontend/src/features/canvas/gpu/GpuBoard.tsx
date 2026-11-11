// GPU 판 — 보드 크기 canvas 하나에 판을 WebGL2 로 그린다(docs/status/캔버스_GPU판설계_2026-11-11.md).
//  SceneBoard 가 그릴 모델(gpuScene)·모드 단계(gpuMode)를 주고, 여기서는 렌더러·아틀라스 수명, 프레임마다 굽기(예산 안)·그리기,
//  준비 끝·켤 때 30번 검사·조작 중 긴 프레임·실패를 모드에 알리고, 마우스가 머문 카드를 덧판으로 고른다.
//  카메라는 쓰지 않는다(읽기만) — useSceneViewport 의 카메라 출처가 화면을 옮길 때마다 알린다.
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from "react";
import type { RefObject } from "react";
import { flashMsg } from "../../../lib/flash";
import { SCENE_LOD_PCT, type SceneCamera } from "../../../lib/sceneViewport";
import { createCardAtlas, type CardAtlas } from "./cardAtlas";
import { buildHitIndex, hitTop, isOccluded, type HitIndex } from "./gpuHit";
import { gpuModeReducer, initialGpuMode, userEditAllowed, type GpuModeEvent, type GpuPhase } from "./gpuMode";
import { createGpuRenderer, type GpuCamera, type GpuRenderer } from "./gpuRenderer";
import type { GpuSceneModel } from "./gpuScene";

const OVERLAY_DWELL_MS = 120; // 마우스가 이만큼 머문 카드에만 덧판(빠른 지나감엔 안 띄움)
const REST_MS = 150; // 카메라가 이만큼 쉬어야 준비 끝을 알린다(입력 중 교체 금지)
const LONG_FRAME_MS = 50;
const INTERACT_WINDOW_MS = 300; // 마지막 카메라 변화 뒤 이만큼은 '조작 중'으로 보고 긴 프레임을 센다
const PROBE_FRAMES = 30;

export interface CameraSource {
  subscribe: (listener: (transitionMs: number) => void) => () => void;
  getSnapshot: () => SceneCamera;
}

export interface GpuBoardProps {
  phase: Exclude<GpuPhase, "dom">;
  token: number;
  sceneId: string;
  model: GpuSceneModel;
  /** 덧판이 덮는 카드 — 그 카드의 GPU 그림을 감춘다(덧판이 준비된 같은 프레임) */
  hiddenId: string | null;
  cameraSource: CameraSource;
  boardRef: RefObject<HTMLDivElement | null>;
  dispatch: (e: GpuModeEvent) => void;
  /** 덧판으로 띄울 카드(마우스 아래 맨 앞 카드가 120ms 머묾·앞 카드에 안 가림) 또는 null(카드 밖) */
  onHover: (cardId: string | null) => void;
  /** 덧판 안에 초점·덧판에서 연 창이 있다 — 마우스가 떠나도 덧판을 두고 새 덧판도 안 띄운다 */
  overlayPinned: boolean;
}

/** 아틀라스와 같은 해상도 단계 — 화면 배율을 1.25배 넘게 늘려 그리지 않는 가장 작은 단계 */
const tierOf = (scale: number) => [0.25, 0.5, 1, 2].find((t) => scale <= t * 1.25) ?? 2;

const median = (xs: number[]) => {
  if (!xs.length) return Infinity;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** 이미지 주소 → 굽는 크기에 맞춘 비트맵(같은 출처 /api 썸네일). 실패하면 null(빗금 자리). */
async function decodeImage(src: string, resizeWidth: number): Promise<ImageBitmap | null> {
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await createImageBitmap(blob, { resizeWidth: Math.max(1, Math.round(resizeWidth)), resizeQuality: "high" });
  } catch {
    return null;
  }
}

const makeCanvas = (w: number, h: number): HTMLCanvasElement | OffscreenCanvas => {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};

export function GpuBoard(props: GpuBoardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef(props);
  live.current = props;
  const st = useRef({
    renderer: null as GpuRenderer | null,
    atlas: null as CardAtlas | null,
    failed: false,
    raf: 0,
    dirty: true,
    size: { width: 0, height: 0 },
    // 보이는 카메라(화면 맞춤 미끄러짐 중엔 사이 값) · 미끄러짐
    shown: null as SceneCamera | null,
    drawn: null as SceneCamera | null, // 마지막으로 그린 카메라(미끄러짐 출발점)
    slide: null as { from: SceneCamera; start: number; ms: number } | null,
    lastCameraAt: -Infinity,
    lastFrameAt: 0,
    synced: { z: 0, x: 0, y: 0, scale: 0, model: null as GpuSceneModel | null, w: 0, h: 0 },
    generation: 0,
    sceneId: "",
    preparedSent: -1,
    probeSent: -1,
    hit: null as HitIndex | null,
    hover: { id: null as string | null, timer: 0 },
    // 25% 이하 단순화 — 판 안에서 정한다(React 상태로 두면 경계를 넘을 때마다 SceneBoard 가 통째로 다시 그려졌다: 11-11 실측 83ms 프레임)
    lowLod: false,
    lodTimer: 0,
    sceneDirty: false, // 단순화가 바뀌어 버퍼를 다시 채울 것
    bakedPrev: false, // 바로 앞 프레임에 구웠다 — 그 프레임 간격은 GPU 느림 판정에 세지 않는다
    texPeak: 0,
    cpuPeak: 0,
  });

  const fail = (reason: "creation" | "memory" | "context-lost") => {
    const s = st.current;
    if (s.failed) return;
    s.failed = true;
    live.current.dispatch({ type: "failure", reason });
  };

  const camera = (): GpuCamera => {
    const s = st.current;
    const c = s.shown ?? live.current.cameraSource.getSnapshot();
    return { z: c.z, x: c.x, y: c.y, dpr: window.devicePixelRatio || 1, width: s.size.width, height: s.size.height };
  };

  /** 보이는 카드 id — 화면 범위의 반만큼 더 넓게(곧 보일 카드를 먼저 굽는다) */
  const visibleIds = (c: GpuCamera, model: GpuSceneModel): Set<string> => {
    const mx = c.width / c.z / 2, my = c.height / c.z / 2;
    const l = -c.x / c.z - mx, t = -c.y / c.z - my, r = (c.width - c.x) / c.z + mx, b = (c.height - c.y) / c.z + my;
    const ids = new Set<string>();
    for (const card of model.cards) if (card.x <= r && card.x + card.w >= l && card.y <= b && card.y + card.h >= t) ids.add(card.id);
    for (const q of model.quads) if (q.x <= r && q.x + q.w >= l && q.y <= b && q.y + q.h >= t) ids.add(q.id);
    return ids;
  };

  /** 아틀라스에 지금 요청·보이는 카드·배율을 알린다 — 모델이 바뀌었거나 화면이 꽤 움직였을 때만(매 프레임 아님).
   *  해상도 단계는 카메라가 쉰 뒤(150ms)에만 바꾼다 — 줌 도중 단계가 바뀔 때마다 보이는 카드를 모두 다시 구우면 그 굽기가 줌 프레임을 먹었다
   *  (11-11 격리 실측: 메인 2~3배). 줌 도중엔 옛 그림을 늘리거나 줄여 그린다. */
  const syncAtlas = (force: boolean) => {
    const s = st.current;
    const { model } = live.current;
    if (!s.atlas) return;
    const c = camera();
    const resting = performance.now() - s.lastCameraAt >= REST_MS;
    const scale = resting || !s.synced.scale ? c.z * c.dpr : s.synced.scale;
    const moved = Math.abs(c.x - s.synced.x) + Math.abs(c.y - s.synced.y) > Math.max(c.width, c.height) * 0.25;
    const zoomed = !s.synced.z || Math.abs(Math.log(c.z / s.synced.z)) > 0.1;
    const retier = tierOf(scale) !== tierOf(s.synced.scale);
    if (!force && s.synced.model === model && !moved && !zoomed && !retier && s.synced.w === c.width && s.synced.h === c.height) return;
    s.synced = { z: c.z, x: c.x, y: c.y, scale, model, w: c.width, h: c.height };
    try {
      s.atlas.sync(model.requests, visibleIds(c, model), scale, s.generation);
    } catch {
      fail("memory");
    }
  };

  const allVisibleBaked = (): boolean => {
    const s = st.current;
    if (!s.atlas) return false;
    const ids = visibleIds(camera(), live.current.model);
    for (const id of ids) if (!s.atlas.lookup(id)) return false;
    return true;
  };

  const kick = () => {
    const s = st.current;
    if (!s.raf && !s.failed) s.raf = requestAnimationFrame(frame);
  };

  /** 버퍼를 다시 채운다 — 덧판이 덮는 카드는 감추고, 25% 이하면 hideLow 조각(결과 수 배지·폴더 이름표·회색 끝 점)을 뺀다 */
  const applyScene = () => {
    const s = st.current;
    if (!s.renderer) return;
    const { model, hiddenId } = live.current;
    s.renderer.setScene({
      cards: model.cards,
      lines: model.lines, rects: model.rects,
      dots: s.lowLod ? model.dots.filter((d) => !d.hideLow) : model.dots,
      quads: s.lowLod ? model.quads.filter((q) => !q.hideLow) : model.quads,
      gridColor: [0, 0, 0, 0], // 점 격자는 DOM 층 그대로(.scene-grid)
    });
    s.renderer.setHidden(hiddenId);
  };

  const drawNow = () => {
    const s = st.current;
    if (!s.renderer || !s.atlas || s.failed || live.current.phase === "preparing") {
      st.current.dirty = true;
      return;
    }
    const c = camera();
    s.renderer.draw(c, s.atlas.lookup);
    s.drawn = { z: c.z, x: c.x, y: c.y };
    s.dirty = false;
  };

  function frame(now: number) {
    const s = st.current;
    s.raf = 0;
    if (s.failed || !s.renderer || !s.atlas) return;
    const p = live.current;
    const gap = s.lastFrameAt ? now - s.lastFrameAt : 0;
    s.lastFrameAt = now;
    // 미끄러짐(화면 맞춤) — 보이는 카메라를 목표로 이끈다
    if (s.slide) {
      const target = p.cameraSource.getSnapshot();
      const k = Math.min(1, (now - s.slide.start) / s.slide.ms);
      const e = k * k * (3 - 2 * k);
      const f = s.slide.from;
      s.shown = { z: f.z + (target.z - f.z) * e, x: f.x + (target.x - f.x) * e, y: f.y + (target.y - f.y) * e };
      if (k >= 1) {
        s.slide = null;
        s.shown = null;
      }
      s.dirty = true;
    }
    if (s.sceneDirty) {
      s.sceneDirty = false;
      applyScene();
      s.dirty = true;
    }
    // 조작 중(카메라가 움직인 뒤 150ms 안)에는 굽지 않는다 — 이미 구운 그림을 늘리거나 줄여 그리고, 쉬면 또렷하게 다시 굽는다.
    //  굽기는 프레임 예산(4ms) 안이라도 느린 PC 에서는 그만큼 길어져 움직이는 프레임을 먹었다(11-11 격리 실측: CPU 4배에서 느린 GPU 잠금).
    const interacting = now - s.lastCameraAt < REST_MS;
    let uploaded = 0, pending = 0, baked = 0;
    if (!interacting) {
      syncAtlas(false);
      try {
        const r = s.atlas.tick();
        uploaded = r.uploadedPx;
        pending = r.pending;
        baked = r.baked;
      } catch {
        fail("memory");
        return;
      }
    } else pending = 1; // 쉬면 다시 돈다
    // 실제 할당 최고점(계약 gpu-env ④) — 텍스처 합계·CPU 굽기 버퍼. 늘 때만 canvas 속성에 적는다(실측 도구가 읽는다)
    const tex = s.renderer.textureBytes(), cpu = s.atlas.cpuBytes();
    if (tex > s.texPeak || cpu > s.cpuPeak) {
      s.texPeak = Math.max(s.texPeak, tex);
      s.cpuPeak = Math.max(s.cpuPeak, cpu);
      canvasRef.current?.setAttribute("data-tex-peak", String(s.texPeak));
      canvasRef.current?.setAttribute("data-cpu-peak", String(s.cpuPeak));
    }
    if ((s.dirty || uploaded > 0) && p.phase !== "preparing") {
      const c = camera();
      s.renderer.draw(c, s.atlas.lookup);
      s.drawn = { z: c.z, x: c.x, y: c.y };
      s.dirty = false;
    }
    const resting = now - s.lastCameraAt >= REST_MS;
    if (p.phase === "preparing" && s.preparedSent !== p.token && resting && allVisibleBaked()) {
      s.preparedSent = p.token;
      p.dispatch({ type: "prepared", token: p.token });
    }
    if (p.phase === "probing" && s.probeSent !== p.token) {
      s.probeSent = p.token;
      const token = p.token;
      s.renderer.draw(camera(), s.atlas.lookup); // 검사는 마지막 그린 카메라로 30번
      void s.renderer.timeGpu(PROBE_FRAMES).then((ms) => {
        if (!st.current.failed) live.current.dispatch({ type: "probe", token, medianMs: median(ms) });
      });
    }
    // 조작 중 긴 프레임(최근 10초 3번이면 모드가 잠근다 — 느린 GPU 판정) — 50ms 를 넘은 프레임만 알린다(그 밖엔 모드 상태가 안 바뀐다).
    //  바로 앞 프레임에 구웠으면 세지 않는다: 그 간격은 CPU 굽기(쉰 뒤 다시 굽기)라 GPU 가 느린 것이 아니다.
    if (p.phase === "gpu" && gap > LONG_FRAME_MS && now - s.lastCameraAt < INTERACT_WINDOW_MS && !s.bakedPrev) p.dispatch({ type: "frame", now, ms: gap });
    s.bakedPrev = baked > 0 || uploaded > 0;
    const busy = pending > 0 || s.dirty || !!s.slide || (p.phase === "preparing" && s.preparedSent !== p.token) || now - s.lastCameraAt < INTERACT_WINDOW_MS;
    if (busy) kick();
    else s.lastFrameAt = 0; // 쉬는 동안의 간격을 다음 프레임의 긴 프레임으로 세지 않게
  }

  // 렌더러·아틀라스 — 마운트 동안 하나(모드가 dom 으로 가면 SceneBoard 가 이 칸을 내려 모두 놓는다)
  useLayoutEffect(() => {
    const s = st.current;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = createGpuRenderer(canvas, { onContextLost: () => fail("context-lost") });
    if (!renderer) {
      fail("creation");
      return;
    }
    s.renderer = renderer;
    s.atlas = createCardAtlas({ uploader: renderer, now: () => performance.now(), makeCanvas, decode: decodeImage });
    s.lowLod = Math.round(live.current.cameraSource.getSnapshot().z * 100) <= SCENE_LOD_PCT;
    const board = live.current.boardRef.current;
    const measure = () => {
      const rect = board?.getBoundingClientRect();
      s.size = { width: rect?.width ?? 0, height: rect?.height ?? 0 };
      s.dirty = true;
      kick();
    };
    measure();
    const ro = board ? new ResizeObserver(measure) : null;
    if (board) ro!.observe(board);
    return () => {
      ro?.disconnect();
      if (s.raf) cancelAnimationFrame(s.raf);
      s.raf = 0;
      clearTimeout(s.hover.timer);
      clearTimeout(s.lodTimer);
      s.atlas?.dispose();
      renderer.destroy();
      s.atlas = null;
      s.renderer = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 카메라 — 바뀔 때마다 한 번 그린다(화면 맞춤이면 마지막으로 그린 카메라에서 같은 시간 동안 미끄러진다)
  useEffect(() => {
    return props.cameraSource.subscribe((transitionMs) => {
      const s = st.current;
      const now = performance.now();
      if (transitionMs > 0) s.slide = { from: s.drawn ?? props.cameraSource.getSnapshot(), start: now, ms: transitionMs };
      s.lastCameraAt = now;
      s.dirty = true;
      // 25% 이하 단순화 — 숨기기는 바로, 다시 보이기는 배율이 150ms 쉰 뒤(useSceneViewport 의 data-lod-low 와 같은 규칙)
      const low = Math.round(props.cameraSource.getSnapshot().z * 100) <= SCENE_LOD_PCT;
      if (low) {
        clearTimeout(s.lodTimer);
        if (!s.lowLod) { s.lowLod = true; s.sceneDirty = true; }
      } else if (s.lowLod) {
        clearTimeout(s.lodTimer);
        s.lodTimer = window.setTimeout(() => { s.lowLod = false; s.sceneDirty = true; kick(); }, LOD_SHOW_MS);
      }
      kick();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.cameraSource]);

  // 씬이 바뀌면 세대를 올려 늦게 온 디코드·굽기를 버린다
  useEffect(() => {
    const s = st.current;
    if (s.sceneId === props.sceneId) return;
    s.sceneId = props.sceneId;
    s.generation += 1;
    s.atlas?.reset(s.generation);
    s.synced.model = null;
  }, [props.sceneId]);

  // 그릴 모델 — 버퍼를 다시 채우고 아틀라스에 알린다(위치·선택이 바뀔 때만 불린다 — 카메라는 아니다). layout 단계에서 바로 그린다.
  useLayoutEffect(() => {
    const s = st.current;
    if (!s.renderer || !s.atlas) return;
    const { model } = props;
    s.sceneDirty = false;
    applyScene();
    s.hit = buildHitIndex(model.cards.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, z: c.z })));
    syncAtlas(true);
    drawNow();
    kick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.model]);
  // 덧판 — 그 카드 한 장만 감추고 되살린다(버퍼 전체를 다시 채우면 느린 PC 에서 50ms 를 넘었다: 11-11 CPU 4배 이동 중 잠금).
  //  layout 단계에서 바로 그린다 — 덧판 DOM 이 붙거나 떨어지는 같은 프레임에 GPU 그림을 감추고 되살린다(깜박임 없음).
  useLayoutEffect(() => {
    const s = st.current;
    if (!s.renderer) return;
    s.renderer.setHidden(props.hiddenId);
    drawNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.hiddenId]);

  // 단계가 바뀌면(준비 → 검사 → 그리기) 다시 돈다
  useEffect(() => {
    st.current.dirty = true;
    kick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.phase, props.token]);

  // 마우스 올림 → 덧판(GPU 단계에서만). 덧판 DOM 위의 움직임도 보드로 올라온다 — 같은 카드면 그대로.
  useEffect(() => {
    const board = props.boardRef.current;
    if (!board || props.phase !== "gpu") return;
    const s = st.current;
    const clear = () => {
      clearTimeout(s.hover.timer);
      s.hover.id = null;
      if (!live.current.overlayPinned) live.current.onHover(null);
    };
    const onMove = (e: MouseEvent) => {
      if (!s.hit) return;
      // 화면을 옮기는 동안(가운데 버튼 끌기·휠 직후)엔 덧판을 고르지 않는다 — 지나가는 카드마다 덧판이 뜨고 내려가 프레임을 먹었다
      if (performance.now() - s.lastCameraAt < REST_MS || board.hasAttribute("data-panning")) {
        clearTimeout(s.hover.timer);
        s.hover.id = null;
        return;
      }
      const rect = board.getBoundingClientRect();
      const c = live.current.cameraSource.getSnapshot();
      const x = (e.clientX - rect.left - c.x) / c.z, y = (e.clientY - rect.top - c.y) / c.z;
      const top = hitTop(s.hit, x, y);
      if (!top) return clear();
      if (top.id === s.hover.id) return;
      clearTimeout(s.hover.timer);
      s.hover.id = top.id;
      if (live.current.overlayPinned) return;
      s.hover.timer = window.setTimeout(() => {
        if (s.hover.id !== top.id || live.current.overlayPinned || !s.hit) return;
        live.current.onHover(isOccluded(s.hit, top) ? null : top.id);
      }, OVERLAY_DWELL_MS);
    };
    board.addEventListener("mousemove", onMove, { passive: true });
    board.addEventListener("mouseleave", clear);
    return () => {
      board.removeEventListener("mousemove", onMove);
      board.removeEventListener("mouseleave", clear);
      clearTimeout(s.hover.timer);
    };
  }, [props.boardRef, props.phase]);

  return (
    <canvas
      ref={canvasRef}
      className="scene-gpu-board"
      data-phase={props.phase}
      aria-hidden="true"
    />
  );
}

const INPUT_QUIET_MS = 1000; // 준비를 취소한 입력 뒤 이만큼 조용하면 처음부터 다시 준비한다
const LOD_SHOW_MS = 150; // 25% 를 넘어 확대한 뒤 이만큼 쉬면 작은 조각을 다시 보인다(useSceneViewport 와 같은 값)
const zoomBand = (scale: number) => (scale > 2.5 ? "hi" : scale < 2.2 ? "lo" : "mid");

/** SceneBoard 쪽 모드 관리 — 표식·씬·미지원·한가함·배율 경계를 gpuMode 에 알리고, 25% 단순화·편집 허용·거절 안내를 준다.
 *  표식이 꺼져 있으면 아무 이벤트도 보내지 않아 상태가 바뀌지 않는다(SceneBoard 추가 렌더 0). 배율은 경계(2.2·2.5)를 넘을 때만 보낸다 —
 *  휠 한 칸마다 보내면 상태가 매번 새 객체라 판 전체가 다시 그려진다. */
export function useGpuBoardMode(o: { flag: boolean; sceneId: string; unsupported: boolean; busy: boolean; cameraSource: CameraSource }) {
  const [mode, dispatch] = useReducer(gpuModeReducer, undefined, initialGpuMode);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const busyRef = useRef(o.busy);
  busyRef.current = o.busy;
  const quietTimer = useRef(0);

  useEffect(() => {
    if (o.flag) dispatch({ type: "flag", enabled: true });
  }, [o.flag]);
  useEffect(() => {
    if (o.flag) dispatch({ type: "scene", sceneId: o.sceneId, unsupported: o.unsupported });
  }, [o.flag, o.sceneId, o.unsupported]);
  useEffect(() => {
    if (o.flag) dispatch({ type: "idle", idle: !o.busy });
  }, [o.flag, o.busy]);
  useEffect(() => () => clearTimeout(quietTimer.current), []);

  // 배율 경계 — 카메라 출처를 듣는다(표식 켬일 때만). 25% 단순화는 GPU 판 안에서 정한다(SceneBoard 를 다시 그리지 않게).
  useEffect(() => {
    if (!o.flag) return;
    const scaleOf = () => o.cameraSource.getSnapshot().z * (window.devicePixelRatio || 1);
    let band = zoomBand(scaleOf());
    let tickTimer = 0;
    dispatch({ type: "zoom", scale: scaleOf(), now: performance.now(), zooming: false });
    const off = o.cameraSource.subscribe(() => {
      const now = performance.now();
      const scale = scaleOf();
      const b = zoomBand(scale);
      if (b !== band) {
        band = b;
        dispatch({ type: "zoom", scale, now, zooming: false });
      }
      // 상한을 넘었거나 상한 때문에 DOM 인 동안만 쉼 판정이 필요하다
      if (band === "hi" || modeRef.current.zoomBlocked) {
        clearTimeout(tickTimer);
        tickTimer = window.setTimeout(() => dispatch({ type: "tick", now: performance.now(), zooming: false }), 160);
      }
    });
    return () => {
      off();
      clearTimeout(tickTimer);
    };
  }, [o.flag, o.cameraSource]);

  /** 사용자 입력(누름·키·붙여넣기·끌어 놓기·창 열기) — 준비 중이면 준비를 취소하고, 조용해지면 처음부터 다시 */
  const noteInput = useCallback(() => {
    if (modeRef.current.phase !== "preparing") return;
    dispatch({ type: "input" });
    clearTimeout(quietTimer.current);
    quietTimer.current = window.setTimeout(() => dispatch({ type: "idle", idle: !busyRef.current }), INPUT_QUIET_MS);
  }, []);

  // 준비 중에는 창 전체의 누름·키·붙여넣기·끌어 놓기를 듣는다(보드 밖에서 창을 여는 누름도 입력이다) — 준비 단계가 아니면 듣지 않는다
  useEffect(() => {
    if (mode.phase !== "preparing") return;
    const types = ["mousedown", "keydown", "paste", "drop"] as const;
    for (const t of types) window.addEventListener(t, noteInput, true);
    return () => {
      for (const t of types) window.removeEventListener(t, noteInput, true);
    };
  }, [mode.phase, noteInput]);

  // 거절 안내 — 같은 안내가 겹치지 않게 1.5초에 한 번
  const refusedAt = useRef(-Infinity);
  const refuse = useCallback(() => {
    const now = performance.now();
    if (now - refusedAt.current < 1500) return;
    refusedAt.current = now;
    flashMsg("보기 모드 — 편집하려면 편집 모드로 돌아가세요(` 키 또는 아래 모드 단추)");
  }, []);

  /** 모드 단추·` 키 — 편집(DOM) ↔ 보기(GPU). 잠긴 세션이면 까닭만 알린다. */
  const toggle = useCallback(() => {
    const m = modeRef.current;
    if (m.locked) {
      flashMsg(m.locked === "context-lost" || m.locked === "creation" ? "이 PC 에서 GPU 판을 켤 수 없어 편집 모드로 둡니다" : "GPU 판이 이 PC 에서 느려 편집 모드로 둡니다");
      return;
    }
    dispatch({ type: "user-mode", mode: m.userDom ? "gpu" : "dom" });
  }, []);

  return { mode, dispatch, editAllowed: userEditAllowed(mode), noteInput, refuse, toggle };
}

/** 카드 사각형 × 카메라 → 화면(보드 기준 CSS px) — GPU 단계에서 cardEls 대신(리스트 크게 보기 위치 등) */
export function cardScreenRect(card: { x: number; y: number; w: number; h: number }, camera: SceneCamera) {
  return { left: card.x * camera.z + camera.x, top: card.y * camera.z + camera.y, width: card.w * camera.z, height: card.h * camera.z };
}
