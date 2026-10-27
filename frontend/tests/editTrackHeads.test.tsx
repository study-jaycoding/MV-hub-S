// @vitest-environment jsdom
// 편집 탭 트랙 머리(Jay 2026-10-23, 다빈치) — 맨 위 빈 트랙 줄 없음(놓아도 새 트랙이 안 생긴다 · 트랙 추가는 우클릭 메뉴) · 머리 두 줄 ·
//  지금 시각은 머리 맨 위 · 비디오 위 빈 곳의 높이(--ed-vgap) · 트랙 머리 메뉴의 '트랙 색 ›' 하위 메뉴(키).
//  jsdom 에는 배치가 없다: 포인터 밑의 요소(elementFromPoint·elementsFromPoint)와 칸 높이는 시험이 정한다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditCardMenu } from "../src/components/timeline/EditTab";
import type { EditTree } from "../src/lib/useEditSequence";
import type { Generation } from "../src/types";

const gen = (id: string, cut: string, type = "image") => ({
  id, job_id: `job-${id}`, status: "done", params: {}, prompt: `prompt ${id}`, folder_path: `e070/${cut}`,
  shared: true, is_final: false, is_held: false, is_mine: false, tags: [], creator_name: "리버",
  assets: [{ id: `a-${id}`, generation_id: id, type, file_path: `/media/${id}.${type === "video" ? "mp4" : "png"}`, thumbnail_path: null, source_url: null, cached: true }],
} as unknown as Generation);

const world = vi.hoisted(() => ({ gens: [] as unknown[] }));
vi.mock("../src/lib/resolveTransfer", async () => ({
  ...(await vi.importActual<typeof import("../src/lib/resolveTransfer")>("../src/lib/resolveTransfer")),
  getResolveConnectionStatus: () => Promise.reject(new Error("안 물었다")),
}));
vi.mock("../src/lib/useEditSequence", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/useEditSequence")>("../src/lib/useEditSequence");
  const counts = { final: 0, held: 0, shared: 2 };
  const tree = { state: "ready", complete: true, note: null, roots: [{
    name: "e070", path: "e070", count: 4, newCount: 0, reviewCounts: counts, children: ["c1", "c2"].map((name) => (
      { name, path: `e070/${name}`, count: 2, newCount: 0, reviewCounts: counts })) }] } as unknown as EditTree;
  return {
    ...actual,
    useEditProjects: () => ({
      projects: [{ id: "p1", name: "P1" }], projectsState: "ok", tree, reload: () => {}, reloadCounts: () => {}, freshByProject: {},
    }),
    useEditGenerations: () => ({ state: "ok", gens: world.gens, error: null, complete: true, known: true, reload: () => {} }),
  };
});
vi.mock("../src/lib/useDisabledFolders", () => ({ useDisabledFolders: () => ({}) }));

import { EditTab } from "../src/components/timeline/EditTab";

let host: HTMLDivElement;
let root: Root;
const flashed: string[] = [];
const cardMenuRef: { current: EditCardMenu | null } = { current: null };
const DOC_KEY = "mvhub.editDoc:local:p1:e070";
const mountOn = (name: string) => {
  act(() => root.render(
    <EditTab authKey="auth" authReady workspace={{ scope: "team", id: "w1", name: "W" }} keysActive
      flash={(message: string) => { flashed.push(message); }} onOpenCutFolder={() => {}} reloadSignal={0}
      peekPath={null} onPeekMarks={() => {}} cardMenuRef={cardMenuRef} onPreview={() => {}} onCompare={() => {}}
      resolve={{ send: () => {}, sendTimeline: () => new Promise<never>(() => {}), busy: false, pendingCount: 0, timelineBusy: false }}
      onFolderAction={() => {}} />,
  ));
  // 재생헤드의 마지막 자리는 시험 사이에도 남는다 — 컷을 눌러 그 컷에서 시작한다(풀은 재생헤드의 컷을 보여 준다)
  goCut(name);
};
const goCut = (name: string) =>
  act(() => [...document.querySelectorAll<HTMLButtonElement>(".ed-cutcell")].find((cell) => cell.textContent === name)!.click());
