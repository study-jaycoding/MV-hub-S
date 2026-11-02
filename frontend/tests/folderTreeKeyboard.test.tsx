// @vitest-environment jsdom
// 폴더 트리의 키보드(조작 규칙 51 — 24회차, Codex 전수 검토): 펼침 자리(지금은 링)는 span 이라 Tab 이 닿지 않아, 접힌 폴더의 하위 폴더에는 키보드만으로
//  갈 길이 없었다(Enter 는 그 폴더를 고르기만 한다). 트리의 관례대로 → 가 펼치고 ← 가 접는다. 고르기와 d(비활성) 같은 줄의 키는 그대로다.
//  아래쪽은 줄 모양(Jay 2026-10-31): 하위가 있으면 막대, 없으면 빈 앞 칸, 개수 0 은 칸 없음, 고른 줄은 색·아이콘·연결선.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url"; // jsdom 이 전역 URL 을 바꿔 둔다 — 파일 주소는 node 의 URL 로
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FolderTreeView, type FolderTreeItem } from "../src/components/common/FolderTreeView";

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
const bars = (name: string) => row(name).querySelector(".folder-tree-bars");
const barCount = (name: string) => row(name).querySelectorAll(".folder-tree-bars i").length;
/** l0 → l1 → … 한 줄로 내려가는 트리. levels = l0 아래 단계 수 */
const chain = (levels: number, at = 0, parent = ""): FolderTreeItem => {
  const path = (parent ? `${parent}/` : "") + `l${at}`;
  return { name: `l${at}`, path, children: at < levels ? [chain(levels, at + 1, path)] : [] };
};
const everyPath = (node: FolderTreeItem): string[] => [node.path, ...(node.children || []).flatMap(everyPath)];
const sizes = () => [...host.querySelectorAll(".folder-tree-row")].map((el) => [...el.classList].find((name) => /^fs\d+$/.test(name)));

it("하위가 있으면 막대, 없으면 빈 앞 칸 — 화살표·폴더 아이콘·점이 없고 개수 0 은 숫자 칸이 없다", () => {
  act(() => root.render(<FolderTreeView nodes={counted} expanded={new Set(["ep001"])} onToggle={() => {}} onSelect={() => {}} />));
  expect(bars("ep001")?.getAttribute("title")).toBe("접기");
  expect(bars("misc")).toBeNull();
  expect(row("misc").querySelector(".folder-tree-slot")?.childElementCount).toBe(0);
  expect(row("c0010").classList.contains("has")).toBe(true);
  expect(row("c0030").classList.contains("has")).toBe(false);
  expect(host.textContent).not.toMatch(/[▸▾-]/);
  expect(host.querySelector(".folder-tree-icon, .folder-tree-caret")).toBeNull();
  expect([...host.querySelectorAll(".folder-tree-count")].map((el) => el.textContent)).toEqual(["45", "42", "3"]);
  expect(row("ep001").classList.contains("open")).toBe(true); // 펼침 = 세로 라임 막대
  expect(bars("ep001")?.classList.contains("st-gen")).toBe(true);

  act(() => root.render(<FolderTreeView nodes={counted} expanded={new Set()} onToggle={() => {}} onSelect={() => {}} />));
  expect(row("ep001").classList.contains("branch")).toBe(true);
  expect(row("ep001").classList.contains("open")).toBe(false); // 접힘 = 가로 회색 막대
  expect(bars("ep001")?.className).not.toContain("st-");
  expect(bars("ep001")?.getAttribute("title")).toBe("펴기");
});

it("막대 수 = 아래 폴더 단계 수 — 5단계 이상도 4개", () => {
  const tree = chain(5);
  act(() => root.render(<FolderTreeView nodes={[tree]} expanded={new Set(everyPath(tree))} onToggle={() => {}} onSelect={() => {}} />));
  expect(["l0", "l1", "l2", "l3", "l4"].map(barCount)).toEqual([4, 4, 3, 2, 1]);
  expect(bars("l5")).toBeNull();
});

