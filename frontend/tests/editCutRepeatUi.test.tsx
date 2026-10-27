// @vitest-environment jsdom
// 편집 탭 ⑤ 같은 컷을 컷 사이에 한 번 더(Jay 2026-10-23) — 화면 조작(slot-ui). 순수 계산은 editCutRepeat.test.ts.
//  jsdom 에는 배치가 없다: getBoundingClientRect 가 0 이라 줄 기준 가로 자리 = clientX(배율 20px/초 — 5초 컷 = 100px),
//  포인터 밑의 요소(elementFromPoint·elementsFromPoint)는 시험이 정한다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditCardMenu, EditCutFolder } from "../src/components/timeline/EditTab";
import type { EditTree } from "../src/lib/useEditSequence";
import type { Generation } from "../src/types";

const gen = (id: string, cut: string) => ({
  id, job_id: `job-${id}`, status: "done", params: {}, prompt: `prompt ${id}`, folder_path: `e070/${cut}`,
  shared: true, is_final: false, is_held: false, is_mine: false, tags: [], creator_name: "리버",
  assets: [{ id: `a-${id}`, generation_id: id, type: "image", file_path: `/media/${id}.png`, thumbnail_path: null, source_url: null, cached: true }],
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
    name: "e070", path: "e070", count: 6, newCount: 0, reviewCounts: counts, children: ["c1", "c2", "c3"].map((name) => (
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
import { clearPoolTagOverlays } from "../src/components/timeline/EditPool";

let host: HTMLDivElement;
let root: Root;
const opened: EditCutFolder[] = [];
const flashed: string[] = [];
const cardMenuRef: { current: EditCardMenu | null } = { current: null };
const mount = (peekPath: string | null = null) => act(() => root.render(
  <EditTab authKey="auth" authReady workspace={{ scope: "team", id: "w1", name: "W" }} keysActive
    flash={(message: string) => { flashed.push(message); }} onOpenCutFolder={(target) => { opened.push(target); }} reloadSignal={0}
    peekPath={peekPath} onPeekMarks={() => {}} cardMenuRef={cardMenuRef} onPreview={() => {}} onCompare={() => {}}
    resolve={{ send: () => {}, sendTimeline: () => new Promise<never>(() => {}), busy: false, pendingCount: 0, timelineBusy: false }}
    onFolderAction={() => {}} />,
));
const DOC_KEY = "mvhub.editDoc:local:p1:e070";
type Seed = { cut: string; gen: string; track: number; slot?: string; kind?: "video" | "image"; dur?: number; head?: number; trim?: number; speed?: number };
const seed = (clips: Seed[], extra: Record<string, unknown> = {}) => localStorage.setItem(DOC_KEY, JSON.stringify({
  v: clips.some((clip) => clip.slot) ? 3 : 1, tracksOff: [], tracksLocked: [], ...extra,
  clips: clips.map((clip) => ({ kind: "image", dur: 5, ...clip, cut: `e070/${clip.cut}` })),
}));
const stored = () => JSON.parse(localStorage.getItem(DOC_KEY) ?? "null");
const placed = () => (stored()?.clips ?? []).map((clip: { cut: string; slot?: string; gen: string; track: number }) =>
  [clip.cut.slice(5) + (clip.slot ? "②" : ""), clip.gen, clip.track]);
const cuts = () => [...document.querySelectorAll(".ed-cutcell")].map((cell) => cell.textContent);
const cutCell = (name: string) => [...document.querySelectorAll<HTMLButtonElement>(".ed-cutcell")].find((cell) => cell.textContent === name)!;
const poolCards = () => [...document.querySelectorAll<HTMLButtonElement>(".ed-pool .ed-card")];
const lane = (track: number) => document.querySelector<HTMLElement>(`.ed-lane[data-track="${track}"]`)!;
const clipOf = (gen: string) => [...document.querySelectorAll<HTMLElement>(".ed-clip")].find((el) => el.dataset.clip?.endsWith(`\n${gen}`))!;
const inserts = () => [...document.querySelectorAll<HTMLElement>(".ed-insert")].map((el) => [el.parentElement!.dataset.track, el.style.left, el.textContent]);
const fire = (target: EventTarget, type: string, init: MouseEventInit = {}) => {
  act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, ...init })); });
};
const press = (init: KeyboardEventInit) => act(() => { document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
let under: Element | null = null;
let underAll: Element[] = [];
// 풀 카드 끌기 — x 는 줄 기준 px
const dragCard = (card: Element, over: Element, x: number) => {
  fire(card, "mousedown", { clientX: 10, clientY: 10 });
  under = over;
  fire(window, "mousemove", { clientX: x, clientY: 80 });
};
const dropCard = (x: number) => fire(window, "mouseup", { clientX: x, clientY: 80, buttons: 0 });
// 타임라인 클립 끌기 — from/to 는 [x, y], 놓는 줄은 over
const dragClip = (el: HTMLElement, from: [number, number], path: [number, number][], over: Element) => {
  underAll = [over];
  fire(el, "pointerdown", { clientX: from[0], clientY: from[1] });
  for (const [x, y] of path) fire(el, "pointermove", { clientX: x, clientY: y });
};
const dropClip = (el: HTMLElement, at: [number, number]) => fire(el, "pointerup", { clientX: at[0], clientY: at[1], buttons: 0 });

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
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  under = null;
  underAll = [];
  document.elementFromPoint = () => under;
  (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => underAll;
  world.gens = [gen("a", "c1"), gen("b", "c1"), gen("x", "c2")];
  opened.length = 0;
  flashed.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  clearPoolTagOverlays();
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("풀 카드를 컷 경계에 놓으면 그 폴더의 새 자리 — 놓은 트랙에 · 몸통이면 지금처럼", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c2", gen: "x", track: 1 }]);
  mount();
  act(() => cutCell("c1").click());
  const b = poolCards().find((card) => card.textContent?.includes("prompt b")) ?? poolCards()[1];
  dragCard(b, lane(2), 205); // c2 와 c3 의 경계(200px) 근처
  expect(inserts()).toEqual([["2", "200px", "여기에 c1 끼워 넣기"]]);
  expect(document.querySelector(".ed-ghost")!.textContent).toBe("여기에 c1 끼워 넣기");
  dropCard(205);
  expect(stored().v).toBe(3);
  expect(placed()).toEqual([["c1", "a", 1], ["c2", "x", 1], ["c1②", "b", 2]]);
  expect(cuts()).toEqual(["c1 ①", "c2", "c1 ②", "c3"]);
  expect(cutCell("c1 ②").title).toBe("e070/c1 ② · 끌어서 순서 바꾸기"); // 무작위 ID 는 안 보인다
  expect(inserts()).toEqual([]);
  // 몸통(경계에서 먼 곳) — 지금처럼 끌기 시작 때 풀의 자리(c1 ①)에
  act(() => cutCell("c1 ①").click());
  dragCard(poolCards()[1], lane(3), 50);
  expect(inserts()).toEqual([]);
  dropCard(50);
  expect(placed()).toContainEqual(["c1", "b", 3]);
});

// Jay 2026-10-23(⑤ 후속): "원래 폴더에 있는 부분에 넣는거는 폴더 근처에가야 … 중간에 끼워넣기는 … 저부분을 늘려서 더 원할하게"
it("풀 카드 — 자기 자리 칸 밖이면 거리와 상관없이 가장 가까운 경계에 끼워 넣기 · 자기 칸 위는 지금처럼 Vn 에 넣기", () => {
  world.gens = [...world.gens, gen("z", "c3")];
  seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c2", gen: "x", track: 1 }]);
  mount();
  act(() => cutCell("c1").click()); // 풀 = c1 의 카드 · c1 0~100 · c2 100~200 · c3 200~300px
  const b = poolCards().find((card) => card.textContent?.includes("prompt b")) ?? poolCards()[1];
  dragCard(b, lane(2), 60); // 자기 칸(c1) 몸통
  expect([inserts(), document.querySelector(".ed-ghost")!.textContent]).toEqual([[], "V2 에 넣기"]);
  fire(window, "mousemove", { clientX: 140, clientY: 80 }); // c2 몸통의 앞쪽 — 띠(±12px) 밖이지만 가장 가까운 c1|c2 경계
  expect(inserts()).toEqual([["2", "100px", "여기에 c1 끼워 넣기"]]);
  fire(window, "mousemove", { clientX: 170, clientY: 80 }); // c2 의 가운데를 넘었다 — c2|c3 경계
  expect(inserts()).toEqual([["2", "200px", "여기에 c1 끼워 넣기"]]);
  fire(window, "mousemove", { clientX: 380, clientY: 80 }); // 맨 뒤 밖 — 맨 끝
  expect(inserts()).toEqual([["2", "300px", "여기에 c1 끼워 넣기"]]);
  fire(window, "mousemove", { clientX: 270, clientY: 80 }); // c3 의 뒤쪽 — 맨 끝 경계
  dropCard(270);
  expect(placed()).toEqual([["c1", "a", 1], ["c2", "x", 1], ["c1②", "b", 2]]);
  expect(cuts()).toEqual(["c1 ①", "c2", "c3", "c1 ②"]);
});

it("타임라인 클립을 가로로 끌어 경계에 놓으면 옮기기 — 첫 자리의 클립은 새 자리로(빈 첫 자리는 숨는다 — 2026-10-26) · 고른 것은 새 열쇠로", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c2", gen: "x", track: 1 }]);
  mount();
  const a = clipOf("a");
  act(() => a.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, buttons: 1, clientX: 50, clientY: 30 })));
  fire(a, "pointerup", { clientX: 50, clientY: 30, buttons: 0 }); // 눌러서 고른다
  dragClip(a, [50, 30], [[80, 30], [298, 32]], lane(1)); // 맨 끝 경계(300px)
  expect(a.style.transform).toBe("translate(248px, 2px)");
  expect(inserts()).toEqual([["1", "300px", "여기로 옮기기"]]);
  dropClip(a, [298, 32]);
  expect(placed()).toEqual([["c1②", "a", 1], ["c2", "x", 1]]);
  expect(cuts()).toEqual(["c2", "c3", "c1"]); // 빈 첫 자리는 숨는다(2026-10-26) — c1 은 새 자리 하나라 번호도 없다
  expect(document.querySelector(".ed-clip.ed-sel")?.dataset.clip).toMatch(/^e070\/c1\/\/[a-z0-9]{10}\na$/);
  expect(flashed).toEqual([]);
});

