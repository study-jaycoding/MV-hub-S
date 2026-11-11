// @vitest-environment jsdom
// 탭 폴더(Jay 2026-11-11 시안 v4) — '+' 우클릭 [씬 추가 · 폴더 추가], 탭을 폴더 위에 끌어 넣고, 폴더 목록에서 끌어 탭 줄로 되돌린다.
//  넣고 빼는 단추는 없다(끌기만). 저장은 onTabFolder 연산 하나로 넘긴다 — 여기서는 어떤 연산을 보내는지만 본다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { SceneBar } from "../src/components/scene/SceneBar";
import type { Scene } from "../src/lib/scenes";
import type { TabFolder } from "../src/lib/sceneWorkspace";
import type { WorkspaceContext } from "../src/types";

const F: TabFolder = { id: "F", name: "Act_01" };
const scene = (id: string, folder?: TabFolder): Scene => ({ id, name: id, cards: [], edges: [], created_at: 0, ...(folder ? { tabFolder: folder } : {}) });
const personal: WorkspaceContext = { scope: "personal", id: null, name: null };
const onTabFolder = vi.fn();
const onReorder = vi.fn();
const onSelect = vi.fn();
const onAdd = vi.fn();
let host: HTMLDivElement;
let root: Root;

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, right: left + width, top, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

// 탭 줄 칸을 가로 한 줄(폭 100)로 둔다 — jsdom 은 자리를 재 주지 않는다
const layout = () => {
  vi.spyOn(host.querySelector<HTMLElement>(".scene-bar")!, "getBoundingClientRect").mockReturnValue(rect(0, 0, 600, 30));
  [...host.querySelectorAll<HTMLElement>(".scene-bar > .scene-tab-wrap, .scene-bar > .scene-tab-folder")].forEach((el, index) => {
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue(rect(index * 100, 0, 100, 30));
  });
};

