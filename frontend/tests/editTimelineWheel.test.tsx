// @vitest-environment jsdom
// 편집 탭 타임라인의 휠(Jay 2026-10-23, 다빈치처럼): Alt+휠 = 재생헤드 기준 확대·축소(커서 자리와 무관 — Jay 의 다빈치는
//  'Zoom around mouse pointer' 가 꺼져 있다) · Shift+휠 = 영상 트랙 높이(머리와 줄이 함께, 30~160px) · Ctrl+휠 = 좌우.
//  jsdom 은 배치가 없어 가로 스크롤 값만 흉내 낸다. 빈 컷 자리는 5초라 c2 의 처음 = 5초.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditCardMenu } from "../src/components/timeline/EditTab";
import type { EditTree } from "../src/lib/useEditSequence";

const world = vi.hoisted(() => ({ gens: [] as unknown[] }));
vi.mock("../src/lib/resolveTransfer", async () => ({
  ...(await vi.importActual<typeof import("../src/lib/resolveTransfer")>("../src/lib/resolveTransfer")),
  getResolveConnectionStatus: () => Promise.reject(new Error("안 물었다")),
}));
vi.mock("../src/lib/useEditSequence", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/useEditSequence")>("../src/lib/useEditSequence");
  const counts = { final: 0, held: 0, shared: 0 };
  const tree = { state: "ready", complete: true, note: null, roots: [{
    name: "e070", path: "e070", count: 0, newCount: 0, reviewCounts: counts, children: ["c1", "c2", "c3"].map((name) => (
      { name, path: `e070/${name}`, count: 0, newCount: 0, reviewCounts: counts })) }] } as unknown as EditTree;
  return {
    ...actual,
    useEditProjects: () => ({
      projects: [{ id: "p1", name: "P1" }], projectsState: "ok", tree, reload: () => {},
      reloadCounts: () => {}, reloadFresh: () => {}, freshByProject: {},
    }),
    useEditGenerations: () => ({ state: "ok", gens: world.gens, error: null, complete: true, known: true, reload: () => {}, reloadIds: () => {} }),
  };
});
vi.mock("../src/lib/useDisabledFolders", () => ({ useDisabledFolders: () => ({}) }));

import { EditTab } from "../src/components/timeline/EditTab";

