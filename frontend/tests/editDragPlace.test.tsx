// @vitest-environment jsdom
// 편집 탭(Jay 2026-10-13) — 풀의 카드를 끌어 타임라인에 넣기 · 컷(폴더) 머리 칸을 끌어 순서 바꾸기.
//  jsdom 에는 배치가 없다: 포인터 밑의 요소(document.elementFromPoint)는 시험이 정하고, 컷 칸의 자리는 style 의 left·width 로 읽는다
//  (타임라인의 가로 자리 = clientX / zoom — getBoundingClientRect 가 0 을 준다).
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditCardMenu, EditCutFolder } from "../src/components/timeline/EditTab";
import type { EditTree } from "../src/lib/useEditSequence";
import type { Generation } from "../src/types";

const gen = (id: string, cut: string, extra: Partial<Generation> = {}) => ({
  id, job_id: `job-${id}`, status: "done", params: {}, prompt: `prompt ${id}`, folder_path: `e070/${cut}`,
  shared: true, is_final: false, is_held: false, is_mine: false, tags: [], creator_name: "리버",
  assets: [{ id: `a-${id}`, generation_id: id, type: "image", file_path: `/media/${id}.png`,
    thumbnail_path: null, source_url: null, cached: true }],
  ...extra,
} as unknown as Generation);

const world = vi.hoisted(() => ({ gens: [] as unknown[], disabled: {} as Record<string, string[]> }));
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
vi.mock("../src/lib/useDisabledFolders", () => ({ useDisabledFolders: () => world.disabled }));

import { EditTab } from "../src/components/timeline/EditTab";