const mount = (scenes: Scene[], activeId: string | null, withFolders = true) => {
  act(() => root.render(
    <SceneBar scenes={scenes} activeId={activeId} workspaceContext={personal} onSelect={onSelect} onAdd={onAdd}
      onRename={vi.fn()} onDelete={vi.fn()} onReorder={onReorder} onAssignWorkspace={vi.fn()} onTabFolder={withFolders ? onTabFolder : undefined} />,
  ));
  layout();
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network in isolated UI test"))));
  [onTabFolder, onReorder, onSelect, onAdd].forEach((fn) => fn.mockClear());
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const pointer = (type: string, target: EventTarget, init: MouseEventInit) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "isPrimary", { value: true });
  act(() => { target.dispatchEvent(event); });
};
const drag = (target: Element, from: [number, number], to: [number, number]) => {
  pointer("pointerdown", target, { clientX: from[0], clientY: from[1] });
  pointer("pointermove", target, { clientX: to[0], clientY: to[1], buttons: 1 });
  pointer("pointerup", target, { clientX: to[0], clientY: to[1] });
};
const contextMenu = (target: Element) => act(() => {
  target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 40 }));
});
const tab = (id: string) => host.querySelector<HTMLElement>(`[data-scene-tab="${id}"] .scene-tab`);
const folderChip = () => host.querySelector<HTMLElement>(".scene-tab-folder");
const menuItems = () => [...document.querySelectorAll<HTMLElement>(".scene-tab-menu .scene-tab-menu-item")];
const itemNamed = (text: string) => menuItems().find((el) => el.textContent?.includes(text));
const nameInput = () => document.querySelector<HTMLInputElement>('input[aria-label="폴더 이름"]');
const type = (value: string) => act(() => {
  const el = nameInput()!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
const enter = () => act(() => { nameInput()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });

it("'+' 우클릭 = [씬 추가 · 폴더 추가] · 씬 추가는 지금 '+' 와 같다 · 폴더 기능이 없으면 메뉴도 없다", () => {
  mount([scene("s1")], "s1");
  contextMenu(host.querySelector(".scene-add")!);
  expect(menuItems().map((el) => el.textContent)).toEqual(["씬 추가", "폴더 추가"]);
  act(() => { itemNamed("씬 추가")!.click(); });
  expect(onAdd).toHaveBeenCalledTimes(1);
  expect(menuItems()).toEqual([]);

  mount([scene("s1")], "s1", false);
  contextMenu(host.querySelector(".scene-add")!);
  expect(menuItems()).toEqual([]);
});

it("폴더 추가 = 줄 맨 끝에 빈 폴더, 이름이 골라진 채 열린다 · Enter 로 이름 · 빈 폴더는 저장 연산을 보내지 않는다", () => {
  mount([scene("s1")], "s1");
  contextMenu(host.querySelector(".scene-add")!);
  act(() => { itemNamed("폴더 추가")!.click(); });
  expect(nameInput()?.value).toBe("새 폴더");
  expect(document.activeElement).toBe(nameInput());
  type("Act_09");
  enter();
  expect(nameInput()).toBeNull();
  expect(folderChip()?.textContent).toBe("Act_09");
  const order = [...host.querySelectorAll(".scene-bar > *")].map((el) => el.className.split(" ")[0]).filter((c) => c.startsWith("scene-tab") || c === "scene-add");
  expect(order).toEqual(["scene-tab-wrap", "scene-tab-folder", "scene-add"]);
  expect(onTabFolder).not.toHaveBeenCalled();
});

it("탭을 폴더 가운데에 놓으면 그 폴더 마지막 탭 뒤로 넣는다 · 폴더 가장자리는 지금처럼 순서만 바꾼다", () => {
  mount([scene("s1"), scene("s2", F), scene("s3"), scene("s4")], "s1"); // 줄: s1 | 폴더(s2) | s3 | s4
  pointer("pointerdown", tab("s4")!, { clientX: 350, clientY: 15 });
  pointer("pointermove", tab("s4")!, { clientX: 150, clientY: 15, buttons: 1 });
  expect(folderChip()!.classList.contains("drop")).toBe(true);
  expect(host.querySelector(".scene-drop-line")).toBeNull();
  pointer("pointerup", tab("s4")!, { clientX: 150, clientY: 15 });
  expect(onTabFolder).toHaveBeenCalledExactlyOnceWith({ type: "put", id: "s4", folder: F, beforeId: "s3" });
  expect(onReorder).not.toHaveBeenCalled();

  drag(tab("s4")!, [350, 15], [105, 15]); // 폴더 왼쪽 끝 = 폴더 앞(첫 탭 s2 앞)
  expect(onReorder).toHaveBeenCalledExactlyOnceWith({ id: "s4", beforeId: "s2" });
  expect(onTabFolder).toHaveBeenCalledTimes(1);
});

it("폴더를 누르면 안의 탭 목록 · 줄을 누르면 그 탭이 열리고 목록은 닫힌다", () => {
  mount([scene("s1"), scene("s2", F), scene("s3", F)], "s1");
  expect(host.querySelectorAll(".scene-bar > .scene-tab-wrap")).toHaveLength(1); // 폴더 안 탭은 줄에 없다
  expect(folderChip()!.textContent).toBe("Act_012");
  act(() => { folderChip()!.click(); });
  expect(menuItems().map((el) => el.textContent)).toEqual(["s2", "s3"]);
  act(() => { itemNamed("s3")!.click(); });
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("s3");
  expect(menuItems()).toEqual([]);
});

it("목록의 탭을 탭 줄에 끌어 놓으면 폴더에서 빼서 그 자리로 · 줄 밖에 놓으면 취소", async () => {
  mount([scene("s1"), scene("s2", F), scene("s3", F)], "s1"); // 줄: s1 | 폴더
  act(() => { folderChip()!.click(); });
  drag(itemNamed("s3")!, [150, 60], [20, 15]); // s1 앞
  expect(onTabFolder).toHaveBeenCalledExactlyOnceWith({ type: "put", id: "s3", folder: null, beforeId: "s1" });
  expect(menuItems()).toEqual([]); // 끈 뒤 목록은 닫힌다

  await act(async () => { await new Promise((done) => setTimeout(done, 0)); }); // 끌기에 딸린 click 삼키기가 풀릴 때까지
  act(() => { folderChip()!.click(); });
  drag(itemNamed("s2")!, [150, 60], [150, 300]); // 캔버스 위 — 놓을 곳 없음
  expect(onTabFolder).toHaveBeenCalledTimes(1);
});

it("보는 탭이 폴더 안이면 폴더 바로 옆에 탭으로 남고 폴더 테두리가 라임이다 · 그 탭을 줄의 다른 자리에 놓으면 폴더에서 빠진다", () => {
  mount([scene("s1"), scene("s2", F), scene("s3", F)], "s2");
  const row = [...host.querySelectorAll<HTMLElement>(".scene-bar > .scene-tab-wrap, .scene-bar > .scene-tab-folder")];
  expect(row.map((el) => el.dataset.sceneTab ?? `f:${el.dataset.tabFolder}`)).toEqual(["s1", "f:F", "s2"]);
  expect(folderChip()!.classList.contains("has-cur")).toBe(true);
  drag(tab("s2")!, [250, 15], [20, 15]);
  expect(onTabFolder).toHaveBeenCalledExactlyOnceWith({ type: "put", id: "s2", folder: null, beforeId: "s1" });
});

it("폴더를 끌면 폴더째 옮긴다 · 폴더 우클릭 '폴더 풀기'", () => {
  mount([scene("s1"), scene("s2", F), scene("s3", F)], "s1");
  drag(folderChip()!, [150, 15], [20, 15]);
  expect(onTabFolder).toHaveBeenLastCalledWith({ type: "moveFolder", folderId: "F", beforeId: "s1" });
  act(() => { folderChip()!.click(); }); // 끈 뒤 딸려 오는 click 은 목록을 열지 않는다
  expect(menuItems()).toEqual([]);

  contextMenu(folderChip()!);
  expect(nameInput()?.value).toBe("Act_01");
  act(() => { itemNamed("폴더 풀기")!.click(); });
  expect(onTabFolder).toHaveBeenLastCalledWith({ type: "ungroup", folderId: "F" });
});
