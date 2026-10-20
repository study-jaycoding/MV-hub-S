// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AssetNode } from "../src/types";

const mocks = vi.hoisted(() => ({ assetProjects: vi.fn(), assetTree: vi.fn(), assetMeta: vi.fn(), revealAsset: vi.fn() }));
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
import { AssetFolderGrid } from "../src/components/assets/AssetFolderGrid";
import { assetFolderGroups } from "../src/components/assets/assetFolderGroups";
import { assetFolderLabel, flattenFiles } from "../src/components/assets/treeUtils";
import { closeLayer, openLayer } from "../src/lib/keyGate";
import { useAssetFolderTabs, type AssetFolderViewState } from "../src/components/assets/useAssetFolderTabs";

const file = (path: string): AssetNode => ({ name: path.split("/").pop()!, path, type: "image" });
const folder = (path: string, children: AssetNode[]): AssetNode => ({ name: path.split("/").pop()!, path, type: "dir", children });
const tree = [folder("assets", [
  folder("assets/CH", [folder("assets/CH/매튜", [file("assets/CH/매튜/a.png"), file("assets/CH/매튜/b.png")]),
    folder("assets/CH/미아", [file("assets/CH/미아/c.png")])]),
  folder("assets/BG", [file("assets/BG/beach.png")]),
]), folder("assets2", [file("assets2/other.png")])];
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  localStorage.clear();
  localStorage.setItem("ch.assets.dir", "assets");
  mocks.assetProjects.mockResolvedValue({ projects: ["P"], linked: [], default: "P" });
  mocks.assetTree.mockResolvedValue({ children: tree });
  mocks.assetMeta.mockResolvedValue({});
  mocks.revealAsset.mockReset().mockResolvedValue({ ok: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const click = async (el: Element) => { await act(async () => el.dispatchEvent(new MouseEvent("click", { bubbles: true }))); await settle(); };
const middle = async (el: Element) => { await act(async () => el.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }))); await settle(); };
const tab = (name: string) => Array.from(host.querySelectorAll('[role="tab"]')).find((el) => el.querySelector(".scene-tab-name")?.textContent === name)!;
const card = (path: string) => host.querySelector(`[data-folder-path="${path}"] .ep-cover`)!;
const search = async (value: string) => {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('[placeholder="Search"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }); await settle();
};
const mount = async () => { await act(async () => root.render(<AssetsView onInfo={() => {}} onPreview={() => {}} />)); await settle(); };
const doubleClick = async (el: Element) => {
  await click(el);
  await act(async () => el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await settle();
};

it("폴더와 전체 보기의 레이아웃·맞춤을 따로 기억한다", async () => {
  await mount();
  await click(host.querySelector('[title="리스트"]')!);
  await click(host.querySelector('.fit-toggle')!);
  expect(host.querySelector('.assets-folder-grid.list')).not.toBeNull();
  expect(localStorage.getItem("ch.assets.folderFit")).toBe("contain");
  const whole = [...host.querySelectorAll('.lib-cut-seg button')].find((el) => el.textContent === "전체")!;
  await click(whole);
  expect(host.querySelector('[title="그리드"]')?.classList.contains("on")).toBe(true);
  expect(host.querySelector('.fit-toggle')?.classList.contains("on")).toBe(false);
  await click([...host.querySelectorAll('.lib-cut-seg button')].find((el) => el.textContent === "폴더")!);
  expect(host.querySelector('.assets-folder-grid.list')).not.toBeNull();
  expect(host.querySelector('.fit-toggle')?.classList.contains("on")).toBe(true);
});

it("전체 파일 보기의 모양·날짜 구분·크기는 다른 폴더를 방문해도 그 자리에서 복원된다", async () => {
  const rootKey = JSON.stringify(["me", "", "P", "assets"]);
  const childKey = JSON.stringify(["me", "", "P", "assets/CH"]);
  localStorage.setItem("ch.assets.placeViews", JSON.stringify({
    [rootKey]: { layout: "list", group: true, scale: 0.8, fill: false, folders: false },
    [childKey]: { layout: "grid", group: false, scale: 1.6, fill: true, folders: false },
  }));
  await mount();
  expect(host.querySelector(".assets-list")).not.toBeNull();
  expect(host.querySelector('[title="리스트"]')?.classList.contains("grouped")).toBe(true);
  expect(host.querySelector<HTMLInputElement>('.size-slider input[type="range"]')?.value).toBe("0.8");
  expect(host.querySelector(".fit-toggle")?.classList.contains("on")).toBe(true);
  const child = [...host.querySelectorAll(".folder-tree-row")].find((row) => row.getAttribute("title")?.startsWith("assets/CH"))!;
  await click(child);
  expect(host.querySelector(".assets-masonry")).not.toBeNull();
  expect(host.querySelector<HTMLInputElement>('.size-slider input[type="range"]')?.value).toBe("1.6");
  expect(host.querySelector(".fit-toggle")?.classList.contains("on")).toBe(false);
  await backspace();
  expect(host.querySelector(".assets-list")).not.toBeNull();
  expect(host.querySelector('[title="리스트"]')?.classList.contains("grouped")).toBe(true);
  expect(host.querySelector<HTMLInputElement>('.size-slider input[type="range"]')?.value).toBe("0.8");
  expect(host.querySelector(".fit-toggle")?.classList.contains("on")).toBe(true);
});

it("폴더 리스트 크기 슬라이더가 공통 배율을 바꾸고 직계 파일도 같은 행 모양을 쓴다", async () => {
  mocks.assetTree.mockResolvedValue({ children: [folder("assets", [...tree[0].children!, file("assets/direct.png")])] });
  localStorage.setItem("ch.assets.folderLayout", "list");
  localStorage.setItem("ch.assets.folderScale", "0.7");
  localStorage.setItem("ch.assets.folderModePath", "P|assets");
  await mount();
  const grid = host.querySelector<HTMLDivElement>(".assets-folder-grid.list")!;
  expect(grid.style.getPropertyValue("--ep-scale")).toBe("0.7");
  const direct = host.querySelector('[data-file-path="assets/direct.png"]')!;
  expect(direct.classList.contains("assets-folder-card")).toBe(true);
  expect(direct.querySelector(".assets-folder-info strong")?.textContent).toBe("direct.png");
  const input = host.querySelector<HTMLInputElement>('.size-slider input[type="range"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "1.7");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
  expect(grid.style.getPropertyValue("--ep-scale")).toBe("1.7");
  expect(localStorage.getItem("ch.assets.folderScale")).toBe("1.7");
  expect(localStorage.getItem("ch.assets.scale")).not.toBe("1.7");
});

it("폴더 리스트의 경로 클릭과 Enter는 원본 위치만 열고 폴더/새 탭 동작은 실행하지 않는다", async () => {
  mocks.assetTree.mockResolvedValue({ children: [folder("assets", [...tree[0].children!, file("assets/direct.png")])] });
  localStorage.setItem("ch.assets.folderLayout", "list");
  localStorage.setItem("ch.assets.folderModePath", "P|assets");
  await mount();
  const folderPath = host.querySelector<HTMLButtonElement>('[data-folder-path="assets/CH"] .assets-source-path')!;
  expect(folderPath.closest(".ep-cover")).toBeNull();
  expect(folderPath.title).toBe("원본 위치 열기 (탐색기)");
  await click(folderPath);
  expect(mocks.revealAsset).toHaveBeenCalledExactlyOnceWith("P", "assets/CH");
  await act(async () => folderPath.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  expect(mocks.revealAsset).toHaveBeenCalledTimes(2);
  await act(async () => {
    folderPath.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true }));
    folderPath.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    folderPath.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
  });
  expect(mocks.revealAsset).toHaveBeenCalledTimes(2);
  expect(localStorage.getItem("ch.assets.dir")).toBe("assets");
  expect(host.querySelectorAll('[role="tab"]')).toHaveLength(1);
  expect(card("assets/CH").getAttribute("aria-pressed")).toBe("false");
  await click(host.querySelector('[data-file-path="assets/direct.png"] .assets-source-path')!);
  expect(mocks.revealAsset).toHaveBeenLastCalledWith("P", "assets/direct.png");
});

it("Assets 카드의 아래 띠는 직계 폴더마다 하나씩 이름·재귀 파일 수를 보여주고 작은 폴더를 바로 연다", async () => {
  mocks.assetTree.mockResolvedValue({ children: [folder("assets", [folder("assets/BG", [
    file("assets/BG/direct.png"), folder("assets/BG/동굴", [file("assets/BG/동굴/a.png")]),
    folder("assets/BG/바닷가", [file("assets/BG/바닷가/b.png"), folder("assets/BG/바닷가/v01", [file("assets/BG/바닷가/v01/c.png")])]),
    folder("assets/BG/바닷속", []),
  ])])] });
  await mount();
  const tiles = () => [...host.querySelectorAll('[data-folder-path="assets/BG"] .ep-cut:not(.more)')];
  expect(tiles().map((tile) => tile.querySelector('.ep-cut-name')?.textContent)).toEqual(["동굴", "바닷가", "바닷속"]);
  expect(tiles().map((tile) => tile.querySelector('.ep-cut-n')?.textContent)).toEqual(["1", "2", "0"]);
  expect(host.querySelector('[data-folder-path="assets/BG"] .ep-cut.more')).toBeNull();
  await search("b.png");
  expect(tiles().map((tile) => tile.querySelector('.ep-cut-n')?.textContent)).toEqual(["0", "1", "0"]);
  await search("");
  await middle(tiles()[1]);
  expect(localStorage.getItem("ch.assets.dir")).toBe("assets");
  expect(tab("바닷가").getAttribute("aria-selected")).toBe("false");
  await click(tab("바닷가"));
  expect(localStorage.getItem("ch.assets.dir")).toBe("assets/BG/바닷가");
  expect(tab("바닷가").getAttribute("aria-selected")).toBe("true");
  await click(tab("assets"));
  await click(tiles()[1]);
  expect(localStorage.getItem("ch.assets.dir")).toBe("assets/BG/바닷가");
});

it("하위 폴더가 많으면 공유 카드처럼 다섯 폴더와 남은 폴더 수를 표시하고 말단은 파일 미리보기를 유지한다", async () => {
  const children = Array.from({ length: 8 }, (_, i) => folder(`assets/BG/f${i}`, [file(`assets/BG/f${i}/a.png`), file(`assets/BG/f${i}/b.png`)]));
  mocks.assetTree.mockResolvedValue({ children: [folder("assets", [folder("assets/BG", children)])] });
  await mount();
  expect(host.querySelectorAll('[data-folder-path="assets/BG"] .ep-cut-name')).toHaveLength(5);
  expect(host.querySelector('[data-folder-path="assets/BG"] .ep-cut.more')?.textContent).toBe("+3");
  await click(host.querySelector('[data-folder-path="assets/BG"] .ep-cut.more')!);
  expect(localStorage.getItem("ch.assets.dir")).toBe("assets/BG");
  expect(host.querySelectorAll('[data-folder-path="assets/BG/f0"] .ep-cut')).toHaveLength(2);
  expect(host.querySelector('[data-folder-path="assets/BG/f0"] .ep-cut-name')).toBeNull();
});

it("폴더 카드에 기존 큰 분류명과 실제 직계 폴더·미디어 개수를 표시하고 검색에도 집계가 맞는다", async () => {
  mocks.assetTree.mockResolvedValue({ children: [folder("assets", [folder("assets/BG", [folder("assets/BG/바닷속", [
    file("assets/BG/바닷속/a.png"), { ...file("assets/BG/바닷속/b.mp4"), type: "video" },
    { ...file("assets/BG/바닷속/c.wav"), type: "audio" },
    folder("assets/BG/바닷속/v01", [file("assets/BG/바닷속/v01/d.png"),
      folder("assets/BG/바닷속/v01/deep", [{ ...file("assets/BG/바닷속/v01/deep/e.mp4"), type: "video" }]),
    ]), folder("assets/BG/바닷속/empty", []),
  ])])])] });
  localStorage.setItem("ch.assets.dir", "assets/BG");
  await mount();
  const cover = card("assets/BG/바닷속");
  expect(cover.querySelector('.ep-num')?.textContent).toBe("BG");
  expect(cover.querySelector('.ep-cap b')?.textContent).toBe("바닷속");
  expect(cover.querySelector('.ep-cap > span')?.textContent).toBe("폴더 2 · 5건 · 이미지 2 · 영상 2 · 오디오 1");
  expect(cover.getAttribute("aria-label")).toBe("BG 바닷속 폴더 열기. 폴더 2 · 5건 · 이미지 2 · 영상 2 · 오디오 1");
  await search(".mp4");
  expect(card("assets/BG/바닷속").querySelector('.ep-cap > span')?.textContent).toBe("폴더 2 · 2건 · 영상 2");
  expect(card("assets/BG/바닷속").getAttribute("aria-label")).toBe("BG 바닷속 폴더 열기. 폴더 2 · 2건 · 영상 2");
  await click(card("assets/BG/바닷속"));
  expect(localStorage.getItem("ch.assets.dir")).toBe("assets/BG");
  expect(card("assets/BG/바닷속").getAttribute('aria-pressed')).toBe("true");
});

it("분류는 Assets·제작 분류를 하위까지 유지하고 다른 등록 폴더를 Assets로 바꾸지 않는다", () => {
  const roots = [folder("assets", []), folder("assets/BG/바닷속", []), folder("assets/CH/미아/facial", []),
    folder("assets/PR/배", []), folder("assets/CLIP/e003", []), folder("assets/custom/source", []),
    folder("assets2/refs", []), folder("@md_master/ref", []), folder("assets\\ch\\미아", [])];
  expect(assetFolderGroups(roots, "", [], "P").groups.map((group) => group.category)).toEqual([
    "Assets", "BG", "CH", "PR", "CLIP", "Assets", "assets2", "@md_master", "CH",
  ]);
  expect(assetFolderGroups([folder("assets/BG/empty", [])], "", [], "P").groups[0]).toMatchObject({
    folderCount: 0, imageCount: 0, videoCount: 0, audioCount: 0,
  });
});

it("직접 파일과 하위 폴더가 섞이면 추가 클릭 없이 모두 펼치고 하위 파일만 이름표를 붙인다", async () => {
  mocks.assetTree.mockResolvedValue({ children: [folder("assets", [folder("assets/CH", [
    file("assets/CH/direct.png"), folder("assets/CH/미아", [file("assets/CH/미아/a.png"),
      folder("assets/CH/미아/facial", [folder("assets/CH/미아/facial/v01", [file("assets/CH/미아/facial/v01/face.png")])]),
    ]), folder("assets/CH/매튜", [file("assets/CH/매튜/b.png")]),
  ])])] });
  localStorage.setItem("ch.assets.dir", "assets/CH");
  localStorage.setItem("ch.assets.expanded", JSON.stringify(["assets", "assets/CH"]));
  await mount();
  expect(host.querySelectorAll(".asset-cell")).toHaveLength(4);
  expect(host.querySelector(".assets-folder-outside")).toBeNull();
  expect(host.querySelectorAll(".assets-folder-card")).toHaveLength(0);
  expect(host.querySelector('.lib-cut-seg button.on')?.textContent).toBe("전체");
  expect(host.querySelector<HTMLButtonElement>('.lib-cut-seg button')!.disabled).toBe(false);
  expect(host.querySelector('img[alt="direct.png"]')!.closest('.asset-media')!.querySelector('.card-folder')).toBeNull();
  const mia = Array.from(host.querySelectorAll(".folder-tree-row")).find((el) => el.getAttribute("title")?.startsWith("assets/CH/미아"))!;
  await click(mia);
  expect(host.querySelectorAll(".asset-cell")).toHaveLength(2);
  expect(Array.from(host.querySelectorAll(".card-folder.static")).map((el) => el.textContent)).toEqual(["facial / v01"]);
  await search("face.png");
  expect(host.querySelectorAll(".asset-cell")).toHaveLength(1);
  expect(host.querySelectorAll(".assets-folder-card")).toHaveLength(0);
  await backspace();
  expect(host.querySelectorAll(".asset-cell")).toHaveLength(4);
});

it("직접 파일이 있어도 폴더·전체 전환과 직접 파일 미리보기가 가능하고 탭별 선택을 보존한다", async () => {
  mocks.assetTree.mockResolvedValue({ children: [folder("assets", [folder("assets/CH", [
    file("assets/CH/direct.png"), folder("assets/CH/미아", [file("assets/CH/미아/a.png"),
      folder("assets/CH/미아/facial", [file("assets/CH/미아/facial/face.png")]),
    ]), folder("assets/CH/매튜", [file("assets/CH/매튜/b.png")]),
  ])])] });
  localStorage.setItem("ch.assets.dir", "assets/CH");
  const preview = vi.fn();
  await act(async () => root.render(<AssetsView onInfo={() => {}} onPreview={preview} />)); await settle();
  expect(host.querySelectorAll(".asset-cell")).toHaveLength(4);
  await click(host.querySelector('.lib-cut-seg button')!);
  expect(host.querySelectorAll(".assets-folder-card[data-folder-path]")).toHaveLength(2);
  expect(host.querySelector('.lib-cut-seg button.on')?.textContent).toBe("폴더");
  await click(host.querySelector('[data-file-path="assets/CH/direct.png"] button')!);
  expect(preview).toHaveBeenCalledOnce();
  expect(host.querySelector('[data-file-path="assets/CH/direct.png"] .asset-last-viewed')?.textContent).toBe("Last viewed");
  expect(new URL(preview.mock.calls[0][0].url, "http://test").searchParams.get("path")).toBe("assets/CH/direct.png");
  await middle(card("assets/CH/미아"));
  expect(tab("미아").getAttribute("aria-selected")).toBe("false");
  await click(tab("미아"));
  expect(tab("미아").getAttribute("aria-selected")).toBe("true");
  expect(host.querySelectorAll(".asset-cell")).toHaveLength(2);
  expect(host.querySelector('.lib-cut-seg button.on')?.textContent).toBe("전체");
  await click(tab("CH"));
  expect(host.querySelectorAll(".assets-folder-card[data-folder-path]")).toHaveLength(2);
  await search("direct.png");
  expect(host.querySelector('[data-file-path="assets/CH/direct.png"]')).not.toBeNull();
  expect(host.querySelector(".assets-empty")).toBeNull();
  await search("face.png");
  expect(host.querySelectorAll(".assets-folder-card[data-folder-path]")).toHaveLength(1);
  expect(host.querySelector('[data-file-path]')).toBeNull();
  await search("");
  await click(host.querySelectorAll('.lib-cut-seg button')[1]);
  expect(host.querySelectorAll(".asset-cell")).toHaveLength(4);
  expect(host.querySelectorAll(".assets-folder-card[data-folder-path]")).toHaveLength(0);
  await click(host.querySelector('.lib-cut-seg button')!);
  await doubleClick(card("assets/CH/미아"));
  expect(host.querySelectorAll(".asset-cell")).toHaveLength(2);
  await backspace();
  expect(host.querySelector('.lib-cut-seg button.on')?.textContent).toBe("폴더");
  act(() => root.unmount()); root = createRoot(host);
  await mount();
  expect(host.querySelectorAll(".assets-folder-card[data-folder-path]")).toHaveLength(2);
  expect(host.querySelector('.lib-cut-seg button.on')?.textContent).toBe("폴더");
});

it("폴더 카드는 클릭으로 선택하고 더블클릭·Enter로 열며 미들클릭은 배경 탭을 추가한다", async () => {
  mocks.assetTree.mockResolvedValue({ children: [folder("assets", tree[0].children!.filter((node) => node.type === "dir"))] });
  await mount();
  await click(card("assets/CH"));
  expect(localStorage.getItem("ch.assets.dir")).toBe("assets");
  expect(card("assets/CH").getAttribute("aria-pressed")).toBe("true");
  expect(card("assets/CH").closest(".assets-folder-card")!.classList.contains("sel")).toBe(true);
  await middle(card("assets/BG"));
  expect(tab("BG").getAttribute("aria-selected")).toBe("false");
  expect(localStorage.getItem("ch.assets.dir")).toBe("assets");
  expect(card("assets/CH").closest(".assets-folder-card")!.classList.contains("sel")).toBe(true);
  await click(tab("assets"));
  await doubleClick(card("assets/CH"));
  expect(localStorage.getItem("ch.assets.dir")).toBe("assets/CH");
  await act(async () => card("assets/CH/매튜").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  await settle();
  expect(localStorage.getItem("ch.assets.dir")).toBe("assets/CH/매튜");
});
const backspace = async (target: EventTarget = document.body, options: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true, ...options });
  await act(async () => target.dispatchEvent(event)); await settle();
  return event;
};
const pointer = (type: string, target: Element, init: MouseEventInit = {}) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
  Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
  act(() => { target.dispatchEvent(event); });
};
const tabNames = () => Array.from(host.querySelectorAll('[role="tab"]')).map((el) => el.querySelector(".scene-tab-name")?.textContent);
const measureTabs = () => host.querySelectorAll<HTMLElement>(".scene-tab-wrap").forEach((wrap) => {
  wrap.getBoundingClientRect = () => {
    const left = Array.from(host.querySelectorAll(".scene-tab-wrap")).indexOf(wrap) * 100;
    return { left, right: left + 100, top: 0, bottom: 30, width: 100, height: 30 } as DOMRect;
  };
});

