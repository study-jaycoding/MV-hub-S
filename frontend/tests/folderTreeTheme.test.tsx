// @vitest-environment jsdom
// 필터 테마(Jay 2026-11-04) — 설정 → 기본 설정의 모션 아래 목록에서 '기본'(▸/▾ 화살표 + 폴더 아이콘, 처음 값)·'v1'(막대·선)을 고르면
//  열린 모든 폴더 트리가 바로 바뀐다. 두 테마 공통: 생성물 0 인 폴더는 흐린 '-'. 더블클릭(A안) = 첫 누름은 고르기, 더블클릭은 펴고 접기.
//  v1 의 줄 모양 자체는 tests/folderTreeKeyboard 가 본다.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url"; // jsdom 이 전역 URL 을 바꿔 둔다 — 파일 주소는 node 의 URL 로
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FolderTreeView, type FolderTreeItem } from "../src/components/common/FolderTreeView";
import { AppearanceSettingsSection } from "../src/components/settings/SettingsSections";
import { loadFolderTreeTheme, saveFolderTreeTheme, useFolderTreeTheme } from "../src/lib/theme";

const KEY = "ch_folder_tree_theme";
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const nodes: FolderTreeItem[] = [
  { name: "ep001", path: "ep001", count: 45, children: [
    { name: "c0010", path: "ep001/c0010", count: 42 },
    { name: "c0020", path: "ep001/c0020", count: 3 },
    { name: "c0030", path: "ep001/c0030", count: 0 },
  ] },
  { name: "ep002", path: "ep002", count: 0, children: [{ name: "c0010", path: "ep002/c0010", count: 0 }] },
  { name: "misc", path: "misc", count: 0 },
];
const row = (path: string) => [...host.querySelectorAll<HTMLElement>(".folder-tree-row")]
  .find((item) => (item.getAttribute("title") || "").split("\n")[0] === path)!;
const caret = (path: string) => row(path).querySelector<HTMLElement>(".folder-tree-caret")!;
const afterName = (path: string) => [...row(path).querySelectorAll(".folder-tree-name ~ .side-mark")].map((el) => el.className);
const fire = (target: HTMLElement, type: string) =>
  act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })); });

it("저장값이 없으면 기본 — 이상한 값도 기본, v1 만 v1 이다. 고른 값은 계정 전환 정리에 지워지지 않는 밑줄 키에 남는다", () => {
  expect(loadFolderTreeTheme()).toBe("base");
  localStorage.setItem(KEY, "weird");
  expect(loadFolderTreeTheme()).toBe("base");
  saveFolderTreeTheme("v1");
  expect([localStorage.getItem(KEY), loadFolderTreeTheme()]).toEqual(["v1", "v1"]);
  expect(KEY.startsWith("ch.")).toBe(false); // personalSettings 는 계정을 바꿀 때 ch. 키를 지운다
});

it("기본 — 하위 있는 줄은 ▸/▾ 화살표 + 폴더 아이콘, 하위 없는 줄은 빈 화살표 칸 + 폴더 아이콘. 막대·앞 칸이 없고 들여쓰기 6+깊이×14", () => {
  act(() => root.render(<FolderTreeView nodes={nodes} expanded={new Set(["ep001"])} onToggle={() => {}} onSelect={() => {}} />));
  expect(host.querySelector(".folder-tree")?.className).toContain("tree-base");
  expect(host.querySelector(".folder-tree-bars, .folder-tree-slot")).toBeNull();
  expect([caret("ep001").textContent, caret("ep001").getAttribute("title")]).toEqual(["▾", "접기"]);
  expect([caret("ep002").textContent, caret("ep002").getAttribute("title")]).toEqual(["▸", "펴기"]);
  expect([caret("misc").textContent, caret("misc").className]).toEqual(["", "folder-tree-caret hidden"]);
  for (const path of ["ep001", "ep001/c0010", "ep002", "misc"]) {
    expect(row(path).querySelector(".folder-tree-caret + .folder-tree-icon + .folder-tree-name")).not.toBeNull();
  }
  expect([row("ep001").style.paddingLeft, row("ep001/c0010").style.paddingLeft]).toEqual(["6px", "20px"]);
});