const seed = (clips: { cut: string; gen: string; track: number; kind?: string }[]) => localStorage.setItem(DOC_KEY, JSON.stringify({
  v: 1, tracksOff: [], tracksLocked: [], clips: clips.map((clip) => ({ kind: "image", dur: 5, ...clip, cut: `e070/${clip.cut}` })),
}));
const stored = () => JSON.parse(localStorage.getItem(DOC_KEY) ?? "null");
const storedTracks = () => (stored()?.clips ?? []).map((clip: { gen: string; track: number }) => [clip.gen, clip.track]);
const heads = () => [...document.querySelectorAll(".ed-head.ed-h-v b")].map((item) => item.textContent);
const gapLane = () => document.querySelector<HTMLElement>(".ed-lanes .ed-l-gap")!;
const poolCards = () => [...document.querySelectorAll<HTMLButtonElement>(".ed-pool .ed-card")];
const fire = (target: EventTarget, type: string, init: MouseEventInit = {}) =>
  act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, ...init })); });
const key = (target: EventTarget, name: string, init: KeyboardEventInit = {}) =>
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key: name, code: name, bubbles: true, cancelable: true, ...init })); });
const headOf = (name: string) => [...document.querySelectorAll<HTMLElement>(".ed-head.ed-h-v")].find((item) => item.querySelector("b")!.textContent === name)!;
const menuRow = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".ed-hmenu > .ed-tmenu-item")].find((item) => item.textContent!.startsWith(label))!;
let under: Element | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem("ch.editTimeline.last:local", JSON.stringify({ projectId: "p1", seq: "e070" }));
  for (const method of ["load", "pause"] as const) vi.spyOn(HTMLMediaElement.prototype, method).mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  const held = new Set<Element>();
  Object.assign(Element.prototype, {
    setPointerCapture(this: Element) { held.add(this); },
    hasPointerCapture(this: Element) { return held.has(this); },
    releasePointerCapture(this: Element) { held.delete(this); },
  });
  under = null;
  document.elementFromPoint = () => under;
  document.elementsFromPoint = () => (under ? [under] : []);
  world.gens = [gen("a", "c1"), gen("b", "c1"), gen("x", "c2"), gen("v", "c2", "video")];
  flashed.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("맨 위 빈 트랙 줄이 없다 — 머리는 두 줄(V n·잠금·켜고 끄기 / Video n) · A1 은 Audio 1 · 소리 조각 수 · 지금 시각은 머리 맨 위", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c2", gen: "v", track: 1, kind: "video" }]);
  mountOn("c1");
  expect(heads()).toEqual(["V3", "V2", "V1"]);
  expect(document.querySelector(".ed-l-new, .ed-h-new, .ed-addtrack")).toBeNull();
  expect([...document.querySelectorAll(".ed-h-v .ed-hname")].map((item) => item.textContent)).toEqual(["Video 3", "Video 2", "Video 1"]);
  expect(headOf("V1").querySelectorAll(".ed-hrow .ed-hbtn")).toHaveLength(2); // 잠금 · 켜고 끄기
  expect(document.querySelector(".ed-h-a .ed-hname")!.firstChild!.textContent).toBe("Audio 1");
  expect(document.querySelector(".ed-h-a .ed-hname small")!.textContent).toBe("1 Clip"); // 영상 클립 하나(그림은 소리가 없다)
  // 지금 시각 — 위 막대가 아니라 트랙 머리 맨 위에서 재생헤드를 따라간다
  expect(document.querySelector(".ed-bar .ed-tc")).toBeNull();
  const tc = document.querySelector(".ed-heads .ed-h-top .ed-tc")!;
  goCut("c2");
  expect(tc.textContent).toBe("00:00:05:00");
  // 비디오 트랙과 소리 줄 사이의 경계는 머리와 줄 양쪽에
  expect([document.querySelector(".ed-heads .ed-h-av"), document.querySelector(".ed-lanes .ed-l-av")].every(Boolean)).toBe(true);
});