it("캔버스처럼 탭을 끌어 앞·뒤로 옮겨도 활성 탭·검색·스크롤을 보존하고 놓기 클릭은 삼킨다", async () => {
  await mount(); await middle(card("assets/CH")); await click(tab("assets"));
  await middle(card("assets/BG")); await click(tab("assets"));
  await search("a.png");
  host.querySelector<HTMLDivElement>(".assets-folder-grid")!.scrollTop = 155;
  measureTabs();
  const bg = tab("BG");
  pointer("pointerdown", bg, { clientX: 250, clientY: 15 });
  pointer("pointermove", bg, { clientX: 20, clientY: 15, buttons: 1 });
  expect(host.querySelector(".scene-drop-line")).not.toBeNull();
  await backspace(); // 끌고 있는 동안 폴더 이동 금지
  expect(localStorage.getItem("ch.assets.dir")).toBe("assets");
  pointer("pointerup", bg, { clientX: 20, clientY: 15 });
  act(() => { bg.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  expect(tabNames()).toEqual(["BG", "assets", "CH"]);
  expect(tab("assets").getAttribute("aria-selected")).toBe("true");
  expect(host.querySelector<HTMLInputElement>('input[placeholder="Search"]')!.value).toBe("a.png");
  expect(host.querySelector<HTMLDivElement>(".assets-folder-grid")!.scrollTop).toBe(155);
  await click(bg); await click(tab("assets"));
  expect(host.querySelector<HTMLInputElement>('input[placeholder="Search"]')!.value).toBe("a.png");
  expect(host.querySelector<HTMLDivElement>(".assets-folder-grid")!.scrollTop).toBe(155);
  pointer("pointerdown", bg, { clientX: 50, clientY: 15 });
  pointer("pointermove", bg, { clientX: 330, clientY: 15, buttons: 1 });
  pointer("pointerup", bg, { clientX: 330, clientY: 15 });
  expect(tabNames()).toEqual(["assets", "CH", "BG"]);
  expect(tab("assets").getAttribute("aria-selected")).toBe("true");
});

it("탭 끌기를 Esc·포인터 유실·창 이탈로 취소하면 순서를 지키고 다음 클릭은 정상 동작한다", async () => {
  await mount(); await middle(card("assets/CH")); await click(tab("assets"));
  await middle(card("assets/BG")); await click(tab("assets")); measureTabs();
  for (const reason of ["Escape", "lostpointercapture", "pointercancel", "buttons", "blur"]) {
    const bg = tab("BG");
    pointer("pointerdown", bg, { clientX: 250, clientY: 15 });
    pointer("pointermove", bg, { clientX: 20, clientY: 15, buttons: 1 });
    act(() => {
      if (reason === "Escape") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      else if (reason === "blur") window.dispatchEvent(new Event("blur"));
      else if (reason === "buttons") pointer("pointermove", bg, { clientX: 20, buttons: 0 });
      else bg.dispatchEvent(new Event(reason, { bubbles: true }));
      // React가 다시 그리기 전의 늦은 move도 취소한 끌기를 되살리지 않는다.
      const move = new MouseEvent("pointermove", { bubbles: true, clientX: 30, buttons: 1 });
      Object.defineProperty(move, "pointerId", { value: 1 }); bg.dispatchEvent(move);
    });
    expect(host.querySelector(".scene-drop-line")).toBeNull();
    pointer("pointerup", bg, { clientX: 20 });
    act(() => { bg.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(tabNames()).toEqual(["assets", "CH", "BG"]);
    expect(tab("assets").getAttribute("aria-selected")).toBe("true");
  }
  const ch = tab("CH");
  pointer("pointerdown", ch, { clientX: 150, clientY: 15 });
  pointer("pointermove", ch, { clientX: 152, clientY: 15, buttons: 1 });
  expect(host.querySelector(".scene-drop-line")).toBeNull();
  pointer("pointerup", ch, { clientX: 152, clientY: 15 });
  await click(ch);
  expect(tab("CH").getAttribute("aria-selected")).toBe("true");
});

it("Backspace는 활성 탭만 상위 폴더로 이동하며 빈 폴더와 최상위에서도 안전하다", async () => {
  await mount();
  await middle(card("assets/BG"));
  await click(tab("assets"));
  await doubleClick(card("assets/CH"));
  await doubleClick(card("assets/CH/매튜"));
  expect((await backspace()).defaultPrevented).toBe(true);
  expect(localStorage.getItem("ch.assets.dir")).toBe("assets/CH");
  expect(tab("BG").getAttribute("aria-selected")).toBe("false");
  await backspace();
  expect(localStorage.getItem("ch.assets.dir")).toBe("assets");
  await backspace();
  expect(localStorage.getItem("ch.assets.dir")).toBe("");
  expect((await backspace()).defaultPrevented).toBe(false);
  await click(tab("BG"));
  expect(localStorage.getItem("ch.assets.dir")).toBe("assets/BG");
  mocks.assetTree.mockResolvedValue({ children: [folder("assets", [folder("assets/empty", [])])] });
  act(() => root.unmount()); root = createRoot(host);
  localStorage.setItem("ch.assets.dir", "assets/empty");
  await mount();
  expect(host.querySelectorAll(".asset-cell")).toHaveLength(0);
  await backspace();
  expect(localStorage.getItem("ch.assets.dir")).toBe("assets");
});

it("입력·조합·보조키·길게 누름·모달·이미 처리한 키는 폴더 이동으로 가져오지 않는다", async () => {
  await mount(); await doubleClick(card("assets/CH"));
  await search("a.png");
  expect((await backspace(host.querySelector('input[placeholder="Search"]')!)).defaultPrevented).toBe(false);
  for (const tag of ["textarea", "select", "div"]) {
    const input = document.createElement(tag);
    if (tag === "div") Object.defineProperty(input, "isContentEditable", { value: true });
    host.append(input);
    expect((await backspace(input)).defaultPrevented).toBe(false);
    input.remove();
  }
  for (const option of ["ctrlKey", "metaKey", "altKey", "shiftKey", "repeat", "isComposing"]) {
    await backspace(document.body, { [option]: true });
  }
  const layer = {};
  openLayer(layer, 1);
  try { await backspace(); } finally { closeLayer(layer); }
  const handled = (event: Event) => event.preventDefault();
  document.body.addEventListener("keydown", handled, { once: true });
  await backspace();
  expect(localStorage.getItem("ch.assets.dir")).toBe("assets/CH");
  expect(host.querySelector<HTMLInputElement>('input[placeholder="Search"]')!.value).toBe("a.png");
  await backspace();
  expect(localStorage.getItem("ch.assets.dir")).toBe("assets");
});

it("Backspace 이동도 보내지 않은 코멘트를 버릴지 확인하고 취소하면 그대로 남긴다", async () => {
  await mount(); await doubleClick(card("assets/CH")); await doubleClick(card("assets/CH/매튜"));
  await click(host.querySelector('.asset-cell button[title^="코멘트"]')!);
  const input = host.querySelector<HTMLInputElement>('input[name="c"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "작성 중");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  try {
    await backspace(input);
    expect(confirm).not.toHaveBeenCalled();
    input.blur();
    await backspace();
    expect(confirm).toHaveBeenCalledOnce();
    expect(localStorage.getItem("ch.assets.dir")).toBe("assets/CH/매튜");
    expect(input.value).toBe("작성 중");
    confirm.mockReturnValue(true);
    await backspace();
    expect(localStorage.getItem("ch.assets.dir")).toBe("assets/CH");
    expect(host.querySelector('input[name="c"]')).toBeNull();
  } finally { confirm.mockRestore(); }
});

it("직계 폴더에 하위 파일을 모으되 경로 경계·직접 파일·필터 결과를 보존한다", () => {
  const mixedTree = [folder("assets", [...tree[0].children!, file("assets/direct.png")]), tree[1]];
  const grouped = assetFolderGroups(mixedTree, "assets", flattenFiles(mixedTree), "P");
  expect(grouped.groups.map((g) => [g.folder.name, g.files.length])).toEqual([["CH", 3], ["BG", 1]]);
  expect(grouped.hasDirectFiles).toBe(true);
  expect(grouped.directFiles.map((f) => f.path)).toEqual(["assets/direct.png"]);
  const filtered = assetFolderGroups(tree, "assets/CH", [file("assets/CH/매튜/b.png")], "P");
  expect(filtered.groups.map((g) => g.files.map((f) => f.name))).toEqual([["b.png"], []]);
});

it("assets → CH는 폴더 카드, 말단은 파일, 전체 버튼은 하위 파일까지 표시한다", async () => {
  await mount();
  expect(host.querySelectorAll(".assets-folder-card")).toHaveLength(2);
  expect(host.querySelector(".assets-folder-outside")).toBeNull();
  await doubleClick(card("assets/CH"));
  expect(host.querySelectorAll(".assets-folder-card")).toHaveLength(2);
  await doubleClick(card("assets/CH/매튜"));
  expect(host.querySelectorAll(".asset-cell")).toHaveLength(2);
  const ch = Array.from(host.querySelectorAll(".folder-tree-row")).find((el) => el.getAttribute("title")?.startsWith("assets/CH"))!;
  await click(ch);
  const all = host.querySelectorAll('.lib-cut-seg button')[1];
  await click(all);
  expect(host.querySelectorAll(".asset-cell")).toHaveLength(3);
  expect(host.querySelectorAll(".assets-folder-card")).toHaveLength(0);
});

it("미들클릭은 새 탭만 추가하며 현재 검색·보기·스크롤과 기존 배경 탭을 보존한다", async () => {
  await mount();
  await doubleClick(card("assets/CH"));
  await search("a.png");
  const grid = host.querySelector<HTMLDivElement>(".assets-folder-grid")!;
  grid.scrollTop = 155;
  const row = Array.from(host.querySelectorAll(".folder-tree-row")).find((el) => el.getAttribute("title")?.startsWith("assets/BG"))!;
  await middle(row);
  expect(tab("CH").getAttribute("aria-selected")).toBe("true");
  expect(tab("BG").getAttribute("aria-selected")).toBe("false");
  await middle(row);
  expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2);
  expect(host.querySelector<HTMLInputElement>('[placeholder="Search"]')!.value).toBe("a.png");
  expect(host.querySelector(".assets-folder-grid")).toBe(grid);
  expect(grid.scrollTop).toBe(155);
  await click(tab("BG"));
  expect(host.querySelector<HTMLInputElement>('[placeholder="Search"]')!.value).toBe("");
  expect(host.querySelectorAll(".asset-cell")).toHaveLength(1);
  await click(host.querySelectorAll('.lib-cut-seg button')[1]);
  await click(tab("CH"));
  expect(host.querySelector<HTMLInputElement>('[placeholder="Search"]')!.value).toBe("a.png");
  expect(host.querySelector<HTMLDivElement>(".assets-folder-grid")!.scrollTop).toBe(155);
  expect(host.querySelector('.lib-cut-seg button.on')?.textContent).toBe("폴더");
  const existing = Array.from(host.querySelectorAll(".folder-tree-row")).find((el) => el.getAttribute("title")?.startsWith("assets/BG"))!;
  await middle(existing);
  expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2);
  expect(tab("CH").getAttribute("aria-selected")).toBe("true");
  expect(tab("BG").getAttribute("aria-selected")).toBe("false");
  expect(host.querySelector('.lib-cut-seg button.on')?.textContent).toBe("폴더");
  await click(tab("BG"));
  expect(host.querySelector('.lib-cut-seg button.on')?.textContent).toBe("전체");
  await click(host.querySelector('[aria-label="BG 탭 닫기"]')!);
  expect(host.querySelectorAll('[role="tab"]')).toHaveLength(1);
  await click(tab("CH"));
  expect(host.querySelector<HTMLInputElement>('[placeholder="Search"]')!.value).toBe("a.png");
  expect(host.querySelector<HTMLDivElement>(".assets-folder-grid")!.scrollTop).toBe(155);
  const lastClose = host.querySelector<HTMLButtonElement>(".scene-del")!;
  expect(lastClose.disabled).toBe(true);
  await click(lastClose);
  expect(host.querySelectorAll('[role="tab"]')).toHaveLength(1);
  expect(tab("CH").getAttribute("aria-selected")).toBe("true");
});

it("저장하지 않은 코멘트로 이동을 취소하면 활성 탭도 닫기 상태도 유지하며 범위 변경 시 탭을 비운다", async () => {
  let state: AssetFolderViewState = { dir: "assets", query: "", typeFilter: null, activeColors: new Set(), activeTags: new Set(),
    sourceOnly: false, commentOnly: false, grayOn: false, sortField: "name", sortDir: "asc", scale: 1,
    fit: "cover", layout: "grid", groupByDate: false, folderMode: true, scrollTop: 0 };
  let tabs!: ReturnType<typeof useAssetFolderTabs>;
  const leave = vi.fn(() => true), apply = vi.fn((view: AssetFolderViewState) => { state = view; });
  function Harness({ scope }: { scope: string }) {
    tabs = useAssetFolderTabs({ scope, read: () => state, apply, canLeave: leave }); return null;
  }
  act(() => root.render(<Harness scope="P" />));
  const original = tabs.active;
  act(() => tabs.open("assets/BG"));
  const second = tabs.tabs.find((tab) => tab.view.dir === "assets/BG")!.id;
  expect(second).not.toBe(original);
  act(() => tabs.select(original));
  apply.mockClear(); leave.mockReturnValue(false);
  act(() => tabs.open("assets/CH"));
  act(() => tabs.open("assets/BG"));
  act(() => tabs.select(second));
  act(() => tabs.close(original));
  expect(tabs.active).toBe(original); expect(tabs.tabs).toHaveLength(3); expect(apply).not.toHaveBeenCalled();
  leave.mockReturnValue(true);
  act(() => tabs.close(original));
  expect(tabs.active).toBe(second); expect(apply).toHaveBeenCalledOnce();
  state = { ...state, dir: "other" };
  act(() => root.render(<Harness scope="Q" />));
  expect(tabs.tabs.map((t) => t.view.dir)).toEqual(["other"]);
});

it("새 탭에서 보던 폴더·모드·스크롤은 창을 다시 열어도 복원된다", async () => {
  await mount();
  await middle(card("assets/CH"));
  expect(tab("CH").getAttribute("aria-selected")).toBe("false");
  await click(tab("CH"));
  expect(tab("CH").getAttribute("aria-selected")).toBe("true");
  await click(host.querySelectorAll('.lib-cut-seg button')[1]);
  const grid = host.querySelector<HTMLDivElement>(".assets-virtual")!;
  grid.scrollTop = 120;
  await act(async () => {
    grid.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 180));
  });
  act(() => root.unmount()); root = createRoot(host);
  await mount();
  expect(host.querySelectorAll('[role="tab"]')).toHaveLength(1);
  expect(tab("CH").getAttribute("aria-selected")).toBe("true");
  expect(host.querySelector('.lib-cut-seg button.on')?.textContent).toBe("전체");
  expect(host.querySelector<HTMLDivElement>(".assets-virtual")!.scrollTop).toBe(120);
});