it("기본 — 열린 폴더 아이콘(A안)은 펼친 폴더에만: 접힌 폴더·하위 없는 줄·펼친 폴더 없음 줄은 닫힌 폴더 그대로, v1 엔 없다", () => {
  const css = readFileSync(new NodeURL("../src/styles/project-sidebar.css", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, ""); // CRLF 로 받은 사본에서도 같게
  const front = css.match(/([^{}]+)::after \{([^}]*skewX\(-22deg\)[^}]*)\}/);
  const selector = front?.[1].trim() ?? "";
  expect(selector).toBe(".folder-tree.tree-base .folder-tree-row.open:not(.virtual) > .folder-tree-icon");
  expect(front?.[2]).toContain("background: var(--fd-front)");
  expect(css).toContain(".folder-tree.tree-base .folder-tree-row.root {\n  --fd-back: linear-gradient(#34b4cf, #1a7a90); --fd-front: linear-gradient(#93f5ff, #41cbe4);");
  expect(css).toContain(".folder-tree.tree-base .folder-tree-row {\n  --fd-back: linear-gradient(#a3d22a, #658f0e); --fd-front: linear-gradient(#ebff80, #a7dc24);");
  const tree: FolderTreeItem[] = [...nodes, { name: "ghost", path: "ghost", count: 2, virtual: true,
    children: [{ name: "c1", path: "ghost/c1", count: 2, virtual: true }] }];
  const opened = () => [...host.querySelectorAll(selector)].map((icon) => (icon.parentElement!.getAttribute("title") || "").split("\n")[0]);
  act(() => root.render(<FolderTreeView nodes={tree} expanded={new Set(["ep001", "ghost"])} onToggle={() => {}} onSelect={() => {}} />));
  expect(opened()).toEqual(["ep001"]); // ep002 접힘·컷·misc·펼친 ghost(폴더 없음)는 아니다
  act(() => saveFolderTreeTheme("v1"));
  expect(opened()).toEqual([]);
});