let host: HTMLDivElement;
let root: Root;
let scrollX = 0;
const cardMenuRef: { current: EditCardMenu | null } = { current: null };
const scroller = () => document.querySelector<HTMLElement>(".ed-scroll")!;
const laneHeight = () => document.querySelector<HTMLElement>(".ed-tl")!.style.getPropertyValue("--ed-lane-h");
const wheel = (init: WheelEventInit) => act(() => {
  scroller().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init }));
});
const mount = () => {
  act(() => root.render(
    <EditTab authKey="auth" authReady workspace={{ scope: "team", id: "w1", name: "W" }} keysActive
      flash={() => {}} onOpenCutFolder={() => {}} reloadSignal={0}
      peekPath={null} onPeekMarks={() => {}} cardMenuRef={cardMenuRef} onPreview={() => {}} onCompare={() => {}}
      resolve={{ send: () => {}, sendTimeline: () => new Promise<never>(() => {}), busy: false, pendingCount: 0, timelineBusy: false }}
      onFolderAction={() => {}} />,
  ));
  // jsdom 의 scrollLeft 는 늘 0 이다 — 값을 쥐는 대역(확대 맞춤이 여기에 쓴다)
  Object.defineProperty(scroller(), "scrollLeft", { configurable: true, get: () => scrollX, set: (value: number) => { scrollX = value; } });
  // 재생헤드를 c2 의 처음(5초)으로 — 재생헤드 자리는 시험 사이에도 남는다
  act(() => [...document.querySelectorAll<HTMLButtonElement>(".ed-cutcell")].find((cell) => cell.textContent === "c2")!.click());
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem("ch.editTimeline.last:local", JSON.stringify({ projectId: "p1", seq: "e070" }));
  for (const method of ["load", "pause"] as const) vi.spyOn(HTMLMediaElement.prototype, method).mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  Object.assign(Element.prototype, { setPointerCapture() {}, hasPointerCapture: () => false, releasePointerCapture() {} });
  world.gens = [];
  scrollX = 0;
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

it("Alt+휠은 커서 자리가 아니라 재생헤드를 화면의 같은 자리에 두고 확대·축소한다", () => {
  mount();
  scrollX = 40; // 확대 20px/초 — 재생헤드(5초)는 화면 왼쪽에서 5×20 − 40 = 60px
  wheel({ deltaY: -100, altKey: true, clientX: 500 }); // 커서는 멀리(500px)
  // 확대 20 × 1.15 = 23px/초 → 재생헤드가 여전히 60px 에 있으려면 5×23 − 60 = 55
  expect(scrollX).toBeCloseTo(55, 6);
  wheel({ deltaY: 100, altKey: true, clientX: 10 });
  expect(scrollX).toBeCloseTo(40, 6); // 되돌아온 확대(20)에서 다시 60px
});

// 기준 자리를 기억한다(Jay 2026-10-26 — 다빈치처럼): 줄이다 스크롤이 0 에 걸려 재생헤드가 밀려나도 다시 키우면 처음 자리로
it("Alt+휠: 줄이다 스크롤이 끝에 걸려 재생헤드가 밀려나도, 다시 키우면 처음 자리로 돌아온다 — 사용자가 넘겼으면 그 자리로 새로 잰다", () => {
  mount();
  // 브라우저처럼 0 아래로는 못 간다
  Object.defineProperty(scroller(), "scrollLeft", { configurable: true, get: () => scrollX, set: (value: number) => { scrollX = Math.max(0, value); } });
  scrollX = 60; // 확대 20 — 재생헤드(5초)는 화면 왼쪽에서 100 − 60 = 40px
  for (let i = 0; i < 7; i += 1) wheel({ deltaY: 100, altKey: true }); // 20 → 약 7.5px/초: 5 × 7.5 − 40 < 0 — 스크롤이 0 에 걸린다
  expect(scrollX).toBe(0);
  for (let i = 0; i < 7; i += 1) wheel({ deltaY: -100, altKey: true }); // 다시 20
  expect(scrollX).toBeCloseTo(60, 4); // 처음 자리(40px) — 기억이 없으면 밀려난 자리(약 37px)로 재서 약 63 이었다
  scrollX = 10; // 사용자가 넘겼다 — 재생헤드는 90px
  wheel({ deltaY: -100, altKey: true }); // 23px/초
  expect(scrollX).toBeCloseTo(5 * 23 - 90, 4);
});

// 눈금자의 작은 눈금(Jay 2026-10-26 — 다빈치처럼): 큰 눈금 사이를 나눈 짧은 선·반의 중간 선. 1초 눈금이면 프레임 나눔
it("눈금자: 작은·중간 눈금 간격이 확대를 따른다 — 5초 눈금(100px)은 10px·50px, 1초 눈금(400px)은 프레임(24 나눔)", () => {
  mount();
  const ruler = () => document.querySelector<HTMLElement>(".ed-ruler")!;
  const vars = () => [ruler().style.getPropertyValue("--tick-minor"), ruler().style.getPropertyValue("--tick-mid")];
  expect(vars()).toEqual(["10px", "50px"]); // 20px/초 — 큰 눈금 5초 = 100px
  for (let i = 0; i < 40; i += 1) wheel({ deltaY: -100, altKey: true }); // 끝까지 키움(400px/초 — 큰 눈금 1초 = 400px)
  expect(vars().map((value) => Number.parseFloat(value))).toEqual([400 / 24, 200]);
});

it("Shift+휠은 영상 트랙 높이를 바꾸고(위 = 키움·아래 = 줄임, 30~160px) 좌우로는 넘기지 않는다", () => {
  mount();
  scrollX = 40;
  expect(laneHeight()).toBe("58px");
  wheel({ deltaX: -100, shiftKey: true }); // 크롬은 Shift+휠을 deltaX 로 준다
  expect(laneHeight()).toBe("65px");
  expect(scrollX).toBe(40);
  for (let i = 0; i < 30; i += 1) wheel({ deltaX: 100, shiftKey: true });
  expect(laneHeight()).toBe("30px");
  for (let i = 0; i < 30; i += 1) wheel({ deltaY: -100, shiftKey: true });
  expect(laneHeight()).toBe("160px");
  expect(scrollX).toBe(40);
});

it("Ctrl+휠은 그대로 좌우로 넘기고 트랙 높이·확대는 그대로다", () => {
  mount();
  scrollX = 40;
  wheel({ deltaY: 30, ctrlKey: true });
  expect(scrollX).toBe(70);
  expect(laneHeight()).toBe("58px");
});