// Jay 2026-10-23 '같게'(맡김) — 클립도 풀 카드처럼: 자기 자리 칸 밖이면 띠 밖이어도 가장 가까운 경계
it("타임라인 클립 — 자기 칸 밖이면 띠 밖이어도 가장 가까운 경계로 옮기기(풀 카드와 같게) · 자기 칸 안은 띠만", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c2", gen: "x", track: 1 }]);
  mount();
  const a = clipOf("a"); // c1 0~100 · c2 100~200 · c3 200~300px
  dragClip(a, [20, 30], [[60, 30]], lane(1)); // 자기 칸 안 · 띠 밖 — 옮기기 아님
  expect(inserts()).toEqual([]);
  fire(a, "pointermove", { clientX: 160, clientY: 30 }); // c2 의 가운데를 넘었다 — c2|c3 경계(띠 밖이지만)
  expect(inserts()).toEqual([["1", "200px", "여기로 옮기기"]]);
  fire(a, "pointermove", { clientX: 260, clientY: 30 }); // c3 의 뒤쪽 — 맨 끝
  expect(inserts()).toEqual([["1", "300px", "여기로 옮기기"]]);
  dropClip(a, [260, 30]);
  expect(placed()).toEqual([["c1②", "a", 1], ["c2", "x", 1]]);
  expect(cuts()).toEqual(["c2", "c3", "c1"]); // 빈 첫 자리는 숨는다(2026-10-26)
});