let host: HTMLDivElement;
let root: Root;
const opened: EditCutFolder[] = [];
const flashed: string[] = [];
const cardMenuRef: { current: EditCardMenu | null } = { current: null };
const previewed: string[] = [];
// 풀 카드의 호버 단추가 부르는 앱의 동작(라이브러리 격자에 주는 것과 같은 것) — 부른 것만 적는다
const newCardActions = () => ({
  canFinalize: () => true, onReview: vi.fn(), onPublish: vi.fn(), onUnpublish: vi.fn(), onFinalize: vi.fn(), onUnfinalize: vi.fn(),
  onSetTags: vi.fn(), onSetAutoTags: vi.fn(), autoTagOptions: [] as string[], onOpenComments: vi.fn(), onInfo: vi.fn(),
});
let cardActions = newCardActions();
const mount = () => act(() => root.render(
  <EditTab authKey="auth" authReady workspace={{ scope: "team", id: "w1", name: "W" }} keysActive
    flash={(message: string) => { flashed.push(message); }} onOpenCutFolder={(target) => { opened.push(target); }} reloadSignal={0}
    peekPath={null} onPeekMarks={() => {}} cardMenuRef={cardMenuRef} onPreview={(target) => { previewed.push(target.genId ?? ""); }}
    onCompare={() => {}}
    resolve={{ send: () => {}, sendTimeline: () => new Promise<never>(() => {}), busy: false, pendingCount: 0, timelineBusy: false }}
    onFolderAction={() => {}} cardActions={cardActions} />,
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
  // jsdom 에는 ResizeObserver 가 없다 — 길이 조절 창(떠 있는 창, lib/useFloatingPanel)이 쓴다
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  under = null;
  document.elementFromPoint = () => under;
  world.gens = [gen("a", "c1"), gen("b", "c1"), gen("x", "c2")];
  world.disabled = {};
  opened.length = 0;
  flashed.length = 0;
  previewed.length = 0;
  cardActions = newCardActions();
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

// Jay 2026-10-14 — 뷰어에 끌어 놓으면 '트랙 줄 위에 놓으세요'만 뜨고 아무 일이 없었다. 오후: 두 판이면 놓은 판이 바뀌어야 한다
//  ("우측은 타임라인이 고정되어서 드래그해서 넣어도 바뀌지가 않는다").
it("풀의 카드를 뷰어에 놓으면 놓은 판이 그 카드를 소스 클립으로 본다 — 편집 문서는 그대로 · 뷰어 밖은 아무 일도 없다", () => {
  mountOn("c1");
  const viewer = (mode: string) => document.querySelector<HTMLElement>(`.ed-top > .ed-view[data-view="${mode}"]:not([hidden])`);
  const picked = () => poolCards().map((card) => card.classList.contains("ed-picked"));
  expect([viewer("timeline"), viewer("source")].map(Boolean)).toEqual([true, false]); // 싱글 뷰어 = 타임라인

  dragCard(poolCards()[1], viewer("timeline")!.firstElementChild);
  expect(ghost()!.textContent).toBe("놓으면 소스 클립으로 봅니다");
  expect(ghost()!.classList.contains("ed-ghost-view")).toBe(true);
  expect(drops()).toEqual([]);
  dropCard();
  expect([viewer("timeline"), viewer("source")].map(Boolean)).toEqual([false, true]); // 놓은 판이 소스 클립이 됐다
  expect(picked()).toEqual([false, true]);
  expect(poolCards().map((card) => card.querySelector(".card-bottom")?.textContent ?? "")).toEqual(["", "소스"]); // 싱글 = '소스'(판 이름 없이)

  dragCard(poolCards()[0], viewer("source")); // 뷰어 밖(줄도 아님)으로 옮겨 놓으면 아무 일도 없다
  under = null;
  fire(window, "mousemove", { clientX: 61, clientY: 80 });
  expect(ghost()!.textContent).toBe("트랙 줄 위에 놓으세요");
  dropCard();
  expect(picked()).toEqual([false, true]);
  expect([stored(), flashed]).toEqual([null, []]);
});

it("뷰어에 놓기: 두 판이면 놓은 판만 바뀐다 — 타임라인 판·소스 테이프 판·소스 클립 판 모두, 다른 판은 그대로", () => {
  localStorage.setItem("ch.editTimeline.ui", JSON.stringify({ dual: true, views: ["source", "timeline"] }));
  mountOn("c1");
  const shown = () => [...document.querySelectorAll<HTMLElement>(".ed-top > .ed-view:not([hidden])")]
    .sort((a, b) => Number(a.style.order) - Number(b.style.order));
  const modes = () => shown().map((item) => item.dataset.view);
  const media = () => shown().map((item) => item.querySelector(".ed-stage > .ed-media:not([hidden])")?.getAttribute("src") ?? null);
  expect(modes()).toEqual(["source", "timeline"]);

  dragCard(poolCards()[0], shown()[0]); // 왼쪽(소스 클립)에 a
  dropCard();
  dragCard(poolCards()[1], shown()[1]); // 오른쪽(타임라인)에 b — 오른쪽이 소스 클립이 되고 왼쪽은 a 그대로(Jay 의 경우)
  dropCard();
  expect([modes(), media()]).toEqual([["source", "source"], ["/media/a.png", "/media/b.png"]]);
  expect(shown().map((item) => item.classList.contains("ed-view-on"))).toEqual([false, true]); // 놓은 판이 재생 키를 받는다

  dragCard(poolCards()[0], shown()[1]); // 소스 클립 판에 다시 놓으면 그 판만
  dropCard();
  expect(media()).toEqual(["/media/a.png", "/media/a.png"]);

  act(() => { localStorage.setItem("ch.editTimeline.ui", JSON.stringify({ dual: true, views: ["tape", "timeline"] })); });
  act(() => root.unmount());
  root = createRoot(host);
  mountOn("c1");
  expect(modes()).toEqual(["tape", "timeline"]);
  dragCard(poolCards()[1], shown()[0]); // 소스 테이프 판에 놓으면 그 판이 소스 클립으로(테이프는 이어서 틀고 컷을 옮기면 사라진다)
  dropCard();
  expect([modes(), media()[0]]).toEqual([["source", "timeline"], "/media/b.png"]);
  expect([stored(), flashed]).toEqual([null, []]);
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

// Codex 코드 리뷰 2회째(2026-10-13)의 셋 — 휠 단추의 놓기 · 멈춘 포인터 밑에서 바뀐 배치 · 끄는 중의 Space·Enter.
it("카드를 끄는 중에 휠 단추를 눌렀다 떼도 놓이지 않는다 — 끌기를 시작한 왼쪽 단추를 놓아야 들어간다", () => {
  seed([{ cut: "c1", gen: "b", track: 2 }]);
  mountOn("c1");
  dragCard(poolCards()[0], lane(2)); // 찬 트랙 위
  expect(drops()).toEqual([["2", "V2 교체"]]);
  fire(window, "mouseup", { button: 1, buttons: 1, clientX: 60, clientY: 80 }); // 왼쪽은 누른 채 휠 단추만 뗐다
  expect(storedTracks()).toEqual([["b", 2]]); // 교체되지 않았다
  expect(drops()).toEqual([["2", "V2 교체"]]); // 끌기는 이어진다
  fire(poolCards()[1], "auxclick", { button: 1, buttons: 1 }); // 그 휠 클릭은 '넣을 트랙' 메뉴도 아니다
  expect(document.querySelector(".ed-tmenu")).toBeNull();
  under = lane(1);
  fire(window, "mousemove", { clientX: 62, clientY: 80 }); // 리스너도 그대로다 — 움직임을 계속 받는다
  expect(drops()).toEqual([["1", "V1 에 넣기"]]);
  dropCard();
  expect(storedTracks()).toEqual([["b", 2], ["a", 1]]);
  expect(flashed).toEqual([]);
});

it("컷을 끌다 포인터를 멈춘 사이 밑의 컷이 바뀌면(휠로 넘김·배치가 밀림) 놓는 순간의 자리에 끼운다 — 끼울 자리 줄도 따라온다", () => {
  mount();
  const lanes = document.querySelector<HTMLElement>(".ed-lanes")!;
  const rect = vi.spyOn(lanes, "getBoundingClientRect");
  const scrollBy = (px: number) => rect.mockReturnValue({ left: -px } as DOMRect); // 타임라인의 가로 자리 = (clientX − 줄의 왼쪽) / 배율
  // 스크롤 칸은 넓다 — 포인터는 가장자리(저절로 넘기는 곳)가 아니다. jsdom 의 0 크기 그대로면 늘 가장자리로 읽힌다
  vi.spyOn(document.querySelector<HTMLElement>(".ed-scroll")!, "getBoundingClientRect").mockReturnValue({ left: 0, right: 5000 } as DOMRect);
  const at = left("c2") + 2; // c2 의 앞쪽 — 끼울 자리는 c2 앞(= c1 의 제자리)
  const one = right("c1") - left("c1"); // 컷 한 칸의 폭

  let cell = dragCut("c1", at);
  expect(document.querySelector(".ed-cutdrop")).toBeNull();
  scrollBy(one * 2); // 포인터는 그대로 — 그 밑은 이제 c3 의 뒤쪽이다(끼울 자리 = 맨 뒤)
  fire(cell, "pointerup", { clientX: at, buttons: 0 }); // 프레임이 돌기 전에 놓아도 놓는 순간에 다시 잰다
  expect(cuts()).toEqual(["c2", "c3", "c1"]);

  press({ key: "z", code: "KeyZ", ctrlKey: true });
  scrollBy(0);
  cell = dragCut("c1", at);
  scrollBy(one); // c2 의 가운데를 넘었다 — 끼울 자리 = c3 앞
  act(() => { vi.advanceTimersToNextFrame(); });
  expect(document.querySelector<HTMLElement>(".ed-cutdrop")!.style.left).toBe(`${left("c3")}px`);
  scrollBy(0); // 되돌아왔다 — 제자리(줄이 사라진다)
  act(() => { vi.advanceTimersToNextFrame(); });
  expect(document.querySelector(".ed-cutdrop")).toBeNull();
  fire(cell, "pointerup", { clientX: at, buttons: 0 });
  expect(cuts()).toEqual(["c1", "c2", "c3"]);
  expect(flashed).toEqual([]);
});

it("컷 끌기도 왼쪽 단추의 놓기만 확정이다 — 왼쪽을 뗀 뒤 남은 휠 단추를 떼는 것은 놓기가 아니다", () => {
  mount();
  let cell = dragCut("c1", right("c3") + 4);
  fire(cell, "pointermove", { clientX: right("c3") + 4, buttons: 4 }); // 휠 단추를 누른 채 왼쪽을 뗐다(pointerup 은 오지 않는다)
  expect(document.querySelector(".ed-cutdrop")).toBeNull();
  fire(cell, "pointerup", { button: 1, buttons: 0 });
  expect(cuts()).toEqual(["c1", "c2", "c3"]);

  cell = dragCut("c1", right("c3") + 4);
  fire(cell, "pointerup", { button: 1, buttons: 0 }); // 다른 단추의 놓기로 끝났다 — 버린다
  expect(cuts()).toEqual(["c1", "c2", "c3"]);
  expect(stored()).toBeNull();
});

it("끄는 동안 Space·Enter 는 초점이 남은 뒤의 단추를 누르지 않는다 — 그 키의 기본 동작을 막고, 끌기가 끝나면 푼다", () => {
  mountOn("c1");
  const play = document.querySelector<HTMLButtonElement>('.ed-top > .ed-view[data-view="timeline"] .ed-play')!;
  play.focus(); // 재생 단추에 초점 — 풀·타임라인의 누름은 초점을 옮기지 않는다
  const held = () => (["keydown", "keyup"] as const).flatMap((type) => [" ", "Enter"].map((key) => {
    const event = new KeyboardEvent(type, { key, bubbles: true, cancelable: true });
    act(() => { play.dispatchEvent(event); });
    return event.defaultPrevented;
  }));
  const free = [false, false, false, false];
  const blocked = [true, true, true, true];
  expect(held()).toEqual(free); // 끌지 않을 때는 그 단추의 키다

  dragCard(poolCards()[0], lane(1));
  expect(document.activeElement).toBe(play);
  expect(held()).toEqual(blocked);
  expect(playing()).toBe(false);
  dropCard();
  expect(held()).toEqual(free);

  const cell = dragCut("c1", right("c3") + 4);
  expect(held()).toEqual(blocked);
  fire(cell, "pointerup", { buttons: 0 });
  expect(held()).toEqual(free);
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
  expect(clip.style.transform).toBe(""); // 그 자리에서 걷는다 — 놓아도 버려질 끌기가 마우스를 따라다니지 않는다(Codex 4회째)
  fire(clip, "pointerup", { clientY: 90, buttons: 0 });
  expect(storedTracks()).toEqual([["a", 2], ["x", 3]]); // 다른 창의 것 그대로 — 그 위에 옛 끌기를 얹지 않는다
  expect(flashed.filter((message) => message.includes("바꾸지 못했습니다"))).toEqual([]);
});

// Codex 코드 리뷰 3회째: 끄는 중의 다른 단추는 **어느 요소 위에서든** 메뉴·창을 열지 않는다 — 풀의 카드를 끄는 채 타임라인의 클립 위에서
//  휠 클릭하면 그 클립의 길이 조절 창이 떴다(풀 쪽 가드는 풀의 카드만 봤다). 끄는 동안 auxclick·contextmenu 를 통째로 삼킨다(useDragKeyHold).
it("카드를 끄는 채 타임라인의 클립 위에서 휠 클릭·우클릭해도 길이 조절 창·클립 메뉴가 뜨지 않는다 — 끌기가 끝나면 풀린다", () => {
  // 길이 조절은 영상만이다 — V2 의 b 를 영상으로 둔다(이 파일의 기본 생성물은 그림)
  world.gens = [gen("a", "c1"), gen("b", "c1", { assets: [{ id: "a-b", generation_id: "b", type: "video", file_path: "/media/b.mp4",
    thumbnail_path: null, source_url: null, cached: true }] } as unknown as Partial<Generation>), gen("x", "c2")];
  seed([{ cut: "c1", gen: "b", track: 2 }]);
  mountOn("c1");
  const clip = () => lane(2).querySelector<HTMLElement>(".ed-clip")!;
  dragCard(poolCards()[0], lane(1));
  expect(drops()).toEqual([["1", "V1 에 넣기"]]);
  const aux = fire(clip(), "auxclick", { button: 1, buttons: 5 });
  const menu = fire(clip(), "contextmenu", { button: 2, buttons: 3 });
  expect([document.querySelector(".ed-trim"), document.querySelector(".ed-tmenu"), aux.defaultPrevented, menu.defaultPrevented])
    .toEqual([null, null, true, true]);
  expect(drops()).toEqual([["1", "V1 에 넣기"]]); // 끌기는 이어진다
  dropCard();
  expect(storedTracks()).toEqual([["b", 2], ["a", 1]]);
  fire(clip(), "auxclick", { button: 1, buttons: 0 }); // 끌기가 끝난 뒤의 휠 클릭은 창을 연다
  expect(document.querySelector(".ed-trim")).not.toBeNull();
});

// 클립 끌기(트랙 옮기기)는 끄는 중이라는 것이 ref 뿐이라 Esc 가 고른 것만 풀고 놓으면 그대로 옮겨졌고, 끄는 동안 뒤의 키가 먹었다.
it("클립 끌기: Esc 는 끌기를 버린다(놓아도 옮기지 않는다) — 끄는 동안 Delete·Space 는 뒤에서 먹지 않는다", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }]);
  mountOn("c1");
  const clip = document.querySelector<HTMLElement>(".ed-clip")!;
  const pointDoc = document as unknown as { elementsFromPoint?: unknown };
  const savedPoint = pointDoc.elementsFromPoint;
  pointDoc.elementsFromPoint = () => [lane(2)]; // 마우스 밑은 V2 — 놓기로 치면 클립이 그리로 간다
  try {
    fire(clip, "pointerdown", { clientX: 10, clientY: 100 });
    fire(clip, "pointermove", { clientX: 10, clientY: 40 });
    expect(clip.style.transform).toBe("translateY(-60px)");
    const space = press({ key: " ", code: "Space" });
    press({ key: "Delete", code: "Delete" }); // 누를 때 그 클립이 골라졌다 — 키가 먹으면 지워진다
    expect([space.defaultPrevented, playing(), storedTracks()]).toEqual([true, false, [["a", 1]]]);
    press({ key: "Escape", code: "Escape" });
    expect(clip.style.transform).toBe("");
    fire(clip, "pointerup", { clientX: 10, clientY: 40, buttons: 0 }); // 버린 뒤의 놓기
    expect(storedTracks()).toEqual([["a", 1]]);
    fire(clip, "pointerdown", { clientX: 10, clientY: 100 }); // 보통의 끌기는 그대로 옮긴다
    fire(clip, "pointermove", { clientX: 10, clientY: 40 });
    fire(clip, "pointerup", { clientX: 10, clientY: 40, buttons: 0 });
    expect(storedTracks()).toEqual([["a", 2]]);
  } finally {
    pointDoc.elementsFromPoint = savedPoint;
  }
});