it("펼친 폴더 옆 가로줄 — 막대 수를 칸에 넘기고, 펼친 줄에만 그려 끝을 18px 로 맞춘다(Jay 2026-11-02)", () => {
  const tree = chain(5);
  act(() => root.render(<FolderTreeView nodes={[tree]} expanded={new Set(everyPath(tree))} onToggle={() => {}} onSelect={() => {}} />));
  expect(["l0", "l1", "l2", "l3", "l4"].map((name) => (bars(name) as HTMLElement).style.getPropertyValue("--bars"))).toEqual(["4", "4", "3", "2", "1"]);
  const css = readFileSync(new NodeURL("../src/styles/project-sidebar.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = css.match(/\.folder-tree-row\.open \.folder-tree-bars::after \{([^}]*)\}/)?.[1] ?? "";
  expect(rule).toContain("width: calc(18px - var(--line-start))");
  expect(rule).toContain("background: rgb(var(--st))");
  expect(css).not.toMatch(/\.folder-tree-row:not\(\.open\) \.folder-tree-bars::after/);
});

it("글자 크기 = 깊이별 15·13, 맨 밑은 늘 11 — 트리 전체 단계로 정해 접어도 안 바뀐다", () => {
  const draw = (tree: FolderTreeItem, expanded = everyPath(tree)) =>
    act(() => root.render(<FolderTreeView nodes={[tree]} expanded={new Set(expanded)} onToggle={() => {}} onSelect={() => {}} />));
  draw(chain(3));
  expect(sizes()).toEqual(["fs15", "fs13", "fs11", "fs11"]);
  draw(chain(3), ["l0"]);
  expect(sizes()).toEqual(["fs15", "fs13"]);
  draw(chain(1));
  expect(sizes()).toEqual(["fs15", "fs11"]); // 폴더가 2단계면 15·11
  draw(chain(0));
  expect(sizes()).toEqual(["fs11"]);
});

it("디스크에 없는 폴더는 이름 뒤에 '폴더 없음' 표가 붙고 숫자는 그대로다 — 고른 뒤에도 남는다", () => {
  const nodes = [{ name: "c0090", path: "c0090", count: 6, virtual: true }, { name: "c0010", path: "c0010", count: 2 }];
  const tag = (name: string) => row(name).querySelector(".folder-tree-nodisk")?.textContent;
  act(() => root.render(<FolderTreeView nodes={nodes} onSelect={() => {}} />));
  expect([tag("c0090"), tag("c0010")]).toEqual(["폴더 없음", undefined]);
  expect(row("c0090").querySelector(".folder-tree-name + .folder-tree-nodisk")).not.toBeNull();
  expect(row("c0090").querySelector(".folder-tree-count")?.textContent).toBe("6");
  act(() => root.render(<FolderTreeView nodes={nodes} selectedPath="c0090" genRows onSelect={() => {}} />));
  expect(tag("c0090")).toBe("폴더 없음");
});

const slotMark = (name: string) => row(name).querySelector(".folder-tree-slot > .side-mark")?.className;
const afterMarks = (name: string) => [...row(name).querySelectorAll(":scope > .side-mark")].map((el) => el.className);

it("고른 줄 — 앞 칸에 그 색 아이콘, 글자 표 없음. 하위 있는 폴더는 막대를 두고 아이콘은 이름 뒤", () => {
  const picked = (selectedPath: string) => act(() => root.render(
    <FolderTreeView nodes={counted} selectedPath={selectedPath} genRows expanded={new Set(["ep001"])} onToggle={() => {}} onSelect={() => {}} />));
  picked("ep001/c0010");
  expect(row("c0010").className).toContain("state st-gen");
  expect(slotMark("c0010")).toBe("side-mark gen");
  expect(row("c0010").querySelector(".side-mark")?.textContent).toBe("");
  picked("ep001");
  expect(row("ep001").className).toContain("state st-gen");
  expect(bars("ep001")?.classList.contains("st-gen")).toBe(true);
  expect([slotMark("ep001"), afterMarks("ep001")]).toEqual([undefined, ["side-mark gen"]]);
});

it("다빈치가 같은 줄이면 줄 색만 빨강 — 앞 칸 아이콘은 그대로, 다빈치 아이콘은 이름 뒤", () => {
  act(() => root.render(<FolderTreeView nodes={counted} selectedPath="ep001/c0010" viewedPath="ep001/c0010" genRows
    expanded={new Set(["ep001"])} onToggle={() => {}} onSelect={() => {}} />));
  expect(row("c0010").className).toContain("st-dv");
  expect(row("c0010").className).not.toContain("st-gen");
  expect([slotMark("c0010"), afterMarks("c0010")]).toEqual(["side-mark gen", ["side-mark dv"]]);
});

it("고른 줄이 든 폴더를 접으면 가로 막대가 그 색 — 다빈치 → 생성 → 보기 순", () => {
  const draw = (paths: { selectedPath?: string; viewedPath?: string; seePath?: string }) =>
    act(() => root.render(<FolderTreeView nodes={counted} {...paths} genRows expanded={new Set()} onToggle={() => {}} onSelect={() => {}} />));
  draw({ seePath: "ep001/c0010" });
  expect(bars("ep001")?.classList.contains("st-see")).toBe(true);
  draw({ seePath: "ep001/c0010", selectedPath: "ep001/c0020" });
  expect(bars("ep001")?.classList.contains("st-gen")).toBe(true);
  draw({ seePath: "ep001/c0010", selectedPath: "ep001/c0020", viewedPath: "ep001/c0030" });
  expect(bars("ep001")?.classList.contains("st-dv")).toBe(true);
  draw({ selectedPath: "misc" }); // 다른 폴더의 줄 — 그대로 회색
  expect(bars("ep001")?.className).not.toContain("st-");
  draw({ selectedPath: "ep0010/c1" }); // 이름 앞부분만 같은 폴더는 안이 아니다
  expect(bars("ep001")?.className).not.toContain("st-");
});

it("생성 위치가 없는 자리(편집·어셋·관리자)는 고른 줄·확인 줄 모두 보기 파랑이다", () => {
  act(() => root.render(<FolderTreeView nodes={counted} selectedPath="ep001" viewedPath="ep001/c0010" expanded={new Set(["ep001"])} onToggle={() => {}} onSelect={() => {}} />));
  expect(row("ep001").className).toContain("st-see");
  expect(afterMarks("ep001")).toEqual(["side-mark see"]);
  expect(row("c0010").className).toContain("st-see");
  expect([slotMark("c0010"), afterMarks("c0010")]).toEqual(["side-mark see", []]);
  expect(host.querySelector(".side-mark.gen, .side-mark.dv")).toBeNull();
});

it("고른 줄 연결 — 깊이 1 이상만, 앞쪽 세로선은 맨 안쪽 8px 부터 5px 씩 길어지고 10px 간격으로 선다", () => {
  const tree = chain(2);
  const draw = (selectedPath: string) => act(() => root.render(
    <FolderTreeView nodes={[tree]} selectedPath={selectedPath} genRows expanded={new Set(everyPath(tree))} onToggle={() => {}} onSelect={() => {}} />));
  draw("l0");
  expect(host.querySelector(".folder-tree-link")).toBeNull();
  draw("l0/l1/l2");
  const lines = [...row("l2").querySelectorAll<HTMLElement>(".vline")].map((el) => [el.style.left, el.style.height]);
  expect(lines).toEqual([["13.5px", "13px"], ["23.5px", "8px"]]);
  expect(row("l2").querySelector<HTMLElement>(".hline")?.style.width).toBe("18px");
  expect([...row("l2").querySelectorAll<HTMLElement>(".folder-tree-mask")].map((el) => el.style.left)).toEqual(["13.5px", "23.5px"]);
});

it("막대를 누르면 펴고 접을 뿐 폴더를 고르지 않는다 — 줄의 나머지는 고르기. 펴고 접기가 없는 트리의 막대는 눌러도 아무 일이 없다", () => {
  const onToggle = vi.fn();
  const onSelect = vi.fn();
  act(() => root.render(<FolderTreeView nodes={counted} expanded={new Set()} onToggle={onToggle} onSelect={onSelect} />));
  act(() => row("ep001").querySelector<HTMLElement>(".folder-tree-bars")!.click());
  expect(onToggle).toHaveBeenCalledExactlyOnceWith("ep001");
  expect(onSelect).not.toHaveBeenCalled(); // 고르면 생성 위치가 바뀐다
  act(() => row("ep001").querySelector<HTMLElement>(".folder-tree-name")!.click());
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("ep001");
  expect(onToggle).toHaveBeenCalledTimes(1);

  const select = vi.fn();
  act(() => root.render(<FolderTreeView nodes={counted} onSelect={select} />)); // 관리자 창 — 언제나 다 펼쳐져 있다
  const lead = row("ep001").querySelector<HTMLElement>(".folder-tree-bars")!;
  expect(lead.classList.contains("toggle")).toBe(false);
  expect(lead.getAttribute("title")).toBeNull();
  act(() => lead.click());
  expect(select).not.toHaveBeenCalled();
  expect(row("c0010")).toBeDefined();
});

it("깊이를 --tree-depth 로 넘겨 라임 선·색 바탕을 계산하고, 들여쓰기는 인라인이라 담기 메뉴의 button 규칙에 덮이지 않는다", () => {
  act(() => root.render(<FolderTreeView nodes={counted} expanded={new Set(["ep001"])} onToggle={() => {}} onSelect={() => {}} />));
  expect(row("ep001").style.getPropertyValue("--tree-depth")).toBe("0");
  expect(row("c0010").style.getPropertyValue("--tree-depth")).toBe("1");
  expect(row("ep001").style.paddingLeft).toBe("8px");
  expect(row("c0010").style.paddingLeft).toBe("18px");
  expect(host.querySelector<HTMLElement>(".folder-tree-children")?.style.getPropertyValue("--tree-depth")).toBe("0");
});
