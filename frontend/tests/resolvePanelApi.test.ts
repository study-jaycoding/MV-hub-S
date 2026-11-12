import { expect, it, vi } from "vitest";
vi.mock("../src/lib/i18n", () => ({ t: (value: string) => value }));
vi.mock("../src/lib/http", () => ({ jsonFetch: vi.fn() }));
import { jsonFetch } from "../src/lib/http";
import { adoptAction, bridgeCompatible, cacheBatches, inventoryAction, panelFailure, stageSummary, targetView, resolvePanelApi,
  type AdoptState, type TargetState, type InventoryItem } from "../src/lib/resolvePanelApi";
const identity = { instance: "hub", account: "a", epoch: 1, protocol: { min: 1, max: 2 } };
const bridge = { protocol: 1, accepts: { min: 1, max: 1 }, startDrag: vi.fn(() => true) };
it("다리 판은 양쪽 범위를 확인", () => {
  expect(bridgeCompatible(bridge, identity)).toBe(true);
  expect(bridgeCompatible(undefined, identity)).toBe(false);
  expect(bridgeCompatible({ ...bridge, protocol: 3 }, identity)).toBe(false);
  expect(bridgeCompatible({ ...bridge, accepts: { min: 2, max: 3 } }, identity)).toBe(false);
});
it.each<[AdoptState, string]>([
  ["in_bin", "done"], ["not_seen", "stop"], ["busy", "stop"], ["not_prepared", "prepare"],
  ["account_changed", "reset"], ["rebuild_recovery_pending", "block"],
  ["conflict", "stop"], ["replace_failed", "stop"], ["stamp_failed", "stop"], ["save_failed", "stop"],
  ["ledger_failed", "stop"], ["project_changed", "stop"], ["other_window", "stop"], ["unknown", "stop"],
])("adopt %s → %s", (state, action) => expect(adoptAction(state)).toBe(action));
it.each<TargetState>(["ok", "missing", "stale", "busy", "rebuild_recovery_pending", "unavailable", "account_changed", "other_window"])("target %s", state => {
  const view = targetView({ state, bin_path: "MV Hub/Film/C1" });
  expect(view.ready).toBe(state === "ok");
  expect(view.action).toBe(state === "stale" ? "ignore" : state === "account_changed" ? "reset" : "set");
});
it.each([
  [{ usage: 0 }, "unstage"], [{ usage: 1 }, "adopt"], [{ usage: null }, "preserve"],
  [{ usage: -1 }, "preserve"], [{ usage: 0.5 }, "preserve"], [{ recovery: true }, "recover"],
])("inventory %j", (item, expected) => expect(inventoryAction(item as InventoryItem)).toBe(expected));
it("stage 상태는 같은 파일·실패·보류를 성공 수와 구분", () => {
  expect(stageSummary({ state: "ok", deferred: 2, items: [
    { gen_id: "1", state: "staged" }, { gen_id: "2", state: "present" },
    { gen_id: "3", state: "same_file_exists" }, { gen_id: "4", state: "conflict" },
  ] })).toEqual({ staged: 2, sameFile: 1, deferred: 2, failed: [{ gen_id: "4", state: "conflict" }] });
});
it("501개 cache는 500+1", () => expect(cacheBatches(Array.from({ length: 501 }, (_, n) => String(n))).map(batch => batch.length)).toEqual([500, 1]));
it("window claim·목적 빈·inventory cursor를 HTTP로 전달", async () => {
  await resolvePanelApi.identity("window", true);
  expect(jsonFetch).toHaveBeenLastCalledWith("/api/resolve/panel/identity?window=window&claim=true");
  await resolvePanelApi.currentBin(identity, "p", "S/C1");
  expect(vi.mocked(jsonFetch).mock.calls.at(-1)?.[0]).toContain("folder_path=S%2FC1");
  await resolvePanelApi.inventory(identity, ["bin", "item"]);
  expect(vi.mocked(jsonFetch).mock.calls.at(-1)?.[0]).toContain("after=");
});
it("에피소드 빈 표·따라가기 bin_id·빈 지우기를 본문으로 전달, 영어 상태는 한국어로", async () => {
  const selection = { ctx: identity, project_id: "p", folder_path: "S", window: "w" };
  await resolvePanelApi.target({ ...selection, seq: 1, create: true, episode_path: "S", create_paths: ["S/C1"] });
  expect(JSON.parse(vi.mocked(jsonFetch).mock.calls.at(-1)![1]!.body as string)).toMatchObject({ episode_path: "S", create_paths: ["S/C1"] });
  await resolvePanelApi.stage({ ...selection, folder_path: "S/C1", seq: 2, gen_ids: [], bin_id: "b1" });
  expect(JSON.parse(vi.mocked(jsonFetch).mock.calls.at(-1)![1]!.body as string)).toMatchObject({ bin_id: "b1" });
  await resolvePanelApi.unstage({ ...selection, folder_path: "S/C1", bin_id: "b1", delete_empty: true });
  expect(JSON.parse(vi.mocked(jsonFetch).mock.calls.at(-1)![1]!.body as string)).toMatchObject({ bin_id: "b1", delete_empty: true });
  await resolvePanelApi.settle({ ...selection, bins: [{ folder_path: "S/C1", bin_id: "b1" }] }); // 앞 에피소드 컷 빈 한 번에
  expect(vi.mocked(jsonFetch).mock.calls.at(-1)![0]).toBe("/api/resolve/panel/settle");
  expect(JSON.parse(vi.mocked(jsonFetch).mock.calls.at(-1)![1]!.body as string)).toMatchObject({ folder_path: "S", bins: [{ folder_path: "S/C1", bin_id: "b1" }] });
  expect(["busy", "unavailable", "active_bin"].map(panelFailure)).toEqual(["확인 중 — 리졸브가 바쁨", "리졸브에 연결하지 못했습니다", "지금 쓰는 빈이라 남겼습니다"]);
});
