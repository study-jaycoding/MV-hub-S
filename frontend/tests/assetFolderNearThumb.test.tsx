// @vitest-environment jsdom
// 어셋 폴더 카드 — 폴더가 많으면 먼 카드의 썸네일은 가까워질 때 붙인다(설계 docs/status/격자지연_폴더카드_가상목록_설계_2026-11-10.md v3.1 시험 ①~⑨).
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AssetNode } from "../src/types";

vi.mock("../src/api", () => ({ api: new Proxy({
  assetThumbUrl: (_project: string, path: string) => `/thumbs/${path}`,
}, { get: (target, name: string) => target[name as keyof typeof target] ?? (() => new Promise(() => {})) }) }));
import { AssetFolderGrid } from "../src/components/assets/AssetFolderGrid";
import { assetFolderGroups } from "../src/components/assets/assetFolderGroups";
import { flattenFiles } from "../src/components/assets/treeUtils";

// 관찰자를 손으로 부른다 — 브라우저처럼 observe 한 카드에 대해서만 '들어옴/나감'을 알린다
class FakeIO {
  static all: FakeIO[] = [];
  observed = new Set<Element>();
  disconnected = false;
  constructor(public cb: IntersectionObserverCallback, public options?: IntersectionObserverInit) { FakeIO.all.push(this); }
  observe(el: Element) { this.observed.add(el); }
  unobserve(el: Element) { this.observed.delete(el); }
  disconnect() { this.disconnected = true; this.observed.clear(); }
  takeRecords() { return []; }
}
const live = () => FakeIO.all.filter((io) => !io.disconnected).at(-1)!;

const file = (path: string): AssetNode => ({ name: path.split("/").pop()!, path, type: "image" });
const folder = (path: string, children: AssetNode[]): AssetNode => ({ name: path.split("/").pop()!, path, type: "dir", children });
const name = (i: number) => `assets/f${String(i).padStart(3, "0")}`;
// 말단 폴더 n 개(각 그림 files 장) — 카드마다 표지 1 + 띠(파일 미리보기) files 장
const leaves = (n: number, files = 2, extra: Record<number, number> = {}) =>
  [folder("assets", Array.from({ length: n }, (_, i) => folder(name(i), Array.from({ length: extra[i] ?? files }, (__, k) => file(`${name(i)}/p${k}.png`)))))];
// 하위 폴더를 가진 폴더 n 개 — 띠가 작은 폴더 단추(미들클릭 = 새 탭)
const nested = (n: number) => [folder("assets", Array.from({ length: n }, (_, i) => folder(name(i), [0, 1].map((c) =>
  folder(`${name(i)}/c${c}`, [file(`${name(i)}/c${c}/a.png`)])))))];

let host: HTMLDivElement, root: Root;
const ref = createRef<HTMLDivElement>();
const onEnter = vi.fn(), onOpenTab = vi.fn(), onPreview = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", FakeIO);
  FakeIO.all = [];
  onEnter.mockReset(); onOpenTab.mockReset(); onPreview.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const draw = async (tree: AssetNode[], layout: "grid" | "list" | "table" = "grid") => {
  const grouped = assetFolderGroups(tree, "assets", flattenFiles(tree), "P");
  await act(async () => root.render(<AssetFolderGrid project="P" {...grouped} scale={1} fit="cover" layout={layout}
    scrollRef={ref} onScroll={() => {}} onEnter={onEnter} onOpenTab={onOpenTab} onPreview={onPreview} />));
  await settle();
};
const card = (i: number) => host.querySelector(`[data-folder-path="${name(i)}"]`)!;
const imgs = (el: ParentNode = host) => el.querySelectorAll("img").length;
const enter = async (el: Element, on = true) => {
  await act(async () => live().cb([{ target: el, isIntersecting: on } as unknown as IntersectionObserverEntry], live() as unknown as IntersectionObserver));
  await settle();
};

it("① 문턱(48)을 넘는 폴더는 처음에 썸네일 대신 빈 자리 — 카드·이름 단추는 모두 있다 ② 들어온 카드만 표지·띠가 붙는다 ③ 나가도 떼지 않는다", async () => {
  await draw(leaves(60));
  expect(host.querySelectorAll(".assets-folder-card")).toHaveLength(60);
  expect(host.querySelectorAll(".ep-cover[aria-label]")).toHaveLength(60);
  expect(imgs()).toBe(0);
  expect(card(5).querySelectorAll(".assets-folder-placeholder")).toHaveLength(3); // 표지 1 + 띠 2
  expect(live().observed.has(card(5))).toBe(true);
  await enter(card(5));
  expect(imgs(card(5))).toBe(3);
  expect(imgs()).toBe(3);
  expect(card(5).querySelector(".ep-cover > img")).not.toBeNull(); // 감싸는 요소 없이 단추의 직계 자식
  expect(live().observed.has(card(5))).toBe(false); // 켜진 카드는 관찰을 푼다
  await enter(card(5), false);
  expect(imgs(card(5))).toBe(3);
});

