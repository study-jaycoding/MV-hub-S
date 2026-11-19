// @vitest-environment jsdom
// 어셋 왼쪽 폴더 트리의 폴더 우클릭 → '원본 위치 열기'(Jay 2026-11-20 시안 B). 누르면 그 폴더 경로로 탐색기 열기를 부르고 메뉴가 닫힌다.
//  Esc 는 메뉴만 닫고 초점을 연 줄로 돌린다. (원격 접속에서 메뉴를 안 띄우는 갈래는 jsdom 주소가 localhost 라 여기서 못 본다.)
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { AssetsSidebar } from "../src/components/assets/AssetsSidebar";
import type { AssetNode } from "../src/types";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const tree: AssetNode[] = [
  { name: "assets", type: "dir", path: "assets", children: [
    { name: "CH", type: "dir", path: "assets/CH", children: [] },
  ] },
];
const show = () => act(() => root.render(
  <AssetsSidebar project="RnD" folderKind="linked" typeFilter={null} dir="assets" meta={{}} sourceOnly={false}
    onRoot={() => {}} loading={false} tree={tree} expanded={new Set(["assets"])} onToggleDir={() => {}} onSelectDir={() => {}} />,
));
const row = (name: string) => [...host.querySelectorAll<HTMLElement>(".folder-tree-row")].find((item) => item.textContent?.includes(name))!;
const menu = () => document.querySelector<HTMLElement>(".assets-tree-menu");
const rightClick = (target: HTMLElement) => {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 90, clientY: 240 });
  act(() => { target.dispatchEvent(event); });
  return event;
};

it("폴더 줄 우클릭 → 이름표와 '원본 위치 열기' 메뉴 · 누르면 그 폴더로 탐색기 열기를 부르고 닫힌다", async () => {
  const reveal = vi.spyOn(api, "revealAsset").mockResolvedValue({ ok: true });
  show();
  expect(menu()).toBeNull();
  expect(rightClick(row("CH")).defaultPrevented).toBe(true); // 브라우저 기본 메뉴 대신
  expect(menu()?.querySelector(".folder-ctx-name")?.textContent).toBe("CH");
  const open = menu()!.querySelector<HTMLButtonElement>(".preview-menu-item")!;
  expect(open.textContent).toContain("원본 위치 열기");
  expect(document.activeElement).toBe(open); // 열리면 단추에 초점 — 줄에 남아 단축키가 먹지 않게
  await act(async () => { open.click(); });
  expect(reveal).toHaveBeenCalledWith("RnD", "assets/CH");
  expect(menu()).toBeNull();
});

it("Esc 는 메뉴만 닫고 초점을 연 줄로 돌린다 · 바깥을 누르면 닫힌다 · 아무것도 열지 않는다", () => {
  const reveal = vi.spyOn(api, "revealAsset").mockResolvedValue({ ok: true });
  show();
  rightClick(row("CH"));
  expect(menu()).not.toBeNull();
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(menu()).toBeNull();
  expect(document.activeElement).toBe(row("CH"));
  rightClick(row("assets"));
  expect(menu()?.querySelector(".folder-ctx-name")?.textContent).toBe("assets");
  act(() => { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  expect(menu()).toBeNull();
  expect(reveal).not.toHaveBeenCalled();
});
