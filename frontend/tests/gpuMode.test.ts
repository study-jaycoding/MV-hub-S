import { describe, expect, it } from "vitest";
import { gpuModeReducer as reduce, initialGpuMode, userEditAllowed, type GpuModeEvent, type GpuModeState } from "../src/features/canvas/gpu/gpuMode";

const send = (s: GpuModeState, ...events: GpuModeEvent[]) => events.reduce(reduce, s);
const start = () => send(initialGpuMode(), { type: "scene", sceneId: "a", unsupported: false }, { type: "flag", enabled: true });
const gpu = () => {
  const s = start();
  return send(s, { type: "prepared", token: s.token }, { type: "probe", token: s.token, medianMs: 12 });
};
const shrink = (s: GpuModeState) => send(s,
  { type: "zoom", scale: 2, now: 1000, zooming: false }, { type: "tick", now: 1150, zooming: false });

describe("gpuMode 우선순위", () => {
  const cases = Array.from({ length: 32 }, (_, mask) => ({
    locked: !!(mask & 1), user: !!(mask & 2), unsupported: !!(mask & 4), zoom: !!(mask & 8), busy: !!(mask & 16),
  }));
  it.each(cases)("잠금=$locked 사용자=$user 미지원=$unsupported 배율=$zoom 바쁨=$busy", (c) => {
    const s: GpuModeState = { ...start(), phase: "dom", locked: c.locked ? "memory" : null,
      userDom: c.user, unsupported: c.unsupported, zoomBlocked: c.zoom, idle: !c.busy };
    const next = reduce(s, { type: "idle", idle: !c.busy });
    const reason = c.locked ? "locked" : c.user ? "user" : c.unsupported ? "unsupported" : c.zoom ? "zoom" : c.busy ? "busy" : null;
    expect(next.reason).toBe(reason);
    expect(next.phase).toBe(reason ? "dom" : "preparing");
  });

  it.each(["locked", "user", "unsupported", "zoom"] as const)("축소가 $0 우선 조건을 덮지 않는다", (reason) => {
    const base: GpuModeState = { ...gpu(), phase: "dom", reason, zoomBlocked: true, scale: 3,
      locked: reason === "locked" ? "memory" : null, userDom: reason === "user",
      blockedScenes: new Set(reason === "unsupported" ? ["a"] : []) };
    const next = shrink(base);
    expect(next.phase).toBe(reason === "zoom" ? "preparing" : "dom");
    expect(next.reason).toBe(reason === "zoom" ? null : reason);
  });

  it("표식 끔은 어느 단계에서나 DOM이고 재활성화해도 잠금은 남는다", () => {
    for (const phase of ["dom", "preparing", "probing", "gpu"] as const) {
      const off = reduce({ ...gpu(), phase }, { type: "flag", enabled: false });
      expect(off.phase).toBe("dom");
      expect(off.reason).toBe("off");
    }
    const locked = send(gpu(), { type: "failure", reason: "context-lost" }, { type: "flag", enabled: false }, { type: "flag", enabled: true });
    expect(locked.reason).toBe("locked");
  });
});