it("기본 — 고르지 않은 줄의 아이콘은 회색 + 50%(③), 고른 줄(생성·보기·다빈치 색 바탕) 아이콘은 색 그대로. v1 엔 아이콘이 없다", () => {
  const css = readFileSync(new NodeURL("../src/styles/project-sidebar.css", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");
  const selector = css.match(/([^{}]+)\{ filter: grayscale\(1\); opacity: 0\.5; \}/)?.[1].trim() ?? "";
  expect(selector).toBe(".folder-tree.tree-base .folder-tree-row:not(.state):not(.anc) > .folder-tree-icon"); // 이름·숫자·화살표는 대상이 아니다
  expect(css).toContain(".folder-tree-row.disabled .folder-tree-icon { filter: grayscale(1); }"); // 생략 줄은 위 폴더여도 회색
  const tree: FolderTreeItem[] = [...nodes, { name: "ghost", path: "ghost", count: 2, virtual: true,
    children: [{ name: "c1", path: "ghost/c1", count: 2, virtual: true }] }];
  const grayed = () => [...host.querySelectorAll(selector)].map((icon) => (icon.parentElement!.getAttribute("title") || "").split(/\n| \(/)[0]);
  act(() => root.render(<FolderTreeView nodes={tree} selectedPath="ep001/c0010" seePath="ep001/c0020" viewedPath="misc" genRows
    expanded={new Set(["ep001", "ghost"])} isDisabled={(path) => path === "ep002"} onToggle={() => {}} onSelect={() => {}} />));
  // 생성 위치를 품은 펼친 ep001 은 위 폴더라 색(B안), 생략 ep002·폴더 없음 ghost 는 회색
  expect(grayed()).toEqual(["ep001/c0030", "ep002", "ghost", "ghost/c1"]);
  act(() => saveFolderTreeTheme("v1"));
  expect(grayed()).toEqual([]);
});

it("기본 — 고른 줄의 위로 이어진 폴더(B안)는 펼쳤든 접었든 아이콘 색 그대로, 형제·다른 폴더는 회색. 색 바탕은 고른 줄에만", () => {
  const css = readFileSync(new NodeURL("../src/styles/project-sidebar.css", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");
  const selector = css.match(/([^{}]+)\{ filter: grayscale\(1\); opacity: 0\.5; \}/)?.[1].trim() ?? "";
  const deep: FolderTreeItem[] = [
    { name: "e030", path: "e030", count: 2, children: [
      { name: "s01", path: "e030/s01", count: 2, children: [{ name: "c0010", path: "e030/s01/c0010", count: 2 }, { name: "c0020", path: "e030/s01/c0020", count: 0 }] },
      { name: "s02", path: "e030/s02", count: 0, children: [{ name: "c0010", path: "e030/s02/c0010", count: 0 }] },
    ] },
    { name: "e035", path: "e035", count: 0, children: [{ name: "c0010", path: "e035/c0010", count: 0 }] },
  ];
  const grayed = () => [...host.querySelectorAll(selector)].map((icon) => (icon.parentElement!.getAttribute("title") || "").split("\n")[0]);
  const draw = (expanded: string[], selectedPath = "e030/s01/c0010") =>
    act(() => root.render(<FolderTreeView nodes={deep} selectedPath={selectedPath} genRows expanded={new Set(expanded)} onToggle={() => {}} onSelect={() => {}} />));
  draw(["e030", "e030/s01", "e030/s02"]); // 두 단계 아래를 고름 — s01·e030 둘 다 색
  expect(grayed()).toEqual(["e030/s01/c0020", "e030/s02", "e030/s02/c0010", "e035"]);
  expect(["e030", "e030/s01"].map((path) => [row(path).classList.contains("anc"), row(path).classList.contains("state")])).toEqual([[true, false], [true, false]]);
  draw([]); // 접어도 고른 줄을 품은 e030 은 색
  expect(grayed()).toEqual(["e035"]);
  draw(["e030", "e030/s01"], ""); // 고른 줄이 없으면 위 폴더도 없다
  expect(host.querySelector(".folder-tree-row.anc")).toBeNull();
});

it("기본 — 보기·생성·다빈치 아이콘은 이름 뒤(생성 다음 다빈치), 고른 줄 연결선이 없다", () => {
  act(() => root.render(<FolderTreeView nodes={nodes} selectedPath="ep001/c0010" viewedPath="ep001/c0010" genRows
    expanded={new Set(["ep001"])} onToggle={() => {}} onSelect={() => {}} />));
  expect(row("ep001/c0010").className).toContain("state st-dv");
  expect(afterName("ep001/c0010")).toEqual(["side-mark gen", "side-mark dv"]);
  expect(host.querySelector(".folder-tree-link, .folder-tree-mask")).toBeNull();
  act(() => root.render(<FolderTreeView nodes={nodes} selectedPath="ep001" genRows
    expanded={new Set(["ep001"])} onToggle={() => {}} onSelect={() => {}} />));
  expect(afterName("ep001")).toEqual(["side-mark gen"]);
});

it("기본 — 화살표 색은 v1 막대와 같은 규칙: 펼침 라임, 고른 줄을 품고 접히면 그 색, 그 밖에 접힘은 색 없음", () => {
  const draw = (paths: { selectedPath?: string; viewedPath?: string; seePath?: string }, expanded: string[]) =>
    act(() => root.render(<FolderTreeView nodes={nodes} {...paths} genRows expanded={new Set(expanded)} onToggle={() => {}} onSelect={() => {}} />));
  draw({}, ["ep001"]);
  expect(caret("ep001").classList.contains("st-gen")).toBe(true);
  expect(caret("ep002").className).not.toContain("st-");
  draw({ selectedPath: "ep002/c0010" }, []);
  expect(caret("ep002").classList.contains("st-gen")).toBe(true);
  expect(caret("ep001").className).not.toContain("st-");
  draw({ selectedPath: "ep002/c0010", viewedPath: "ep002/c0010" }, []);
  expect(caret("ep002").classList.contains("st-dv")).toBe(true);
});

it("기본 — 화살표를 누르면 펴고 접을 뿐 고르지 않는다. 펴고 접기가 없는 트리(관리자 창)는 화살표가 숨고 눌러도 아무 일이 없다", () => {
  const onToggle = vi.fn();
  const onSelect = vi.fn();
  act(() => root.render(<FolderTreeView nodes={nodes} expanded={new Set()} onToggle={onToggle} onSelect={onSelect} />));
  act(() => caret("ep001").click());
  expect(onToggle).toHaveBeenCalledExactlyOnceWith("ep001");
  expect(onSelect).not.toHaveBeenCalled();

  const select = vi.fn();
  act(() => root.render(<FolderTreeView nodes={nodes} onSelect={select} />));
  expect([caret("ep001").textContent, caret("ep001").className]).toEqual(["", "folder-tree-caret hidden"]);
  act(() => caret("ep001").click());
  expect(select).not.toHaveBeenCalled();
});

it("더블클릭(A안) — 하위 있는 줄은 두 누름이 지금처럼 고르고 더블클릭이 한 번 펴고 접는다. 하위 없는 줄은 고르기만", () => {
  for (const theme of ["base", "v1"] as const) {
    saveFolderTreeTheme(theme);
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    act(() => root.render(<FolderTreeView nodes={nodes} expanded={new Set()} onToggle={onToggle} onSelect={onSelect} />));
    const name = row("ep001").querySelector<HTMLElement>(".folder-tree-name")!;
    fire(name, "click");
    fire(name, "click");
    fire(name, "dblclick");
    expect(onSelect.mock.calls).toEqual([["ep001"], ["ep001"]]);
    expect(onToggle.mock.calls).toEqual([["ep001"]]);
    fire(row("misc"), "click");
    fire(row("misc"), "dblclick");
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenLastCalledWith("misc");
  }
});

it("더블클릭 — 막대·화살표를 빠르게 두 번 누르면 두 번 토글뿐(줄의 더블클릭이 세 번째를 더하지 않는다). 펴고 접기가 없는 트리는 더블클릭해도 아무 일이 없다", () => {
  for (const theme of ["base", "v1"] as const) {
    saveFolderTreeTheme(theme);
    const onToggle = vi.fn();
    act(() => root.render(<FolderTreeView nodes={nodes} expanded={new Set()} onToggle={onToggle} onSelect={() => {}} />));
    const lead = row("ep001").querySelector<HTMLElement>(theme === "base" ? ".folder-tree-caret" : ".folder-tree-bars")!;
    fire(lead, "click");
    fire(lead, "click");
    fire(lead, "dblclick");
    expect(onToggle).toHaveBeenCalledTimes(2);
  }
  const select = vi.fn();
  act(() => root.render(<FolderTreeView nodes={nodes} onSelect={select} />));
  fire(row("ep001"), "dblclick");
  expect(row("ep001/c0010")).toBeDefined(); // 관리자 창 트리는 늘 펼쳐져 있고 그대로다
});

it("생성물 0 인 폴더는 흐린 '-' — 조회 전(null)·숫자 없는 트리(undefined)는 칸이 없고, 0 보다 크면 숫자 그대로", () => {
  const items: FolderTreeItem[] = [
    { name: "zero", path: "zero", count: 0 }, { name: "loading", path: "loading", count: null },
    { name: "none", path: "none" }, { name: "five", path: "five", count: 5 },
  ];
  for (const theme of ["base", "v1"] as const) {
    saveFolderTreeTheme(theme);
    act(() => root.render(<FolderTreeView nodes={items} onSelect={() => {}} />));
    const badge = (path: string) => row(path).querySelector(".folder-tree-count");
    expect([badge("zero")?.textContent, badge("zero")?.className]).toEqual(["-", "folder-tree-count zero"]);
    expect([badge("loading"), badge("none")]).toEqual([null, null]);
    expect(badge("five")?.textContent).toBe("5");
  }
});

it("테마를 바꾸면 이미 그려진 트리가 바로 다시 그린다 — 같은 창의 저장도, 다른 창의 storage 알림도", () => {
  act(() => root.render(<FolderTreeView nodes={nodes} expanded={new Set(["ep001"])} onToggle={() => {}} onSelect={() => {}} />));
  expect(host.querySelector(".folder-tree-caret")).not.toBeNull();
  act(() => saveFolderTreeTheme("v1"));
  expect(host.querySelector(".folder-tree")?.className).toContain("tree-v1");
  expect([host.querySelector(".folder-tree-caret, .folder-tree-icon"), host.querySelector(".folder-tree-bars")?.tagName]).toEqual([null, "SPAN"]);
  expect(row("ep001/c0010").style.paddingLeft).toBe("18px");
  act(() => {
    localStorage.setItem(KEY, "base"); // 다른 창(떠 있는 캔버스·어셋 창)이 골랐다
    window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
  });
  expect(host.querySelector(".folder-tree")?.className).toContain("tree-base");
  expect(host.querySelector(".folder-tree-bars")).toBeNull();
});

function Settings({ onTreeTheme }: { onTreeTheme?: (theme: "base" | "v1") => void }) {
  const theme = useFolderTreeTheme();
  return (
    <>
      <AppearanceSettingsSection accent="#c4e84a" lang="ko" reduceMotion={false} treeTheme={theme}
        onAccent={() => {}} onLang={() => {}} onReduceMotion={() => {}} onTreeTheme={onTreeTheme ?? saveFolderTreeTheme} />
      <FolderTreeView nodes={nodes} expanded={new Set(["ep001"])} onToggle={() => {}} onSelect={() => {}} />
    </>
  );
}

it("설정 — 모션 칸 바로 아래 '필터 테마': 지금 값 단추를 누르면 목록이 펼쳐지고, 고르면 그 값이 적용·저장되며 목록이 닫힌다", () => {
  act(() => root.render(<Settings />));
  const heads = [...host.querySelectorAll(".settings-section > h4")].map((el) => el.textContent);
  expect(heads.slice(heads.indexOf("모션"), heads.indexOf("모션") + 2)).toEqual(["모션", "필터 테마"]);
  const button = host.querySelector<HTMLButtonElement>(".tree-theme-btn")!;
  expect([button.textContent, button.getAttribute("aria-expanded")]).toEqual(["기본⌄", "false"]);
  expect(host.querySelector(".tree-theme-list")).toBeNull();
  act(() => button.click());
  const options = [...host.querySelectorAll<HTMLButtonElement>(".tree-theme-list [role=option]")];
  expect(options.map((el) => [el.textContent, el.getAttribute("aria-selected")])).toEqual([
    ["기본화살표 + 폴더 아이콘", "true"], ["v1막대·선", "false"]]);
  act(() => options[1].click());
  expect([localStorage.getItem(KEY), host.querySelector(".tree-theme-list"), button.textContent]).toEqual(["v1", null, "v1⌄"]);
  expect(host.querySelector(".folder-tree")?.className).toContain("tree-v1"); // 열린 트리가 바로 바뀐다
  const summary = [...host.querySelectorAll(".settings-section")].find((el) => el.querySelector("h4")?.textContent === "필터 테마")!
    .querySelector(".settings-description-summary")!.textContent!;
  expect(summary).toBe("사이드바 폴더 트리 모양을 고릅니다.");
  expect(/(\.\.\.|…)$/.test(summary)).toBe(false);
});

it("설정 — 목록 밖을 누르면 고르지 않고 닫힌다", () => {
  const onTreeTheme = vi.fn();
  act(() => root.render(<Settings onTreeTheme={onTreeTheme} />));
  act(() => host.querySelector<HTMLButtonElement>(".tree-theme-btn")!.click());
  expect(host.querySelector(".tree-theme-list")).not.toBeNull();
  fire(document.body, "mousedown");
  expect(host.querySelector(".tree-theme-list")).toBeNull();
  expect(onTreeTheme).not.toHaveBeenCalled();
});