it("세로로만 끌면 경계 근처라도 지금처럼 트랙 옮기기 · 가로로 갔다가 시작점 근처로 돌아와 놓으면 경계 규칙대로", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c2", gen: "x", track: 1 }]);
  mount();
  dragClip(clipOf("a"), [97, 30], [[97, 90]], lane(2)); // c1 의 끝(경계 100px 바로 앞)에서 세로로만
  expect(clipOf("a").style.transform).toBe("translateY(60px)");
  expect(inserts()).toEqual([]);
  dropClip(clipOf("a"), [97, 90]);
  expect(placed()).toEqual([["c1", "a", 2], ["c2", "x", 1]]);
  // 가로로 문턱을 넘었다가 돌아와 c1|c2 경계(100px)에 놓으면 — 첫 자리의 클립이라 새 자리(c1 바로 뒤)
  const a = clipOf("a");
  dragClip(a, [97, 30], [[140, 30], [99, 30]], lane(2));
  expect(inserts()).toEqual([["2", "100px", "여기로 옮기기"]]);
  dropClip(a, [99, 30]);
  expect(placed()).toEqual([["c1②", "a", 2], ["c2", "x", 1]]);
  expect(cuts()).toEqual(["c1", "c2", "c3"]); // 빈 첫 자리는 숨고 새 자리 하나만 보인다(2026-10-26)
});

it("반복 자리의 유일한 클립 — 제자리·같은 트랙이면 아무 일 없음(안내 없음) · 트랙만 바꾸면 트랙만 · 자리째 옮기면 북마크가 따라간다", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c2", gen: "x", track: 1 }, { cut: "c1", slot: "abc123", gen: "b", track: 1 }],
    { cutOrder: ["e070/c1", "e070/c2", "e070/c1//abc123", "e070/c3"], markers: [{ cut: "e070/c1//abc123", local: 1 }] });
  mount();
  expect(cuts()).toEqual(["c1 ①", "c2", "c1 ②", "c3"]);
  // 폴더끼리는 이름순이고 반복 자리만 끼워 둔 상태 — 목록 메뉴의 '배치 순서'는 '폴더순' 표시만(누를 수 없다 · Jay 2026-10-26 "내순서라고 적혀있어서
  //  헷갈린다" → '배치 순서'로·빈 곳 채우기 밑으로)
  const listBtn = () => document.querySelector<HTMLButtonElement>(".ed-listbtn")!;
  const orderItem = () => [...document.querySelectorAll<HTMLButtonElement>(".ed-tmenu-item")].find((item) => item.textContent!.startsWith("배치 순서"));
  const orderShown = () => {
    act(() => listBtn().click());
    const item = orderItem()!;
    const seen = [item.textContent, item.disabled];
    act(() => item.click()); // 눌러 봐도
    if (orderItem()) act(() => listBtn().click());
    return seen;
  };
  const before = localStorage.getItem(DOC_KEY);
  expect(orderShown()).toEqual(["배치 순서폴더순", true]);
  expect(localStorage.getItem(DOC_KEY)).toBe(before); // 끼워 넣은 배치가 흩어지지 않는다
  dragClip(clipOf("b"), [250, 30], [[280, 30], [302, 30]], lane(1)); // 자기 뒤 경계(300px) — 제자리
  dropClip(clipOf("b"), [302, 30]);
  expect([localStorage.getItem(DOC_KEY), flashed]).toEqual([before, []]);
  dragClip(clipOf("b"), [250, 30], [[280, 30], [302, 90]], lane(2)); // 같은 경계 · V2 — 트랙만
  dropClip(clipOf("b"), [302, 90]);
  expect(placed()).toEqual([["c1", "a", 1], ["c2", "x", 1], ["c1②", "b", 2]]);
  expect(stored().cutOrder).toEqual(["e070/c1", "e070/c2", "e070/c1//abc123", "e070/c3"]);
  dragClip(clipOf("b"), [250, 90], [[150, 90], [101, 90]], lane(2)); // c1|c2 경계 — 자리째
  dropClip(clipOf("b"), [101, 90]);
  expect(cuts()).toEqual(["c1 ①", "c1 ②", "c2", "c3"]);
  expect(stored().markers).toEqual([{ cut: "e070/c1//abc123", local: 1 }]);
  expect(stored().clips.find((clip: { gen: string }) => clip.gen === "b").slot).toBe("abc123");
  expect([stored().cutOrder, orderShown()]).toEqual([undefined, ["배치 순서폴더순", true]]); // 이름순과 같아져 정한 순서가 없다 — 그대로 '폴더순'
});

