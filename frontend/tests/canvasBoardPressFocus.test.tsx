// @vitest-environment jsdom
// 보드 누름의 초점 처리(SceneBoard onBoardMouseDownCapture) — Jay 2026-11-18.
//  편집칸 안의 알약(contentEditable=false)을 누른 것도 칸 안의 누름이다 — 보드가 칸을 blur 해 편집이 끝나면 알약을 글자로 풀 수 없다.
//  ('생성 결과' 창의 Draft 화질 메뉴 — 포털 누름에 초점을 가져가지 않는 쪽은 sceneVariantWindow.test.tsx)
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneBoard } from "../src/components/scene/SceneBoard";
import type { Scene, SceneCard } from "../src/lib/scenes";
import type { SceneGenDataApi } from "../src/lib/useSceneGenData";

const fixture = vi.hoisted(() => ({ data: null as unknown as SceneGenDataApi }));
vi.mock("../src/lib/useSceneGenData", () => ({ useSceneGenData: () => fixture.data }));

// jsdom 에는 isContentEditable 이 없다 — 브라우저 규칙대로(가장 가까운 contenteditable 값이 false 가 아니면 편집 가능) 이 시험에서만 채운다
const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "isContentEditable");
let host: HTMLDivElement;
let root: Root;
const noop = () => {};
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
    configurable: true,
    get(this: HTMLElement) {
      const owner = this.closest("[contenteditable]");
      return !!owner && owner.getAttribute("contenteditable") !== "false";
    },
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("requestAnimationFrame", () => 0); vi.stubGlobal("cancelAnimationFrame", noop);
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network"))));
  localStorage.clear(); sessionStorage.clear();
  fixture.data = { genData: {}, genDataRef: { current: {} }, setGenData: noop, missingIds: new Set(), disabledIds: new Set(), refParents: {},
    colors: { begin: () => null, end: noop, isLive: () => false, currentIds: () => [], applyRecovered: () => [] } } as unknown as SceneGenDataApi;
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (original) Object.defineProperty(HTMLElement.prototype, "isContentEditable", original);
  else delete (HTMLElement.prototype as { isContentEditable?: boolean }).isContentEditable;
});

it("텍스트 편집칸의 알약을 누르면 편집이 이어지고 그 알약이 글자로 풀린다 — 보드가 칸을 blur 하지 않는다", async () => {
  const cards = [
    { id: "ref", kind: "reference", x: 0, y: 0, refs: [{ type: "image", file_path: "/fixtures/ref.png", name: "ref.png" }] },
    { id: "txt", kind: "text", x: 400, y: 0, text: "@image1 가 달린다" },
  ] as SceneCard[];
  const scene = { id: "press", name: "S", created_at: 0, cards, edges: [{ id: "e", from: "ref", to: "txt" }] } as Scene;
  await act(async () => { root.render(<SceneBoard scene={scene} onChange={noop} />); });
  const view = host.querySelector<HTMLElement>('.scene-card[data-id="txt"] .scene-textview-inline')!;
  expect(view.querySelector(".scene-inlinetok"), "보기 칸 알약").toBeTruthy();
  await act(async () => { view.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  const editor = host.querySelector<HTMLElement>(".scene-textedit")!;
  expect(editor, "편집칸").toBeTruthy();
  expect(document.activeElement).toBe(editor);
  const pill = editor.querySelector<HTMLElement>("[data-tok]")!;
  expect(pill, "편집칸 알약").toBeTruthy();
  await act(async () => {
    pill.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    pill.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
  const still = host.querySelector<HTMLElement>(".scene-textedit");
  expect(still, "편집이 이어진다").toBe(editor);
  expect(editor.querySelector("[data-tok]"), "누른 알약은 글자로").toBeNull();
  expect(editor.textContent).toContain("@image1");
});