// Codex 코드 리뷰 4회째(클립 끌기 P2 둘). ① 끌던 클립이 다른 창의 저장으로 사라지면 놓는 이벤트를 받을 요소가 없어 '끄는 중'(키·메뉴
//  막기)이 Esc 를 누를 때까지 남았다 — 창이 초점을 잃어도 끌기가 남았다. 걷는 길을 한 곳으로 모았다(EditTimeline 의 cancelClipDrag).
it("클립 끌기: 끌던 클립이 다른 창의 저장으로 사라지면 끌기를 걷는다 — 메뉴 막기가 남지 않는다. 창이 초점을 잃어도 버린다", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c2", gen: "x", track: 1 }]);
  mountOn("c1");
  const [mine, other] = [...lane(1).querySelectorAll<HTMLElement>(".ed-clip")];
  const pointDoc = document as unknown as { elementsFromPoint?: unknown };
  const savedPoint = pointDoc.elementsFromPoint;
  pointDoc.elementsFromPoint = () => [lane(2)]; // 마우스 밑은 V2 — 놓기로 치면 클립이 그리로 간다
  try {
    fire(mine, "pointerdown", { clientX: 10, clientY: 100 });
    fire(mine, "pointermove", { clientX: 10, clientY: 40 });
    expect(mine.style.transform).toBe("translateY(-60px)");
    fire(other, "contextmenu", { button: 2, buttons: 3 }); // 끄는 중에는 메뉴가 뜨지 않는다
    expect(document.querySelector(".ed-tmenu")).toBeNull();
    // 다른 창이 끌던 클립을 지웠다 — 이 창은 그것을 받아들인다. 쥐고 있던 요소가 없어져 놓는 이벤트는 오지 않는다
    seed([{ cut: "c2", gen: "x", track: 1 }]);
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key: DOC_KEY })); });
    const rest = lane(1).querySelector<HTMLElement>(".ed-clip")!;
    expect(lane(1).querySelectorAll(".ed-clip")).toHaveLength(1);
    fire(rest, "contextmenu", { button: 2, buttons: 0 }); // 끄는 중이 풀렸다 — 메뉴가 뜬다
    expect(document.querySelector(".ed-tmenu")).not.toBeNull();
    press({ key: "Escape", code: "Escape" });
    expect(document.querySelector(".ed-tmenu")).toBeNull();
    // 창이 초점을 잃으면(Alt+Tab) 그 끌기도 버린다 — 놓아도 옮기지 않는다
    fire(rest, "pointerdown", { clientX: 10, clientY: 100 });
    fire(rest, "pointermove", { clientX: 10, clientY: 40 });
    expect(rest.style.transform).toBe("translateY(-60px)");
    fire(window, "blur");
    expect([rest.style.transform, rest.style.zIndex]).toEqual(["", ""]);
    fire(rest, "pointerup", { clientX: 10, clientY: 40, buttons: 0 });
    expect(storedTracks()).toEqual([["x", 1]]);
  } finally {
    pointDoc.elementsFromPoint = savedPoint;
  }
});

