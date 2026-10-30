// @vitest-environment jsdom
// 폴더 트리의 키보드(조작 규칙 51 — 24회차, Codex 전수 검토): 펼침 자리(지금은 링)는 span 이라 Tab 이 닿지 않아, 접힌 폴더의 하위 폴더에는 키보드만으로
//  갈 길이 없었다(Enter 는 그 폴더를 고르기만 한다). 트리의 관례대로 → 가 펼치고 ← 가 접는다. 고르기와 d(비활성) 같은 줄의 키는 그대로다.
//  아래쪽은 화살표·폴더 아이콘을 없앤 줄 모양(Jay 2026-10-30): 하위가 있으면 링, 없으면 점, 개수 0 은 칸 없음.
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
  expect(rows()).toEqual(["ep001", "misc"]); // 접혀 있다
  expect(key(row("ep001"), "ArrowRight").defaultPrevented).toBe(true);
  expect(onToggle).toHaveBeenCalledWith("ep001"); // 전엔 아무 일도 없었다
  show(new Set(["ep001"]));
  expect(rows()).toEqual(["ep001", "c0010", "misc"]);
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

const counted = [{ name: "ep001", path: "ep001", count: 45, children: [
  { name: "c0010", path: "ep001/c0010", count: 42 },
  { name: "c0020", path: "ep001/c0020", count: 3 },
  { name: "c0030", path: "ep001/c0030", count: 0 },
] }, { name: "misc", path: "misc", count: 0 }];
const fill = (name: string) => row(name).querySelector(".folder-tree-ring .done")?.getAttribute("stroke-dasharray");

it("하위가 있으면 링(내용 있는 하위 폴더 / 전체), 없으면 점 — 화살표·폴더 아이콘이 없고 개수 0 은 숫자 칸이 없다", () => {
  act(() => root.render(<FolderTreeView nodes={counted} expanded={new Set(["ep001"])} onToggle={() => {}} onSelect={() => {}} />));
  expect(fill("ep001")).toBe("2 3");
  expect(row("ep001").querySelector(".folder-tree-ring")?.getAttribute("title")).toBe("접기 · 내용 있는 하위 폴더 2 / 3");
  expect(row("misc").querySelector(".folder-tree-ring")).toBeNull();
  expect(row("misc").querySelector(".folder-tree-dot")).not.toBeNull();
  expect(row("c0010").classList.contains("has")).toBe(true);
  expect(row("c0030").classList.contains("has")).toBe(false);
  expect(host.textContent).not.toMatch(/[▸▾-]/);
  expect(host.querySelector(".folder-tree-icon, .folder-tree-caret")).toBeNull();
  expect([...host.querySelectorAll(".folder-tree-count")].map((el) => el.textContent)).toEqual(["45", "42", "3"]);
  expect(row("ep001").classList.contains("open")).toBe(true); // 펼침 = 밝게

  act(() => root.render(<FolderTreeView nodes={counted} expanded={new Set()} onToggle={() => {}} onSelect={() => {}} />));
  expect(row("ep001").classList.contains("branch")).toBe(true);
  expect(row("ep001").classList.contains("open")).toBe(false); // 접힘 = 회색
  expect(row("ep001").querySelector(".folder-tree-ring")?.getAttribute("title")).toBe("펴기 · 내용 있는 하위 폴더 2 / 3");
});

it("내용 있는 하위 폴더가 없으면 링은 바탕만 그린다", () => {
  act(() => root.render(<FolderTreeView nodes={[{ name: "e002", path: "e002", children: [{ name: "c1", path: "e002/c1" }] }]}
    expanded={new Set()} onToggle={() => {}} onSelect={() => {}} />));
  expect(row("e002").querySelector(".folder-tree-ring .track")).not.toBeNull();
  expect(fill("e002")).toBeUndefined();
});

it("링을 누르면 펴고 접을 뿐 폴더를 고르지 않는다 — 줄의 나머지는 고르기. 펴고 접기가 없는 트리의 링은 눌러도 아무 일이 없다", () => {
  const onToggle = vi.fn();
  const onSelect = vi.fn();
  act(() => root.render(<FolderTreeView nodes={counted} expanded={new Set()} onToggle={onToggle} onSelect={onSelect} />));
  act(() => row("ep001").querySelector<HTMLElement>(".folder-tree-ring")!.click());
  expect(onToggle).toHaveBeenCalledExactlyOnceWith("ep001");
  expect(onSelect).not.toHaveBeenCalled(); // 고르면 생성 위치가 바뀐다
  act(() => row("ep001").querySelector<HTMLElement>(".folder-tree-name")!.click());
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("ep001");
  expect(onToggle).toHaveBeenCalledTimes(1);

  const select = vi.fn();
  act(() => root.render(<FolderTreeView nodes={counted} onSelect={select} />)); // 관리자 창 — 언제나 다 펼쳐져 있다
  const ring = row("ep001").querySelector<HTMLElement>(".folder-tree-ring")!;
  expect(ring.classList.contains("toggle")).toBe(false);
  expect(ring.getAttribute("title")).toBe("내용 있는 하위 폴더 2 / 3");
  act(() => ring.click());
  expect(select).not.toHaveBeenCalled();
  expect(row("c0010")).toBeDefined();
});

it("깊이를 --tree-depth 로 넘겨 깊이선·분홍 막대를 계산하고, 들여쓰기는 인라인이라 담기 메뉴의 button 규칙에 덮이지 않는다", () => {
  act(() => root.render(<FolderTreeView nodes={counted} expanded={new Set(["ep001"])} onToggle={() => {}} onSelect={() => {}} />));
  expect(row("ep001").style.getPropertyValue("--tree-depth")).toBe("0");
  expect(row("c0010").style.getPropertyValue("--tree-depth")).toBe("1");
  expect(row("c0010").style.paddingLeft).toBe("calc(var(--tree-base, 6px) + 14px)");
  expect(host.querySelector<HTMLElement>(".folder-tree-children")?.style.getPropertyValue("--tree-depth")).toBe("0");
});
