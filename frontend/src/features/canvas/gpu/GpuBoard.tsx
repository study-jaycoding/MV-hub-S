// GPU 판 — 보드 크기 canvas 하나에 판을 WebGL2 로 그린다(docs/status/캔버스_GPU판설계_2026-11-11.md).
//  SceneBoard 가 그릴 모델(gpuScene)·모드 단계(gpuMode)를 주고, 여기서는 렌더러·아틀라스 수명, 프레임마다 굽기(예산 안)·그리기,
//  준비 끝·켤 때 30번 검사·조작 중 긴 프레임·실패를 모드에 알리고, 마우스가 머문 카드를 덧판으로 고른다.
//  카메라는 쓰지 않는다(읽기만) — useSceneViewport 의 카메라 출처가 화면을 옮길 때마다 알린다.
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { RefObject } from "react";
import { flashMsg } from "../../../lib/flash";
import { STORAGE_KEYS } from "../../../lib/storageKeys";
import { SCENE_LOD_PCT, type SceneCamera } from "../../../lib/sceneViewport";
import { createCardAtlas, type CardAtlas } from "./cardAtlas";
import { buildHitIndex, hitTop, isOccluded, type HitIndex } from "./gpuHit";
import { gpuModeReducer, initialGpuMode, userEditAllowed, type GpuFailure, type GpuModeEvent, type GpuPhase } from "./gpuMode";
import { createGpuRenderer, type GpuCamera, type GpuRenderer } from "./gpuRenderer";
import type { GpuSceneModel } from "./gpuScene";

const OVERLAY_DWELL_MS = 120; // 마우스가 이만큼 머문 카드에만 덧판(빠른 지나감엔 안 띄움)
const REST_MS = 150; // 카메라가 이만큼 쉬어야 준비 끝을 알린다(입력 중 교체 금지)
const LONG_FRAME_MS = 50;
const LONG_FRAME_WINDOW_MS = 10_000; // 이 창 안에
const LONG_FRAME_LIMIT = 3; // 이만큼이면 느린 GPU(계약 mode — gpuMode 의 frame 판정과 같은 수)
const INTERACT_WINDOW_MS = 300; // 마지막 카메라 변화 뒤 이만큼은 '조작 중'으로 보고 긴 프레임을 센다
const PROBE_FRAMES = 30;
const LOAF_SETTLE_MS = 120; // 긴 프레임 후보는 그 구간의 LoAF 기록이 도착할 만큼 기다렸다 판정한다
// 긴 애니메이션 프레임(LoAF) 기록 — scripts 는 그 프레임에 돈 스크립트(이벤트·약속·React 렌더·rAF …)
type LoafEntry = PerformanceEntry & { scripts?: ReadonlyArray<{ invoker?: string; startTime: number; duration: number }> };
// GPU 판과 무관함이 확실한 일 — 저장(IndexedDB)·네트워크 응답 해석·파일 읽기 콜백. 그 밖(React 렌더·이벤트·타이머·rAF·출처 불명)은 판의 일로 본다(Codex 합의 6차)
const UNRELATED_INVOKER = /^(IDB|Response\.|XMLHttpRequest|FileReader|WebSocket|BroadcastChannel)/;
const loafSupported = () => typeof PerformanceObserver !== "undefined" && !!PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame");

