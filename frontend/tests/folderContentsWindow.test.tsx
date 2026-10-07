// @vitest-environment jsdom
// 카드의 폴더 이름표로 여는 '폴더의 생성물' 창 — 본 목록과 따로 조회한다(useFolderContents).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Generation } from "../src/types";

const mocks = vi.hoisted(() => ({ listGenerations: vi.fn() }));
vi.mock("../src/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/api")>();
  return { ...real, api: { ...real.api, listGenerations: mocks.listGenerations } };
});

import { GEN_PAGE } from "../src/api";
import { FolderContentsWindow, type FolderWindowTarget } from "../src/components/FolderContentsWindow";
import { APP_EVENTS, dispatchAppEvent } from "../src/lib/appEvents";
import type { PreviewTarget } from "../src/types";
import { folderContentsQuery } from "../src/lib/useFolderContents";
import { useGenerationKeyboardActions } from "../src/lib/useGenerationKeyboardActions";
import { useGenerationSelection } from "../src/lib/useGenerationSelection";

const g = (id: string, over: Partial<Generation> = {}): Generation =>
  ({
    id, prompt: `p ${id}`, shared: false, is_final: false, is_mine: true, status: "done", created_at: "2026-10-07", sort_ts: Number(id.replace(/\D/g, "")) || 0,
    assets: [{ id: `a-${id}`, generation_id: id, type: "image", file_path: `/media/${id}.png`, thumbnail_path: null }],
    references: [], tags: [], auto_tags: [], deleted: false, project_id: "p1", folder_path: "e035/c0010",
    ...over,
  }) as unknown as Generation;