// ② 왼쪽으로 누르기만 한 채(6px 전) 휠 클릭하면 길이 조절 창이 뜨고, 그대로 더 움직이면 창 뒤에서 대기 중이던 끌기가 살아났다(쥐기가
//  남아 움직임이 클립으로 온다). 다른 단추로 창·메뉴를 열기 전에 대기 중인 끌기와 쥐기를 걷는다.
it("클립을 누르기만 한 채(6px 전) 휠 클릭·우클릭으로 창을 열면 대기 중인 끌기를 걷는다 — 창 뒤에서 끌기가 살아나지 않는다", () => {
  world.gens = [gen("a", "c1"), gen("b", "c1", { assets: [{ id: "a-b", generation_id: "b", type: "video", file_path: "/media/b.mp4",
    thumbnail_path: null, source_url: null, cached: true }] } as unknown as Partial<Generation>), gen("x", "c2")];
  seed([{ cut: "c1", gen: "b", track: 2 }]);
  mountOn("c1");
  const clip = () => lane(2).querySelector<HTMLElement>(".ed-clip")!;
  const pointDoc = document as unknown as { elementsFromPoint?: unknown };
  const savedPoint = pointDoc.elementsFromPoint;
  pointDoc.elementsFromPoint = () => [lane(1)]; // 마우스 밑은 V1 — 끌기가 살아 있으면 놓을 때 그리로 간다
  try {
    fire(clip(), "pointerdown", { clientX: 10, clientY: 100 });
    fire(clip(), "pointermove", { clientX: 10, clientY: 98 }); // 문턱(6px) 전 — 아직 끌기가 아니다
    fire(clip(), "auxclick", { button: 1, buttons: 5, clientX: 10, clientY: 98 });
    expect(document.querySelector(".ed-trim")).not.toBeNull();
    expect(clip().hasPointerCapture(1)).toBe(false); // 쥐기도 놓았다 — 창 뒤의 클립이 움직임을 받지 않는다
    fire(clip(), "pointermove", { clientX: 10, clientY: 40 }); // 왼쪽을 누른 채 더 움직였다
    expect(clip().style.transform).toBe("");
    fire(clip(), "pointerup", { clientX: 10, clientY: 40, buttons: 0 });
    expect(storedTracks()).toEqual([["b", 2]]);
    act(() => document.querySelector<HTMLElement>('.ed-trim [aria-label="닫기"]')!.click());
    expect(document.querySelector(".ed-trim")).toBeNull();
    // 우클릭 메뉴도 같다
    fire(clip(), "pointerdown", { clientX: 10, clientY: 100 });
    fire(clip(), "contextmenu", { button: 2, buttons: 3, clientX: 10, clientY: 100 });
    expect(document.querySelector(".ed-tmenu")).not.toBeNull();
    fire(clip(), "pointermove", { clientX: 10, clientY: 40 });
    expect(clip().style.transform).toBe("");
    fire(clip(), "pointerup", { clientX: 10, clientY: 40, buttons: 0 });
    expect(storedTracks()).toEqual([["b", 2]]);
  } finally {
    pointDoc.elementsFromPoint = savedPoint;
  }
});

