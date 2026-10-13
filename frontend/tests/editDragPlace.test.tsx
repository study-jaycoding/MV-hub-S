// @vitest-environment jsdom
// 편집 탭(Jay 2026-10-13) — 풀의 카드를 끌어 타임라인에 넣기 · 컷(폴더) 머리 칸을 끌어 순서 바꾸기.
//  jsdom 에는 배치가 없다: 포인터 밑의 요소(document.elementFromPoint)는 시험이 정하고, 컷 칸의 자리는 style 의 left·width 로 읽는다
//  (타임라인의 가로 자리 = clientX / zoom — getBoundingClientRect 가 0 을 준다).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditCardMenu, EditCutFolder } from "../src/components/timeline/EditTab";
import type { EditTree } from "../src/lib/useEditSequence";
import type { Generation } from "../src/types";

const gen = (id: string, cut: string, extra: Partial<Generation> = {}) => ({
  id, job_id: `job-${id}`, status: "done", params: {}, prompt: `prompt ${id}`, folder_path: `e070/${cut}`,
  shared: true, is_final: false, is_held: false, is_mine: false, creator_name: "리버",
  assets: [{ id: `a-${id}`, generation_id: id, type: "image", file_path: `/media/${id}.png`,
    thumbnail_path: null, source_url: null, cached: true }],
  ...extra,
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

let host: HTMLDivElement;
let root: Root;
const opened: EditCutFolder[] = [];
const flashed: string[] = [];
const cardMenuRef: { current: EditCardMenu | null } = { current: null };
const mount = () => act(() => root.render(
  <EditTab authKey="auth" authReady workspace={{ scope: "team", id: "w1", name: "W" }} keysActive
    flash={(message: string) => { flashed.push(message); }} onOpenCutFolder={(target) => { opened.push(target); }} reloadSignal={0}
    peekPath={null} onPeekMarks={() => {}} cardMenuRef={cardMenuRef} onPreview={() => {}} onCompare={() => {}}
    resolve={{ send: () => {}, sendTimeline: () => new Promise<never>(() => {}), busy: false, pendingCount: 0, timelineBusy: false }}
    onFolderAction={() => {}} />,
));
// 그 컷에서 시작한다 — 재생헤드의 마지막 자리는 시험 사이에도 남는다(useEditPlayback 의 lastPos). 풀은 재생헤드가 있는 컷을 보여 준다
const mountOn = (name: string) => {
  mount();
  act(() => [...document.querySelectorAll<HTMLButtonElement>(".ed-cutcell")].find((cell) => cell.textContent === name)!.click());
};
const DOC_KEY = "mvhub.editDoc:local:p1:e070";
const seed = (clips: { cut: string; gen: string; track: number }[], extra: Record<string, unknown> = {}) =>
  localStorage.setItem(DOC_KEY, JSON.stringify({
    v: 1, tracksOff: [], tracksLocked: [], ...extra,
    clips: clips.map((clip) => ({ kind: "image", dur: 5, ...clip, cut: `e070/${clip.cut}` })),
  }));
const stored = () => JSON.parse(localStorage.getItem(DOC_KEY) ?? "null");
const storedTracks = () => (stored()?.clips ?? []).map((clip: { gen: string; track: number }) => [clip.gen, clip.track]);
const timecode = () => document.querySelector(".ed-tc")!.textContent;
const cuts = () => [...document.querySelectorAll(".ed-cutcell")].map((cell) => cell.textContent);
const cutCell = (name: string) => [...document.querySelectorAll<HTMLButtonElement>(".ed-cutcell")].find((cell) => cell.textContent === name)!;
const poolCards = () => [...document.querySelectorAll<HTMLButtonElement>(".ed-pool .ed-card")];
const lane = (track: number) => document.querySelector<HTMLElement>(`.ed-lane[data-track="${track}"]`)!;
const ghost = () => document.querySelector<HTMLElement>(".ed-ghost");
const drops = () => [...document.querySelectorAll<HTMLElement>(".ed-drop")].map((item) => [item.parentElement!.dataset.track, item.textContent]);
const playing = () => !!document.querySelector('.ed-top > .ed-view[data-view="timeline"] .ed-play rect');
const fire = (target: EventTarget, type: string, init: MouseEventInit = {}) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
};
const press = (init: KeyboardEventInit) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => { document.body.dispatchEvent(event); });
  return event;
};
let under: Element | null = null; // 포인터 바로 밑에 보이는 요소
// 카드를 눌러 끌기 — 끝내는 것(놓기·Esc·창이 초점을 잃음)은 시험이 한다
const dragCard = (card: Element, over: Element | null) => {
  fire(card, "mousedown", { clientX: 10, clientY: 10 });
  under = over;
  fire(window, "mousemove", { clientX: 60, clientY: 80 });
};
const dropCard = () => fire(window, "mouseup", { clientX: 60, clientY: 80, buttons: 0 });
// 컷 칸의 가로 자리(px)
const left = (name: string) => parseFloat(cutCell(name).style.left);
const right = (name: string) => left(name) + parseFloat(cutCell(name).style.width);
const dragCut = (name: string, toX: number) => {
  const cell = cutCell(name);
  fire(cell, "pointerdown", { clientX: left(name) + 2 });
  fire(cell, "pointermove", { clientX: toX });
  return cell;
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem("ch.editTimeline.last:local", JSON.stringify({ projectId: "p1", seq: "e070" }));
  for (const method of ["load", "pause"] as const) vi.spyOn(HTMLMediaElement.prototype, method).mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  // jsdom 에는 포인터 쥐기가 없다 — 쥔 요소를 기억해 hasPointerCapture 가 참을 주게 한다(컷 머리 끌기가 그것을 본다)
  const held = new Set<Element>();
  Object.assign(Element.prototype, {
    setPointerCapture(this: Element) { held.add(this); },
    hasPointerCapture(this: Element) { return held.has(this); },
    releasePointerCapture(this: Element) { held.delete(this); },
  });
  under = null;
  document.elementFromPoint = () => under;
  world.gens = [gen("a", "c1"), gen("b", "c1"), gen("x", "c2")];
  opened.length = 0;
  flashed.length = 0;
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

it("풀의 카드를 끌어 트랙 줄에 놓으면 그 컷의 그 트랙에 들어간다 — 빈 칸은 넣기, 찬 칸은 교체, 지금 있는 트랙·잠긴 트랙은 아무 일도 없다", () => {
  seed([], { tracksLocked: [3] });
  mountOn("c1");
  const [a, b] = poolCards();
  expect(a.title).toContain("끌기 = 타임라인에 넣기");

  fire(a, "mousedown", { clientX: 10, clientY: 10 }); // 5px 을 안 넘으면 끌기가 아니다 — 누르기(고르기) 그대로
  fire(window, "mousemove", { clientX: 12, clientY: 12 });
  expect(ghost()).toBeNull();
  dropCard();
  act(() => a.click());
  expect(poolCards()[0].classList.contains("ed-picked")).toBe(true);

  dragCard(a, null); // 줄 밖 — 유령만 따라온다
  expect(ghost()!.textContent).toBe("트랙 줄 위에 놓으세요");
  expect(ghost()!.style.transform).toBe("translate(74px, 94px)");
  expect(drops()).toEqual([]);
  under = lane(2); // 줄 위 — 그 카드의 컷(c1) 칸이 강조되고 무엇이 될지 적힌다
  fire(window, "mousemove", { clientX: 61, clientY: 80 });
  expect(drops()).toEqual([["2", "V2 에 넣기"]]);
  expect(ghost()!.textContent).toBe("V2 에 넣기");
  dropCard();
  expect(storedTracks()).toEqual([["a", 2]]);
  expect([ghost(), drops()]).toEqual([null, []]);
  act(() => poolCards()[0].click()); // 끌기에 딸려 온 click 은 누르기가 아니다 — 고른 것이 뒤집히지 않는다
  expect(poolCards()[0].classList.contains("ed-picked")).toBe(true);

  dragCard(b, lane(2)); // 찬 칸 = 교체(휠 클릭 메뉴와 같다)
  expect(drops()).toEqual([["2", "V2 교체"]]);
  dropCard();
  expect(storedTracks()).toEqual([["b", 2]]);

  dragCard(poolCards()[1], lane(2)); // 이미 그 트랙에 있다 — 놓아도 그대로(되돌리기 단계·실패 알림 없음)
  expect(drops()).toEqual([["2", "지금 여기"]]);
  dropCard();
  dragCard(poolCards()[0], lane(3)); // 잠긴 트랙
  expect(drops()).toEqual([["3", "잠김 — 놓을 수 없음"]]);
  dropCard();
  dragCard(poolCards()[0], document.querySelector(".ed-lane.ed-l-a")); // 소리 줄은 놓을 곳이 아니다
  expect(drops()).toEqual([]);
  dropCard();
  expect(storedTracks()).toEqual([["b", 2]]);
  expect(flashed).toEqual([]);
  press({ key: "z", code: "KeyZ", ctrlKey: true }); // 되돌리기 = 교체 한 단계
  expect(storedTracks()).toEqual([["a", 2]]);
});

it("카드 끌기: 시작하면 재생이 멈추고 끄는 동안 키는 쉰다 — Esc·창이 초점을 잃음·카드가 목록에서 사라짐은 버린다", () => {
  mountOn("c1");
  act(() => document.querySelector<HTMLButtonElement>('.ed-top > .ed-view[data-view="timeline"] .ed-play')!.click());
  expect(playing()).toBe(true);
  dragCard(poolCards()[0], lane(1));
  expect(playing()).toBe(false); // 끌기가 시작되면 멈춘다
  press({ key: " ", code: "Space" }); // 끄는 동안 재생·편집 키는 쉰다
  expect(playing()).toBe(false);
  press({ key: "Escape", code: "Escape" }); // Esc = 버림
  expect([ghost(), drops()]).toEqual([null, []]);
  dropCard(); // 버린 뒤의 놓기는 아무것도 넣지 않는다
  expect(stored()).toBeNull();

  dragCard(poolCards()[0], lane(1));
  act(() => { window.dispatchEvent(new Event("blur")); }); // 창이 초점을 잃었다
  expect(ghost()).toBeNull();
  expect(stored()).toBeNull();

  dragCard(poolCards()[0], lane(1));
  world.gens = [gen("b", "c1"), gen("x", "c2")]; // 끄는 사이 그 카드가 공유 목록에서 빠졌다
  mount();
  expect(ghost()).toBeNull();
  dropCard();
  expect(stored()).toBeNull();
  expect(flashed).toEqual([]);
});

it("카드 위에서도 Ctrl·Shift 를 누른 채 끌면 지금처럼 상자 고르기다 — 카드를 끌어 넣지 않는다", () => {
  mountOn("c1");
  fire(poolCards()[0], "mousedown", { clientX: 10, clientY: 10, ctrlKey: true });
  under = lane(1);
  fire(window, "mousemove", { clientX: 60, clientY: 80, ctrlKey: true });
  expect(ghost()).toBeNull();
  expect(document.querySelector(".ed-pool .assets-marquee")).not.toBeNull();
  dropCard();
  expect(stored()).toBeNull();
});

it("컷 머리 칸을 끌면 폴더 순서가 바뀐다 — 끼울 자리에 줄이 서고, 놓으면 한 단계로 적히며, 알약을 누르면 이름순으로 돌아간다", () => {
  mount();
  expect(cuts()).toEqual(["c1", "c2", "c3"]);
  act(() => cutCell("c2").click()); // 재생헤드를 c2 로 — 끈 뒤에 딸려 오는 click 이 먹었는지 이것으로 본다
  expect(timecode()).toBe("00:00:05:00");

  const cell = dragCut("c1", right("c3") + 4); // 맨 뒤로
  expect(cell.classList.contains("ed-cutdrag")).toBe(true);
  expect(document.querySelector<HTMLElement>(".ed-cutdrop")!.style.left).toBe(`${right("c3")}px`);
  fire(cell, "pointerup", { buttons: 0 });
  expect(cuts()).toEqual(["c2", "c3", "c1"]);
  expect(stored().cutOrder).toEqual(["e070/c2", "e070/c3", "e070/c1"]);
  expect(document.querySelector(".ed-cutdrop")).toBeNull();
  expect(timecode()).toBe("00:00:00:00"); // 재생헤드는 보던 컷(c2)에 그대로 — c2 가 맨 앞이 됐다
  act(() => cutCell("c1").click()); // 그 끌기에 딸린 click — c1 로 가지 않는다
  expect(timecode()).toBe("00:00:00:00");
  act(() => cutCell("c1").click()); // 그다음 누르기는 누르기다
  expect(timecode()).toBe("00:00:10:00");

  const chip = () => document.querySelector<HTMLButtonElement>(".ed-orderchip");
  expect(chip()!.textContent).toBe("폴더 순서: 내 순서 ↺");
  press({ key: "z", code: "KeyZ", ctrlKey: true }); // 되돌리기 한 단계
  expect(cuts()).toEqual(["c1", "c2", "c3"]);
  expect(chip()).toBeNull();
  press({ key: "z", code: "KeyZ", ctrlKey: true, shiftKey: true });
  expect(cuts()).toEqual(["c2", "c3", "c1"]);
  act(() => chip()!.click()); // 이름순으로
  expect(cuts()).toEqual(["c1", "c2", "c3"]);
  expect(stored().cutOrder).toBeUndefined();
  expect(flashed).toEqual([]);
});

it("컷 머리 끌기: 제자리면 아무 일도 없고, Esc·놓친 놓기는 버리며, 끈 직후의 더블클릭은 폴더 창을 열지 않는다", () => {
  mountOn("c1");
  let cell = dragCut("c1", left("c2") + 3); // c2 의 가운데를 못 넘었다 — 제자리
  expect(document.querySelector(".ed-cutdrop")).toBeNull();
  fire(cell, "pointerup", { buttons: 0 });
  expect(stored()).toBeNull();

  cell = dragCut("c1", right("c3") + 4);
  expect(document.querySelector(".ed-cutdrop")).not.toBeNull();
  press({ key: "Escape", code: "Escape" }); // Esc = 버림
  expect(document.querySelector(".ed-cutdrop")).toBeNull();
  fire(cell, "pointerup", { buttons: 0 });
  expect(cuts()).toEqual(["c1", "c2", "c3"]);

  cell = dragCut("c1", right("c3") + 4);
  fire(cell, "pointermove", { clientX: right("c3") + 6, buttons: 0 }); // 단추가 떼어진 채 온 움직임 — 놓는 이벤트를 놓쳤다
  expect(document.querySelector(".ed-cutdrop")).toBeNull();
  expect(stored()).toBeNull();

  cell = dragCut("c3", left("c1") + 1); // 맨 앞으로
  fire(cell, "pointerup", { buttons: 0 });
  expect(cuts()).toEqual(["c3", "c1", "c2"]);
  fire(cutCell("c3"), "dblclick"); // 끌기 + 한 번 누르기를 브라우저가 두 번 누름으로 셌다 — 폴더 창을 열지 않는다
  expect(opened).toEqual([]);
  act(() => { vi.advanceTimersByTime(600); });
  fire(cutCell("c3"), "dblclick"); // 보통의 더블클릭은 그대로 연다
  expect(opened.map((item) => item.path)).toEqual(["e070/c3"]);
  expect(flashed).toEqual([]); // 제자리에 놓은 것·버린 것은 '바꾸지 못했습니다'가 아니다
});

// 끄는 사이 다른 창이 이 편집을 저장했다(이 창은 그것을 받아들인다 — 문서의 rev 가 바뀐다). 끌기를 시작한 문서가 아니므로 버린다.
//  클립 끌기는 놓을 때 낡은 rev 로 오는데, 그것을 '잠긴 트랙이 있거나 옮길 자리가 없습니다'로 알리던 것도 여기서 본다(Codex 3회째 P3).
it("끄는 사이 다른 창이 이 편집을 바꾸면 카드·컷·클립 끌기를 말없이 버린다", () => {
  const otherWindowSaves = (clips: { cut: string; gen: string; track: number }[]) => {
    seed(clips);
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key: DOC_KEY })); });
  };
  seed([{ cut: "c1", gen: "a", track: 1 }]);
  mountOn("c1");

  dragCard(poolCards()[1], lane(2));
  expect(drops()).toEqual([["2", "V2 에 넣기"]]);
  otherWindowSaves([{ cut: "c1", gen: "a", track: 3 }]);
  expect([ghost(), drops()]).toEqual([null, []]);
  dropCard();
  expect(storedTracks()).toEqual([["a", 3]]);

  const cell = dragCut("c1", right("c3") + 4);
  expect(document.querySelector(".ed-cutdrop")).not.toBeNull();
  otherWindowSaves([{ cut: "c1", gen: "a", track: 2 }]);
  expect(document.querySelector(".ed-cutdrop")).toBeNull();
  fire(cell, "pointerup", { buttons: 0 });
  expect(cuts()).toEqual(["c1", "c2", "c3"]);

  // 클립 끌기 — 다른 창이 **다른 클립**을 바꿨다(끌던 클립은 제 줄에 그대로라 놓기가 온다)
  otherWindowSaves([{ cut: "c1", gen: "a", track: 2 }, { cut: "c2", gen: "x", track: 1 }]);
  const clip = lane(2).querySelector<HTMLElement>(".ed-clip")!;
  document.elementsFromPoint = () => [lane(1)];
  fire(clip, "pointerdown", { clientY: 10 });
  fire(clip, "pointermove", { clientY: 90 });
  otherWindowSaves([{ cut: "c1", gen: "a", track: 2 }, { cut: "c2", gen: "x", track: 3 }]);
  expect(lane(2).querySelector(".ed-clip")).toBe(clip);
  fire(clip, "pointerup", { clientY: 90, buttons: 0 });
  expect(storedTracks()).toEqual([["a", 2], ["x", 3]]); // 다른 창의 것 그대로 — 그 위에 옛 끌기를 얹지 않는다
  expect(flashed.filter((message) => message.includes("바꾸지 못했습니다"))).toEqual([]);
});