export interface CameraSource {
  /** transitionMs: > 0 화면 맞춤 미끄러짐 · 0 바로 옮김 · -1 움직임 아님(기기 배율 바뀜 — 조작 시각을 갱신하지 않는다) */
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

// 받은 썸네일 파일(압축된 그대로) — 해상도 단계가 바뀌어 다시 구울 때 같은 주소를 다시 받지 않는다. 최근 것 400개(썸네일 수십 KB 라 수십 MB 아래).
//  shortcut: 개수로만 자른다(크기 합계는 안 본다) — 큰 원본을 썸네일로 쓰는 카드가 많아지면 바이트 합계로 자를 것
const BLOB_CACHE_MAX = 400;
const blobCache = new Map<string, Promise<Blob | null>>();
function blobOf(src: string): Promise<Blob | null> {
  const hit = blobCache.get(src);
  if (hit) {
    blobCache.delete(src);
    blobCache.set(src, hit); // 최근에 쓴 것을 뒤로(오래된 것부터 버린다)
    return hit;
  }
  const p = fetch(src).then((res) => (res.ok ? res.blob() : null)).catch(() => null);
  blobCache.set(src, p);
  void p.then((b) => { if (!b) blobCache.delete(src); }); // 실패는 기억하지 않는다(다음에 다시 받는다)
  while (blobCache.size > BLOB_CACHE_MAX) blobCache.delete(blobCache.keys().next().value!);
  return p;
}

/** 그림 파일 머리 → 보이는 크기(PNG·GIF·JPEG·WebP). JPEG 의 EXIF 회전(5~8)은 가로세로를 바꾼다 — createImageBitmap 이 회전한 그림을 내기 때문.
 *  모르는 형식·잘린 머리면 null. */
export function imageSizeOf(b: Uint8Array): { w: number; h: number } | null {
  const u16 = (i: number, le = false) => (le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
  const u32 = (i: number, le = false) => (le ? (u16(i, true) | (u16(i + 2, true) << 16)) >>> 0 : ((u16(i) << 16) | u16(i + 2)) >>> 0);
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 3) === "PNG") return { w: u32(16), h: u32(20) };
  if (b.length >= 10 && ascii(0, 4) === "GIF8") return { w: u16(6, true), h: u16(8, true) };
  if (b.length >= 26 && ascii(0, 2) === "BM") return { w: Math.abs(u32(18, true) | 0), h: Math.abs(u32(22, true) | 0) };
  if (b.length >= 12 && ascii(4, 4) === "ftyp") {
    // AVIF·HEIC(ISOBMFF) — 'ispe' 상자의 폭·높이, 'irot' 가 90·270도면 바꾼다
    let size: { w: number; h: number } | null = null, turned = false;
    for (let i = 8; i + 16 <= b.length; i++) {
      if (b[i] !== 0x69) continue; // 'i'
      const t = ascii(i, 4);
      if (t === "ispe" && !size) size = { w: u32(i + 8), h: u32(i + 12) };
      else if (t === "irot") turned = (b[i + 4] & 3) % 2 === 1;
    }
    return size && turned ? { w: size.h, h: size.w } : size;
  }
  if (b.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const kind = ascii(12, 4);
    if (kind === "VP8 ") return { w: u16(26, true) & 0x3fff, h: u16(28, true) & 0x3fff };
    if (kind === "VP8L") return { w: 1 + (((b[22] & 0x3f) << 8) | b[21]), h: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
    if (kind === "VP8X") return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let turned = false;
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xff) { i += 1; continue; } // 채움 바이트
      const len = u16(i + 2);
      if (m === 0xe1 && ascii(i + 4, 6) === "Exif\0\0") {
        // EXIF 방향(0x0112) — TIFF 머리의 바이트 순서·IFD0 항목에서 찾는다
        const t = i + 10, le = ascii(t, 2) === "II";
        const ifd = t + u32(t + 4, le);
        const n = ifd + 2 <= b.length ? u16(ifd, le) : 0;
        for (let k = 0; k < n && ifd + 2 + k * 12 + 10 <= b.length; k++) {
          const e = ifd + 2 + k * 12;
          if (u16(e, le) === 0x0112) turned = u16(e + 8, le) >= 5;
        }
      }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        const h = u16(i + 5), w = u16(i + 7);
        return turned ? { w: h, h: w } : { w, h };
      }
      i += 2 + len;
    }
  }
  return null;
}