// 문서는 그대로인데(rev 가 안 바뀐다) 끌던 클립이 화면에서 빠지는 길 — 숨기기(hideOff)가 켜진 채 다른 탭이 그 컷 폴더를 비활성으로 돌렸다.
it("클립 끌기: 문서가 그대로여도 끌던 클립의 컷이 화면에서 빠지면 끌기를 걷는다", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c2", gen: "x", track: 1 }], { hideOff: true });
  mountOn("c1");
  const mine = lane(1).querySelector<HTMLElement>(".ed-clip")!;
  fire(mine, "pointerdown", { clientX: 10, clientY: 100 });
  fire(mine, "pointermove", { clientX: 10, clientY: 40 });
  expect(mine.style.transform).toBe("translateY(-60px)");
  const before = localStorage.getItem(DOC_KEY);
  world.disabled = { p1: ["e070/c1"] };
  mount(); // 다시 그린다 — 실제로는 비활성 알림이 다시 그리게 한다
  expect([lane(1).querySelectorAll(".ed-clip").length, mine.isConnected, localStorage.getItem(DOC_KEY)]).toEqual([1, false, before]);
  fire(lane(1).querySelector<HTMLElement>(".ed-clip")!, "contextmenu", { button: 2, buttons: 0 }); // 끄는 중이 풀렸다 — 메뉴가 뜬다
  expect(document.querySelector(".ed-tmenu")).not.toBeNull();
});

// 길이 조절 창은 떠 있는 창이라 떠 있는 동안 타임라인을 쓴다(Jay 2026-10-13 밤) — 그 클립이 타임라인에서 빠지면(지움) 조절할 것이 없으니 닫는다.
it("길이 조절 창이 떠 있는 동안 그 클립을 지우면 창이 닫힌다 — 되돌려도 다시 뜨지 않는다", () => {
  world.gens = [gen("a", "c1"), gen("b", "c1", { assets: [{ id: "a-b", generation_id: "b", type: "video", file_path: "/media/b.mp4",
    thumbnail_path: null, source_url: null, cached: true }] } as unknown as Partial<Generation>), gen("x", "c2")];
  seed([{ cut: "c1", gen: "b", track: 2 }]);
  mountOn("c1");
  const clip = lane(2).querySelector<HTMLElement>(".ed-clip")!;
  fire(clip, "pointerdown", { clientX: 10, clientY: 100 }); // 누르면 그 클립이 골라진다
  fire(clip, "pointerup", { clientX: 10, clientY: 100, buttons: 0 });
  fire(clip, "auxclick", { button: 1, buttons: 0 });
  expect(document.querySelector(".ed-trim")).not.toBeNull();
  press({ key: "Delete", code: "Delete" }); // 초점이 타임라인(body)이면 키는 타임라인의 것 — 고른 클립을 지운다
  expect([storedTracks(), document.querySelector(".ed-trim")]).toEqual([[], null]);
  press({ key: "z", code: "KeyZ", ctrlKey: true });
  expect([storedTracks(), document.querySelector(".ed-trim")]).toEqual([[["b", 2]], null]);
});

// 2026-10-14 두 창 실측: 창이 스스로 닫히면(다른 창의 저장을 받아들임) 초점이 body 로 떨어졌다 — ✕·Esc 로 닫을 때처럼 편집 화면으로 돌린다.
it("길이 조절 창이 다른 창의 저장으로 스스로 닫혀도 초점이 편집 화면으로 돌아온다 — 다른 곳에 둔 초점은 건드리지 않는다", () => {
  world.gens = [gen("a", "c1"), gen("b", "c1", { assets: [{ id: "a-b", generation_id: "b", type: "video", file_path: "/media/b.mp4",
    thumbnail_path: null, source_url: null, cached: true }] } as unknown as Partial<Generation>), gen("x", "c2")];
  seed([{ cut: "c1", gen: "b", track: 2 }]);
  mountOn("c1");
  const openOn = (track: number) => {
    const clip = lane(track).querySelector<HTMLElement>(".ed-clip")!;
    fire(clip, "pointerdown", { clientX: 10, clientY: 100 });
    fire(clip, "pointerup", { clientX: 10, clientY: 100, buttons: 0 });
    fire(clip, "auxclick", { button: 1, buttons: 0 });
  };
  const otherWindowSaves = (track: number) => {
    seed([{ cut: "c1", gen: "b", track }]);
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key: DOC_KEY })); });
  };
  const root = document.querySelector<HTMLElement>(".ed-root")!;

  openOn(2);
  act(() => document.querySelector<HTMLElement>('.ed-trim [aria-label="닫기"]')!.focus());
  expect(document.querySelector(".ed-trim")!.contains(document.activeElement)).toBe(true);
  otherWindowSaves(3);
  expect([document.querySelector(".ed-trim"), document.activeElement]).toEqual([null, root]);

  // 창은 떠 있는 채 뒤를 쓰는 창이다 — 초점을 풀에 둔 채였다면 그대로 둔다
  openOn(3);
  const elsewhere = document.querySelector<HTMLElement>('.ed-pool [title="검색"]')!;
  act(() => elsewhere.focus());
  otherWindowSaves(2);
  expect([document.querySelector(".ed-trim"), document.activeElement]).toEqual([null, elsewhere]);
});

