// @vitest-environment jsdom
// 폴더 트리의 키보드(조작 규칙 51 — 24회차, Codex 전수 검토): 펼침표(▸)는 글자(span)라 Tab 이 닿지 않아, 접힌 폴더의 하위 폴더에는 키보드만으로
//  갈 길이 없었다(Enter 는 그 폴더를 고르기만 한다). 트리의 관례대로 → 가 펼치고 ← 가 접는다. 고르기와 d(비활성) 같은 줄의 키는 그대로다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FolderTreeView } from "../src/components/common/FolderTreeView";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const nodes = [{ name: "ep001", path: "ep001", children: [{ name: "c0010", path: "ep001/c0010" }] }, { name: "misc", path: "misc" }];
const rows = () => [...host.querySelectorAll<HTMLElement>(".folder-tree-row")].map((row) => row.textContent);
const row = (name: string) => [...host.querySelectorAll<HTMLElement>(".folder-tree-row")].find((item) => item.textContent?.includes(name))!;
const key = (target: HTMLElement, name: string) => {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  act(() => { target.dispatchEvent(event); });
  return event;
};

it("→ 가 접힌 폴더를 펼치고 ← 가 접는다 — 이미 그 상태면 아무 일도 아니다. 하위 없는 폴더에서는 아무 일도 아니다", () => {
  const onToggle = vi.fn();
  const onSelect = vi.fn();
  const show = (expanded: Set<string>) => act(() => root.render(<FolderTreeView nodes={nodes} expanded={expanded} onToggle={onToggle} onSelect={onSelect} />));
  show(new Set());
  expect(rows()).toEqual(["▸ep001-", "misc-"]); // 접혀 있다
  expect(key(row("ep001"), "ArrowRight").defaultPrevented).toBe(true);
  expect(onToggle).toHaveBeenCalledWith("ep001"); // 전엔 아무 일도 없었다
  show(new Set(["ep001"]));
  expect(rows()).toEqual(["▾ep001-", "c0010-", "misc-"]);
  expect(key(row("ep001"), "ArrowRight").defaultPrevented).toBe(false); // 이미 펼쳐져 있다
  expect(onToggle).toHaveBeenCalledTimes(1);
  expect(key(row("ep001"), "ArrowLeft").defaultPrevented).toBe(true);
  expect(onToggle).toHaveBeenCalledTimes(2);
  expect(key(row("misc"), "ArrowRight").defaultPrevented).toBe(false); // 하위가 없다
  expect(onToggle).toHaveBeenCalledTimes(2);
  expect(onSelect).not.toHaveBeenCalled(); // 펼치기는 고르기가 아니다
});

it("줄의 다른 키(d 등)는 전처럼 줄의 키 처리로 가고, 화살표는 거기로 가지 않는다 — onToggle 이 없는 트리에서는 화살표도 줄의 것이다", () => {
  const onRowKeyDown = vi.fn();
  act(() => root.render(<FolderTreeView nodes={nodes} expanded={new Set()} onToggle={() => {}} onSelect={() => {}} onRowKeyDown={onRowKeyDown} />));
  key(row("ep001"), "d");
  expect(onRowKeyDown).toHaveBeenCalledWith("ep001", expect.objectContaining({ key: "d" }));
  key(row("ep001"), "ArrowRight");
  expect(onRowKeyDown).toHaveBeenCalledTimes(1);

  const plain = vi.fn();
  act(() => root.render(<FolderTreeView nodes={nodes} onSelect={() => {}} onRowKeyDown={plain} />));
  key(row("ep001"), "ArrowRight");
  expect(plain).toHaveBeenCalledWith("ep001", expect.objectContaining({ key: "ArrowRight" }));
});
