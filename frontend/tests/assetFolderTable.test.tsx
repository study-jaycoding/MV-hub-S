// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AssetNode } from "../src/types";

const mocks = vi.hoisted(() => ({ assetProjects: vi.fn(), assetTree: vi.fn(), assetMeta: vi.fn(), me: vi.fn(), revealAsset: vi.fn() }));
vi.mock("../src/api", () => ({ api: new Proxy({
  ...mocks,
  assetFileUrl: (_project: string, path: string) => `/files/${path}`,
  assetThumbUrl: (_project: string, path: string) => `/thumbs/${path}`,
}, { get: (target, name: string) => target[name as keyof typeof target] ?? (() => new Promise(() => {})) }) }));
vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return { Virtualizer: forwardRef((props: { data: unknown[]; children: (row: unknown) => React.ReactNode }, ref) => {
    useImperativeHandle(ref, () => ({ scrollToIndex: () => {} }));
    return <>{props.data.map(props.children)}</>;
  }) };
});
import { AssetsView } from "../src/components/AssetsView";
import { AssetFolderTable } from "../src/components/assets/AssetFolderTable";
import { assetFolderGroups } from "../src/components/assets/assetFolderGroups";
import { flattenFiles } from "../src/components/assets/treeUtils";

const file = (path: string, type: "image" | "video" | "audio" = "image"): AssetNode => ({ name: path.split("/").pop()!, path, type });
const folder = (path: string, children: AssetNode[]): AssetNode => ({ name: path.split("/").pop()!, path, type: "dir", children });
const tree = [folder("assets", [
  folder("assets/CH", [folder("assets/CH/person", [
    file("assets/CH/person/a.png"), file("assets/CH/person/b.mp4", "video"), file("assets/CH/person/c.wav", "audio"),
  ])]),
  folder("assets/BG", [file("assets/BG/beach.png")]), file("assets/direct.png"),
])];
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network in table UI test"))));
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem("ch.assets.dir", "assets");
  localStorage.setItem("ch.assets.folderModePath", "P|assets");
  mocks.assetProjects.mockResolvedValue({ projects: ["P"], linked: [], default: "P" });
  mocks.assetTree.mockResolvedValue({ children: tree });
  mocks.assetMeta.mockResolvedValue({});
  mocks.me.mockResolvedValue({ creator_uid: "account-a" });
  mocks.revealAsset.mockReset().mockResolvedValue({ ok: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const click = async (el: Element) => { await act(async () => el.dispatchEvent(new MouseEvent("click", { bubbles: true }))); await settle(); };
const fire = async (el: Element, event: Event) => { await act(async () => el.dispatchEvent(event)); await settle(); };
const mount = async () => { await act(async () => root.render(<AssetsView onInfo={() => {}} onPreview={() => {}} />)); await settle(); };
const tab = (name: string) => [...host.querySelectorAll('[role="tab"]')].find((el) => el.querySelector(".scene-tab-name")?.textContent === name)!;
const listButton = () => host.querySelector('[title="리스트"]')!;
const folderModeButton = (name: string) => [...host.querySelectorAll(".lib-cut-seg button")].find((el) => el.textContent === name)!;
const setSize = async (value: string) => {
  const input = host.querySelector<HTMLInputElement>('.size-slider input[type="range"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
};

async function mountTable(overrides: Partial<Parameters<typeof AssetFolderTable>[0]> = {}) {
  const grouped = assetFolderGroups(tree, "assets", flattenFiles(tree), "P");
  const props = { project: "P", groups: grouped.groups, directFiles: grouped.directFiles, scale: 1.2,
    fit: "contain" as const, scrollRef: createRef<HTMLDivElement>(), onScroll: vi.fn(),
    onEnter: vi.fn(), onOpenTab: vi.fn(), onPreview: vi.fn(), ...overrides };
  await act(async () => root.render(<AssetFolderTable {...props} />));
  return props;
}

it("표는 제공된 폴더·미디어 집계와 직접 파일을 표시하고 없는 통계는 만들지 않는다", async () => {
  const props = await mountTable();
  expect([...host.querySelectorAll("thead th")].map((el) => el.textContent)).toEqual(["미리보기", "이름", "폴더", "파일", "이미지", "영상", "오디오"]);
  const ch = host.querySelector('[data-folder-path="assets/CH"]')!;
  expect([...ch.querySelectorAll("td")].slice(1).map((el) => el.textContent)).toEqual(["1", "3", "1", "1", "1"]);
  const direct = host.querySelector('[data-file-path="assets/direct.png"]')!;
  expect([...direct.querySelectorAll("td")].slice(1).map((el) => el.textContent)).toEqual(["0", "1", "1", "0", "0"]);
  expect(host.querySelectorAll("tbody tr")).toHaveLength(3);
  expect(host.querySelector<HTMLDivElement>(".assets-folder-table")!.style.getPropertyValue("--ep-scale")).toBe("1.2");
  expect(host.querySelectorAll(".assets-folder-table-preview.contain")).toHaveLength(3);
  expect(props.scrollRef).toHaveProperty("current", host.querySelector(".assets-folder-table"));
  await fire(host.querySelector(".assets-folder-table")!, new Event("scroll", { bubbles: true }));
  expect(props.onScroll).toHaveBeenCalledTimes(1);
});

it("표의 단일 선택·폴더 진입·중간클릭·키보드와 미리보기는 서로 간섭하지 않는다", async () => {
  const props = await mountTable({ lastViewedPath: "assets/CH/person/a.png" });
  const row = host.querySelector('[data-folder-path="assets/CH"]')!;
  await click(row);
  expect(row.getAttribute("aria-selected")).toBe("true");
  expect(props.onEnter).not.toHaveBeenCalled();
  const preview = row.querySelector("button")!;
  await click(preview);
  await fire(preview, new MouseEvent("dblclick", { bubbles: true }));
  await fire(preview, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
  expect(props.onPreview).toHaveBeenCalledTimes(1);
  expect(props.onPreview).toHaveBeenLastCalledWith(expect.objectContaining({ path: "assets/CH/person/a.png" }));
  expect(row.querySelector(".asset-last-viewed")?.textContent).toBe("Last viewed");
  expect(props.onEnter).not.toHaveBeenCalled();
  expect(props.onOpenTab).not.toHaveBeenCalled();
  await fire(row, new MouseEvent("dblclick", { bubbles: true }));
  await fire(row, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
  expect(props.onEnter).toHaveBeenCalledWith("assets/CH");
  expect(props.onOpenTab).toHaveBeenCalledWith("assets/CH");
  for (const key of ["Enter", " "]) await fire(row, new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  expect(props.onEnter).toHaveBeenCalledTimes(3);
  await fire(row, new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true }));
  await fire(row, new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
  await fire(preview, new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(props.onEnter).toHaveBeenCalledTimes(3);
});

it("직접 파일의 행/버튼 미리보기와 빈 표를 유지한다", async () => {
  const props = await mountTable();
  const row = host.querySelector('[data-file-path="assets/direct.png"]')!;
  await click(row);
  await click(row.querySelector("button")!);
  await fire(row, new KeyboardEvent("keydown", { key: " ", bubbles: true }));
  expect(props.onPreview).toHaveBeenCalledTimes(3);
  expect(props.onOpenTab).not.toHaveBeenCalled();
  await act(async () => root.render(<AssetFolderTable {...props} groups={[]} directFiles={[]} />));
  expect(host.querySelector("table")).toBeNull();
  expect(host.querySelector(".assets-empty")?.textContent).toBe("이 폴더에 미디어가 없습니다.");
});

it("표의 원본 경로는 클릭/Enter로 한 번씩 열고 행의 진입·미리보기·새 탭에 전파하지 않는다", async () => {
  const props = await mountTable();
  const row = host.querySelector('[data-folder-path="assets/CH"]')!;
  const path = row.querySelector<HTMLButtonElement>(".assets-source-path")!;
  await click(path);
  expect(mocks.revealAsset).toHaveBeenCalledExactlyOnceWith("P", "assets/CH");
  await fire(path, new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  expect(mocks.revealAsset).toHaveBeenCalledTimes(2);
  await fire(path, new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true }));
  await fire(path, new MouseEvent("dblclick", { bubbles: true }));
  await fire(path, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
  expect(mocks.revealAsset).toHaveBeenCalledTimes(2);
  expect(row.getAttribute("aria-selected")).toBe("false");
  await click(host.querySelector('[data-file-path="assets/direct.png"] .assets-source-path')!);
  expect(mocks.revealAsset).toHaveBeenLastCalledWith("P", "assets/direct.png");
  expect(props.onEnter).not.toHaveBeenCalled();
  expect(props.onOpenTab).not.toHaveBeenCalled();
  expect(props.onPreview).not.toHaveBeenCalled();
});

it("폴더 리스트를 다시 누르면 표로 바뀌고 다시 누르면 리스트로 돌아가며 저장한다", async () => {
  await mount();
  await click(listButton());
  expect(host.querySelector(".assets-folder-grid.list")).not.toBeNull();
  await click(listButton());
  expect(host.querySelector(".assets-folder-table table")).not.toBeNull();
  expect(listButton().classList.contains("grouped")).toBe(true);
  expect(localStorage.getItem("ch.assets.folderLayout")).toBe("table");
  await click(listButton());
  expect(host.querySelector(".assets-folder-grid.list")).not.toBeNull();
  expect(host.querySelector(".assets-folder-table")).toBeNull();
  await click(listButton());
  await act(async () => root.render(null));
  await mount();
  expect(host.querySelector(".assets-folder-table table")).not.toBeNull();
});

it("표/리스트·크기·맞춤·스크롤을 폴더 탭별로 복원한다", async () => {
  localStorage.setItem("ch.assets.folderLayout", "table");
  localStorage.setItem("ch.assets.folderScale", "0.8");
  localStorage.setItem("ch.assets.folderFit", "contain");
  await mount();
  host.querySelector<HTMLDivElement>(".assets-folder-table")!.scrollTop = 140;
  await fire(host.querySelector('[data-folder-path="assets/CH"]')!, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
  expect(tab("CH").getAttribute("aria-selected")).toBe("false");
  expect(host.querySelector<HTMLDivElement>(".assets-folder-table")!.scrollTop).toBe(140);
  await click(tab("CH"));
  expect(tab("CH").getAttribute("aria-selected")).toBe("true");
  await click(listButton());
  await click(host.querySelector(".fit-toggle")!);
  const slider = host.querySelector<HTMLInputElement>('.size-slider input[type="range"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "1.4");
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });
  host.querySelector<HTMLDivElement>(".assets-folder-grid.list")!.scrollTop = 70;
  await click(tab("assets"));
  const table = host.querySelector<HTMLDivElement>(".assets-folder-table")!;
  expect(table.style.getPropertyValue("--ep-scale")).toBe("0.8");
  expect(table.scrollTop).toBe(140);
  expect(host.querySelector(".assets-folder-table-preview.contain")).not.toBeNull();
  await fire(host.querySelector('[data-folder-path="assets/CH"]')!, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
  expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2);
  expect(tab("CH").getAttribute("aria-selected")).toBe("false");
  expect(table.scrollTop).toBe(140);
  await click(tab("CH"));
  expect(tab("CH").getAttribute("aria-selected")).toBe("true");
  const list = host.querySelector<HTMLDivElement>(".assets-folder-grid.list")!;
  expect(list.style.getPropertyValue("--ep-scale")).toBe("1.4");
  expect(list.scrollTop).toBe(70);
  expect(host.querySelector(".fit-toggle")?.classList.contains("on")).toBe(false);
  await click(host.querySelector('[aria-label="CH 탭 닫기"]')!);
  await click(tab("assets"));
  expect(host.querySelector<HTMLDivElement>(".assets-folder-table")!.scrollTop).toBe(140);
});

it("폴더 표 전환은 파일 전체 모드의 날짜 구분과 레이아웃을 바꾸지 않는다", async () => {
  localStorage.setItem("ch.assets.folderLayout", "table");
  await mount();
  await click(folderModeButton("전체"));
  await click(listButton());
  await click(listButton());
  expect(listButton().classList.contains("grouped")).toBe(true);
  expect(localStorage.getItem("ch.assets.groupByDate")).toBe("1");
  await click(folderModeButton("폴더"));
  expect(host.querySelector(".assets-folder-table")).not.toBeNull();
  await click(listButton());
  expect(localStorage.getItem("ch.assets.groupByDate")).toBe("1");
  await click(folderModeButton("전체"));
  expect(listButton().classList.contains("grouped")).toBe(true);
  expect(localStorage.getItem("ch.assets.layout")).toBe("list");
});

it("혼합 폴더의 명시 보기와 크기는 경로 이동·Backspace·기존 폴더 새 탭에도 독립 복원된다", async () => {
  localStorage.removeItem("ch.assets.folderModePath");
  const mixed = structuredClone(tree);
  mixed[0].children![0].children!.push(file("assets/CH/direct.png"));
  mocks.assetTree.mockResolvedValue({ children: mixed });
  await mount();
  expect(folderModeButton("전체").classList.contains("on")).toBe(true);
  await click(folderModeButton("폴더"));
  await click(listButton()); await click(listButton()); await setSize("0.8");
  await click(host.querySelector(".fit-toggle")!);
  await fire(host.querySelector('[data-folder-path="assets/CH"]')!, new MouseEvent("dblclick", { bubbles: true }));
  expect(folderModeButton("전체").classList.contains("on")).toBe(true);
  await click(folderModeButton("폴더"));
  await click(host.querySelector('[title="그리드"]')!); await setSize("1.4");
  await click(host.querySelector(".fit-toggle")!);
  await fire(document.body, new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
  let table = host.querySelector<HTMLDivElement>(".assets-folder-table")!;
  expect(table).not.toBeNull(); expect(table.style.getPropertyValue("--ep-scale")).toBe("0.8");
  expect(host.querySelector(".fit-toggle")?.classList.contains("on")).toBe(true);
  await fire(host.querySelector('[data-folder-path="assets/CH"]')!, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
  expect(tab("CH").getAttribute("aria-selected")).toBe("false");
  await click(tab("CH"));
  expect(tab("CH").getAttribute("aria-selected")).toBe("true");
  const grid = host.querySelector<HTMLDivElement>(".assets-folder-grid")!;
  expect(grid.classList.contains("table")).toBe(false);
  expect(grid.style.getPropertyValue("--ep-scale")).toBe("1.4");
  expect(host.querySelector(".fit-toggle")?.classList.contains("on")).toBe(false);
  await click(tab("assets"));
  table = host.querySelector<HTMLDivElement>(".assets-folder-table")!;
  expect(table.style.getPropertyValue("--ep-scale")).toBe("0.8");
});

it("폴더 보기는 계정·워크스페이스·프로젝트를 경로와 함께 분리한다", async () => {
  const scopes = [
    { account: "account-a", workspace: "w1", project: "P", layout: "list", group: true, scale: 0.8, fill: false },
    { account: "account-b", workspace: "w1", project: "P", layout: "grid", group: false, scale: 1.6, fill: true },
    { account: "account-a", workspace: "w2", project: "P", layout: "list", group: false, scale: 1.2, fill: true },
    { account: "account-a", workspace: "w1", project: "Q", layout: "grid", group: false, scale: 0.9, fill: false },
  ];
  const key = (scope: typeof scopes[number]) => JSON.stringify([scope.account, scope.workspace, scope.project, "assets"]);
  const saved = Object.fromEntries(scopes.map((scope) => [key(scope), {
    layout: scope.layout, group: scope.group, scale: scope.scale, fill: scope.fill,
  }]));
  localStorage.setItem("ch.assets.folder.placeViews", JSON.stringify(saved));
  localStorage.setItem("ch.assets.placeViews", JSON.stringify(Object.fromEntries(scopes.map((scope) => [key(scope), {
    layout: "grid", group: false, folders: true,
  }]))));
  for (const scope of scopes) {
    await act(async () => root.render(null));
    localStorage.setItem("ch.assets.dir", "assets"); localStorage.setItem("ch.assets.project", scope.project);
    localStorage.setItem("ch.workspaceContext", JSON.stringify({ scope: "team", id: scope.workspace }));
    mocks.me.mockResolvedValue({ creator_uid: scope.account });
    mocks.assetProjects.mockResolvedValue({ projects: [scope.project], linked: [], default: scope.project });
    await mount();
    const grid = host.querySelector<HTMLDivElement>(".assets-folder-grid")!;
    expect(grid.classList.contains("table")).toBe(scope.layout === "list" && scope.group);
    expect(grid.classList.contains("list")).toBe(scope.layout === "list" && !scope.group);
    expect(grid.style.getPropertyValue("--ep-scale")).toBe(String(scope.scale));
    expect(host.querySelector(".fit-toggle")?.classList.contains("on")).toBe(!scope.fill);
  }
  const kept = JSON.parse(localStorage.getItem("ch.assets.folder.placeViews")!);
  for (const scope of scopes) expect(kept[key(scope)]).toEqual(saved[key(scope)]);
});