// Codex 코드 리뷰 6회째: 영상 정보(loadedmetadata)가 오기 전에 ▶ 를 누르면, 창을 열 때 걸어 둔 '마지막 프레임으로'가 뒤늦게 돌아 재생
//  자리를 끝으로 옮겼다(처음부터 트는 대신 끝에서 바로 멈춤).
it("길이 조절 창: 영상 정보가 오기 전에 재생을 눌러도 처음부터 튼다 — 뒤늦은 '마지막 프레임으로'가 끼어들지 않는다", () => {
  world.gens = [gen("a", "c1"), gen("b", "c1", { assets: [{ id: "a-b", generation_id: "b", type: "video", file_path: "/media/b.mp4",
    thumbnail_path: null, source_url: null, cached: true }] } as unknown as Partial<Generation>), gen("x", "c2")];
  seed([{ cut: "c1", gen: "b", track: 2 }]);
  mountOn("c1");
  fire(lane(2).querySelector<HTMLElement>(".ed-clip")!, "auxclick", { button: 1, buttons: 0 });
  const video = document.querySelector<HTMLVideoElement>(".ed-trim video")!;
  const go = () => act(() => document.querySelector<HTMLElement>(".ed-trim .ed-trim-go")!.click());
  // jsdom 의 video 는 정보를 받지 않는다(readyState 0 — 열 때의 '마지막 프레임으로'는 loadedmetadata 를 기다린다). 적는 값을 기록한다
  const sets: number[] = [];
  Object.defineProperty(video, "currentTime", { configurable: true, get: () => sets[sets.length - 1] ?? 0, set: (value: number) => { sets.push(value); } });
  go();
  expect(sets).toEqual([0]); // 처음부터
  act(() => { video.dispatchEvent(new Event("loadedmetadata")); });
  expect(sets).toEqual([0]); // 뒤늦게 온 정보가 재생 자리를 끝으로 옮기지 않는다
  go(); // 멈추면 그 길이의 마지막 프레임(120프레임 = 119/24초)으로 돌아간다
  expect(sets[sets.length - 1]).toBeCloseTo(119 / 24);
});

// 2026-10-13 격리 실측: 영상을 못 받으면 검은 상자만 있고 ▶ 를 눌러도 아무 일이 없었다 — 까닭을 적고 ▶ 를 끈다. 길이는 그대로 조절된다.
it("길이 조절 창: 영상을 못 받으면 까닭을 적고 재생 단추를 끈다 — 길이는 조절된다", () => {
  world.gens = [gen("a", "c1"), gen("b", "c1", { assets: [{ id: "a-b", generation_id: "b", type: "video", file_path: "/media/b.mp4",
    thumbnail_path: null, source_url: null, cached: true }] } as unknown as Partial<Generation>), gen("x", "c2")];
  seed([{ cut: "c1", gen: "b", track: 2, ...{ kind: "video" } }]); // 문서에도 영상으로 적는다(이 파일의 기본은 그림 — 그림은 줄일 수 없다)
  mountOn("c1");
  fire(lane(2).querySelector<HTMLElement>(".ed-clip")!, "auxclick", { button: 1, buttons: 0 });
  const pop = document.querySelector<HTMLElement>(".ed-trim")!;
  const go = pop.querySelector<HTMLElement>(".ed-trim-go")!;
  expect([pop.querySelector(".ed-trim-play em"), go.getAttribute("aria-disabled")]).toEqual([null, "false"]);
  act(() => { pop.querySelector("video")!.dispatchEvent(new Event("error")); });
  expect([pop.querySelector(".ed-trim-play em")?.textContent, go.getAttribute("aria-disabled")])
    .toEqual(["영상을 불러오지 못했습니다 — 길이는 조절할 수 있습니다", "true"]);
  const play = vi.mocked(HTMLMediaElement.prototype.play);
  play.mockClear();
  act(() => go.click());
  expect([play.mock.calls.length, go.textContent]).toEqual([0, "▶ 재생"]);
  act(() => [...pop.querySelectorAll("button")].find((item) => item.textContent === "−1f")!.click());
  expect((stored().clips as { trim?: number }[])[0].trim).toBeCloseTo(119 / 24);
});