describe("gpuMode 준비와 취소", () => {
  it("한가할 때만 준비하며 검사 동안부터 편집을 막는다", () => {
    let s = send(initialGpuMode(), { type: "idle", idle: false }, { type: "flag", enabled: true });
    expect(s.phase).toBe("dom");
    expect(s.reason).toBe("busy");
    expect(userEditAllowed(s)).toBe(true);
    s = reduce(s, { type: "idle", idle: true });
    expect(s.phase).toBe("preparing");
    expect(userEditAllowed(s)).toBe(true);
    s = reduce(s, { type: "prepared", token: s.token });
    expect(s.phase).toBe("probing");
    expect(userEditAllowed(s)).toBe(false);
    s = reduce(s, { type: "probe", token: s.token, medianMs: 12 });
    expect(s.phase).toBe("gpu");
    expect(userEditAllowed(s)).toBe(false);
  });

  it.each(["input", "idle"] as const)("준비 중 $0 취소 뒤 옛 콜백은 무시하고 새 세대로 다시 준비한다", (type) => {
    const s = start();
    const cancelled = reduce(s, type === "input" ? { type } : { type, idle: false });
    expect(cancelled.phase).toBe("dom");
    expect(cancelled.token).toBeGreaterThan(s.token);
    const late = send(cancelled, { type: "prepared", token: s.token }, { type: "probe", token: s.token, medianMs: 99 });
    expect(late).toBe(cancelled);
    const restarted = reduce(late, { type: "idle", idle: true });
    expect(restarted.phase).toBe("preparing");
    expect(restarted.token).toBeGreaterThan(cancelled.token);
    expect(reduce(restarted, { type: "prepared", token: s.token })).toBe(restarted);
    expect(reduce(restarted, { type: "probe", token: restarted.token, medianMs: 1 })).toBe(restarted);
  });

  it("씬 변경은 진행 중 준비·검사 콜백을 무효화한다", () => {
    for (const phase of ["preparing", "probing"] as const) {
      const s = { ...start(), phase };
      const next = reduce(s, { type: "scene", sceneId: "b", unsupported: false });
      expect(next.phase).toBe("preparing");
      expect(next.token).toBeGreaterThan(s.token);
      expect(send(next, { type: "prepared", token: s.token }, { type: "probe", token: s.token, medianMs: 1 })).toBe(next);
    }
  });

  it("줌 중 준비가 끝나도 검사로 바꾸지 않고 끝난 결과를 잃지 않는다", () => {
    const s = start();
    const waiting = send(s, { type: "zoom", scale: 1.2, now: 0, zooming: true }, { type: "prepared", token: s.token });
    expect(waiting.phase).toBe("preparing");
    expect(reduce(waiting, { type: "tick", now: 100, zooming: false }).phase).toBe("probing");
  });
});

describe("gpuMode 줌 경계와 쉼", () => {
  it("2.5 초과 + 150ms 쉼에만 DOM, 2.2 미만 + 150ms 쉼에만 복귀", () => {
    let s = send(gpu(), { type: "zoom", scale: 2.5, now: 0, zooming: false }, { type: "tick", now: 150, zooming: false });
    expect(s.phase).toBe("gpu");
    s = send(s, { type: "zoom", scale: 2.51, now: 200, zooming: false }, { type: "tick", now: 349, zooming: false });
    expect(s.phase).toBe("gpu");
    s = reduce(s, { type: "tick", now: 350, zooming: false });
    expect(s.reason).toBe("zoom");
    s = send(s, { type: "zoom", scale: 2.2, now: 400, zooming: false }, { type: "tick", now: 550, zooming: false });
    expect(s.reason).toBe("zoom");
    s = send(s, { type: "zoom", scale: 2.19, now: 600, zooming: false }, { type: "tick", now: 749, zooming: false });
    expect(s.phase).toBe("dom");
    expect(reduce(s, { type: "tick", now: 750, zooming: false }).phase).toBe("preparing");
  });

  it("줌 중 오래 지나도 전환하지 않고 마지막 움직임부터 다시 150ms 센다", () => {
    let s = send(gpu(), { type: "zoom", scale: 3, now: 0, zooming: true }, { type: "tick", now: 1000, zooming: true });
    expect(s.phase).toBe("gpu");
    s = reduce(s, { type: "zoom", scale: 3, now: 1100, zooming: false });
    expect(reduce(s, { type: "tick", now: 1249, zooming: false }).phase).toBe("gpu");
    s = reduce(s, { type: "tick", now: 1250, zooming: false });
    expect(s.reason).toBe("zoom");
    s = send(s, { type: "zoom", scale: 2, now: 1300, zooming: true }, { type: "tick", now: 3000, zooming: true });
    expect(s.reason).toBe("zoom");
    s = reduce(s, { type: "tick", now: 3100, zooming: false });
    expect(reduce(s, { type: "tick", now: 3250, zooming: false }).phase).toBe("preparing");
  });

  it("준비 완료 직전 상한을 넘으면 검사에 진입하지 않는다", () => {
    const s = start();
    const next = send(s, { type: "zoom", scale: 3, now: 10, zooming: false }, { type: "prepared", token: s.token });
    expect(next.phase).toBe("preparing");
    expect(reduce(next, { type: "tick", now: 160, zooming: false }).reason).toBe("zoom");
  });
});