it("숨긴 컷이 사이에 있는 경계 — 같은 트랙·다른 트랙으로 놓아도 순서 결과가 같다(전체 순서로 제자리를 본다)", () => {
  world.gens = [...world.gens, gen("z", "c3")]; // 빈 폴더는 기본 비활성 — c3 는 보이게
  const start = () => {
    seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c1", slot: "abc123", gen: "b", track: 1 }, { cut: "c2", gen: "x", track: 1 }],
      { cutOrder: ["e070/c1", "e070/c1//abc123", "e070/c2", "e070/c3"], cutsOff: ["e070/c2"], hideOff: true });
    mount();
  };
  start();
  expect(cuts()).toEqual(["c1 ①", "c1 ②", "c3"]); // c2 는 숨김
  dragClip(clipOf("b"), [150, 30], [[180, 30], [202, 30]], lane(1)); // 보이기로는 제 뒤 경계(c3 앞) — 전체 순서로는 c2 를 넘는다
  dropClip(clipOf("b"), [202, 30]);
  const same = stored().cutOrder;
  act(() => root.unmount());
  root = createRoot(host);
  start();
  dragClip(clipOf("b"), [150, 30], [[180, 30], [202, 90]], lane(2));
  dropClip(clipOf("b"), [202, 90]);
  expect([same, stored().cutOrder]).toEqual([["e070/c1", "e070/c2", "e070/c1//abc123", "e070/c3"], ["e070/c1", "e070/c2", "e070/c1//abc123", "e070/c3"]]);
});

it("반복 자리 — 클립 누름은 그 자리로 · D 는 자리마다 · 폴더 창은 폴더로 열고 휠 클릭 넣기·표는 그 자리 · 창을 닫고 첫 자리에서 열면 첫 자리", () => {
  world.gens = [...world.gens, gen("z", "c3")]; // 빈 폴더는 기본 비활성 — c3 가 회색으로 섞이지 않게
  seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c2", gen: "x", track: 1 }, { cut: "c1", slot: "abc123", gen: "b", track: 1 }],
    { cutOrder: ["e070/c1", "e070/c2", "e070/c1//abc123", "e070/c3"] });
  mount();
  const b = clipOf("b");
  fire(b, "pointerdown", { clientX: 250, clientY: 30 });
  fire(b, "pointerup", { clientX: 250, clientY: 30, buttons: 0 });
  expect(document.querySelector(".ed-cutcell.ed-cur")?.textContent).toBe("c1 ②");
  press({ key: "Escape", code: "Escape" }); // 고른 것을 풀어 D 가 자리에 걸리게
  act(() => document.querySelector<HTMLElement>(".ed-lanes")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })));
  press({ key: "d", code: "KeyD" });
  expect(stored().cutsOff).toEqual(["e070/c1//abc123"]);
  expect([...document.querySelectorAll(".ed-cutcell.ed-cutoff")].map((cell) => cell.textContent)).toEqual(["c1 ②"]);
  press({ key: "d", code: "KeyD" });
  // 폴더 창 — 반복 자리에서 열면 App 에는 폴더 경로
  act(() => cutCell("c1 ②").dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 250 })));
  expect(opened.at(-1)?.path).toBe("e070/c1");
  expect(opened.at(-1)?.marks).toEqual({ b: { label: "V1 - 선택 카드", lead: true } });
  mount("e070/c1"); // 창이 떴다(peekPath: null → 폴더) — 연결이 풀리지 않는다
  act(() => cardMenuRef.current!({ id: "a" }, 30, 40));
  act(() => [...document.querySelectorAll<HTMLButtonElement>(".ed-tmenu-item")].find((item) => item.textContent!.includes("V2"))!.click());
  expect(placed()).toEqual([["c1", "a", 1], ["c2", "x", 1], ["c1②", "b", 1], ["c1②", "a", 2]]);
  mount(null); // 창을 닫는다
  act(() => cutCell("c1 ①").dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 50 })));
  mount("e070/c1");
  act(() => cardMenuRef.current!({ id: "b" }, 30, 40));
  act(() => [...document.querySelectorAll<HTMLButtonElement>(".ed-tmenu-item")].find((item) => item.textContent!.includes("V3"))!.click());
  expect(placed()).toContainEqual(["c1", "b", 3]);
});