it("폴더 이름표는 선택 폴더 아래 경로만 표시하고 Windows 구분자·비슷한 경로를 구분한다", () => {
  expect(assetFolderLabel("assets/CH/미아/facial/v01/a.png", "assets/CH/미아")).toBe("facial / v01");
  expect(assetFolderLabel("assets/CH/미아/a.png", "assets/CH/미아")).toBe("");
  expect(assetFolderLabel("assets2/a.png", "assets")).toBe("");
  expect(assetFolderLabel("a.png", "")).toBe("");
  expect(assetFolderLabel("assets/CH/미아/a.png", "")).toBe("assets / CH / 미아");
  expect(assetFolderLabel("assets\\CH\\미아\\facial\\v01\\a.png", "assets\\CH\\미아\\")).toBe("facial / v01");
});

it("전체 보기에서 하위 폴더 이름표가 상시 보이고 폴더 이동·목록 보기에도 범위가 맞는다", async () => {
  mocks.assetTree.mockResolvedValue({ children: [folder("assets", [folder("assets/CH", [folder("assets/CH/미아", [
    file("assets/CH/미아/direct.png"), folder("assets/CH/미아/facial", [folder("assets/CH/미아/facial/v01", [file("assets/CH/미아/facial/v01/face.png")])]),
  ])])])] });
  localStorage.setItem("ch.assets.dir", "assets/CH/미아");
  await mount();
  await click(host.querySelectorAll('.lib-cut-seg button')[1]);
  const labels = () => Array.from(host.querySelectorAll(".asset-media > .card-bottom .card-folder.static")).map((el) => el.textContent);
  expect(labels()).toEqual(["facial / v01"]);
  const image = host.querySelector('img[alt="face.png"]')!;
  expect(image.closest(".asset-media")!.getAttribute("title")).toContain("facial / v01");
  act(() => { image.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5 })); window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 })); });
  await click(image); // 이름표를 겹쳐도 기존 파일 선택 동작을 유지한다
  expect(image.closest(".asset-cell")!.classList.contains("selected")).toBe(true);
  await backspace();
  expect(labels()).toEqual(["미아", "미아 / facial / v01"]);
  const list = host.querySelector('[title="리스트"]');
  expect(list).not.toBeNull();
  await click(list!);
  expect(host.querySelectorAll(".asset-cell.list")).toHaveLength(2);
  expect(labels()).toEqual(["미아", "미아 / facial / v01"]);
});