it("영상 클립 아래 이름 줄(컷 이름 · 길이) · 소리 조각에도 컷 이름 · 트랙을 낮추면 머리는 단추 줄만(다빈치 색 — Jay 2026-10-23)", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c2", gen: "v", track: 1, kind: "video" }]);
  mountOn("c1");
  const bars = [...document.querySelectorAll(".ed-clip .ed-clip-bar")]
    .map((bar) => [bar.querySelector(".ed-clip-name")!.textContent, bar.querySelector("b")!.textContent]);
  expect(bars).toEqual([["c1", "5.0s"], ["c2", "5.0s"]]);
  expect([...document.querySelectorAll(".ed-aud span")].map((item) => item.textContent)).toEqual(["c2"]); // 소리는 영상 클립만
  const box = () => document.querySelector(".ed-tl")!;
  expect(box().classList.contains("ed-short")).toBe(false);
  const scroll = document.querySelector<HTMLElement>(".ed-scroll")!;
  for (let i = 0; i < 3; i += 1) { // Shift+휠 세 번 — 58 → 52 → 46 → 41px
    act(() => { scroll.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, shiftKey: true, bubbles: true, cancelable: true })); });
  }
  expect([box().classList.contains("ed-short"), (box() as HTMLElement).style.getPropertyValue("--ed-lane-h")]).toEqual([true, "41px"]);
});

it("트랙 위 빈 곳에 카드를 놓아도 트랙이 생기지 않는다 — 트랙 추가는 트랙 머리 우클릭 메뉴로", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }]);
  mountOn("c1");
  fire(poolCards()[1], "mousedown", { clientX: 10, clientY: 10 });
  under = gapLane();
  fire(window, "mousemove", { clientX: 60, clientY: 80 });
  expect(document.querySelector(".ed-drop, .ed-insert")).toBeNull(); // 놓을 곳이 아니다
  fire(window, "mouseup", { clientX: 60, clientY: 80, buttons: 0 });
  expect([heads(), storedTracks()]).toEqual([["V3", "V2", "V1"], [["a", 1]]]);
  fire(headOf("V3"), "contextmenu", { button: 2, buttons: 0, clientX: 30, clientY: 100 });
  act(() => menuRow("트랙 추가").click());
  expect(heads()).toEqual(["V4", "V3", "V2", "V1"]);
  expect(stored().tracks).toBe(4);
  expect(flashed).toEqual([]);
});

it("빈 곳 우클릭 = 브라우저 메뉴 대신 '트랙' 메뉴(트랙 추가 — 맨 위에 · 빈 트랙 모두 삭제) · 트랙 줄 빈 곳 = 그 트랙 메뉴 · 클립은 클립 메뉴", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }]);
  mountOn("c1");
  const rightClick = (target: Element) => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 50 });
    act(() => { target.dispatchEvent(event); });
    return event.defaultPrevented;
  };
  const menuHead = () => document.querySelector(".ed-hmenu .ed-tmenu-head")?.textContent ?? null;
  expect(rightClick(gapLane())).toBe(true); // 브라우저 메뉴를 막았다
  expect(menuHead()).toBe("트랙");
  expect([...document.querySelectorAll(".ed-hmenu > .ed-tmenu-item")].map((item) => item.textContent)).toEqual(["트랙 추가맨 위에", "빈 트랙 모두 삭제"]);
  act(() => menuRow("트랙 추가").click());
  expect([heads(), stored().tracks]).toEqual([["V4", "V3", "V2", "V1"], 4]); // 맨 위에 하나
  expect(rightClick(document.querySelector('.ed-lanes [data-track="2"]')!)).toBe(true);
  expect(menuHead()).toBe("V2 트랙");
  key(document.activeElement ?? document.body, "Escape");
  expect(rightClick(document.querySelector(".ed-heads .ed-h-top")!)).toBe(true); // 머리 칸의 빈 곳(지금 시각)도
  expect(menuHead()).toBe("트랙");
  key(document.activeElement ?? document.body, "Escape");
  rightClick(document.querySelector(".ed-clip")!);
  expect([menuHead(), !!document.querySelector('[aria-label="클립 메뉴"]')]).toEqual([null, true]); // 클립은 제 메뉴
});

