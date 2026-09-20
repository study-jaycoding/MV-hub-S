// @vitest-environment jsdom
// 정보 팝업이 화면 아래로 나가던 것(2026-09-20 실측: 1664×905 에서 아래쪽 줄 카드를 열면 210px 이 화면 밖, 단추 8개 중 4개가 안 보임).
// 시작 위치는 높이를 모른 채 top 만 막는데(아래 200px) 팝업은 80vh 까지 자란다 — 넘친 만큼 올리고, 사용자가 끌어 옮긴 뒤에는 건드리지 않는다.
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InfoPopup } from "../src/components/InfoPopup";
import type { AssetMeta, AssetNode } from "../src/types";

vi.mock("../src/api", () => ({ api: { assetFileUrl: () => "/fixture.png", assetThumbUrl: () => "/fixture-thumb.png", revealAsset: vi.fn() } }));
vi.mock("../src/lib/modelCatalog", () => ({ useModelDisplayName: () => (name: string) => name }));
const node: AssetNode = { name: "fixture.png", path: "folder/fixture.png", type: "image" };
const meta: AssetMeta = { is_source: false, source_name: null, tags: [], comment: null, color: null, comment_count: 0, has_unread: false };
let popupHeight = 600;
let root: Root, host: HTMLDivElement, resized: (() => void) | null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.assign(window, { innerWidth: 1600, innerHeight: 900 });
  resized = null;
  popupHeight = 600;
  vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { resized = cb; } observe() {} disconnect() {} });
  // jsdom 은 배치를 하지 않는다 — 팝업의 상자를 style.top + 고정 높이로 흉내 낸다.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const top = this.classList.contains("info-popup") ? parseFloat(this.style.top) || 0 : 0;
    return { top, bottom: top + popupHeight, left: 0, right: 380, width: 380, height: popupHeight, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const open = (y: number) => {
  // 앱 루트와 같은 StrictMode — effect 가 두 번 돌아도 한 번만 올라가야 한다
  act(() => root.render(<StrictMode><InfoPopup target={{ kind: "file", project: "fixture", node, meta, x: 400, y }} onClose={() => {}} onPreview={() => {}} /></StrictMode>));
  return host.querySelector<HTMLDivElement>(".info-popup")!;
};

it("아래쪽에서 열면 넘친 만큼 올라가 화면 안에 들어온다", () => {
  const popup = open(800); // 시작 top = min(808, 900-200) = 700 → 바닥 1300
  expect(parseFloat(popup.style.top)).toBe(900 - 8 - 600); // 두 번 올라가면 이보다 작아진다
});

it("위쪽에서 열면 그대로다", () => {
  expect(open(100).style.top).toBe("108px");
});

it("열린 뒤 내용이 늘어 넘쳐도 다시 올린다", () => {
  const popup = open(400); // top 408 · 높이 600 → 바닥 1008 → 292 로 올라간다
  expect(popup.style.top).toBe("292px");
  popupHeight = 700; // 견적·썸네일이 늦게 채워져 커졌다
  act(() => resized?.());
  expect(popup.style.top).toBe("192px"); // 900 - 8 - 700
});

it("사용자가 끌어 옮긴 뒤에는 자동으로 올리지 않는다", () => {
  const popup = open(100);
  const head = popup.querySelector<HTMLElement>(".info-head")!;
  act(() => { head.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 500, clientY: 120 })); });
  act(() => { window.dispatchEvent(new MouseEvent("pointermove", { clientX: 500, clientY: 720 })); }); // 아래로 600px
  act(() => { window.dispatchEvent(new MouseEvent("pointerup", {})); });
  const dragged = popup.style.top;
  expect(parseFloat(dragged)).toBeGreaterThan(600);
  act(() => resized?.());
  expect(popup.style.top).toBe(dragged);
});
