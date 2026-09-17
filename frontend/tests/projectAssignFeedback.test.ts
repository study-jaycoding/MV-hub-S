// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HttpError } from "../src/lib/http";
import { getLang, setLang, t } from "../src/lib/i18n";
import { useGenerationProjectActions } from "../src/lib/useGenerationProjectActions";
import type { Filters, Generation } from "../src/types";

const { assignProject, broadcast } = vi.hoisted(() => ({ assignProject: vi.fn(), broadcast: vi.fn() }));
vi.mock("../src/api", () => ({ api: { assignProject } }));
vi.mock("../src/lib/libraryBroadcast", () => ({ postLibraryChanged: broadcast }));

let previousLang: ReturnType<typeof getLang>;
beforeEach(() => {
  previousLang = getLang();
  setLang("en");
  vi.resetAllMocks();
  assignProject.mockResolvedValue({ ok: true, updated: 2, team_synced: true });
});
afterEach(() => { setLang(previousLang); vi.restoreAllMocks(); });

function setup(ids = ["g1", "g2"], tab: "my" | "team" = "my") {
  const flash = vi.fn(), reload = vi.fn().mockResolvedValue(undefined), bumpBoard = vi.fn();
  return { flash, reload, bumpBoard, actions: useGenerationProjectActions({
    flash, reload, bumpBoard, selectedRef: { current: new Set(ids) },
    filtersRef: { current: { tab } as Filters },
  }) };
}

it.each(["en", "ko"] as const)("%s uses whole sentences for project, folder and Unsorted", async (lang) => {
  setLang(lang);
  const h = setup();
  await h.actions.assignSelectedToProject("p");
  await h.actions.assignSelectedToProject("p", "e001/c0010");
  await h.actions.dropUnassign("g1");
  expect(h.flash.mock.calls.map(([message]) => message)).toEqual(lang === "en" ? [
    "Moved 2 items into the project.", "Moved 2 items into 'e001/c0010'.", "Moved 2 items to Unsorted.",
  ] : ["2개를 프로젝트에 담았습니다.", "2개를 'e001/c0010' 폴더에 담았습니다.", "2개를 미분류로 옮겼습니다."]);
  expect(broadcast).toHaveBeenCalledTimes(3);
});

it("preserves user folder replacement characters verbatim", async () => {
  const h = setup();
  const folder = "A$&B$'C$`D$1/{count}/{folder}";
  await h.actions.assignSelectedToProject("p", folder);
  expect(h.flash).toHaveBeenCalledExactlyOnceWith(`Moved 2 items into '${folder}'.`);
});

it.each([true, false, null, undefined])("only false team_synced warns (%s)", async (team_synced) => {
  assignProject.mockResolvedValue({ updated: 2, team_synced });
  const h = setup();
  await h.actions.assignSelectedToProject("p");
  const message = h.flash.mock.calls[0][0];
  expect(message.includes("Team sync failed")).toBe(team_synced === false);
  expect(message).not.toMatch(/[가-힣]/);
  expect(h.flash).toHaveBeenCalledOnce();
  expect(broadcast).toHaveBeenCalledOnce();
});

const failureCases = [
  [400, "담을 수 없는 대상입니다. 프로젝트와 워크스페이스를 확인한 뒤 다시 시도해 주세요."],
  [401, "이동할 권한이 없습니다. 로그인 상태와 권한을 확인해 주세요."],
  [403, "이동할 권한이 없습니다. 로그인 상태와 권한을 확인해 주세요."],
  [404, "대상을 찾을 수 없습니다. 목록을 새로고침한 뒤 다시 시도해 주세요."],
  [409, "다른 곳에서 먼저 바뀌었습니다. 새로고침한 뒤 다시 시도해 주세요."],
  [500, "옮기지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요."],
] as const;
it.each(failureCases)("API %i gives a safe translated message and no success side effects", async (status, expected) => {
  const raw = "SYNTHETIC_INTERNAL_DETAIL";
  assignProject.mockRejectedValue(new HttpError(status, raw, raw));
  const consoleError = vi.spyOn(console, "error");
  const h = setup();
  await h.actions.boardAssign([{ id: "g1" }] as Generation[], "p");
  expect(h.flash).toHaveBeenCalledExactlyOnceWith(t(expected));
  expect(h.flash.mock.calls[0][0]).not.toContain(raw);
  expect(h.flash.mock.calls[0][0]).not.toMatch(/[가-힣]/);
  expect(h.flash.mock.calls[0][0]).not.toMatch(/\d/);
  expect(assignProject).toHaveBeenCalledOnce();
  expect(h.reload).not.toHaveBeenCalled();
  expect(h.bumpBoard).not.toHaveBeenCalled();
  expect(broadcast).not.toHaveBeenCalled();
  expect(consoleError).not.toHaveBeenCalled();
});

