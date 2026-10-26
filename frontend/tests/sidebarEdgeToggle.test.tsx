// @vitest-environment jsdom
// 사이드바 열고 닫기 = 끝선 손잡이(Jay 2026-10-26 시안 C) — 도구 줄(워크스페이스·공유 & 리뷰·캔버스)과 어셋 창의 폴더 트리.
// jsdom 은 자리를 재지 못한다 — 끝선 위 가운데·창 왼쪽 끝 자리는 격리 서버 화면 실측으로 본다(docs/status/사이드바_경계선_손잡이_2026-10-26.md).
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AssetNode } from "../src/types";

const mocks = vi.hoisted(() => ({ assetProjects: vi.fn(), assetTree: vi.fn(), assetMeta: vi.fn() }));
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
import { LibraryToolbar } from "../src/components/LibraryToolbar";

const noop = () => {};
const TOOLBAR: ComponentProps<typeof LibraryToolbar> = {
  typeFilter: "all", onTypeFilter: noop, scale: 1, onScale: noop, fill: true, onToggleFill: noop,
  layout: "grid", onLayout: noop, groupByDate: false, onToggleGroupByDate: noop,
  filtersOpen: true, onToggleFilters: noop, count: 4, loading: false, failedCount: 0, onClearFailed: noop,
  colorDots: [], colorFilter: new Set(), onToggleColor: noop, sharedOnly: false, onToggleShared: noop,
  commentOnly: false, onToggleComment: noop, hasUnread: false,
  tags: [], tagFilter: new Set(), onSelectTag: noop, onDeleteTag: noop, onClearTags: noop,
  tagPanelOpen: false, onToggleTagPanel: noop,
};
const file = (path: string): AssetNode => ({ name: path.split("/").pop()!, path, type: "image" });
const folder = (path: string, children: AssetNode[]): AssetNode => ({ name: path.split("/").pop()!, path, type: "dir", children });

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  localStorage.clear();
  mocks.assetProjects.mockResolvedValue({ projects: ["P"], linked: [], default: "P" });
  mocks.assetTree.mockResolvedValue({ children: [folder("assets", [file("assets/a.png")])] });
  mocks.assetMeta.mockResolvedValue({});
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const click = async (el: Element) => { await act(async () => el.dispatchEvent(new MouseEvent("click", { bubbles: true }))); await settle(); };
const look = (el: Element | null) => el && [el.classList.contains("open"), el.getAttribute("title"), el.getAttribute("aria-expanded"),
  el.querySelector("path")?.getAttribute("d")?.startsWith("M14.5") ? "‹" : "›"];

it("도구 줄: 열림 = 끝선 위 동그라미 ‹ · 닫힘 = 반달 › — 누르면 여닫기, 옛 ▢/▷ 단추는 없다", async () => {
  const toggle = vi.fn();
  await act(async () => root.render(<LibraryToolbar {...TOOLBAR} onToggleFilters={toggle} />));
  const edge = () => host.querySelector(".lib-toolbar > .side-edge-toggle");
  expect(look(edge())).toEqual([true, "필터 사이드바 닫기", "true", "‹"]);
  expect(host.querySelector(".lib-filter-ic")).toBeNull();
  await click(edge()!);
  expect(toggle).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<LibraryToolbar {...TOOLBAR} filtersOpen={false} onToggleFilters={toggle} />));
  expect(look(edge())).toEqual([false, "필터 사이드바 열기", "false", "›"]);
});

it("떠 있는 창의 도구 줄(showFilterToggle:false)·보드에는 손잡이가 없고, 캔버스는 켜서 쓴다", async () => {
  await act(async () => root.render(<LibraryToolbar {...TOOLBAR} showFilterToggle={false} />));
  expect(host.querySelector(".side-edge-toggle")).toBeNull();
  await act(async () => root.render(<LibraryToolbar {...TOOLBAR} boardMode />));
  expect(host.querySelector(".side-edge-toggle")).toBeNull();
  await act(async () => root.render(<LibraryToolbar {...TOOLBAR} boardMode showFilterToggle />));
  expect(host.querySelector(".side-edge-toggle")).not.toBeNull();
});

it("어셋 창: 같은 손잡이로 왼쪽 폴더 트리를 여닫고, 이 창만의 기억으로 다시 열어도 그대로", async () => {
  const mount = async () => { await act(async () => root.render(<AssetsView onInfo={noop} onPreview={noop} />)); await settle(); };
  const edge = () => host.querySelector(".assets-grid-wrap > .side-edge-toggle");
  await mount();
  expect(host.querySelector(".assets-tree")).not.toBeNull(); // 처음엔 열림
  expect(look(edge())).toEqual([true, "폴더 사이드바 닫기", "true", "‹"]);
  await click(edge()!);
  expect(host.querySelector(".assets-tree")).toBeNull();
  expect(look(edge())).toEqual([false, "폴더 사이드바 열기", "false", "›"]);
  expect(localStorage.getItem("ch.assets.treeOpen")).toBe("0");
  act(() => root.unmount()); root = createRoot(host);
  await mount();
  expect(host.querySelector(".assets-tree")).toBeNull();
  await click(edge()!);
  expect(host.querySelector(".assets-tree")).not.toBeNull();
  expect(localStorage.getItem("ch.assets.treeOpen")).toBe("1");
});