/** 크기를 디코드 없이 알 수 없는 그림 — GPU 판이 예산 안에서 그릴 수 없다. 그 씬은 DOM 판에 둔다(계약 mode '그릴 수 없는 카드') */
export const UNDRAWABLE = "undrawable";
const JPEG_FULL_SCAN_MAX = 64 * 1024 * 1024;

/** 이미지 주소 → maxW×maxH 상자 안에 비율을 지켜 맞춘 비트맵(아틀라스가 예약한 크기를 넘으면 그 굽기가 실패한다). 받지 못하면 null(빗금 자리),
 *  원본 크기를 디코드 없이 알 수 없으면 UNDRAWABLE. */
export async function decodeImage(src: string, maxW: number, maxH: number): Promise<ImageBitmap | null | typeof UNDRAWABLE> {
  try {
    const blob = await blobOf(src);
    if (!blob) return null;
    const W = Math.max(1, Math.floor(maxW)), H = Math.max(1, Math.floor(maxH));
    if (blob.type === "image/svg+xml") {
      // SVG 는 createImageBitmap(blob) 이 못 읽는다(크롬) — 그림 요소로 읽어 크기를 안 뒤 상자까지 맞춘다(생성 중·빈 생성 카드의 로고).
      //  shortcut: 그림 요소가 SVG 를 원본 크기로 그려 둘 수 있다 — 지금 쓰는 SVG 는 앱 로고뿐이라 작다, 큰 SVG 레퍼런스가 생기면 width·height 속성을 먼저 읽을 것
      const url = URL.createObjectURL(blob);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const nw = img.naturalWidth || W, nh = img.naturalHeight || H;
        const k = Math.min(W / nw, H / nh);
        return await createImageBitmap(img, { resizeWidth: Math.max(1, Math.floor(nw * k)), resizeHeight: Math.max(1, Math.floor(nh * k)), resizeQuality: "high" });
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    // 파일 머리에서 원본 크기(회전 반영)를 먼저 읽어 처음 디코드부터 두 변을 상자 안으로 — 폭만 주거나 원본을 먼저 디코드하면 긴 그림은 상자를 넘는
    //  비트맵이 예산 밖에서 생겼다(2048×16384 = 128MiB, Codex 리뷰 2~4차). 크게 늘리지는 않는다(그릴 때 늘린다).
    let size = imageSizeOf(new Uint8Array(await blob.slice(0, 1024 * 1024).arrayBuffer()));
    if (!size && blob.size > 1024 * 1024 && blob.size <= JPEG_FULL_SCAN_MAX && blob.type !== "image/png")
      size = imageSizeOf(new Uint8Array(await blob.arrayBuffer())); // 메타데이터가 길어 크기 정보가 1MiB 뒤에 있는 JPEG — 압축된 파일만 읽는다(디코드 아님)
    if (!size || !(size.w > 0) || !(size.h > 0)) return UNDRAWABLE;
    const k = Math.min(1, W / size.w, H / size.h);
    return await createImageBitmap(blob, { resizeWidth: Math.max(1, Math.floor(size.w * k)), resizeHeight: Math.max(1, Math.floor(size.h * k)), resizeQuality: "high" });
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
    probe: null as { token: number; medianMs: number } | null, // 끝난 검사 — 카메라가 쉴 때 알린다
    hit: null as HitIndex | null,
    hover: { id: null as string | null, timer: 0 },
    // 25% 이하 단순화 — 판 안에서 정한다(React 상태로 두면 경계를 넘을 때마다 SceneBoard 가 통째로 다시 그려졌다: 11-11 실측 83ms 프레임)
    lowLod: false,
    lodTimer: 0,
    sceneDirty: false, // 단순화가 바뀌어 버퍼를 다시 채울 것
    bakedPrev: false, // 바로 앞 프레임에 구웠다 — 그 프레임 간격은 GPU 느림 판정에 세지 않는다
    texPeak: 0,
    cpuPeak: 0,
    longFrames: [] as number[],
    longCandidates: [] as Array<{ from: number; to: number }>,
    undrawableScene: "", // 그릴 수 없는 그림을 알린 씬
    loafOn: false,
    loaf: [] as Array<{ start: number; end: number }>, // GPU 판과 무관한 일(저장·네트워크 응답 해석) 스크립트가 돈 구간
  });

  const fail = (reason: "creation" | "memory" | "context-lost" | "slow-frames") => {
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

  /** 긴 프레임 후보를 판정해 센다 — 간격에서 GPU 판과 무관한 일(저장·네트워크 응답 해석)의 시간을 덜고도 50ms 를 넘으면 센다(섞인 프레임의
   *  판 지연도 놓치지 않게). 2,060장 실측에서 이동 직후의 씬 저장(IndexedDB·응답 JSON 80~150ms)을 GPU 탓으로 세어 1배에서도 잠겼다(11-11 LoAF 진단).
   *  LoAF 를 못 쓰는 브라우저는 후보를 그대로 센다. 기준에 닿아 잠그면 true. */
  const judgeLongFrames = (now: number): boolean => {
    const s = st.current;
    const ready = s.longCandidates.filter((c) => !s.loafOn || now - c.to >= LOAF_SETTLE_MS);
    if (!ready.length) return false;
    s.longCandidates = s.longCandidates.filter((c) => !ready.includes(c));
    for (const c of ready) {
      // 그 간격과 실제로 겹친 시간만 던다(스크립트 구간 단위 — 두 간격에 걸친 일을 두 번 덜지 않는다, Codex 리뷰 2차)
      const unrelated = s.loaf.reduce((sum, e) => sum + Math.max(0, Math.min(e.end, c.to) - Math.max(e.start, c.from)), 0);
      if (c.to - c.from - unrelated <= LONG_FRAME_MS) continue;
      s.longFrames = s.longFrames.filter((t) => c.to - t <= LONG_FRAME_WINDOW_MS);
      s.longFrames.push(c.to);
      if (s.longFrames.length >= LONG_FRAME_LIMIT) {
        fail("slow-frames");
        return true;
      }
    }
    return false;
  };

  /** 버퍼를 다시 채운다 — 덧판이 덮는 카드는 감추고, 25% 이하면 hideLow 조각(결과 수 배지·폴더 이름표·회색 끝 점)을 뺀다 */
  const applyScene = () => {
    const s = st.current;
    if (!s.renderer) return;
    const { model, hiddenId } = live.current;
    s.renderer.setScene({
      cards: model.cards, lines: model.lines, rects: model.rects, dots: model.dots, quads: model.quads,
      gridColor: [0, 0, 0, 0], // 점 격자는 DOM 층 그대로(.scene-grid)
    });
    s.renderer.setHidden(hiddenId);
    s.renderer.setLowLod(s.lowLod);
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
      // 단순화 경계를 넘었다 — 유니폼 하나만 바꾼다(버퍼 전체를 다시 채우면 축소 도중 그 프레임이 34~83ms 였다: 11-11 실측)
      s.sceneDirty = false;
      s.renderer.setLowLod(s.lowLod);
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
    // 실제 할당 최고점(계약 gpu-env ④) — 텍스처 합계·CPU 굽기 버퍼(비트맵 포함). 아틀라스·렌더러가 할당하는 순간마다 적어 둔 값을 읽는다
    //  (tick 이 끝난 뒤의 합계는 그 사이 잡았다 놓은 굽기 캔버스를 놓친다 — 11-11 리뷰). 늘 때만 canvas 속성에 적는다(실측 도구가 읽는다)
    const tex = s.renderer.texturePeak(), cpu = s.atlas.cpuPeak();
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
      // 표본이 정확히 30개·모두 유한해야 중앙값을 믿는다 — 몇 개 뒤 끊긴 짧은 배열([1, 1, ∞] → 중앙값 1)이 검사를 통과했다(11-11 리뷰). 거부·모자람 = 느린 GPU.
      void s.renderer.timeGpu(PROBE_FRAMES)
        .then((ms) => (ms.length === PROBE_FRAMES && ms.every(Number.isFinite) ? median(ms) : Infinity), () => Infinity)
        .then((medianMs) => {
          if (st.current.failed) return;
          st.current.probe = { token, medianMs };
          kick();
        });
    }
    // 검사 결과는 카메라가 쉬고(150ms) 화면을 끌고 있지 않을 때 알린다 — 검사 도중 시작한 이동·줌 사이에 판을 바꾸지 않는다(계약 transition)
    if (s.probe && (s.probe.token !== p.token || p.phase !== "probing")) s.probe = null;
    if (s.probe && resting && !s.slide && !p.boardRef.current?.hasAttribute("data-panning")) {
      p.dispatch({ type: "probe", token: s.probe.token, medianMs: s.probe.medianMs });
      s.probe = null;
    }
    // 조작 중 긴 프레임(최근 10초 3번이면 잠근다 — 느린 GPU 판정). 판 안에서 세고, 기준에 닿을 때 한 번만 모드에 알린다 —
    //  긴 프레임마다 모드 상태를 바꾸면 SceneBoard 가 그때마다 다시 그려져 그것이 또 긴 프레임을 만들었다(11-11 CPU 4배 이동 중 잠금 연쇄).
    //  바로 앞 프레임에 구웠으면 세지 않는다: 그 간격은 CPU 굽기(쉰 뒤 다시 굽기)라 GPU 가 느린 것이 아니다.
    if (p.phase === "gpu" && gap > LONG_FRAME_MS && now - s.lastCameraAt < INTERACT_WINDOW_MS && !s.bakedPrev) s.longCandidates.push({ from: now - gap, to: now });
    if (judgeLongFrames(now)) return;
    s.bakedPrev = baked > 0 || uploaded > 0;
    const busy = pending > 0 || s.dirty || !!s.slide || !!s.probe || s.longCandidates.length > 0 || (p.phase === "preparing" && s.preparedSent !== p.token) || now - s.lastCameraAt < INTERACT_WINDOW_MS;
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
    // 원본 크기를 디코드 없이 알 수 없는 그림이 나오면 그 씬은 GPU 판이 그릴 수 없다 — 모드에 '미지원'으로 알려 DOM 판에 둔다(씬마다 한 번, 늦은 결과는 버림)
    const decode = async (src: string, w: number, h: number) => {
      const scene = live.current.sceneId;
      const r = await decodeImage(src, w, h);
      if (r !== UNDRAWABLE) return r;
      if (!st.current.failed && live.current.sceneId === scene && s.undrawableScene !== scene) {
        s.undrawableScene = scene;
        live.current.dispatch({ type: "unsupported", sceneId: scene, unsupported: true });
      }
      return null;
    };
    s.atlas = createCardAtlas({ uploader: renderer, now: () => performance.now(), makeCanvas, decode });
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
    // 긴 프레임의 까닭 — GPU 판과 무관한 일(저장·네트워크 응답 해석)의 스크립트 시간을 프레임마다 적어 둔다(최근 15초)
    let loafObs: PerformanceObserver | null = null;
    if (loafSupported()) {
      s.loafOn = true;
      loafObs = new PerformanceObserver((list) => {
        for (const e of list.getEntries() as LoafEntry[])
          for (const x of e.scripts ?? []) if (UNRELATED_INVOKER.test(x.invoker ?? "")) s.loaf.push({ start: x.startTime, end: x.startTime + x.duration });
        const now = performance.now();
        s.loaf = s.loaf.filter((x) => now - x.end < 15_000);
        if (s.longCandidates.length) kick();
      });
      loafObs.observe({ type: "long-animation-frame" });
    }
    return () => {
      loafObs?.disconnect();
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
      s.dirty = true;
      if (transitionMs < 0) {
        // 기기 배율만 바뀌었다 — 다시 그리고(해상도) 굽기 단계를 맞추되 조작으로 세지 않는다
        kick();
        return;
      }
      if (transitionMs > 0) s.slide = { from: s.drawn ?? props.cameraSource.getSnapshot(), start: now, ms: transitionMs };
      s.lastCameraAt = now;
      // 머무는 중이던 덧판 예약을 버린다 — 포인터 아래에서 카드가 떠나도 120ms 뒤에 그 카드 덧판이 떴다(Codex 리뷰 2차)
      clearTimeout(s.hover.timer);
      s.hover.id = null;
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
    clearTimeout(s.hover.timer); // 카드 자리가 바뀌었다 — 옛 판정으로 건 덧판 예약은 버린다(다음 움직임에 다시 고른다)
    s.hover.id = null;
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
      //  화면 맞춤 미끄러짐 중도 같다 — 덧판 DOM 은 이미 목표 카메라에 있어 그림과 어긋난다
      if (performance.now() - s.lastCameraAt < REST_MS || s.slide || board.hasAttribute("data-panning")) {
        clearTimeout(s.hover.timer);
        s.hover.id = null;
        return;
      }
      const rect = board.getBoundingClientRect();
      const c = camera(); // 그림과 같은 카메라(미끄러짐 중엔 사이 값)
      const x = (e.clientX - rect.left - c.x) / c.z, y = (e.clientY - rect.top - c.y) / c.z;
      const top = hitTop(s.hit, x, y);
      if (!top) return clear();
      if (top.id === s.hover.id) return;
      clearTimeout(s.hover.timer);
      s.hover.id = top.id;
      if (live.current.overlayPinned) return;
      s.hover.timer = window.setTimeout(() => {
        if (s.hover.id !== top.id || live.current.overlayPinned || !s.hit) return;
        if (performance.now() - s.lastCameraAt < REST_MS || s.slide || board.hasAttribute("data-panning")) return;
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
// 이 페이지의 잠금(실패·느린 GPU) — 모드 상태는 SceneBoard 안이라 탭을 떠났다 오면 풀려 느린 PC 에서 매번 다시 검사했다(11-11 리뷰).
//  sessionStorage 에 페이지 시작 시각과 같이 둔다: 다시 올라온 보드는 이어 받고, 새로 고침(시작 시각이 다름)하면 풀린다.
const readSessionLock = (): GpuFailure | null => {
  try {
    const v = JSON.parse(sessionStorage.getItem(STORAGE_KEYS.canvasGpuLock) || "null") as { reason: GpuFailure; page: number } | null;
    return v && v.page === performance.timeOrigin ? v.reason : null;
  } catch {
    return null;
  }
};
const writeSessionLock = (reason: GpuFailure) => {
  try {
    sessionStorage.setItem(STORAGE_KEYS.canvasGpuLock, JSON.stringify({ reason, page: performance.timeOrigin }));
  } catch {
    /* 저장 못 하면 이 보드에서만 잠근다 */
  }
};
const LOD_SHOW_MS = 150; // 25% 를 넘어 확대한 뒤 이만큼 쉬면 작은 조각을 다시 보인다(useSceneViewport 와 같은 값)
const zoomBand = (scale: number) => (scale > 2.5 ? "hi" : scale < 2.2 ? "lo" : "mid");

/** SceneBoard 쪽 모드 관리 — 표식·씬·미지원·한가함·배율 경계를 gpuMode 에 알리고, 25% 단순화·편집 허용·거절 안내를 준다.
 *  표식이 꺼져 있으면 아무 이벤트도 보내지 않아 상태가 바뀌지 않는다(SceneBoard 추가 렌더 0). 배율은 경계(2.2·2.5)를 넘을 때만 보낸다 —
 *  휠 한 칸마다 보내면 상태가 매번 새 객체라 판 전체가 다시 그려진다. */
export function useGpuBoardMode(o: { flag: boolean; sceneId: string; unsupported: boolean; busy: boolean; cameraSource: CameraSource }) {
  const [mode, dispatch] = useReducer(gpuModeReducer, undefined, initialGpuMode);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // 훅 아래에서 정해지는 한가함(태그 편집·S 확인·되찾기 창·올리는 중인 파일·보드 안 입력칸 초점) — SceneBoard 가 setLateBusy 로 알린다
  const [lateBusy, setLateBusy] = useState(false);
  const busy = o.busy || lateBusy;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const quietTimer = useRef(0);
  /** 조용히 1초 지나면 한가함 — 그새 입력·바쁨이 오면 다시 센다 */
  const armQuiet = useCallback(() => {
    clearTimeout(quietTimer.current);
    quietTimer.current = window.setTimeout(() => {
      if (!busyRef.current && !modeRef.current.idle) dispatch({ type: "idle", idle: true });
    }, INPUT_QUIET_MS);
  }, []);

  useEffect(() => {
    if (!o.flag) return;
    const lock = readSessionLock();
    if (lock) dispatch({ type: "failure", reason: lock });
    dispatch({ type: "flag", enabled: true });
  }, [o.flag]);
  useEffect(() => {
    if (mode.locked) writeSessionLock(mode.locked);
  }, [mode.locked]);
  useEffect(() => {
    if (o.flag) dispatch({ type: "scene", sceneId: o.sceneId, unsupported: o.unsupported });
  }, [o.flag, o.sceneId, o.unsupported]);
  // 바쁘면 바로 한가하지 않음, 바쁨이 끝나면 1초 조용한 뒤에야 한가함 — 끌기·글 편집이 끝나자마자 준비(새 WebGL·굽기)를 시작하지 않게
  useEffect(() => {
    if (!o.flag) return;
    if (busy) {
      clearTimeout(quietTimer.current);
      if (modeRef.current.idle) dispatch({ type: "idle", idle: false });
      return;
    }
    armQuiet();
  }, [o.flag, busy, armQuiet]);
  useEffect(() => () => clearTimeout(quietTimer.current), []);

  // 배율 경계 — 카메라 출처를 듣는다(표식 켬일 때만). 25% 단순화는 GPU 판 안에서 정한다(SceneBoard 를 다시 그리지 않게).
  useEffect(() => {
    if (!o.flag) return;
    const scaleOf = () => o.cameraSource.getSnapshot().z * (window.devicePixelRatio || 1);
    let band = zoomBand(scaleOf());
    let tickTimer = 0;
    let slideEnd = 0; // 진행 중인 화면 맞춤 미끄러짐이 끝나는 시각 — 그 사이 온 다른 알림(기기 배율 -1·바로 옮김 0)이 대기를 줄이지 않게(Codex 리뷰 4차)
    // 쉼 판정 예약 — 상한을 넘었거나 상한 때문에 DOM 인 동안만. 미끄러짐이면 끝난 뒤에 센다(그림이 아직 움직이는데 바꾸지 않게, Codex 리뷰 3차)
    const scheduleTick = (transitionMs: number) => {
      const now = performance.now();
      if (transitionMs > 0) slideEnd = Math.max(slideEnd, now + transitionMs);
      if (band !== "hi" && !modeRef.current.zoomBlocked) return;
      clearTimeout(tickTimer);
      tickTimer = window.setTimeout(() => dispatch({ type: "tick", now: performance.now(), zooming: false }), Math.max(0, slideEnd - now) + 160);
    };
    dispatch({ type: "zoom", scale: scaleOf(), now: performance.now(), zooming: false });
    scheduleTick(0); // 처음부터 상한을 넘은 채 카메라 알림이 없어도 판정한다 — 안 그러면 준비에 멈춰 있었다
    const off = o.cameraSource.subscribe((transitionMs) => {
      const now = performance.now();
      const scale = scaleOf();
      const b = zoomBand(scale);
      if (b !== band) {
        band = b;
        dispatch({ type: "zoom", scale, now, zooming: false });
      }
      scheduleTick(transitionMs);
    });
    return () => {
      off();
      clearTimeout(tickTimer);
    };
  }, [o.flag, o.cameraSource]);

  /** 사용자 입력(누름·키·붙여넣기·끌어 놓기·창 열기) — 준비 중이면 준비를 취소하고, 편집 중(한가함을 기다리는 dom)이면 기다림을 늘인다.
   *  조용히 1초 지나야 처음부터 다시 준비한다 — 전엔 취소한 뒤 첫 입력부터 1초면 무조건 다시 준비해 편집하는 동안 1초마다 새 WebGL 을 만들었다(11-11 리뷰). */
  const noteInput = useCallback(() => {
    const m = modeRef.current;
    if (m.phase === "preparing") dispatch({ type: "input" });
    else if (m.phase !== "dom" || m.reason !== "busy") return;
    else if (m.idle) dispatch({ type: "idle", idle: false });
    armQuiet();
  }, [armQuiet]);

  // 준비 중·한가함을 기다리는 동안 창 전체의 누름·키·붙여넣기·끌어 놓기를 듣는다(보드 밖에서 창을 여는 누름도 입력이다) — 그 밖엔 듣지 않는다
  const listening = mode.phase === "preparing" || (mode.phase === "dom" && mode.reason === "busy");
  useEffect(() => {
    if (!listening) return;
    const types = ["mousedown", "keydown", "paste", "drop"] as const;
    for (const t of types) window.addEventListener(t, noteInput, true);
    return () => {
      for (const t of types) window.removeEventListener(t, noteInput, true);
    };
  }, [listening, noteInput]);

  // 거절 안내 — 같은 안내가 겹치지 않게 1.5초에 한 번
  const refusedAt = useRef(-Infinity);
  const refuse = useCallback(() => {
    const now = performance.now();
    if (now - refusedAt.current < 1500) return;
    refusedAt.current = now;
    flashMsg("보기 모드 — 편집하려면 편집 모드로 돌아가세요(` 키 또는 오른쪽 위 모드 단추)");
  }, []);

  /** 모드 단추·` 키 — 편집(DOM) ↔ 보기(GPU). 잠긴 세션이면 까닭만 알린다. 사용자가 고르지 않았는데 DOM 인 동안(바쁨·확대·미지원) 누르면
   *  보기 모드를 켜 달라는 뜻이다 — 전엔 '편집 모드 선택'으로 받아 첫 누름에 화면이 그대로였다(11-11 리뷰). */
  const toggle = useCallback(() => {
    const m = modeRef.current;
    if (m.locked) {
      flashMsg(m.locked === "context-lost" || m.locked === "creation" ? "이 PC 에서 GPU 판을 켤 수 없어 편집 모드로 둡니다" : "GPU 판이 이 PC 에서 느려 편집 모드로 둡니다");
      return;
    }
    if (m.userDom) return dispatch({ type: "user-mode", mode: "gpu" });
    if (m.phase !== "dom") return dispatch({ type: "user-mode", mode: "dom" });
    // 미지원 노드가 지금도 있으면 까닭만, 지웠으면(씬 막음 기록만 남음) 다시 켠다 — user-mode gpu 가 그 씬의 막음을 푼다(Codex 리뷰 2차)
    if (m.reason === "unsupported") return m.unsupported ? flashMsg("이 씬에는 GPU 판이 아직 못 그리는 노드가 있어 편집 모드로 둡니다") : dispatch({ type: "user-mode", mode: "gpu" });
    if (m.reason === "zoom") return flashMsg("크게 확대한 동안은 편집 모드로 둡니다 — 줄이면 보기 모드로 돌아갑니다");
    if (busyRef.current) return flashMsg("편집 중인 것이 끝나면 보기 모드로 바꿉니다");
    clearTimeout(quietTimer.current);
    dispatch({ type: "idle", idle: true });
  }, []);

  return { mode, dispatch, editAllowed: userEditAllowed(mode), noteInput, refuse, toggle, setLateBusy };
}
