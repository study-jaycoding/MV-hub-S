import { lazy, useCallback, useEffect, useReducer, useRef, useState, type ComponentType } from "react";
import { STORAGE_KEYS } from "../../../lib/storageKeys";
import type { SceneCamera } from "../../../lib/sceneViewport";
import type { GpuBoardProps } from "./GpuBoard";

export type GpuPhase = "dom" | "preparing" | "probing" | "gpu";
export type GpuModeReason = "off" | "locked" | "user" | "unsupported" | "zoom" | "busy" | null;
export type GpuFailure = "context-lost" | "creation" | "memory" | "slow-probe" | "slow-frames";

export interface GpuModeState {
  phase: GpuPhase;
  reason: GpuModeReason;
  token: number;
  prepared: boolean;
  enabled: boolean;
  userDom: boolean;
  locked: GpuFailure | null;
  sceneId: string;
  unsupported: boolean;
  blockedScenes: ReadonlySet<string>;
  idle: boolean;
  scale: number;
  zooming: boolean;
  lastZoomAt: number;
  zoomBlocked: boolean;
  longFrames: readonly number[];
}

export type GpuModeEvent =
  | { type: "flag"; enabled: boolean }
  | { type: "user-mode"; mode: "dom" | "gpu" }
  | { type: "scene"; sceneId: string; unsupported: boolean }
  | { type: "unsupported"; sceneId: string; unsupported: boolean }
  | { type: "zoom"; scale: number; now: number; zooming: boolean }
  | { type: "tick"; now: number; zooming: boolean }
  | { type: "idle"; idle: boolean }
  | { type: "input" }
  | { type: "prepared"; token: number }
  | { type: "probe"; token: number; medianMs: number }
  | { type: "frame"; now: number; ms: number }
  | { type: "failure"; reason: GpuFailure };

export function initialGpuMode(): GpuModeState {
  return {
    phase: "dom", reason: "off", token: 0, prepared: false, enabled: false, userDom: false, locked: null,
    sceneId: "", unsupported: false, blockedScenes: new Set(), idle: true,
    scale: 1, zooming: false, lastZoomAt: -Infinity, zoomBlocked: false, longFrames: [],
  };
}

function toDom(s: GpuModeState, reason: GpuModeReason): GpuModeState {
  if (s.phase === "dom" && s.reason === reason) return s;
  return { ...s, phase: "dom", reason, prepared: false, token: s.token + (s.phase === "dom" ? 0 : 1) };
}

function reconcile(s: GpuModeState): GpuModeState {
  if (s.locked) return toDom(s, "locked");
  if (!s.enabled) return toDom(s, "off");
  if (s.userDom) return toDom(s, "user");
  if (s.unsupported || s.blockedScenes.has(s.sceneId)) return toDom(s, "unsupported");
  if (s.zoomBlocked) return toDom(s, "zoom");
  if (s.phase === "gpu" || s.phase === "probing") return s;
  if (!s.idle) return toDom(s, "busy");
  // 줌이 끝나기 전에는 준비를 새로 시작하지 않아 화면 교체가 입력에 끼어들지 않는다.
  if (s.phase === "dom" && (s.zooming || s.scale > 2.5)) return toDom(s, "busy");
  if (s.phase === "preparing")
    return s.prepared && !s.zooming && s.scale <= 2.5 ? { ...s, phase: "probing" } : s;
  return { ...s, phase: "preparing", reason: null, prepared: false, token: s.token + 1 };
}

function settleZoom(s: GpuModeState, now: number): GpuModeState {
  if (s.zooming || now - s.lastZoomAt < 150) return s;
  if (!s.zoomBlocked && s.scale > 2.5) return { ...s, zoomBlocked: true };
  if (s.zoomBlocked && s.scale < 2.2) return { ...s, zoomBlocked: false };
  return s;
}

