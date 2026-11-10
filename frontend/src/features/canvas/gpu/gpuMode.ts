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
