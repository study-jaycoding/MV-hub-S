// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getLang, setLang } from "../src/lib/i18n";
import { useGenerationProjectActions } from "../src/lib/useGenerationProjectActions";
import type { Filters, Generation } from "../src/types";

const { assignProject, broadcast } = vi.hoisted(() => ({ assignProject: vi.fn(), broadcast: vi.fn() }));
vi.mock("../src/api", () => ({ api: { assignProject } }));
vi.mock("../src/lib/libraryBroadcast", () => ({ postLibraryChanged: broadcast }));
const unknownEn = "Could not confirm the move result. Check the list before moving the items again.";
const unknownKo = "이동 결과를 확인할 수 없습니다. 다시 이동하기 전에 목록을 확인해 주세요.";
let previousLang: ReturnType<typeof getLang>;
beforeEach(() => { previousLang = getLang(); setLang("en"); vi.resetAllMocks(); });
afterEach(() => { setLang(previousLang); vi.restoreAllMocks(); });

function setup(ids = ["g1", "g2"]) {
  const order: string[] = [];
  const flash = vi.fn(() => { order.push("flash"); });
  const reload = vi.fn(async () => { order.push("reload"); });
  const bumpBoard = vi.fn(() => { order.push("board"); });
  broadcast.mockImplementation(() => { order.push("broadcast"); });
  return { order, flash, reload, bumpBoard, actions: useGenerationProjectActions({
    flash, reload, bumpBoard, selectedRef: { current: new Set(ids) }, filtersRef: { current: { tab: "team" } as Filters },
  }) };
}
const malformed: [string, unknown][] = [
  ["null JSON", null], ["boolean JSON", false], ["number JSON", 0], ["string JSON", "SYNTHETIC_RESPONSE"],
  ["array JSON", []], ["missing updated", {}], ["null updated", { updated: null }],
  ["boolean updated", { updated: false }], ["string updated", { updated: "2" }],
  ["negative updated", { updated: -1 }], ["fraction updated", { updated: 0.5 }],
  ["object updated", { updated: { detail: "SYNTHETIC_RESPONSE" } }], ["array updated", { updated: [] }],
  ["explicit false ok", { ok: false, updated: 2 }], ["explicit null ok", { ok: null, updated: 2 }],
  ["explicit string ok", { ok: "true", updated: 2 }],
  // These cases are defensive mock boundaries, not values emitted by normal JSON serialization.
  ["mock-only undefined", undefined], ["mock-only NaN", { updated: Number.NaN }],
  ["mock-only infinity", { updated: Number.POSITIVE_INFINITY }],
  ["unsafe integer", { updated: Number.MAX_SAFE_INTEGER + 1 }],
];
it.each(malformed)("malformed %s resolves with one neutral notice and refresh, never retries", async (_label, value) => {
  assignProject.mockResolvedValue(value);
  const consoleError = vi.spyOn(console, "error");
  const consoleWarn = vi.spyOn(console, "warn");
  const h = setup();
  await expect(h.actions.assignSelectedToProject("p", "ep/shot")).resolves.toBeUndefined();
  expect(h.flash).toHaveBeenCalledExactlyOnceWith(unknownEn);
  expect(h.order).toEqual(["reload", "broadcast", "flash"]);
  expect(assignProject).toHaveBeenCalledExactlyOnceWith(["g1", "g2"], "p", "team", "ep/shot", true);
  expect(h.reload).toHaveBeenCalledOnce(); expect(broadcast).toHaveBeenCalledOnce();
  expect(h.bumpBoard).not.toHaveBeenCalled();
  expect(consoleError).not.toHaveBeenCalled(); expect(consoleWarn).not.toHaveBeenCalled();
});