it("가로 끌기도 판정은 놓는 순간의 배치로(끄는 사이 확대가 바뀌면 그 배율로) · Esc 는 버린다", () => {
  world.gens = [...world.gens, gen("z", "c3")];
  seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c2", gen: "x", track: 1 }]);
  mount();
  const a = clipOf("a");
  dragClip(a, [50, 30], [[120, 30], [202, 30]], lane(1)); // 20px/초 — c2|c3 경계(200px)
  expect(inserts()).toEqual([["1", "200px", "여기로 옮기기"]]);
  // 끄는 동안은 편집 키가 쉰다 — 확대는 Alt+휠(기본 지정, ×1.15)로 바꾼다(막대의 ＋ 단추는 H 로 바뀌었다). 23px/초 — 경계는 115·230px
  act(() => { document.querySelector(".ed-scroll")!.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, altKey: true, bubbles: true, cancelable: true })); });
  // 놓는 순간의 배율로 — 170px 은 23px/초면 c2(115~230)의 가운데 앞이라 c1|c2 경계, 20px/초였다면 c2|c3 경계(클립도 풀 카드처럼 가장 가까운 경계 — 10-23 '같게')
  dropClip(a, [170, 30]);
  expect(cuts()).toEqual(["c1", "c2", "c3"]); // 빈 첫 자리는 숨는다(2026-10-26) — c1|c2 경계에 새 자리 하나
  const moved = localStorage.getItem(DOC_KEY);
  dragClip(clipOf("a"), [50, 30], [[200, 30], [347, 30]], lane(1)); // 이제(빈 첫 자리 숨김) c1 0~115 · c2 115~230 · c3 230~345 — 맨 끝 경계(345px)
  expect(inserts()).toEqual([["1", "345px", "여기로 옮기기"]]);
  press({ key: "Escape", code: "Escape" });
  expect(inserts()).toEqual([]);
  dropClip(clipOf("a"), [347, 30]);
  expect([localStorage.getItem(DOC_KEY), clipOf("a").style.transform]).toEqual([moved, ""]);
});

it("자리 만들기를 되돌리면 재생헤드는 그 자리의 다음(이름순 보정이면 c2 로 갔다) · 다시 하면 자리가 돌아온다", () => {
  world.gens = [...world.gens, gen("z", "c3")];
  seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c2", gen: "x", track: 1 }]);
  mount();
  act(() => cutCell("c1").click());
  dragCard(poolCards()[1], lane(1), 198); // c2|c3 경계 → c1 ② 가 c3 앞에
  dropCard(198);
  expect(cuts()).toEqual(["c1 ①", "c2", "c1 ②", "c3"]);
  act(() => cutCell("c1 ②").click());
  press({ key: "z", code: "KeyZ", ctrlKey: true });
  expect(cuts()).toEqual(["c1", "c2", "c3"]);
  expect(document.querySelector(".ed-cutcell.ed-cur")?.textContent).toBe("c3");
  press({ key: "z", code: "KeyZ", ctrlKey: true, shiftKey: true });
  expect(cuts()).toEqual(["c1 ①", "c2", "c1 ②", "c3"]);
  expect(stored().v).toBe(3);
});

it("반복 자리의 마지막 클립을 빼면 자리도 없어지고 재생헤드는 그 자리의 다음으로", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c2", gen: "x", track: 1 }, { cut: "c1", slot: "abc123", gen: "b", track: 1 }],
    { cutOrder: ["e070/c1", "e070/c2", "e070/c1//abc123", "e070/c3"] });
  mount();
  const b = clipOf("b");
  fire(b, "pointerdown", { clientX: 250, clientY: 30 });
  fire(b, "pointerup", { clientX: 250, clientY: 30, buttons: 0 });
  expect(document.querySelector(".ed-cutcell.ed-cur")?.textContent).toBe("c1 ②");
  press({ key: "Delete", code: "Delete" });
  expect(cuts()).toEqual(["c1", "c2", "c3"]);
  expect(document.querySelector(".ed-cutcell.ed-cur")?.textContent).toBe("c3");
});

// ⑤ 후속(Jay 2026-10-26): "다른 트랙에 생기게 했던 클립을 다시 원래 클립으로 가져올려고 하니까 계속 끼워넣기만 된다. 본래 그 클릭이 있던 곳에는 다시
//  클립위에 쌓을수 있어야한다" · "비어있는 부분을 없앨수도 없네". 계약: docs/status/편집탭_끼워넣기_원래자리_2026-10-26.md
const drops = () => [...document.querySelectorAll<HTMLElement>(".ed-drop")].map((el) => [el.parentElement!.dataset.track, el.style.left, el.textContent]);
const repeatDoc = () => {
  world.gens = [...world.gens, gen("z", "c3")];
  seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c2", gen: "x", track: 1 }, { cut: "c1", slot: "abc123", gen: "b", track: 1 }],
    { cutOrder: ["e070/c1", "e070/c2", "e070/c1//abc123", "e070/c3"] });
  mount(); // c1 ① 0~100 · c2 100~200 · c1 ② 200~300 · c3 300~400
};