it.each(["grid", "list"] as const)("어셋 %s 카드의 표지·제목·정보·빈 영역 미들클릭은 같은 폴더 탭을 한 번만 연다", async (layout) => {
  const onOpenTab = vi.fn(), onEnter = vi.fn(), onPreview = vi.fn();
  const grouped = assetFolderGroups(tree, "assets", flattenFiles(tree), "P");
  await act(async () => root.render(<AssetFolderGrid project="P" {...grouped} scale={1} fit="cover" layout={layout}
    scrollRef={null} onScroll={() => {}} onEnter={onEnter} onOpenTab={onOpenTab} onPreview={onPreview} />));
  const article = host.querySelector('[data-folder-path="assets/CH"]')!;
  const targets = [article, article.querySelector(".ep-cover")!, article.querySelector(".ep-num")!, article.querySelector(".ep-strip")!];
  if (layout === "list") targets.push(article.querySelector(".assets-folder-info strong")!, article.querySelector(".assets-folder-info > span")!);
  for (const target of targets) {
    onOpenTab.mockClear();
    const down = new MouseEvent("mousedown", { button: 1, bubbles: true, cancelable: true });
    const auxiliary = new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true });
    await act(async () => { target.dispatchEvent(down); target.dispatchEvent(auxiliary); });
    expect(down.defaultPrevented).toBe(true);
    expect(auxiliary.defaultPrevented).toBe(true);
    expect(onOpenTab).toHaveBeenCalledExactlyOnceWith("assets/CH");
    expect(article.querySelector(".ep-cover")?.getAttribute("aria-pressed")).toBe("false");
  }
  onOpenTab.mockClear();
  await act(async () => article.dispatchEvent(new MouseEvent("auxclick", { button: 2, bubbles: true })));
  expect(onOpenTab).not.toHaveBeenCalled();
  expect(onEnter).not.toHaveBeenCalled();
  expect(onPreview).not.toHaveBeenCalled();
});