const entries = ["selected", "board", "folder", "unsorted"] as const;
it.each(entries.flatMap((entry) => ["ko", "en"].map((lang) => ({ entry, lang: lang as "ko" | "en" }))))(
  "$entry/$lang preserves entry arguments and uses a neutral refresh-failure notice", async ({ entry, lang }) => {
    setLang(lang);
    assignProject.mockResolvedValue({ updated: null, team_synced: false, detail: "SYNTHETIC_RESPONSE" });
    const h = setup();
    h.reload.mockImplementation(async () => { h.order.push("reload"); throw new Error("SYNTHETIC_REFRESH"); });
    const action = entry === "selected" ? h.actions.assignSelectedToProject("p", "ep/shot")
      : entry === "board" ? h.actions.boardAssign([{ id: "g1" }, { id: "g2" }] as Generation[], "p", "ep/shot")
      : entry === "folder" ? h.actions.dropOnFolder("g1", "p", "ep/shot")
      : h.actions.dropUnassign("g1");
    await expect(action).resolves.toBeUndefined();
    expect(assignProject).toHaveBeenCalledExactlyOnceWith(["g1", "g2"], entry === "unsorted" ? null : "p", "team", entry === "unsorted" ? undefined : "ep/shot", entry !== "unsorted");
    expect(h.order).toEqual(entry === "board" ? ["reload", "board", "broadcast", "flash"] : ["reload", "broadcast", "flash"]);
    expect(h.flash).toHaveBeenCalledExactlyOnceWith(lang === "en"
      ? `${unknownEn} · Could not refresh the view. Reload it to check the result.`
      : `${unknownKo} · 화면을 새로고침하지 못했습니다. 다시 불러와 주세요.`);
    expect(h.reload).toHaveBeenCalledOnce(); expect(broadcast).toHaveBeenCalledOnce();
  },
);

it.each([{ updated: 0 }, { ok: true, updated: 0 }, { updated: 2 }, { ok: true, updated: 2 }])(
  "keeps a valid ACK without requiring ok: %j", async (response) => {
    assignProject.mockResolvedValue(response);
    const h = setup();
    await h.actions.assignSelectedToProject("p");
    expect(h.flash).toHaveBeenCalledExactlyOnceWith(`Moved ${response.updated} items into the project.`);
    expect(assignProject).toHaveBeenCalledOnce();
  },
);

it("does not impose a new updated <= requested IDs policy", async () => {
  assignProject.mockResolvedValue({ updated: 2 });
  const h = setup(["alias"]);
  await h.actions.assignSelectedToProject("p");
  expect(h.flash).toHaveBeenCalledExactlyOnceWith("Moved 2 items into the project.");
});

it.each([null, undefined, true])("does not reject a valid ACK for team_synced=%s", async (team_synced) => {
  assignProject.mockResolvedValue({ updated: 2, team_synced });
  const h = setup();
  await h.actions.assignSelectedToProject("p");
  expect(h.flash).toHaveBeenCalledExactlyOnceWith("Moved 2 items into the project.");
});

it("normalizes valid fields once before reload and never rereads the raw object", async () => {
  let reads = 0, teamReads = 0;
  const response = { ok: true,
    get updated() { reads += 1; if (reads > 1) throw new Error("SECOND_READ"); return 2; },
    get team_synced() { teamReads += 1; if (teamReads > 1) throw new Error("SECOND_TEAM_READ"); return false; },
  };
  assignProject.mockResolvedValue(response);
  const h = setup();
  h.reload.mockImplementation(async () => {
    h.order.push("reload");
    Object.defineProperty(response, "ok", { get() { throw new Error("AFTER_RELOAD_OK_READ"); } });
    Object.defineProperty(response, "updated", { get() { throw new Error("AFTER_RELOAD_READ"); } });
    Object.defineProperty(response, "team_synced", { get() { throw new Error("AFTER_RELOAD_TEAM_READ"); } });
  });
  await expect(h.actions.assignSelectedToProject("p")).resolves.toBeUndefined();
  expect(reads).toBe(1); expect(teamReads).toBe(1);
  expect(h.flash).toHaveBeenCalledExactlyOnceWith("Moved 2 items into the project. · ⚠ Team sync failed (server unreachable) — resync needed");
});

it("empty selection does not request or refresh even when response would be invalid", async () => {
  assignProject.mockResolvedValue(null);
  const h = setup([]);
  await h.actions.assignSelectedToProject("p");
  expect(assignProject).not.toHaveBeenCalled(); expect(h.order).toEqual([]);
});