it("끼워 넣은 클립을 가로로 끌어 원래 자리 몸통의 빈 트랙에 놓으면 그 위에 쌓인다 — 떠난 자리는 사라지고 되돌리기 한 번", () => {
  repeatDoc();
  expect(cuts()).toEqual(["c1 ①", "c2", "c1 ②", "c3"]);
  dragClip(clipOf("b"), [250, 30], [[200, 30], [50, 90]], lane(2)); // c1 ① 몸통 · V2
  expect([inserts(), drops()]).toEqual([[], [["2", "1px", "V2 로 옮기기"]]]);
  dropClip(clipOf("b"), [50, 90]);
  expect(placed()).toEqual([["c1", "a", 1], ["c2", "x", 1], ["c1", "b", 2]]);
  expect(cuts()).toEqual(["c1", "c2", "c3"]);
  expect(flashed).toEqual([]);
  press({ key: "z", code: "KeyZ", ctrlKey: true });
  expect(placed()).toEqual([["c1", "a", 1], ["c2", "x", 1], ["c1②", "b", 1]]);
  press({ key: "z", code: "KeyZ", ctrlKey: true, shiftKey: true });
  expect(placed()).toEqual([["c1", "a", 1], ["c2", "x", 1], ["c1", "b", 2]]);
});

it("찬 칸이면 맞바꿈(트랙 번호가 같아도 다른 자리로) — 두 클립 모두 고른 것이 유지된다 · 다른 폴더 몸통은 지금처럼 가장 가까운 경계", () => {
  repeatDoc();
  const a = clipOf("a");
  fire(a, "pointerdown", { clientX: 50, clientY: 30, ctrlKey: true });
  fire(a, "pointerup", { clientX: 50, clientY: 30, buttons: 0 });
  const b = clipOf("b");
  underAll = [lane(1)];
  fire(b, "pointerdown", { clientX: 250, clientY: 30, ctrlKey: true }); // Ctrl 로 b 도 고른 채 끈다
  for (const x of [200, 60]) fire(b, "pointermove", { clientX: x, clientY: 30 }); // c1 ① 의 V1(a 가 있음)
  expect(drops()).toEqual([["1", "1px", "V1 와 맞바꾸기"]]);
  dropClip(b, [60, 30]);
  expect(placed()).toEqual([["c1②", "a", 1], ["c2", "x", 1], ["c1", "b", 1]]);
  expect([...document.querySelectorAll(".ed-clip.ed-sel")].map((el) => (el as HTMLElement).dataset.clip?.split("\n")[1]).sort()).toEqual(["a", "b"]);
  // 다른 폴더(c2) 몸통 — 지금처럼 가장 가까운 경계(띠)
  dragClip(clipOf("a"), [250, 30], [[200, 30], [130, 30]], lane(1));
  expect([inserts().length, drops()]).toEqual([1, []]);
});

it("맞바꿈 — 서로 다른 시작점·길이·속도가 그대로 따라가고, 되돌리기 한 번에 둘 다 돌아오고 다시 하면 다시 맞바뀐다", () => {
  world.gens = [...world.gens, gen("z", "c3")];
  const a = { cut: "c1", gen: "a", track: 1, kind: "video" as const, dur: 8, head: 1, trim: 4, speed: 2 };
  const b = { cut: "c1", slot: "abc123", gen: "b", track: 1, kind: "video" as const, dur: 9, trim: 6, speed: 0.5 };
  seed([a, { cut: "c2", gen: "x", track: 1 }, b], { cutOrder: ["e070/c1", "e070/c2", "e070/c1//abc123", "e070/c3"] });
  mount(); // c1 ① 0~2s(40px) · c2 40~140 · c1 ② 140~380(12s) · c3
  const edits = () => stored().clips.filter((clip: { gen: string }) => clip.gen !== "x")
    .map((clip: { gen: string; slot?: string; head?: number; trim?: number; speed?: number; track: number }) => [clip.gen, clip.slot ?? "", clip.track, clip.head ?? 0, clip.trim, clip.speed]);
  dragClip(clipOf("b"), [250, 30], [[200, 30], [20, 30]], lane(1)); // c1 ① 의 V1(a)
  expect(drops()).toEqual([["1", "1px", "V1 와 맞바꾸기"]]);
  dropClip(clipOf("b"), [20, 30]);
  expect(edits()).toEqual([["a", "abc123", 1, 1, 4, 2], ["b", "", 1, 0, 6, 0.5]]);
  press({ key: "z", code: "KeyZ", ctrlKey: true });
  expect(edits()).toEqual([["a", "", 1, 1, 4, 2], ["b", "abc123", 1, 0, 6, 0.5]]);
  press({ key: "z", code: "KeyZ", ctrlKey: true, shiftKey: true });
  expect(edits()).toEqual([["a", "abc123", 1, 1, 4, 2], ["b", "", 1, 0, 6, 0.5]]);
});