it("카드 전체 미들클릭을 지원해도 작은 폴더·파일·더보기·원본 경로 버튼의 동작은 섞이지 않는다", async () => {
  const nested = [folder("assets", [folder("assets/CH", Array.from({ length: 6 }, (_, i) =>
    folder(`assets/CH/c${i}`, [file(`assets/CH/c${i}/a.png`)]))), folder("assets/BG", [file("assets/BG/a.png")]), file("assets/direct.png")])];
  const grouped = assetFolderGroups(nested, "assets", flattenFiles(nested), "P");
  const onOpenTab = vi.fn(), onEnter = vi.fn(), onPreview = vi.fn();
  await act(async () => root.render(<AssetFolderGrid project="P" {...grouped} scale={1} fit="cover" layout="list"
    scrollRef={null} onScroll={() => {}} onEnter={onEnter} onOpenTab={onOpenTab} onPreview={onPreview} />));
  const child = host.querySelector('[data-folder-path="assets/CH"] .ep-cut:not(.more)')!;
  await middle(child.querySelector("img")!);
  expect(onOpenTab).toHaveBeenCalledExactlyOnceWith("assets/CH/c0");
  onOpenTab.mockClear();
  const preview = host.querySelector('[data-folder-path="assets/BG"] .ep-cut')!;
  const more = host.querySelector('[data-folder-path="assets/CH"] .ep-cut.more')!;
  const path = host.querySelector('[data-folder-path="assets/BG"] .assets-source-path')!;
  const direct = host.querySelector('[data-file-path="assets/direct.png"] .ep-cover')!;
  await middle(preview); await middle(more); await middle(path); await middle(direct);
  expect(onOpenTab).not.toHaveBeenCalled();
  expect(onEnter).not.toHaveBeenCalled();
  expect(onPreview).not.toHaveBeenCalled();
  expect(mocks.revealAsset).not.toHaveBeenCalled();
  await click(child); await click(more); await click(preview); await click(path); await click(direct);
  expect(onEnter.mock.calls.map(([value]) => value)).toEqual(["assets/CH/c0", "assets/CH"]);
  expect(onPreview.mock.calls.map(([value]) => value.path)).toEqual(["assets/BG/a.png", "assets/direct.png"]);
  expect(mocks.revealAsset).toHaveBeenCalledExactlyOnceWith("P", "assets/BG");
  expect(onOpenTab).not.toHaveBeenCalled();
});