// Jay 2026-10-15 11A ⓐ — 많이 줄이면 컷 칸이 몇 px 라 끄는 동안 무엇을 잡았는지 안 보였다 → 포인터 옆에 '컷 이름 · 길이'.
//  jsdom 에는 배치가 없다 — 컷 칸의 이름이 잘렸는지(scrollWidth > clientWidth)는 시험이 정한다(그대로면 0 = 0, 다 보인다).
it("많이 줄여 컷 이름이 칸에 안 보이면 끄는 동안 포인터 옆에 잡은 것의 이름표가 뜬다 — 컷 끌기·클립 끌기 모두, 이름이 보이면 없다", () => {
  seed([{ cut: "c1", gen: "a", track: 2, ...{ dur: 4.1 } }]);
  mountOn("c1");
  const tip = () => document.querySelector<HTMLElement>(".ed-grabtip");
  const squeeze = (name: string) => {
    Object.defineProperty(cutCell(name), "scrollWidth", { configurable: true, value: 30 });
    Object.defineProperty(cutCell(name), "clientWidth", { configurable: true, value: 3 });
  };
  const clip = lane(2).querySelector<HTMLElement>(".ed-clip")!;
  const pointDoc = document as unknown as { elementsFromPoint?: unknown };
  const savedPoint = pointDoc.elementsFromPoint;
  pointDoc.elementsFromPoint = () => [lane(2)]; // 놓는 곳은 제 트랙 — 클립은 옮겨지지 않는다
  try {
    // 이름이 보이면 이름표는 없다
    let cell = dragCut("c2", right("c3") + 4);
    expect([document.querySelector(".ed-cutdrop") !== null, tip()]).toEqual([true, null]);
    press({ key: "Escape", code: "Escape" });
    fire(clip, "pointerdown", { clientX: 10, clientY: 100 });
    fire(clip, "pointermove", { clientX: 10, clientY: 40 });
    expect([clip.style.transform, tip()]).toEqual(["translateY(-60px)", null]);
    fire(clip, "pointerup", { clientX: 10, clientY: 40, buttons: 0 });

    squeeze("c1");
    squeeze("c2");
    cell = dragCut("c2", right("c3") + 4); // 컷 끌기 = 그 컷의 이름 · 컷 길이(빈 컷 = 기본 5초)
    expect(tip()!.textContent).toBe("c2 · 5.0s");
    fire(cell, "pointermove", { clientX: 300, clientY: 200 }); // 포인터를 따라온다(오른쪽 위)
    expect(tip()!.style.transform).toBe("translate(312px, 160px)");
    Object.defineProperty(tip()!, "offsetWidth", { configurable: true, value: 80 });
    fire(cell, "pointermove", { clientX: 1000, clientY: 200 }); // 창 오른쪽 끝(jsdom 1024) — 자리가 없으면 포인터 왼쪽에(Codex 11A 리뷰)
    expect(tip()!.style.transform).toBe("translate(908px, 160px)");
    press({ key: "Escape", code: "Escape" }); // 끌기가 끝나면 사라진다
    expect(tip()).toBeNull();
    fire(cell, "pointerup", { buttons: 0 });

    fire(clip, "pointerdown", { clientX: 10, clientY: 100 }); // 클립 끌기 = 그 클립의 컷 이름 · 클립의 쓰는 길이
    fire(clip, "pointermove", { clientX: 10, clientY: 40 });
    expect([tip()!.textContent, tip()!.style.transform]).toEqual(["c1 · 4.1s", "translate(22px, 0px)"]);
    fire(clip, "pointerup", { clientX: 10, clientY: 40, buttons: 0 });
    expect(tip()).toBeNull();
    expect([cuts(), storedTracks()]).toEqual([["c1", "c2", "c3"], [["a", 2]]]);
  } finally {
    pointDoc.elementsFromPoint = savedPoint;
  }
});

// Jay 2026-10-15 11A ⓑ — 끌다가 가장자리에서 화면이 넘어가면 끼울 자리(줄)가 화면 밖일 수 있다 → 그쪽 가장자리에 '끼울 자리'.
it("컷을 끄는 중 끼울 자리가 화면 밖이면 그쪽 가장자리에 '끼울 자리' 가 뜬다 — 화면 안·제자리면 없다", () => {
  mount();
  const scroll = document.querySelector<HTMLElement>(".ed-scroll")!;
  vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue({ left: 0, right: 5000 } as DOMRect); // 포인터는 가장자리(저절로 넘김)가 아니다
  Object.defineProperty(scroll, "clientWidth", { configurable: true, value: right("c2") + 10 }); // 보이는 칸 = c1·c2 와 c3 의 앞쪽
  const mark = () => document.querySelector<HTMLElement>(".ed-edgemark");
  const seen = () => mark() && [mark()!.textContent, mark()!.className, mark()!.parentElement!.dataset.track];

  let cell = dragCut("c1", right("c3") + 4); // 맨 뒤 — 끼울 자리가 화면 오른쪽 밖
  expect(seen()).toEqual(["끼울 자리 ▶", "ed-edgemark ed-edgemark-right", "1"]);
  fire(cell, "pointermove", { clientX: left("c3") + 1 }); // c3 앞 — 화면 안
  expect([document.querySelector(".ed-cutdrop") !== null, mark()]).toEqual([true, null]);
  press({ key: "Escape", code: "Escape" });
  fire(cell, "pointerup", { buttons: 0 });

  scroll.scrollLeft = right("c1") + 1; // c2 부터 보인다 — c1 의 앞·끝(= c2 의 앞)은 화면 왼쪽 밖
  cell = dragCut("c3", 1); // 맨 앞
  expect(seen()).toEqual(["◀ 끼울 자리", "ed-edgemark ed-edgemark-left", "1"]);
  press({ key: "Escape", code: "Escape" }); // 끌기가 끝나면 사라진다
  expect(mark()).toBeNull();
  fire(cell, "pointerup", { buttons: 0 });

  cell = dragCut("c1", left("c2") + 3); // 제자리(c2 앞) — 화면 밖이어도 줄도 표시도 없다
  expect([document.querySelector(".ed-cutdrop"), mark()]).toEqual([null, null]);
  fire(cell, "pointerup", { buttons: 0 });
  expect(cuts()).toEqual(["c1", "c2", "c3"]);
});