it("④ 문턱 이하이거나 관찰자가 없는 환경이면 지금처럼 바로 그린다", async () => {
  await draw(leaves(48));
  expect(imgs()).toBe(48 * 3);
  act(() => root.unmount()); root = createRoot(host);
  vi.stubGlobal("IntersectionObserver", undefined);
  await draw(leaves(60));
  expect(imgs()).toBe(60 * 3);
});

it("⑤ 언마운트하면 관찰자를 끊는다", async () => {
  await draw(leaves(60));
  expect(FakeIO.all.some((io) => !io.disconnected)).toBe(true);
  act(() => root.unmount()); root = createRoot(host);
  expect(FakeIO.all.every((io) => io.disconnected)).toBe(true);
});

it("⑥ 켜진 카드에 띠 썸네일이 새로 붙으면 바로 보이고, 일부가 떨어져도 남은 것은 그대로다", async () => {
  await draw(leaves(60));
  await enter(card(7));
  expect(imgs(card(7))).toBe(3);
  await draw(leaves(60, 2, { 7: 3 })); // 검색·트리 갱신으로 같은 카드의 띠가 한 장 늘었다
  expect(imgs(card(7))).toBe(4);
  await draw(leaves(60, 2, { 7: 1 }));
  expect(imgs(card(7))).toBe(2);
  expect(imgs()).toBe(2); // 다른 카드는 여전히 빈 자리
});

it("⑦ 49 → 48 → 49 — 48 에서 모두 켜지고, 다시 49 로 늘어도 켜진 것은 꺼지지 않는다", async () => {
  await draw(leaves(49));
  expect(imgs()).toBe(0);
  await draw(leaves(48));
  expect(imgs()).toBe(48 * 3);
  await draw(leaves(49));
  expect(imgs()).toBe(48 * 3); // 새로 생긴 49번째만 빈 자리
  expect(card(48).querySelectorAll(".assets-folder-placeholder")).toHaveLength(3);
  // 직접 파일이 섞여도 항목 수(폴더 + 직접 파일)로 센다
  act(() => root.unmount()); root = createRoot(host);
  const mixed = leaves(46);
  mixed[0].children!.push(file("assets/d0.png"), file("assets/d1.png"), file("assets/d2.png")); // 46 + 3 = 49
  await draw(mixed);
  expect(imgs()).toBe(0);
});

it("⑧ 그리드 → 표 → 그리드로 바꾸면 새 스크롤 상자로 다시 관찰한다", async () => {
  await draw(leaves(60));
  const first = live();
  expect(first.options?.root).toBe(ref.current);
  await draw(leaves(60), "table");
  expect(first.disconnected).toBe(true);
  await draw(leaves(60), "grid");
  const again = live();
  expect(again).not.toBe(first);
  expect(again.options?.root).toBe(ref.current);
  expect(again.observed.size).toBe(60);
  await enter(card(3));
  expect(imgs(card(3))).toBe(3);
});

it("⑨ 빈 자리·그림 어느 쪽을 미들클릭해도 같은 작은 폴더를 새 탭으로 열고, 붙기 전후 초점은 같은 단추에 남으며 그림은 끌리지 않는다", async () => {
  await draw(nested(60));
  const middle = async (el: Element) => { await act(async () => el.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }))); await settle(); };
  const strip = () => card(2).querySelector(".ep-cut:not(.more)")!;
  await middle(strip().querySelector(".assets-folder-placeholder")!);
  expect(onOpenTab).toHaveBeenLastCalledWith(`${name(2)}/c0`);
  const cover = card(2).querySelector<HTMLButtonElement>(".ep-cover")!;
  cover.focus();
  await enter(card(2));
  expect(document.activeElement).toBe(cover);
  const img = strip().querySelector("img")!;
  expect(img.getAttribute("draggable")).toBe("false");
  onOpenTab.mockClear();
  await middle(img);
  expect(onOpenTab).toHaveBeenLastCalledWith(`${name(2)}/c0`);
});