it("맞바꿀 상대의 생성물이 떠나는 자리에 이미 있으면 힌트도 '놓을 수 없음' — 명령과 같은 판정, 문서 그대로", () => {
  world.gens = [...world.gens, gen("z", "c3")];
  // 첫 자리 a(V1)·x 대신 같은 폴더의 b(V2) · 반복 자리 b(V1) — a 를 반복 자리 V1 로 끌면 b 가 첫 자리로 와야 하는데 첫 자리에 이미 b 가 있다
  seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c1", gen: "b", track: 2 }, { cut: "c2", gen: "x", track: 1 }, { cut: "c1", slot: "abc123", gen: "b", track: 1 }],
    { cutOrder: ["e070/c1", "e070/c2", "e070/c1//abc123", "e070/c3"] });
  mount();
  const before = localStorage.getItem(DOC_KEY);
  dragClip(clipOf("a"), [50, 30], [[120, 30], [250, 30]], lane(1)); // c1 ② 의 V1(b)
  expect(drops()).toEqual([["1", "201px", "같은 생성물이 있어 놓을 수 없음"]]);
  dropClip(clipOf("a"), [250, 30]);
  expect(localStorage.getItem(DOC_KEY)).toBe(before);
});

it("도착 칸에 편집값이 다른 같은 생성물 — 놓을 수 없음 · 문서·고른 것·되돌리기 이력 그대로", () => {
  world.gens = [...world.gens, gen("z", "c3")];
  seed([{ cut: "c1", gen: "a", track: 1, kind: "video", dur: 8, trim: 3 }, { cut: "c2", gen: "x", track: 1 },
    { cut: "c1", slot: "abc123", gen: "a", track: 1, kind: "video", dur: 8, speed: 2 }],
  { cutOrder: ["e070/c1", "e070/c2", "e070/c1//abc123", "e070/c3"] });
  mount(); // c1 ① 0~60 · c2 60~160 · c1 ② 160~240
  const before = localStorage.getItem(DOC_KEY);
  const again = [...document.querySelectorAll<HTMLElement>(".ed-clip")].find((el) => el.dataset.clip?.startsWith("e070/c1//"))!;
  dragClip(again, [200, 30], [[150, 30], [30, 30]], lane(1)); // c1 ① 의 V1(편집값이 다른 같은 a)
  expect(drops()).toEqual([["1", "1px", "같은 생성물이 있어 놓을 수 없음"]]);
  dropClip(again, [30, 30]);
  expect(localStorage.getItem(DOC_KEY)).toBe(before);
  expect([...document.querySelectorAll(".ed-clip.ed-sel")].map((el) => (el as HTMLElement).dataset.clip)).toEqual([again.dataset.clip]); // 고른 것 그대로
  press({ key: "z", code: "KeyZ", ctrlKey: true }); // 되돌릴 단계가 생기지 않았다
  expect(localStorage.getItem(DOC_KEY)).toBe(before);
});

it("풀 카드를 같은 폴더의 다른 자리에 — 도착 칸의 교체·지금 여기·잠김이 그 자리 기준이고 놓은 결과도 같다", () => {
  repeatDoc(); // c1 ①(a V1) · c2 · c1 ②(b V1) · c3
  act(() => cutCell("c1 ①").click());
  const cardOf = (text: string) => poolCards()[text === "prompt a" ? 0 : 1]; // 풀 = c1 의 a·b(목록 순서)
  dragCard(cardOf("prompt b"), lane(1), 250); // c1 ② 의 V1 = b 자신
  expect(drops()).toEqual([["1", "201px", "지금 여기"]]);
  dropCard(250);
  dragCard(cardOf("prompt a"), lane(1), 250); // c1 ② 의 V1(b 가 있음) — 교체
  expect(drops()).toEqual([["1", "201px", "V1 교체"]]);
  dropCard(250);
  expect(placed()).toEqual([["c1", "a", 1], ["c2", "x", 1], ["c1②", "a", 1]]);
  act(() => [...document.querySelectorAll<HTMLButtonElement>(".ed-h-v button")].find((btn) => btn.getAttribute("aria-label") === "트랙 잠그기"
    && btn.closest(".ed-h-v")!.textContent!.includes("V2"))!.click()); // V2 잠금
  const before = localStorage.getItem(DOC_KEY);
  dragCard(cardOf("prompt b"), lane(2), 250);
  expect(drops()).toEqual([["2", "201px", "잠김 — 놓을 수 없음"]]);
  dropCard(250);
  expect(localStorage.getItem(DOC_KEY)).toBe(before);
});