export function gpuModeReducer(s: GpuModeState, e: GpuModeEvent): GpuModeState {
  switch (e.type) {
    case "flag":
      return reconcile({ ...s, enabled: e.enabled });
    case "user-mode": {
      const blockedScenes = new Set(s.blockedScenes);
      if (e.mode === "gpu" && !s.unsupported) blockedScenes.delete(s.sceneId);
      return reconcile({ ...s, userDom: e.mode === "dom", blockedScenes });
    }
    case "scene": {
      if (e.sceneId === s.sceneId)
        return gpuModeReducer(s, { type: "unsupported", sceneId: e.sceneId, unsupported: e.unsupported });
      const blockedScenes = new Set(s.blockedScenes);
      if (e.unsupported) blockedScenes.add(e.sceneId);
      return reconcile({ ...s, phase: "dom", prepared: false, token: s.token + 1, sceneId: e.sceneId,
        unsupported: e.unsupported, blockedScenes });
    }
    case "unsupported": {
      if (e.sceneId !== s.sceneId) return s;
      const blockedScenes = new Set(s.blockedScenes);
      if (e.unsupported) blockedScenes.add(s.sceneId);
      return reconcile({ ...s, unsupported: e.unsupported, blockedScenes });
    }
    case "zoom": {
      const changed = e.scale !== s.scale;
      const next = { ...s, scale: e.scale, zooming: e.zooming,
        lastZoomAt: changed || e.zooming || s.zooming ? e.now : s.lastZoomAt };
      return reconcile(settleZoom(next, e.now));
    }
    case "tick": {
      const next = { ...s, zooming: e.zooming,
        lastZoomAt: e.zooming || s.zooming ? e.now : s.lastZoomAt };
      return reconcile(settleZoom(next, e.now));
    }
    case "idle":
      return reconcile({ ...s, idle: e.idle });
    case "input":
      return s.phase === "preparing" ? reconcile({ ...s, idle: false }) : s;
    case "prepared":
      if (e.token !== s.token || s.phase !== "preparing") return s;
      return reconcile({ ...s, prepared: true });
    case "probe":
      if (e.token !== s.token || s.phase !== "probing") return s;
      return reconcile({ ...s, phase: "gpu", locked: e.medianMs > 12 || !Number.isFinite(e.medianMs) ? "slow-probe" : s.locked });
    case "frame": {
      if (s.phase !== "gpu") return s;
      const longFrames = s.longFrames.filter((at) => e.now - at <= 10_000);
      if (e.ms > 50) longFrames.push(e.now);
      return reconcile({ ...s, longFrames, locked: longFrames.length >= 3 ? "slow-frames" : s.locked });
    }
    case "failure":
      return reconcile({ ...s, locked: s.locked ?? e.reason });
  }
}

export function userEditAllowed(s: GpuModeState): boolean {
  return s.phase === "dom" || s.phase === "preparing";
}

// ── SceneBoard 쪽 모드 훅 ─────────────────────────────────────────────────────────────
// GpuBoard.tsx(WebGL·아틀라스)에서 옮겨 왔다 — canvas api 가 이 훅을 내보내려고 GPU 판 본체까지 불러오면, api 를 쓰는 lib 모듈(sceneBackup 등)이
//  무거워져 공책 시험이 전체 시험에서 시간 초과했다(11-11 실측). 본체는 api 가 켤 때만 불러온다(lazy).

/** GPU 판 본체를 켤 때만 불러오는 칸(lazy). 불러오기가 실패하면(네트워크·새 배포 뒤 옛 덩어리 404) 오류를 위로 던져 캔버스 전체를
 *  대체 화면으로 보내지 않고, 생성 실패로 이 페이지를 잠가 DOM 판에 둔다(Codex 리뷰 15차 P2). 늦게 실패해도 칸이 그려질 때만 알린다. */
export function lazyGpuBoard(load: () => Promise<{ GpuBoard: ComponentType<GpuBoardProps> }>) {
  return lazy<ComponentType<GpuBoardProps>>(() => load().then((m) => ({ default: m.GpuBoard }), () => ({ default: GpuBoardLoadFailed })));
}
function GpuBoardLoadFailed({ dispatch }: GpuBoardProps) {
  useEffect(() => { dispatch({ type: "failure", reason: "creation" }); }, [dispatch]);
  return null;
}

export interface CameraSource {
  /** transitionMs: > 0 화면 맞춤 미끄러짐 · 0 바로 옮김 · -1 움직임 아님(기기 배율 바뀜 — 조작 시각을 갱신하지 않는다) */
  subscribe: (listener: (transitionMs: number) => void) => () => void;
  getSnapshot: () => SceneCamera;
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
const zoomBand = (scale: number) => (scale > 2.5 ? "hi" : scale < 2.2 ? "lo" : "mid");

/** SceneBoard 쪽 모드 관리 — 표식·씬·미지원·한가함·배율 경계를 gpuMode 에 알리고, 25% 단순화·편집 허용·거절 안내를 준다.
 *  표식이 꺼져 있으면 아무 이벤트도 보내지 않아 상태가 바뀌지 않는다(SceneBoard 추가 렌더 0). 배율은 경계(2.2·2.5)를 넘을 때만 보낸다 —
 *  휠 한 칸마다 보내면 상태가 매번 새 객체라 판 전체가 다시 그려진다. */
export function useGpuBoardMode(o: { flag: boolean; sceneId: string; unsupported: boolean; busy: boolean; cameraSource: CameraSource;
  /** 거절·까닭 안내(lib/flash 의 flashMsg) — SceneBoard 가 넘긴다. 여기서 import 하면 canvas api 를 쓰는 lib 모듈이 라이브러리 기능까지 불러온다 */
  flash: (msg: string) => void }) {
  const [mode, dispatch] = useReducer(gpuModeReducer, undefined, initialGpuMode);
  const flashRef = useRef(o.flash);
  flashRef.current = o.flash;
  const flashMsg = (msg: string) => flashRef.current(msg);
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