describe("gpuMode 잠금과 씬별 기억", () => {
  it.each([12.01, 50, NaN])("검사 중앙값 %s 는 세션 잠금", (medianMs) => {
    const s = start();
    const next = send(s, { type: "prepared", token: s.token }, { type: "probe", token: s.token, medianMs });
    expect(next.locked).toBe("slow-probe");
    expect(next.phase).toBe("dom");
  });

  it("감시는 첫 10초 뒤에도 계속하고 50ms 초과만 10초 창에서 센다", () => {
    let s = send(gpu(), { type: "frame", now: 100_000, ms: 50 }, { type: "frame", now: 100_010, ms: 51 },
      { type: "frame", now: 110_011, ms: 51 }, { type: "frame", now: 110_012, ms: 51 });
    expect(s.phase).toBe("gpu");
    expect(s.longFrames).toEqual([110_011, 110_012]);
    s = reduce(s, { type: "frame", now: 120_011, ms: 51 });
    expect(s.locked).toBe("slow-frames");
    expect(s.reason).toBe("locked");
  });

  it("GPU 밖 프레임은 세지 않고 실패는 줌 중에도 즉시 잠근다", () => {
    const s = start();
    expect(reduce(s, { type: "frame", now: 0, ms: 100 })).toBe(s);
    const next = send(gpu(), { type: "zoom", scale: 3, now: 0, zooming: true }, { type: "failure", reason: "context-lost" });
    expect(next.phase).toBe("dom");
    expect(next.locked).toBe("context-lost");
    const again = send(next, { type: "user-mode", mode: "gpu" }, { type: "scene", sceneId: "b", unsupported: false },
      { type: "flag", enabled: false }, { type: "flag", enabled: true }, { type: "failure", reason: "memory" });
    expect(shrink(again).locked).toBe("context-lost");
    expect(shrink(again).reason).toBe("locked");
  });

  it("미지원이 사라져도 씬별로 기억하고 현재 씬의 사용자 재시도만 해제", () => {
    let s = send(gpu(), { type: "unsupported", sceneId: "a", unsupported: true }, { type: "unsupported", sceneId: "a", unsupported: false });
    expect(shrink(s).reason).toBe("unsupported");
    s = reduce(s, { type: "scene", sceneId: "b", unsupported: false });
    expect(s.phase).toBe("preparing");
    expect(reduce(s, { type: "unsupported", sceneId: "a", unsupported: true })).toBe(s);
    s = send(s, { type: "unsupported", sceneId: "b", unsupported: true }, { type: "unsupported", sceneId: "b", unsupported: false },
      { type: "user-mode", mode: "gpu" });
    expect(s.phase).toBe("preparing");
    expect(s.blockedScenes.has("a")).toBe(true);
    s = reduce(s, { type: "scene", sceneId: "a", unsupported: false });
    expect(s.reason).toBe("unsupported");
    expect(reduce(s, { type: "user-mode", mode: "gpu" }).phase).toBe("preparing");
  });

  it("미지원이 여전히 있으면 재시도로도 켜지지 않고, 사용자 DOM 선택은 씬을 넘어 남는다", () => {
    const s = send(gpu(), { type: "unsupported", sceneId: "a", unsupported: true }, { type: "user-mode", mode: "gpu" },
      { type: "unsupported", sceneId: "a", unsupported: false });
    expect(s.reason).toBe("unsupported");
    const next = send(s, { type: "user-mode", mode: "dom" }, { type: "scene", sceneId: "b", unsupported: false });
    expect(shrink(next).reason).toBe("user");
    expect(reduce(next, { type: "user-mode", mode: "gpu" }).phase).toBe("preparing");
  });

  it("원본 상태의 집합·프레임 기록을 바꾸지 않는다", () => {
    const s = gpu();
    reduce(s, { type: "unsupported", sceneId: "a", unsupported: true });
    reduce(s, { type: "frame", now: 1, ms: 51 });
    expect([...s.blockedScenes]).toEqual([]);
    expect(s.longFrames).toEqual([]);
  });
});