it("같은 생성물이 그 자리에 있으면 놓을 수 없음 — 문서 그대로", () => {
  world.gens = [...world.gens, gen("z", "c3")];
  seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c2", gen: "x", track: 1 }, { cut: "c1", slot: "abc123", gen: "a", track: 1 }],
    { cutOrder: ["e070/c1", "e070/c2", "e070/c1//abc123", "e070/c3"] });
  mount();
  const before = localStorage.getItem(DOC_KEY);
  const again = [...document.querySelectorAll<HTMLElement>(".ed-clip")].find((el) => el.dataset.clip?.startsWith("e070/c1//"))!;
  dragClip(again, [250, 30], [[200, 30], [50, 90]], lane(2));
  expect(drops()).toEqual([["2", "1px", "같은 생성물이 있어 놓을 수 없음"]]);
  dropClip(again, [50, 90]);
  expect(localStorage.getItem(DOC_KEY)).toBe(before);
});

it("풀 카드도 같은 폴더의 다른 자리 몸통이면 그 자리에 넣는다(강조 칸·교체 판정이 그 자리)", () => {
  repeatDoc();
  act(() => cutCell("c1 ①").click()); // 풀 = c1 의 카드
  const card = poolCards().find((item) => item.textContent?.includes("prompt a")) ?? poolCards()[0];
  dragCard(card, lane(2), 250); // c1 ② 몸통 · V2
  expect(drops()).toEqual([["2", "201px", "V2 에 넣기"]]);
  dropCard(250);
  expect(placed()).toContainEqual(["c1②", "a", 2]);
});

it("빈 첫 자리는 보이지 않는다 — 그림의 C0110 ③ · 왼쪽 폴더를 누르면 그 폴더의 보이는 자리로 · 숨는 순간 재생헤드는 그 다음 자리로", () => {
  world.gens = [...world.gens, gen("z", "c3")];
  seed([{ cut: "c1", slot: "aaa111", gen: "a", track: 1 }, { cut: "c1", slot: "bbb222", gen: "b", track: 2 }, { cut: "c2", gen: "x", track: 1 }],
    { cutOrder: ["e070/c1//aaa111", "e070/c1//bbb222", "e070/c1", "e070/c2", "e070/c3"] });
  mount();
  expect(cuts()).toEqual(["c1 ①", "c1 ②", "c2", "c3"]);
  act(() => cutCell("c3").click());
  act(() => [...document.querySelectorAll<HTMLButtonElement>(".ed-side .folder-tree-row")].find((row) => row.textContent?.includes("c1"))!.click());
  expect(document.querySelector(".ed-cutcell.ed-cur")?.textContent).toBe("c1 ①");
});

it("첫 자리의 유일한 클립을 옮기면 첫 자리가 숨고, 거기 서 있던 재생헤드는 그 다음 자리로", () => {
  world.gens = [...world.gens, gen("z", "c3")];
  seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c2", gen: "x", track: 1 }]);
  mount();
  const a = clipOf("a");
  fire(a, "pointerdown", { clientX: 50, clientY: 30 });
  fire(a, "pointerup", { clientX: 50, clientY: 30, buttons: 0 });
  expect(document.querySelector(".ed-cutcell.ed-cur")?.textContent).toBe("c1");
  dragClip(clipOf("a"), [50, 30], [[150, 30], [298, 30]], lane(1)); // 맨 끝 경계
  dropClip(clipOf("a"), [298, 30]);
  expect(cuts()).toEqual(["c2", "c3", "c1"]);
  expect(document.querySelector(".ed-cutcell.ed-cur")?.textContent).toBe("c2");
});

it("반복 자리에서 연 폴더 창 — 그 자리가 사라지면 남은 반복 자리로 넣는다(숨은 첫 자리를 되살리지 않는다)", () => {
  world.gens = [...world.gens, gen("z", "c3")];
  seed([{ cut: "c1", slot: "aaa111", gen: "a", track: 1 }, { cut: "c1", slot: "bbb222", gen: "b", track: 1 }, { cut: "c2", gen: "x", track: 1 }],
    { cutOrder: ["e070/c1//aaa111", "e070/c2", "e070/c1//bbb222", "e070/c3"] });
  mount();
  expect(cuts()).toEqual(["c1 ①", "c2", "c1 ②", "c3"]);
  act(() => cutCell("c1 ②").dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 250 })));
  expect(opened.at(-1)?.path).toBe("e070/c1");
  mount("e070/c1");
  const b = clipOf("b");
  fire(b, "pointerdown", { clientX: 250, clientY: 30 });
  fire(b, "pointerup", { clientX: 250, clientY: 30, buttons: 0 });
  press({ key: "Delete", code: "Delete" }); // c1 ② 가 사라진다
  expect(cuts()).toEqual(["c1", "c2", "c3"]);
  act(() => cardMenuRef.current!({ id: "b" }, 30, 40));
  act(() => [...document.querySelectorAll<HTMLButtonElement>(".ed-tmenu-item")].find((item) => item.textContent!.includes("V2"))!.click());
  expect(placed()).toEqual([["c1②", "a", 1], ["c2", "x", 1], ["c1②", "b", 2]]); // 남은 반복 자리(aaa111)에 — 첫 자리가 아니다
  expect(stored().clips.find((clip: { gen: string; slot?: string }) => clip.gen === "b").slot).toBe("aaa111");
  expect(cuts()).toEqual(["c1", "c2", "c3"]);
});