it("non-HTTP failure uses a safe connection message", async () => {
  assignProject.mockRejectedValue(new TypeError("SYNTHETIC_INTERNAL_DETAIL"));
  const h = setup();
  await h.actions.assignSelectedToProject("p");
  expect(h.flash).toHaveBeenCalledExactlyOnceWith("Could not move the items. Check your connection and try again.");
  expect(broadcast).not.toHaveBeenCalled();
});

it.each([false, true])("an acknowledged move survives synthetic reload rejection (board=%s)", async (board) => {
  const h = setup();
  h.reload.mockRejectedValue(new Error("SYNTHETIC_REFRESH_DETAIL"));
  assignProject.mockResolvedValue({ updated: 2, team_synced: false });
  if (board) await h.actions.boardAssign([{ id: "g1" }, { id: "g2" }] as Generation[], "p");
  else await h.actions.assignSelectedToProject("p");
  expect(assignProject).toHaveBeenCalledOnce();
  expect(h.reload).toHaveBeenCalledOnce();
  expect(h.bumpBoard).toHaveBeenCalledTimes(board ? 1 : 0);
  expect(broadcast).toHaveBeenCalledOnce();
  expect(h.flash).toHaveBeenCalledExactlyOnceWith("Moved 2 items into the project. · ⚠ Team sync failed (server unreachable) — resync needed · The move finished, but the view could not be refreshed. Reload to see it.");
});

it("keeps reload then board then broadcast then one flash", async () => {
  const h = setup();
  const order: string[] = [];
  h.reload.mockImplementation(async () => { order.push("reload"); });
  h.bumpBoard.mockImplementation(() => { order.push("board"); });
  broadcast.mockImplementation(() => { order.push("broadcast"); });
  h.flash.mockImplementation(() => { order.push("flash"); });
  await h.actions.boardAssign([{ id: "g1" }] as Generation[], "p");
  expect(order).toEqual(["reload", "board", "broadcast", "flash"]);
});

it("preserves selected expansion, explicit multi-drag, unselected single and resume arguments", async () => {
  const h = setup(["g1", "g2"], "team");
  await h.actions.dropOnFolder("g1", "p", "e001/c0010");
  await h.actions.dropOnFolder("g3,g4", "p", "e001/c0010");
  await h.actions.dropUnassign("g5");
  expect(assignProject.mock.calls).toEqual([
    [["g1", "g2"], "p", "team", "e001/c0010", true],
    [["g3", "g4"], "p", "team", "e001/c0010", true],
    [["g5"], null, "team", undefined, false],
  ]);
  expect(h.bumpBoard).not.toHaveBeenCalled();
});

it("does nothing for an empty selection", async () => {
  const h = setup([]);
  await h.actions.assignSelectedToProject("p");
  expect(assignProject).not.toHaveBeenCalled(); expect(h.reload).not.toHaveBeenCalled();
  expect(broadcast).not.toHaveBeenCalled(); expect(h.flash).not.toHaveBeenCalled();
});

it("does not merge two explicit calls", async () => {
  const h = setup();
  await Promise.all([h.actions.assignSelectedToProject("p"), h.actions.assignSelectedToProject("p")]);
  expect(assignProject).toHaveBeenCalledTimes(2); expect(broadcast).toHaveBeenCalledTimes(2);
});

it("passes 1501 IDs once without claiming HTTP or DB capacity", async () => {
  const ids = Array.from({ length: 1501 }, (_, i) => `synthetic-${i}`);
  await setup(ids).actions.assignSelectedToProject("p", "ep/shot");
  expect(assignProject).toHaveBeenCalledExactlyOnceWith(ids, "p", "my", "ep/shot", true);
});

it("keeps updated zero as success", async () => {
  assignProject.mockResolvedValue({ updated: 0 });
  const h = setup();
  await h.actions.assignSelectedToProject("p");
  expect(h.flash).toHaveBeenCalledExactlyOnceWith("Moved 0 items into the project.");
});

it("preserves the earlier Comfy Running translation", () => {
  expect(t("실행 중")).toBe("Running");
});