it("타임라인의 클립을 트랙 위 빈 곳으로 끌어 놓아도 아무 일도 없다", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }]);
  mountOn("c1");
  const clip = document.querySelector<HTMLElement>(".ed-clip")!;
  fire(clip, "pointerdown", { clientX: 10, clientY: 200 });
  fire(clip, "pointermove", { clientX: 10, clientY: 60 });
  under = gapLane();
  fire(clip, "pointerup", { clientX: 10, clientY: 60, buttons: 0 });
  expect([heads(), storedTracks()]).toEqual([["V3", "V2", "V1"], [["a", 1]]]);
});

it("비디오 위 빈 곳 = 칸에 남는 높이의 4/7(가로 스크롤 막대는 뺀다) — 트랙이 칸을 넘으면 0", () => {
  const sizes = { box: 600, scroll: 600, scrollClient: 590 };
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("ed-tl") ? sizes.box : this.classList.contains("ed-scroll") ? sizes.scrollClient : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("ed-scroll") ? sizes.scroll : 0;
  });
  const watchers: (() => void)[] = [];
  vi.stubGlobal("ResizeObserver", class {
    constructor(private fire: () => void) { watchers.push(() => this.fire()); }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  seed([{ cut: "c1", gen: "a", track: 1 }]);
  mountOn("c1");
  const vgap = () => document.querySelector<HTMLElement>(".ed-tl")!.style.getPropertyValue("--ed-vgap");
  // 600 − 막대 10 − (지금 시각 54 + 트랙 3 × 58 + 경계 5 + A1 58) = 299 → 4/7 = 170
  expect(vgap()).toBe("170px");
  sizes.box = 300; // 칸을 줄였다 — 남는 높이가 없다
  act(() => watchers.forEach((watch) => watch()));
  expect(vgap()).toBe("0px");
});

it("트랙 머리 메뉴의 '트랙 색 ›' — → 로 열려 고른 색에 초점, ↑↓ 는 하위 메뉴 안에서만, ← 는 하위 메뉴만 닫는다", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }]);
  mountOn("c1");
  fire(headOf("V2"), "contextmenu", { button: 2, buttons: 0, clientX: 30, clientY: 300 });
  expect(document.querySelector(".ed-hmenu .ed-tmenu-head")!.textContent).toBe("V2 트랙");
  const colorRow = menuRow("트랙 색");
  act(() => colorRow.focus());
  key(colorRow, "ArrowRight");
  const sub = document.querySelector<HTMLElement>(".ed-hmenu .ed-submenu")!;
  const swatches = [...sub.querySelectorAll<HTMLButtonElement>(".ed-swatch")];
  expect(swatches).toHaveLength(8);
  expect(document.activeElement).toBe(swatches[0]); // 색이 없으면 첫 색
  expect(sub.querySelector<HTMLButtonElement>(".ed-tmenu-item")!.disabled).toBe(true); // 색 없음 — 이미 없다
  key(document.activeElement!, "ArrowDown");
  expect(document.activeElement).toBe(swatches[1]);
  key(document.activeElement!, "ArrowLeft");
  expect(document.querySelector(".ed-hmenu .ed-submenu")).toBeNull();
  expect(document.activeElement).toBe(colorRow);
  expect(document.querySelector(".ed-hmenu")).not.toBeNull(); // 메뉴는 그대로
  key(colorRow, "ArrowRight");
  act(() => (document.activeElement as HTMLButtonElement).click());
  expect(stored().trackColors).toEqual({ 2: "#e5484d" });
  expect(document.querySelector(".ed-hmenu")).toBeNull();
});
