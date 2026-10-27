// @vitest-environment jsdom
// 뷰어와 타임라인 사이 손잡이(Jay 2026-10-23, 다빈치처럼): 위로 끌면 타임라인 칸이 커지고 아래로 끌면 작아진다(120px ~ 위쪽 160px·막대 44px 를
//  남긴 높이) · 놓으면 이 브라우저에 기억 · 더블클릭 = 기본 · Tab 으로 온 손잡이의 ↑↓ = 16px. jsdom 은 배치가 없어 높이를 흉내 낸다
//  (편집 화면 900px, 타임라인 칸 300px).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditCardMenu } from "../src/components/timeline/EditTab";
import type { EditTree } from "../src/lib/useEditSequence";

vi.mock("../src/lib/resolveTransfer", async () => ({
  ...(await vi.importActual<typeof import("../src/lib/resolveTransfer")>("../src/lib/resolveTransfer")),
  getResolveConnectionStatus: () => Promise.reject(new Error("안 물었다")),
}));
vi.mock("../src/lib/useEditSequence", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/useEditSequence")>("../src/lib/useEditSequence");
  const counts = { final: 0, held: 0, shared: 0 };
  const tree = { state: "ready", complete: true, note: null, roots: [{
    name: "e070", path: "e070", count: 0, newCount: 0, reviewCounts: counts, children: ["c1", "c2"].map((name) => (
      { name, path: `e070/${name}`, count: 0, newCount: 0, reviewCounts: counts })) }] } as unknown as EditTree;
  return {
    ...actual,
    useEditProjects: () => ({
      projects: [{ id: "p1", name: "P1" }], projectsState: "ok", tree, reload: () => {},
      reloadCounts: () => {}, reloadFresh: () => {}, freshByProject: {},
    }),
    useEditGenerations: () => ({ state: "ok", gens: [], error: null, complete: true, known: true, reload: () => {}, reloadIds: () => {} }),
  };
});
vi.mock("../src/lib/useDisabledFolders", () => ({ useDisabledFolders: () => ({}) }));

import { EditTab } from "../src/components/timeline/EditTab";

const KEY = "ch.editTimeline.tlHeight";
let host: HTMLDivElement;
let root: Root;
const cardMenuRef: { current: EditCardMenu | null } = { current: null };
const edRoot = () => document.querySelector<HTMLElement>(".ed-root")!;
const split = () => document.querySelector<HTMLElement>(".ed-split")!;
const tlVar = () => edRoot().style.getPropertyValue("--ed-tl-h");
const pointer = (type: string, clientY: number) => act(() => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, clientY });
  Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
  split().dispatchEvent(event);
});
const mount = () => {
  act(() => root.render(
    <EditTab authKey="auth" authReady workspace={{ scope: "team", id: "w1", name: "W" }} keysActive
      flash={() => {}} onOpenCutFolder={() => {}} reloadSignal={0}
      peekPath={null} onPeekMarks={() => {}} cardMenuRef={cardMenuRef} onPreview={() => {}} onCompare={() => {}}
      resolve={{ send: () => {}, sendTimeline: () => new Promise<never>(() => {}), busy: false, pendingCount: 0, timelineBusy: false }}
      onFolderAction={() => {}} />,
  ));
  Object.defineProperty(edRoot(), "clientHeight", { configurable: true, get: () => 900 });
  Object.defineProperty(document.querySelector(".ed-tl")!, "offsetHeight", { configurable: true, get: () => 300 });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem("ch.editTimeline.last:local", JSON.stringify({ projectId: "p1", seq: "e070" }));
  for (const method of ["load", "pause"] as const) vi.spyOn(HTMLMediaElement.prototype, method).mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  Object.assign(Element.prototype, { setPointerCapture() {}, hasPointerCapture: () => false, releasePointerCapture() {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("손잡이를 위로 끌면 타임라인 칸이 커지고, 놓으면 기억해 다시 열어도 그 높이다", () => {
  mount();
  expect(tlVar()).toBe(""); // 처음 = CSS 기본(40%)
  pointer("pointerdown", 500);
  pointer("pointermove", 400); // 100px 위로
  expect(tlVar()).toBe("400px");
  expect(localStorage.getItem(KEY)).toBeNull(); // 끄는 동안은 적지 않는다
  pointer("pointerup", 400);
  expect(tlVar()).toBe("400px");
  expect(JSON.parse(localStorage.getItem(KEY)!)).toBe(400);
  act(() => root.unmount());
  root = createRoot(host);
  mount();
  expect(tlVar()).toBe("400px");
});

it("한계 — 아래로는 120px, 위로는 위쪽 160px·막대 44px 를 남긴 696px 까지", () => {
  mount();
  pointer("pointerdown", 500);
  pointer("pointermove", 2000);
  expect(tlVar()).toBe("120px");
  pointer("pointermove", -2000);
  expect(tlVar()).toBe("696px"); // 900 − 44 − 160
  pointer("pointerup", -2000);
  expect(JSON.parse(localStorage.getItem(KEY)!)).toBe(696);
});

it("더블클릭하면 기본 높이로 돌아가고 기억을 지운다 · 놓지 않고 취소하면 끌기 전 그대로", () => {
  localStorage.setItem(KEY, "350");
  mount();
  expect(tlVar()).toBe("350px");
  pointer("pointerdown", 500);
  pointer("pointermove", 450);
  pointer("pointercancel", 450);
  expect(tlVar()).toBe("350px");
  act(() => { split().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); });
  expect(tlVar()).toBe("");
  expect(localStorage.getItem(KEY)).toBeNull();
});

it("Tab 으로 온 손잡이의 ↑↓ 는 칸 높이를 16px 씩 바꾸고 편집 화면의 키로 가지 않는다", () => {
  mount();
  act(() => split().focus());
  const up = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
  act(() => { split().dispatchEvent(up); });
  expect(up.defaultPrevented).toBe(true);
  expect(tlVar()).toBe("316px");
  expect(JSON.parse(localStorage.getItem(KEY)!)).toBe(316);
});