// Jay 2026-10-15 — 풀 카드에도 라이브러리 카드의 호버 단추(S·T·C·ⓘ·⤓): 누르면 라이브러리와 같은 앱의 동작을 부르고, 그 누름은 카드의
//  고르기·끌기·크게 보기·정보 창으로 번지지 않는다(라이브러리 격자와 같은 약속). 카드 몸통의 누르기·더블클릭·휠 클릭은 그대로다.
it("풀 카드의 호버 단추 — S·T·C·ⓘ 는 앱의 동작을 부르고, 그 누름은 고르기·끌기·크게 보기가 아니다 · 몸통은 그대로", () => {
  mountOn("c1");
  const card = () => poolCards()[0];
  const part = (selector: string) => card().querySelector<HTMLElement>(selector)!;
  const picked = () => poolCards().map((item) => item.classList.contains("ed-picked"));
  expect([...card().querySelectorAll(".card-tl button")].map((item) => item.textContent)).toEqual(["S", "T", "C"]);
  expect([part(".ov-info"), part('.ov-icon[title="다운로드"]')].every(Boolean)).toBe(true);

  // S = 공유 & 리뷰의 검토 메뉴 → 보류 → 예
  fire(part(".card-sf"), "mousedown");
  act(() => part(".card-sf").click());
  act(() => part(".review-held").click());
  act(() => part(".cs-final-yes").click());
  expect(cardActions.onReview.mock.calls.map(([g, action]) => [g.id, action])).toEqual([["a", "held"]]);
  // C = 코멘트 창 · ⓘ = 정보 창
  act(() => part(".card-tl .card-cm:last-child").click());
  act(() => part(".ov-info").click());
  expect([cardActions.onOpenComments.mock.calls.map(([g]) => g.id), cardActions.onInfo.mock.calls.map(([target]) => target.gen.id)])
    .toEqual([["a"], ["a"]]);
  // 단추를 누른 채 끌어도 카드 끌기가 아니고, 단추를 두 번 눌러도 크게 보기가 아니다
  fire(part(".ov-info"), "mousedown", { clientX: 10, clientY: 10 });
  under = lane(2);
  fire(window, "mousemove", { clientX: 60, clientY: 80 });
  expect(ghost()).toBeNull();
  fire(window, "mouseup", { clientX: 60, clientY: 80, buttons: 0 });
  fire(part(".ov-info"), "dblclick");
  fire(part(".card-tl .card-cm"), "dblclick");
  expect([picked(), previewed, opened, stored()]).toEqual([[false, false], [], [], null]);

  // T = 태그 고치기(카드 아래 입력칸). 넣은 태그는 목록을 다시 받기 전에도 카드에 남는다 — 닫았다 다시 열어 더 넣으면 앞의 것과 같이 적힌다
  const typeTag = (tag: string) => {
    const input = card().querySelector<HTMLInputElement>(".cs-tag-input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, tag);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  };
  act(() => part(".card-tl .card-cm").click());
  typeTag("컷1");
  act(() => { part(".cs-tag-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(card().querySelector(".cs-tag-input")).toBeNull();
  act(() => part(".card-tl .card-cm").click());
  typeTag("컷2");
  expect(cardActions.onSetTags.mock.calls.map(([g, tags]) => [g.id, tags])).toEqual([["a", ["컷1"]], ["a", ["컷1", "컷2"]]]);

  // 몸통: 휠 클릭 = 넣을 트랙 메뉴(라이브러리 카드의 휠 클릭 = 정보 창은 뜨지 않는다) · 누르기 = 고르기 · 더블클릭 = 크게 보기
  fire(part(".card-thumb"), "auxclick", { button: 1, buttons: 0 });
  expect([document.querySelector(".ed-tmenu") !== null, cardActions.onInfo.mock.calls.length]).toEqual([true, 1]);
  press({ key: "Escape", code: "Escape" });
  act(() => part(".card-thumb").click());
  fire(part(".card-thumb"), "dblclick");
  expect([picked(), previewed]).toEqual([[true, false], ["a"]]);
  expect(flashed).toEqual([]);
});

// Jay 2026-10-15 — 풀 맨 윗줄 카드가 위에서 잘렸다: 스크롤 칸은 제 안쪽 끝에서 자르는데 위 여백이 0 이라, 고른 카드의 바깥 흰 테두리
//  (outline 2px + 간격 2px)와 호버로 들리는 카드(.card:hover 의 translateY(-3px))가 잘렸다. 진짜 CSS 를 올려 계산된 값을 본다.
it("풀 격자의 위 여백은 고른 카드의 바깥 테두리·호버로 들리는 높이를 담는다 · 뺀 단추는 숨고 넣은 카드의 단추는 호버 때만", () => {
  const css = (name: string) => readFileSync(new NodeURL(`../src/styles/${name}.css`, import.meta.url), "utf8");
  act(() => root.render(<><style>{css("generations") + css("edit-tab")}</style>
    <div className="ed-pbody ed-pgrid">
      <div className="ed-card ed-picked"><div className="card card-grid selected"><div className="card-clip"><div className="card-thumb">
        <span className="card-drag-grip">⠿</span>
        <div className="thumb-overlay"><div className="ov-bottom">
          <button className="ov-icon">⤓</button><button className="ov-icon ov-ref">@</button><button className="ov-icon ov-import">⬇</button>
        </div></div>
      </div></div></div></div>
    </div></>));
  const style = (selector: string) => getComputedStyle(host.querySelector(selector)!);
  const px = (value: string) => parseFloat(value) || 0;
  const pad = px(style(".ed-pgrid").paddingTop);
  expect(pad).toBeGreaterThanOrEqual(px(style(".ed-picked").outlineWidth) + px(style(".ed-picked").outlineOffset));
  expect(pad).toBeGreaterThanOrEqual(3);
  expect([".card-drag-grip", ".ov-ref", ".ov-import", ".ov-icon"].map((selector) => style(selector).display === "none"))
    .toEqual([true, true, true, false]); // ⠿·@·⬇ 는 뺐다 · ⤓ 는 있다
  expect(style(".thumb-overlay").opacity).toBe("0"); // 라이브러리의 '선택'은 늘 보이지만 여기의 굵은 테두리는 넣은 것이다
});
