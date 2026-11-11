import { describe, expect, it, vi } from "vitest";
vi.mock("../src/lib/i18n", () => ({ t: (value: string) => value }));
vi.mock("../src/lib/http", () => ({ jsonFetch: vi.fn() }));
import { adoptAction, bridgeCompatible, cacheBatches, dragPermission, startPanelDrag, targetView,
  type AdoptState, type TargetState } from "../src/lib/resolvePanelApi";

const identity = { instance: "hub", account: "a", epoch: 1, protocol: { min: 1, max: 2 } };
const bridge = { protocol: 1, accepts: { min: 1, max: 1 }, startDrag: vi.fn(() => true) };
const allowed = { bridge, identity, prepared: true, targetOk: true, contextCurrent: true };

describe("끌기 관문", () => {
  it("다섯 조건이 맞을 때만 허용", () => expect(dragPermission(allowed)).toEqual({ ok: true, reason: "" }));
  it.each([
    { bridge: undefined }, { bridge: { ...bridge, protocol: 3 } }, { prepared: false },
    { targetOk: false }, { contextCurrent: false },
  ])("각 거절 경로 %j", rejected => {
    const result = dragPermission({ ...allowed, ...rejected });
    expect(result.ok).toBe(false); expect(result.reason).not.toBe("");
  });
  it("양방향 판 범위를 확인", () => {
    expect(bridgeCompatible({ ...bridge, accepts: { min: 2, max: 3 } }, identity)).toBe(false);
    expect(bridgeCompatible(bridge, null)).toBe(false);
    expect(bridgeCompatible({ ...bridge, protocol: NaN }, identity)).toBe(false);
  });
  it("화면 판을 전달하고 false를 성공으로 바꾸지 않음", () => {
    const startDrag = vi.fn(() => false);
    expect(startPanelDrag({ ...bridge, startDrag }, "Z:/render/file.mp4")).toBe(false);
    expect(startDrag).toHaveBeenCalledWith("Z:/render/file.mp4", { protocol: 1 });
  });
});

it.each<[AdoptState, string]>([
  ["in_bin", "done"], ["conflict", "stop"], ["elsewhere", "stop"], ["project_changed", "stop"],
  ["account_changed", "reset"], ["not_seen", "retry"], ["busy", "busy"], ["not_prepared", "prepare"],
  ["stamp_failed", "stop"], ["save_failed", "stop"], ["ledger_failed", "stop"], ["unknown", "stop"],
  ["rebuild_recovery_pending", "block"],
])("adopt 표 %s → %s", (state, action) => expect(adoptAction(state)).toBe(action));

it.each<[TargetState, string, boolean]>([
  ["ok", "set", true], ["missing", "set", false], ["stale", "ignore", false],
  ["account_changed", "reset", false], ["busy", "set", false], ["rebuild_recovery_pending", "set", false], ["unavailable", "set", false],
])("target 표 %s", (state, action, ready) => expect(targetView({ state })).toMatchObject({ action, ready }));

it("HTTP 서버 문구 보존", () => expect(targetView({ state: "unavailable", details: "업데이트 중" }).message).toBe("업데이트 중"));
it("빈 목록·500·501 경계", () => {
  expect(cacheBatches([])).toEqual([]);
  const ids = Array.from({ length: 501 }, (_, index) => String(index));
  expect(cacheBatches(ids).map(batch => batch.length)).toEqual([500, 1]);
  expect(cacheBatches(ids).flat()).toEqual(ids);
  expect(cacheBatches(ids.slice(0, 500))).toHaveLength(1);
});