const target = (over: Partial<FolderWindowTarget> = {}): FolderWindowTarget => ({
  tab: "my", projectId: "p1", path: "e035/c0010", genId: "g2", projectName: "뻘뻘뻘", ...over,
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.listGenerations.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const win = () => host.querySelector<HTMLElement>(".folder-contents");
const tiles = () => [...host.querySelectorAll<HTMLButtonElement>(".fc-tile")];
const key = (el: Element, k: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  act(() => { el.dispatchEvent(event); });
  return event;
};
const view = (over: Partial<Parameters<typeof FolderContentsWindow>[0]> = {}) => {
  const handlers = { onPreview: vi.fn(), onClose: vi.fn() };
  act(() => root.render(
    <FolderContentsWindow target={target()} workspace={{}} ready covered={false} {...handlers} {...over} />,
  ));
  return handlers;
};

it("query: this tab, this folder, the effective workspace — and none of the main list's other filters", () => {
  const workspace = { workspace_ids: ["w2", "w1", "w2"], media_type: "video", colors: ["red"], search: "x", review_filter: "held" };
  expect(folderContentsQuery({ tab: "team", projectId: "p1", path: "e035/c0010" }, workspace as never)).toEqual({
    tab: "team", project_id: "p1", folder_path: "e035/c0010", workspace_ids: ["w1", "w2"],
  });
  // 프로젝트가 없는 폴더는 "none" — 빼면 다른 프로젝트의 같은 이름 폴더가 섞인다
  expect(folderContentsQuery({ tab: "my", projectId: null, path: "work" }, { workspace_scope: "personal" })).toEqual({
    tab: "my", project_id: "none", folder_path: "work", workspace_scope: "personal",
  });
});

it("opens with the folder's items, marks the card that was clicked, and hands the window's own list to the preview", async () => {
  mocks.listGenerations.mockResolvedValue([g("g1"), g("g2", { shared: true }), g("g3", { is_final: true, is_mine: false, creator_name: "리버" })]);
  const h = view();
  expect(host.querySelector(".fc-note")!.textContent).toContain("불러오는 중");
  await flush();
  expect(mocks.listGenerations).toHaveBeenCalledTimes(1);
  expect(mocks.listGenerations.mock.calls[0]).toEqual([{ tab: "my", project_id: "p1", folder_path: "e035/c0010" }, null]);
  expect(win()!.querySelector(".folder-peek-title")!.textContent).toBe("뻘뻘뻘 › e035/c0010");
  expect(win()!.querySelector(".folder-peek-count")!.textContent).toBe("3개");
  expect(tiles()).toHaveLength(3);
  expect(tiles().map((t) => t.classList.contains("here"))).toEqual([false, true, false]);
  expect(tiles()[2].querySelector(".fc-mark.final")).not.toBeNull();
  expect(tiles()[2].querySelector(".creator-badge")!.textContent).toContain("리버");

  act(() => { tiles()[2].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  expect(h.onPreview).toHaveBeenCalledTimes(1);
  const opened = h.onPreview.mock.calls[0][0];
  expect(opened.genId).toBe("g3");
  expect(opened.items.map((x: { genId: string }) => x.genId)).toEqual(["g1", "g2", "g3"]); // 좌우 이동은 창의 목록으로
  expect(opened.index).toBe(2);
  expect(opened.sceneId).toBeUndefined(); // 작업 공간에서 연 것
  // 타일은 단추다 — 키보드(Enter·Space)와 보조기술의 누름은 detail 0 인 click 으로 온다. 마우스 한 번 클릭은 열지 않는다.
  act(() => { tiles()[0].dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })); });
  expect(h.onPreview).toHaveBeenCalledTimes(1);
  act(() => tiles()[0].click());
  expect((h.onPreview.mock.calls[1][0] as PreviewTarget).genId).toBe("g1");

  // 공유 & 리뷰에서 연 창은 그 칸(@team)에 '마지막으로 본' 을 남긴다 — 빠지면 내 작업 칸에 섞인다
  const team = view({ target: target({ tab: "team" }) });
  await flush();
  act(() => { tiles()[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  expect(team.onPreview.mock.calls[0][0].sceneId).toBe("@team");
});

it("paging: a full page means more; [더 보기] continues from the last row and never repeats a row", async () => {
  const page1 = Array.from({ length: GEN_PAGE }, (_, i) => g(`g${1000 - i}`));
  mocks.listGenerations.mockResolvedValueOnce(page1);
  view();
  await flush();
  expect(win()!.querySelector(".folder-peek-count")!.textContent).toBe(`${GEN_PAGE}+개`); // 총개수는 모른다
  const more = () => host.querySelector<HTMLButtonElement>(".fc-more");
  let resolve!: (rows: Generation[]) => void;
  mocks.listGenerations.mockReturnValueOnce(new Promise<Generation[]>((r) => (resolve = r)));
  act(() => { more()!.click(); more()!.click(); }); // 연타 — 요청은 하나만
  expect(mocks.listGenerations).toHaveBeenCalledTimes(2);
  const last = page1[page1.length - 1];
  expect(mocks.listGenerations.mock.calls[1][1]).toEqual({ ts: last.sort_ts, id: last.id });
  await act(async () => resolve([last, g("g5"), g("g4")])); // 겹친 행(last)은 다시 넣지 않는다
  await flush();
  expect(tiles()).toHaveLength(GEN_PAGE + 2);
  expect(more()).toBeNull(); // 가득 차지 않은 쪽 = 끝
  expect(win()!.querySelector(".folder-peek-count")!.textContent).toBe(`${GEN_PAGE + 2}개`);
});

it("a failed next page keeps the list and the button; a failed first load offers a retry", async () => {
  mocks.listGenerations.mockResolvedValueOnce(Array.from({ length: GEN_PAGE }, (_, i) => g(`g${1000 - i}`)));
  view();
  await flush();
  mocks.listGenerations.mockRejectedValueOnce(new Error("서버 불통"));
  await act(async () => host.querySelector<HTMLButtonElement>(".fc-more")!.click());
  await flush();
  expect(tiles()).toHaveLength(GEN_PAGE);
  expect(host.querySelector(".fc-error")!.textContent).toContain("서버 불통");
  expect(host.querySelector(".fc-more")).not.toBeNull();

  mocks.listGenerations.mockReset();
  mocks.listGenerations.mockRejectedValueOnce(new Error("처음부터 실패"));
  view({ target: target({ path: "e035/c0020" }) });
  await flush();
  expect(tiles()).toHaveLength(0);
  expect(host.querySelector(".fc-error")!.textContent).toContain("처음부터 실패");
  mocks.listGenerations.mockResolvedValueOnce([g("g9", { folder_path: "e035/c0020" })]);
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>(".fc-btn")].find((b) => b.textContent === "다시 시도")!.click());
  await flush();
  expect(tiles()).toHaveLength(1);
});

it("a next-page answer that arrives after the window moved to another folder is dropped", async () => {
  mocks.listGenerations.mockResolvedValueOnce(Array.from({ length: GEN_PAGE }, (_, i) => g(`g${1000 - i}`)));
  view();
  await flush();
  let lateMore!: (rows: Generation[]) => void;
  mocks.listGenerations.mockReturnValueOnce(new Promise<Generation[]>((r) => (lateMore = r)));
  act(() => host.querySelector<HTMLButtonElement>(".fc-more")!.click()); // 앞 폴더의 다음 쪽 — 아직 답이 없다
  mocks.listGenerations.mockResolvedValueOnce([g("g7", { folder_path: "e035/c0020" })]);
  view({ target: target({ path: "e035/c0020" }) });
  await flush();
  await act(async () => lateMore([g("g3"), g("g2")]));
  await flush();
  expect(tiles().map((t) => t.title)).toEqual(["p g7"]); // 다른 폴더의 행이 섞이지 않는다
  expect(host.querySelector(".fc-more")).toBeNull();
});

it("an empty folder says so; a late answer for a previous folder is dropped", async () => {
  let late!: (rows: Generation[]) => void;
  mocks.listGenerations.mockReturnValueOnce(new Promise<Generation[]>((r) => (late = r)));
  view();
  mocks.listGenerations.mockResolvedValueOnce([]);
  view({ target: target({ path: "e035/c0020" }) }); // 응답 전에 다른 폴더로
  await flush();
  expect(host.querySelector(".fc-note")!.textContent).toContain("생성물이 없습니다");
  await act(async () => late([g("g1"), g("g2")])); // 앞 폴더의 늦은 응답
  await flush();
  expect(tiles()).toHaveLength(0);
  expect(win()!.querySelector(".folder-peek-title")!.textContent).toContain("c0020");
});

it("the window is the list as of opening: the library-change signal neither refetches nor folds it; nothing is fetched until ready", async () => {
  const page1 = Array.from({ length: GEN_PAGE }, (_, i) => g(`g${1000 - i}`));
  mocks.listGenerations.mockResolvedValueOnce(page1);
  view();
  await flush();
  mocks.listGenerations.mockResolvedValueOnce([g("g5")]);
  await act(async () => host.querySelector<HTMLButtonElement>(".fc-more")!.click());
  await flush();
  expect(tiles()).toHaveLength(GEN_PAGE + 1);
  // 공유 & 리뷰 탭에서는 이 신호가 변경이 없어도 15초마다 난다 — 따라가면 더 본 쪽이 주기적으로 접힌다
  act(() => dispatchAppEvent(APP_EVENTS.libraryChanged));
  await flush();
  expect(mocks.listGenerations).toHaveBeenCalledTimes(2);
  expect(tiles()).toHaveLength(GEN_PAGE + 1);

  mocks.listGenerations.mockReset();
  view({ target: target({ path: "x/y" }), ready: false });
  await flush();
  expect(mocks.listGenerations).not.toHaveBeenCalled(); // 계정·워크스페이스 범위가 정해지기 전에는 묻지 않는다
});

it("keys inside the window stay inside: Esc closes it, Tab is trapped, and it yields to a preview on top", async () => {
  mocks.listGenerations.mockResolvedValue([g("g1"), g("g2")]);
  const outside = document.createElement("button");
  document.body.append(outside);
  outside.focus();
  const windowKeys = vi.fn();
  window.addEventListener("keydown", windowKeys);
  const h = view();
  await flush();
  expect(win()!.contains(document.activeElement)).toBe(true); // 열릴 때 초점이 창으로

  key(tiles()[0], "r"); // 뒤 화면의 단축키로 새지 않는다
  expect(windowKeys).not.toHaveBeenCalled();
  const esc = key(tiles()[0], "Escape");
  expect(esc.defaultPrevented).toBe(true);
  expect(h.onClose).toHaveBeenCalledTimes(1);
  expect(windowKeys).not.toHaveBeenCalled();

  const closeButton = win()!.querySelector<HTMLButtonElement>(".folder-peek-x")!;
  tiles()[1].focus(); // 마지막 초점 가능 요소
  expect(key(tiles()[1], "Tab").defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(closeButton); // 창 안에서 돈다
  expect(key(closeButton, "Tab", { shiftKey: true }).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(tiles()[1]);

  // 크게 보기·정보 창이 위에 떠 있으면 Esc 를 그쪽에 양보한다
  h.onClose.mockClear();
  outside.focus(); // 크게 보기가 초점을 가져갔다고 치고
  const covered = view({ covered: true });
  expect(document.activeElement).toBe(outside); // 위 창이 떠 있는 동안에는 초점을 뺏지 않는다
  expect(key(tiles()[0], "Escape").defaultPrevented).toBe(false);
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
  expect(covered.onClose).not.toHaveBeenCalled();
  window.removeEventListener("keydown", windowKeys);
  // 위 창이 닫히면(초점이 다른 데 가 있어도) 초점이 다시 이 창으로 온다
  outside.focus();
  view();
  expect(win()!.contains(document.activeElement)).toBe(true);

  // 크게 보기의 [부분 수정]으로 넘어가면 닫힌다 — 부분 수정 창 뒤에서 키보드를 잡고 있지 않게
  const edit = view();
  act(() => { window.dispatchEvent(new CustomEvent(APP_EVENTS.partialEdit, { detail: { genId: "g1" } })); });
  expect(edit.onClose).toHaveBeenCalledTimes(1);

  // 바깥 막을 누르면 닫히고, 닫히면 초점을 돌려준다
  const again = view();
  act(() => { host.querySelector(".folder-contents-catcher")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  expect(again.onClose).toHaveBeenCalledTimes(1);
  act(() => root.render(<span />));
  expect(document.activeElement).toBe(outside);
  outside.remove();
});

it("while the window is open the main list ignores its shortcuts, and clicks in the window keep the selection behind", () => {
  const blocked = { current: false };
  const clearSelect = vi.fn();
  let selection!: ReturnType<typeof useGenerationSelection>;
  function Probe() {
    selection = useGenerationSelection({ resetKey: "k" });
    useGenerationKeyboardActions({
      clearSelect, flash: () => {}, reload: () => {}, setGens: () => {},
      filtersRef: { current: { tab: "my" } }, gensRef: { current: [] }, selectedRef: selection.selectedRef,
      backgroundBlockedRef: blocked,
    });
    return (
      <>
        <div className="folder-contents-catcher" />
        <section className="folder-contents"><button type="button" className="inside" /></section>
        <div className="elsewhere" />
      </>
    );
  }
  act(() => root.render(<Probe />));
  act(() => selection.toggleSelect("a"));

  blocked.current = true;
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
  expect(clearSelect).not.toHaveBeenCalled(); // 창을 닫는 Esc 가 뒤의 선택까지 풀지 않는다
  blocked.current = false;
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
  expect(clearSelect).toHaveBeenCalledTimes(1);

  const down = (selector: string) => act(() => { host.querySelector(selector)!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  down(".inside");
  down(".folder-contents-catcher");
  expect(selection.selected.has("a")).toBe(true);
  down(".elsewhere");
  expect(selection.selected.size).toBe(0); // 그 밖의 바깥 클릭은 종전대로 선택을 푼다
});
