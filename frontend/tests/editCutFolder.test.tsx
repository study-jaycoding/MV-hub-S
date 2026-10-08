// @vitest-environment jsdom
// 편집 탭(Jay 2026-10-08) — 미디어 풀(폴더 목록 옆: 보기 방식·크기·검색·정렬, 고르기·넣기/빼기·우클릭 트랙 메뉴) ·
// 뷰어 판(싱글/듀얼·무엇을 볼지·타임바·반복·키 대상) · 풀의 Resolve 보내기 · 그림을 누르면 그 컷으로 · 컷 더블클릭 = 공유 & 리뷰의 폴더 창 열기(무엇을 열지만 App 에 알린다) ·
// 그 창의 카드 우클릭 = 넣을 트랙 고르기(찬 트랙은 교체) · 빈 폴더 기본 비활성과 숨기기 · D 로 폴더 켜고 끄기 ·
// 왼쪽 폴더 옆의 새 항목·최종·보류 표시 · 공유 목록과 폴더 옆 숫자 다시 받기 ·
// 트랙 머리 우클릭(트랙 추가·옮기기·삭제·색) · 마크 인/아웃 · 북마크(색 메뉴·모두 지우기) · 구간 반복 재생 · 소스 테이프.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditCardMenu, EditCutFolder } from "../src/components/timeline/EditTab";
import type { EditTree } from "../src/lib/useEditSequence";
import type { CardMark, Generation, PreviewTarget } from "../src/types";

const gen = (id: string, cut: string, extra: Partial<Generation> = {}) => ({
  id, job_id: `job-${id}`, status: "done", params: {}, prompt: `prompt ${id}`, folder_path: `e070/${cut}`,
  shared: true, is_final: false, is_held: false, is_mine: false, creator_name: "리버",
  assets: [{ id: `a-${id}`, generation_id: id, type: "image", file_path: `/media/${id}.png`,
    thumbnail_path: null, source_url: null, cached: true }],
  ...extra,
} as unknown as Generation);

const world = vi.hoisted(() => ({
  gens: [] as unknown[], known: true, state: "ok", error: null as string | null,
  reload: (() => {}) as () => void, reloadCounts: (() => {}) as () => void, fresh: {} as Record<string, number>,
}));
vi.mock("../src/lib/useEditSequence", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/useEditSequence")>("../src/lib/useEditSequence");
  // c1 = 새로 공유된 것 1 · 최종 1 · 보류 1, c2 = 표시할 것 없음, c3 = 빈 폴더
  const tree = { state: "ready", complete: true, note: null, roots: [{
    name: "e070", path: "e070", count: 4, newCount: 1, reviewCounts: { final: 1, held: 1, shared: 2 }, children: [
      { name: "c1", path: "e070/c1", count: 2, newCount: 1, reviewCounts: { final: 1, held: 1, shared: 0 } },
      { name: "c2", path: "e070/c2", count: 2, newCount: 0, reviewCounts: { final: 0, held: 0, shared: 2 } },
      { name: "c3", path: "e070/c3", count: 0, newCount: 0, reviewCounts: { final: 0, held: 0, shared: 0 } },
    ] }] } as unknown as EditTree;
  return {
    ...actual,
    useEditProjects: () => ({
      projects: [{ id: "p1", name: "P1" }, { id: "p2", name: "P2" }], projectsState: "ok", tree, reload: () => {},
      reloadCounts: world.reloadCounts, freshByProject: world.fresh,
    }),
    useEditGenerations: () => ({
      state: world.state, gens: world.gens, error: world.error, complete: world.known, known: world.known, reload: world.reload,
    }),
  };
});
vi.mock("../src/lib/useDisabledFolders", () => ({ useDisabledFolders: () => ({}) }));

import { EditTab } from "../src/components/timeline/EditTab";

let host: HTMLDivElement;
let root: Root;
const opened: EditCutFolder[] = [];
const onOpenCutFolder = (target: EditCutFolder) => { opened.push(target); };
const flashed: string[] = [];
const flash = (message: string) => { flashed.push(message); };
const workspace = { scope: "team" as const, id: "w1", name: "W" };
const peekMarks: Record<string, CardMark>[] = []; // 폴더 창이 떠 있는 동안 편집 탭이 알린 표
const onPeekMarks = (marks: Record<string, CardMark>) => { peekMarks.push(marks); };
const cardMenuRef: { current: EditCardMenu | null } = { current: null };
const previews: PreviewTarget[] = []; // 풀의 더블클릭이 앱에 열어 달라고 한 크게 보기
const onPreview = (target: PreviewTarget) => { previews.push(target); };
const compared: Generation[][] = []; // 풀의 [비교]가 앱에 넘긴 생성물들
const onCompare = (gens: Generation[]) => { compared.push(gens); };
const sent: Generation[][] = []; // 풀의 [Resolve로 보내기]가 앱에 넘긴 생성물들
const resolveState = { busy: false, pendingCount: 0 };
const sendToResolve = (gens: Generation[]) => { sent.push(gens); };
// peekPath = 폴더 창이 떠 있는 컷(없으면 null). 창은 App 의 것이라 여기서는 떠 있다는 사실만 넘긴다.
const mount = (reloadSignal = 0, peekPath: string | null = null, ws: typeof workspace | { scope: "unknown"; id: null; name: null } = workspace) =>
  act(() => root.render(
    <EditTab authKey="auth" authReady workspace={ws} keysActive flash={flash}
      onOpenCutFolder={onOpenCutFolder} reloadSignal={reloadSignal}
      peekPath={peekPath} onPeekMarks={onPeekMarks} cardMenuRef={cardMenuRef} onPreview={onPreview} onCompare={onCompare}
      resolve={{ send: sendToResolve, ...resolveState }} />,
  ));
const DOC_KEY = "ch.editTimeline:local:p1:e070";
type Seed = { cut: string; gen: string; track: number; job?: string; off?: boolean };
// 타임라인에 미리 넣어 둔 상태로 시작한다(넣기는 폴더 창의 우클릭 메뉴로만 한다 — 아래 시험이 그 길을 본다).
const seed = (clips: Seed[], extra: Record<string, unknown> = {}) => localStorage.setItem(DOC_KEY, JSON.stringify({
  v: 1, tracksOff: [], tracksLocked: [], ...extra,
  clips: clips.map((clip) => ({ kind: "image", dur: 5, ...clip, cut: `e070/${clip.cut}` })),
}));
const stored = () => JSON.parse(localStorage.getItem(DOC_KEY)!);
const storedTracks = () => stored().clips.map((clip: { gen: string; track: number }) => [clip.gen, clip.track]);
const timecode = () => document.querySelector(".ed-tc")!.textContent;
const cuts = () => [...document.querySelectorAll(".ed-cutcell")].map((cell) => cell.textContent);
const offCuts = () => [...document.querySelectorAll(".ed-cutcell.ed-cutoff")].map((cell) => cell.textContent);
const cutCell = (name: string) => [...document.querySelectorAll<HTMLButtonElement>(".ed-cutcell")].find((cell) => cell.textContent === name)!;
const clips = () => [...document.querySelectorAll<HTMLElement>(".ed-clip")];
const poolCards = () => [...document.querySelectorAll<HTMLButtonElement>(".ed-pool .ed-card")];
const poolRows = (kind: string) => [...document.querySelectorAll<HTMLButtonElement>(`.ed-pool button.ed-prow-${kind}`)];
const poolButton = (label: string) => document.querySelector<HTMLButtonElement>(`.ed-pool .ed-pbtn[aria-label="${label}"]`)!;
const popItem = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".ed-pop-item")].find((item) => item.textContent!.includes(label))!;
const typeIn = (input: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const rightClick = (target: Element) => {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 40 });
  act(() => { target.dispatchEvent(event); });
  return event;
};
const UI_KEY = "ch.editTimeline.ui";
// 뷰어 판 — 보이는 것만, 왼쪽부터(자리는 CSS order, 안 보이는 판은 hidden 으로 붙어 있다)
const panes = () => [...document.querySelectorAll<HTMLElement>(".ed-top > .ed-view")].filter((item) => !item.hidden)
  .sort((a, b) => Number(a.style.order) - Number(b.style.order));
const paneModes = () => panes().map((item) => item.dataset.view);
const pane = (mode: string) => document.querySelector<HTMLElement>(`.ed-top > .ed-view[data-view="${mode}"]`)!;
const pickMode = (from: string, label: string) => {
  act(() => pane(from).querySelector<HTMLButtonElement>(".ed-vpick-btn")!.click());
  act(() => [...pane(from).querySelectorAll<HTMLButtonElement>(".ed-pop-item")].find((item) => item.textContent!.includes(label))!.click());
};
const playingIn = (mode: string) => !!pane(mode).querySelector(".ed-play rect"); // 재생 중이면 단추가 '일시정지' 그림이다
const videoGen = () => gen("v", "c1", { assets: [{ id: "a-v", generation_id: "v", type: "video", file_path: "/media/v.mp4",
  thumbnail_path: null, source_url: null, cached: true }] as Generation["assets"], model: "seedance" });
const hideButton = () => document.querySelector<HTMLButtonElement>(".ed-toggle")!;
const trackMenu = () => document.querySelector<HTMLElement>(".ed-tmenu");
const menuItems = () => [...document.querySelectorAll<HTMLButtonElement>(".ed-tmenu-item")];
const menuText = () => menuItems().map((item) => `${item.textContent}${item.disabled ? " ×" : ""}`);
const cardMenu = (id: string) => act(() => cardMenuRef.current!({ id }, 30, 40)); // 창의 카드를 우클릭
const mouse = (target: Element, type: string, init: MouseEventInit = {}) =>
  act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init })); });
const press = (init: KeyboardEventInit, target: EventTarget = document.body) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem("ch.editTimeline.last:local", JSON.stringify({ projectId: "p1", seq: "e070" }));
  for (const method of ["load", "pause"] as const) vi.spyOn(HTMLMediaElement.prototype, method).mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  // jsdom 에는 포인터 잡기가 없다 — 클립은 누를 때 포인터를 잡는다.
  Object.assign(Element.prototype, { setPointerCapture() {}, hasPointerCapture: () => false, releasePointerCapture() {} });
  world.gens = [gen("a", "c1"), gen("b", "c1", { is_final: true, is_mine: true }), gen("x", "c2"), gen("y", "c2", { is_held: true })];
  world.known = true;
  world.state = "ok";
  world.error = null;
  world.reload = () => {};
  world.reloadCounts = () => {};
  world.fresh = {};
  opened.length = 0;
  flashed.length = 0;
  peekMarks.length = 0;
  previews.length = 0;
  compared.length = 0;
  sent.length = 0;
  Object.assign(resolveState, { busy: false, pendingCount: 0 });
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

// 미디어 풀(Jay 2026-10-08) — 다빈치의 Bins | 클립처럼 왼쪽 폴더 목록 바로 옆에 둔다(뷰어의 왼쪽). 폭은 끌어서 바꾼다.
it("미디어 풀은 뷰어 왼쪽에 있다 — 누르면 고르고, 더블클릭하면 크게 보고, 우클릭하면 넣을 트랙을 고른다", () => {
  mount();
  act(() => cutCell("c1").click());
  expect([...document.querySelector(".ed-top")!.children].slice(0, 2).map((item) => item.classList[0]))
    .toEqual(["ed-pool-side", "sidebar-resize-handle"]); // 풀 · 폭 조절 손잡이가 뷰어보다 앞(왼쪽)
  expect(paneModes()).toEqual(["timeline"]);
  expect(document.querySelector(".ed-pool-side > .ed-pool h3")!.textContent).toBe("e070 / c1");
  expect(document.querySelector<HTMLElement>(".ed-pool-side")!.style.getPropertyValue("--sidebar-w")).toBe("392px");
  const handle = document.querySelector<HTMLElement>(".ed-top > .sidebar-resize-handle")!;
  act(() => handle.focus()); // 끄는 동안 손잡이가 초점을 받는다 — 놓으면 편집 화면으로 돌아온다(←·→ 가 풀 폭이 아니라 프레임을 옮기게)
  mouse(handle, "pointerup");
  expect(document.activeElement).toBe(document.querySelector(".ed-root"));
  const [a, b] = poolCards();
  expect(a.querySelector(".card.card-grid.st-shared")).not.toBeNull(); // 라이브러리 카드 모양 — 공유 = 라임 테두리
  expect(b.querySelector(".card.st-final .card-sf.final .card-final-star")).not.toBeNull(); // 최종 = 골드·★
  expect(a.querySelector(".creator-badge")?.textContent).toContain("리버"); // 남이 만든 것만 작성자 배지
  expect(b.querySelector(".creator-badge")).toBeNull();

  act(() => a.click()); // 누르기 = 고르기만 — 타임라인은 그대로다
  expect(poolCards()[0].classList.contains("ed-picked")).toBe(true);
  expect(document.querySelector<HTMLElement>(".ed-slot")!.title).toContain("우클릭"); // 빈 자리는 넣는 방법을 알려 준다

  mouse(poolCards()[1], "dblclick"); // 더블클릭 = 크게 보기(앱의 크게 보기 창) — 앞뒤 넘기기는 풀에 보이는 순서
  expect(previews).toHaveLength(1);
  expect(previews[0]).toMatchObject({ url: "/media/b.png", type: "image", genId: "b", sceneId: "@team", index: 1 });
  expect(previews[0].items!.map((item) => item.genId)).toEqual(["a", "b"]);
  expect(localStorage.getItem(DOC_KEY)).toBeNull(); // 고르기·크게 보기는 타임라인을 바꾸지 않는다

  expect(rightClick(poolCards()[0]).defaultPrevented).toBe(true); // 우클릭 = 넣을 트랙(브라우저 메뉴 대신)
  expect(menuText()).toEqual(["V3비어 있음", "V2비어 있음", "V1비어 있음"]);
  act(() => menuItems()[2].click());
  const mark = poolCards()[0].querySelector(".card.selected .card-bottom > .card-here > span")!;
  expect(mark.textContent).toBe("V1 - 선택 카드");
  expect(mark.getAttribute("data-short")).toBe("V1"); // 카드가 작으면 이것만 보인다(CSS)
  rightClick(poolCards()[1]);
  expect(menuText()).toEqual(["V3비어 있음", "V2비어 있음", "V1교체"]);
  act(() => menuItems()[1].click()); // V2 에 쌓는다 — 위 트랙이 보인다
  expect(storedTracks()).toEqual([["a", 1], ["b", 2]]);
  expect(poolCards()[1].querySelector(".card-here")?.textContent).toBe("V2 - 선택 카드");
  expect(poolCards()[0].querySelector(".card-bottom > .card-folder.static")?.textContent).toBe("V1 - 선택 카드"); // 깔린 것은 옅게
  expect(document.querySelector(".ed-pool-sub")!.textContent).toBe("공유된 것 2개 · 넣은 것 2개");
});

it("미디어 풀: Ctrl·Shift 로 여러 장을 고르면 비교할 수 있다 — 앱의 비교 창에 그 생성물들을 넘긴다", () => {
  mount();
  act(() => cutCell("c1").click());
  const bar = () => document.querySelector<HTMLElement>(".ed-pool-sel");
  act(() => poolCards()[0].click());
  const compare = () => bar()!.querySelector<HTMLButtonElement>(".ed-psel-btn:not(.ed-psel-resolve)");
  expect(bar()!.textContent).toContain("1개 선택");
  expect(compare()).toBeNull(); // 한 장으로는 비교할 것이 없다
  mouse(poolCards()[1], "click", { ctrlKey: true });
  expect(document.querySelectorAll(".ed-pool .ed-picked")).toHaveLength(2);
  expect(bar()!.textContent).toContain("2개 선택");
  act(() => compare()!.click());
  expect(compared.map((gens) => gens.map((item) => item.id))).toEqual([["a", "b"]]);

  // Resolve 로 보내기(Jay 2026-10-08) — 고른 것을 앱의 보내기 줄에 넘긴다. 처리 중이면 대기열에 더한다고 알린다.
  const resolve = () => bar()!.querySelector<HTMLButtonElement>(".ed-psel-resolve")!;
  expect(resolve().textContent).toBe("◆ Resolve로 보내기");
  act(() => resolve().click());
  expect(sent.map((gens) => gens.map((item) => item.id))).toEqual([["a", "b"]]);
  Object.assign(resolveState, { busy: true, pendingCount: 2 });
  mount();
  expect(resolve().textContent).toBe("◆ Resolve에 추가 (2)");
  expect(resolve().getAttribute("aria-busy")).toBe("true");

  mouse(poolCards()[1], "click", { shiftKey: true }); // 다시 누르면 빠진다
  expect(document.querySelectorAll(".ed-pool .ed-picked")).toHaveLength(1);
  mouse(poolCards()[1], "click", { ctrlKey: true });
  act(() => [...bar()!.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "선택 해제")!.click());
  expect(document.querySelector(".ed-pool .ed-picked")).toBeNull();
  expect(localStorage.getItem(DOC_KEY)).toBeNull();
});

// 끌어서 고르기(Jay 2026-10-08) — 라이브러리 격자처럼 상자에 걸친 카드를 고른다(jsdom 의 카드는 모두 (0,0) 에 있다).
it("미디어 풀: 끌어서 상자로 여러 장을 고른다 — Ctrl 을 누른 채 끌면 더하고, 끌기 끝의 click 은 누르기가 아니다", () => {
  mount();
  act(() => cutCell("c1").click());
  const body = () => document.querySelector<HTMLElement>(".ed-pbody")!;
  const move = (type: string, x: number, y: number) =>
    act(() => { window.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, buttons: type === "mousemove" ? 1 : 0 })); });
  const pickedCount = () => document.querySelectorAll(".ed-pool .ed-picked").length;

  mouse(body(), "mousedown", { clientX: 0, clientY: 0 });
  move("mousemove", 3, 3); // 5px 이하는 끌기가 아니다
  expect(document.querySelector(".assets-marquee")).toBeNull();
  move("mousemove", 30, 30);
  expect(document.querySelector(".ed-pbody > .assets-marquee")).not.toBeNull(); // 상자가 보인다
  expect(pickedCount()).toBe(2);
  move("mouseup", 30, 30);
  expect(document.querySelector(".assets-marquee")).toBeNull();
  act(() => poolCards()[0].click()); // 카드 위에서 놓으면 따라오는 click — 고른 것을 한 장으로 되돌리지 않는다
  expect(pickedCount()).toBe(2);
  expect(document.querySelector(".ed-pool-sel")!.textContent).toContain("2개 선택");
  act(() => { vi.advanceTimersByTime(1); });
  act(() => poolCards()[0].click()); // 그 뒤의 누르기는 한 장 고르기
  expect(pickedCount()).toBe(1);

  mouse(body(), "mousedown", { clientX: 100, clientY: 100, ctrlKey: true }); // 아무것도 안 걸친 상자 + Ctrl = 그대로
  move("mousemove", 140, 140);
  move("mouseup", 140, 140);
  expect(pickedCount()).toBe(1);
  // 버튼을 창 밖에서 놓아 mouseup 이 안 왔다 — 버튼이 안 눌린 채 움직이면 거기서 끝난다(상자가 마우스를 계속 따라다니지 않는다)
  mouse(body(), "mousedown", { clientX: 0, clientY: 0, ctrlKey: true });
  move("mousemove", 30, 30);
  expect(pickedCount()).toBe(2);
  act(() => { window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 200, clientY: 200, buttons: 0 })); });
  expect(document.querySelector(".assets-marquee")).toBeNull();
  act(() => { window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 300, clientY: 300, buttons: 1 })); });
  expect(document.querySelector(".assets-marquee")).toBeNull();
  expect(pickedCount()).toBe(2);
  act(() => { vi.advanceTimersByTime(1); });
  mouse(body(), "mousedown", { clientX: 100, clientY: 100 }); // Ctrl 없이 빈 곳을 끌면 풀린다
  move("mousemove", 140, 140);
  move("mouseup", 140, 140);
  expect(pickedCount()).toBe(0);
  expect(localStorage.getItem(DOC_KEY)).toBeNull();
});

it("미디어 풀: 보기 방식(썸네일·메타데이터·목록)과 크기·정렬·검색을 바꾼다 — 보기 설정은 이 브라우저에 남는다", () => {
  seed([{ cut: "c1", gen: "b", track: 1 }]);
  mount();
  act(() => cutCell("c1").click());
  const grid = () => document.querySelector<HTMLElement>(".ed-pgrid");
  const prompts = (kind: string) => poolRows(kind).map((row) => row.querySelector(".ed-pprompt")!.textContent);
  expect(grid()!.style.gridTemplateColumns).toContain("160px"); // 기본 = 썸네일 보기

  act(() => poolButton("보기 방식").click());
  expect([...document.querySelectorAll(".ed-pop-item")].map((item) => item.textContent)).toEqual(["메타데이터 보기", "✓썸네일 보기", "목록 보기"]);
  const size = () => document.querySelector<HTMLInputElement>(".ed-pop-size")!;
  expect(size().min).toBe("56"); // 다빈치의 작은 썸네일쯤까지 줄어든다
  typeIn(size(), "200"); // 크기 슬라이더
  expect(grid()!.style.gridTemplateColumns).toContain("200px");
  act(() => popItem("메타데이터 보기").click());
  expect(document.querySelector(".ed-pop")).toBeNull(); // 고르면 닫힌다
  expect(prompts("meta")).toEqual(["prompt a", "prompt b"]);
  expect(poolRows("meta")[0].querySelector<HTMLElement>(".ed-pthumb")!.style.width).toBe("200px");
  expect(poolRows("meta")[0].querySelector(".ed-pinfo b")!.textContent).toBe("S리버"); // 상태 · 만든 사람 · 모델
  expect(poolRows("meta")[1].querySelector(".ed-pstate-final")?.textContent).toBe("★");
  expect(poolRows("meta")[1].querySelector(".cd-mark.lead")?.textContent).toBe("V1 - 선택 카드"); // 넣은 것의 표

  act(() => poolButton("보기 방식").click());
  act(() => popItem("목록 보기").click());
  expect(grid()).toBeNull();
  expect(prompts("list")).toEqual(["prompt a", "prompt b"]);
  expect(poolRows("list")[1].lastElementChild!.textContent).toBe("V1");
  act(() => poolButton("보기 방식").click());
  expect(size().disabled).toBe(true); // 목록에는 그림이 없다
  press({ key: "Escape", code: "Escape" }); // Esc 는 펼친 메뉴가 먹는다
  expect(document.querySelector(".ed-pop")).toBeNull();

  act(() => poolButton("정렬").click());
  act(() => popItem("오래된순").click());
  expect(prompts("list")).toEqual(["prompt b", "prompt a"]);
  act(() => poolButton("정렬").click());
  act(() => popItem("최신순").click());
  expect(prompts("list")).toEqual(["prompt a", "prompt b"]);
  act(() => poolButton("정렬").click());
  act(() => popItem("넣은 것 먼저").click());
  expect(prompts("list")).toEqual(["prompt b", "prompt a"]);
  expect(JSON.parse(localStorage.getItem(UI_KEY)!)).toMatchObject({ view: "list", size: 200, sort: "placed", dual: false });

  act(() => poolButton("검색").click()); // 검색 — 프롬프트·모델·만든 사람
  const search = () => document.querySelector<HTMLInputElement>(".ed-pool-search");
  typeIn(search()!, "PROMPT A");
  expect(prompts("list")).toEqual(["prompt a"]);
  expect(document.querySelector(".ed-pool-sub")!.textContent).toContain("찾은 것 1개");
  typeIn(search()!, "없는 글");
  expect(document.querySelector(".ed-pool")!.textContent).toContain("검색에 맞는 생성물이 없습니다.");
  act(() => search()!.focus());
  expect(press({ key: " ", code: "Space" }, search()!).defaultPrevented).toBe(false); // 글을 치는 동안 편집 키는 쉰다
  press({ key: "Escape", code: "Escape" }, search()!); // Esc = 검색을 접는다
  expect(search()).toBeNull();
  expect(prompts("list")).toEqual(["prompt b", "prompt a"]);

  act(() => root.unmount()); // 다시 열어도 보기 설정이 남는다
  root = createRoot(host);
  mount();
  expect(prompts("list")).toEqual(["prompt b", "prompt a"]);
});

// 뷰어 판(Jay 2026-10-08, 다빈치의 뷰어) — 위 줄(지금 시각 · 무엇을 볼지 · 전체 길이 · 싱글/듀얼), 아래 줄(타임바 · 버튼 · 반복).
it("뷰어 판: 위 줄에서 무엇을 볼지 고른다(타임라인·소스·한 트랙만) — 두 판은 서로 다른 것을 보고, 같은 것을 고르면 자리를 바꾼다", () => {
  world.gens = [...world.gens, videoGen()];
  seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c1", gen: "b", track: 2 }]); // b 가 위(타임라인에서 보이는 것)
  mount();
  act(() => cutCell("c1").click());
  expect(paneModes()).toEqual(["timeline"]); // 기본 = 싱글 · 타임라인
  const timeline = pane("timeline");
  expect(timeline.querySelector(".ed-vtop > .ed-vtc")!.textContent).toBe("00:00:00:00"); // 지금 시각(왼쪽)
  expect(timeline.querySelector(".ed-vtotal")!.textContent).toBe("00:00:15:00"); // 전체 길이(오른쪽)
  expect(timeline.querySelector(".ed-vpick-btn")!.textContent).toBe("타임라인");
  expect(timeline.querySelector(".ed-chip-l")!.textContent).toBe("e070 / c1 · V2");
  expect(timeline.querySelector<HTMLImageElement>("img.ed-media")!.getAttribute("src")).toBe("/media/b.png");
  expect([...timeline.querySelectorAll(".ed-vbot .ed-tbtn")].map((item) => item.getAttribute("aria-label"))).toEqual([
    "처음으로 (Home)", "역재생 (J)", "정지 (K)", "재생/정지 (Space)", "끝으로 (End)", "반복 재생",
    "구간 반복 재생 (Alt+/) — 마크 인/아웃 사이를 되풀이합니다", "마크 인 (I)", "마크 아웃 (O)", // 오른쪽 아래(다빈치의 뷰어)
  ]);
  expect(timeline.querySelectorAll(".ed-scrub-track > i")).toHaveLength(0); // 재생바에 컷 경계 점은 없다 — 북마크·인/아웃만 보인다
  const dual = () => document.querySelector<HTMLButtonElement>(".ed-top .ed-view:not([hidden]) .ed-dual")!;
  expect(dual().closest(".ed-view")).toBe(timeline); // 싱글/듀얼 단추는 위 줄(맨 오른쪽 판)에

  act(() => dual().click()); // 듀얼 — [소스 | 타임라인]
  expect(paneModes()).toEqual(["source", "timeline"]);
  expect(document.querySelectorAll(".ed-top .ed-view:not([hidden]) .ed-dual")).toHaveLength(1);
  expect(dual().closest(".ed-view")).toBe(pane("timeline"));
  expect(pane("source").textContent).toContain("미디어 풀에서 생성물을 고르면 여기에서 봅니다.");
  act(() => poolCards()[0].click()); // 그림 a 를 고른다 — 소스 판에 뜬다
  expect(pane("source").querySelector<HTMLImageElement>("img.ed-media")!.getAttribute("src")).toBe("/media/a.png");
  act(() => poolCards()[2].click()); // 영상 v — 같은 판·같은 아래 줄(브라우저 기본 재생 막대가 아니다)
  const video = pane("source").querySelector<HTMLVideoElement>("video.ed-media")!;
  expect(video.getAttribute("src")).toBe("/media/v.mp4");
  expect(video.controls).toBe(false);
  expect(pane("source").querySelector(".ed-chip-r")!.textContent).toBe("리버 · seedance");
  expect(pane("source").querySelectorAll(".ed-vbot .ed-tbtn")).toHaveLength(6); // 소스 판에는 마크·구간 반복 단추가 없다
  expect(localStorage.getItem(DOC_KEY)).not.toBeNull();
  expect(storedTracks()).toEqual([["a", 1], ["b", 2]]); // 소스로 보는 것은 타임라인을 바꾸지 않는다
  act(() => cutCell("c2").click()); // 다른 컷으로 가도 소스는 그대로다
  expect(pane("source").querySelector<HTMLVideoElement>("video.ed-media")!.getAttribute("src")).toBe("/media/v.mp4");
  act(() => cutCell("c1").click());

  pickMode("source", "V1 만 보기"); // 왼쪽 판을 V1 만 보기로 — 타임라인에서는 b(V2)에 가려진 a 가 보인다
  expect(paneModes()).toEqual(["1", "timeline"]);
  act(() => { vi.advanceTimersByTime(40); }); // 따라가는 보기는 프레임마다 타임라인의 시각을 읽는다
  expect(pane("1").querySelector<HTMLImageElement>("img.ed-media")!.getAttribute("src")).toBe("/media/a.png");
  expect(pane("1").querySelector(".ed-chip-l")!.textContent).toBe("e070 / c1 · V1");
  expect(pane("1").querySelector(".ed-vpick-btn")!.textContent).toBe("V1 만 보기");
  expect(pane("source").hidden).toBe(true); // 소스 판은 안 보일 뿐 붙어 있다(영상 요소를 떼지 않는다)

  pickMode("timeline", "V1 만 보기"); // 오른쪽에서 왼쪽 것과 같은 것을 고르면 서로 자리를 바꾼다
  expect(paneModes()).toEqual(["timeline", "1"]);
  pickMode("1", "소스");
  expect(paneModes()).toEqual(["timeline", "source"]);
  expect(JSON.parse(localStorage.getItem(UI_KEY)!)).toMatchObject({ dual: true, views: ["timeline", "source"] });

  act(() => dual().click()); // 싱글 — 오른쪽 판의 것만 남는다. 싱글이어도 소스를 볼 수 있다
  expect(paneModes()).toEqual(["source"]);
  expect(pane("timeline").hidden).toBe(true);
  expect(pane("timeline").querySelector<HTMLVideoElement>("video")!.muted).toBe(true); // 안 보이는 타임라인은 소리를 끈다
  expect(JSON.parse(localStorage.getItem(UI_KEY)!).dual).toBe(false);
});

it("뷰어 판: 재생 키는 마지막에 누른 판의 시계로 간다 — 소스를 틀면 타임라인은 멈추고, 반복은 시계마다 따로 켠다", () => {
  world.gens = [...world.gens, videoGen()];
  localStorage.setItem(UI_KEY, JSON.stringify({ dual: true, views: ["source", "timeline"] }));
  mount();
  act(() => cutCell("c1").click());
  act(() => poolCards()[2].click()); // 소스 = 영상 v
  expect(pane("timeline").classList.contains("ed-view-on")).toBe(true); // 처음에는 타임라인이 키를 받는다
  press({ key: " ", code: "Space" });
  expect(playingIn("timeline")).toBe(true);
  expect(playingIn("source")).toBe(false);

  mouse(pane("source").querySelector(".ed-stage")!, "mousedown"); // 소스 판을 누른다
  expect(pane("source").classList.contains("ed-view-on")).toBe(true);
  expect(pane("timeline").classList.contains("ed-view-on")).toBe(false);
  press({ key: " ", code: "Space" }); // Space 는 이제 소스 것 — 타임라인은 멈춘다(둘을 같이 틀지 않는다)
  expect(playingIn("source")).toBe(true);
  expect(playingIn("timeline")).toBe(false);
  press({ key: "k", code: "KeyK" });
  expect(playingIn("source")).toBe(false);
  press({ key: "m", code: "KeyM" }); // 편집 키(M = 북마크)는 언제나 타임라인 것이다
  expect(stored().markers).toHaveLength(1);

  mouse(document.querySelector(".ed-tl")!, "mousedown"); // 아래 타임라인을 누르면 다시 타임라인
  expect(pane("timeline").classList.contains("ed-view-on")).toBe(true);
  act(() => pane("source").querySelector<HTMLButtonElement>(".ed-play")!.click()); // 단추는 누른 판의 것
  expect(playingIn("source")).toBe(true);
  act(() => pane("timeline").querySelector<HTMLButtonElement>(".ed-play")!.click()); // 타임라인을 틀면 소스가 멈춘다
  expect(playingIn("timeline")).toBe(true);
  expect(playingIn("source")).toBe(false);
  act(() => pane("timeline").querySelector<HTMLButtonElement>(".ed-t-stop")!.click());
  expect(playingIn("timeline")).toBe(false);

  const loop = (mode: string) => pane(mode).querySelector<HTMLButtonElement>(".ed-t-loop")!;
  act(() => loop("source").click()); // 반복 — 소스만 켠다
  expect(loop("source").getAttribute("aria-pressed")).toBe("true");
  expect(loop("timeline").getAttribute("aria-pressed")).toBe("false");
  expect(JSON.parse(localStorage.getItem(UI_KEY)!)).toMatchObject({ loop: false, loopSrc: true });

  // 메뉴에서 고른 것이 재생 키를 받는다 — 타임라인이 키를 받던 중에 오른쪽 판을 'V1 만 보기'로 바꾸면(왼쪽과 자리를 바꾼다)…
  expect(pane("source").classList.contains("ed-view-on")).toBe(true); // 방금 소스 판의 반복 단추를 눌렀다 — 누른 판이 키를 받는다
  mouse(document.querySelector(".ed-tl")!, "mousedown");
  act(() => pane("source").querySelector<HTMLButtonElement>(".ed-t-stop")!.focus()); // 초점이 들어온 것만으로는 안 바뀐다
  expect(pane("timeline").classList.contains("ed-view-on")).toBe(true); // (우클릭 메뉴가 닫히며 초점을 돌려줄 때 대상이 바뀌지 않게)
  act(() => pane("source").querySelector<HTMLButtonElement>(".ed-t-stop")!.click()); // 그 단추를 키보드로 실행하면(click) 그 판
  expect(pane("source").classList.contains("ed-view-on")).toBe(true);
  act(() => document.querySelector<HTMLElement>(".ed-root")!.focus());
  mouse(document.querySelector(".ed-tl")!, "mousedown");
  expect(pane("timeline").classList.contains("ed-view-on")).toBe(true);
  pickMode("timeline", "소스"); // 오른쪽(타임라인)에서 소스를 고른다 — 자리가 바뀌고 소스가 키를 받는다
  expect(paneModes()).toEqual(["timeline", "source"]);
  expect(pane("source").classList.contains("ed-view-on")).toBe(true);
  pickMode("timeline", "V1 만 보기"); // 타임라인류를 고르면 다시 타임라인의 시계
  expect(paneModes()).toEqual(["1", "source"]);
  expect(pane("1").classList.contains("ed-view-on")).toBe(true);
  pickMode("1", "타임라인");

  // 타임바 — 누른 자리로 간다(jsdom 의 줄 폭은 0 이라 맨 앞). 끝으로 단추는 전체 끝으로.
  act(() => pane("timeline").querySelector<HTMLButtonElement>(".ed-t-last")!.click());
  expect(timecode()).toBe("00:00:15:00");
  expect(pane("timeline").querySelector(".ed-vtop > .ed-vtc")!.textContent).toBe("00:00:15:00"); // 위 줄의 지금 시각도 같이 간다
  mouse(pane("timeline").querySelector(".ed-scrub")!, "pointerdown");
  expect(timecode()).toBe("00:00:00:00");
});

// 소스만 보이는 화면(싱글·소스)에서는 재생 키가 소스로 간다 — 판을 따로 누르지 않아도, 저장된 화면으로 다시 들어와도.
//  안 그러면 Space 가 안 보이는 타임라인을 튼다(Codex 코드 리뷰).
it("뷰어 판: 소스만 보이면 재생 키는 소스 것이다 — 메뉴로 막 바꿨을 때도, 저장된 화면으로 다시 들어왔을 때도", () => {
  world.gens = [...world.gens, videoGen()];
  mount();
  act(() => cutCell("c1").click());
  act(() => poolCards()[2].click());
  pickMode("timeline", "소스"); // 싱글 뷰어를 소스로 — 소스 화면을 따로 누르지 않는다
  expect(paneModes()).toEqual(["source"]);
  press({ key: " ", code: "Space" });
  expect(playingIn("source")).toBe(true);
  expect(playingIn("timeline")).toBe(false); // 안 보이는 타임라인은 돌지 않는다
  press({ key: "k", code: "KeyK" });
  mouse(document.querySelector(".ed-tl")!, "mousedown"); // 아래 타임라인을 눌러도 — 보이는 판이 소스뿐이다
  press({ key: "l", code: "KeyL" });
  expect(playingIn("source")).toBe(true);
  expect(playingIn("timeline")).toBe(false);
  press({ key: "k", code: "KeyK" });

  act(() => root.unmount()); // 다시 들어온다 — 저장된 화면은 싱글·소스
  root = createRoot(host);
  mount();
  expect(paneModes()).toEqual(["source"]);
  act(() => cutCell("c1").click());
  act(() => poolCards()[2].click());
  press({ key: " ", code: "Space" });
  expect(playingIn("source")).toBe(true);
  expect(playingIn("timeline")).toBe(false);
});

it("타임라인의 그림을 누르면 그 컷으로 간다 — 이미 그 컷이면 보던 자리 그대로", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }]);
  mount();
  act(() => cutCell("c2").click());
  expect(timecode()).toBe("00:00:05:00");
  mouse(clips()[0], "pointerdown");
  expect(document.querySelector(".ed-cutcell.ed-cur")?.textContent).toBe("c1");
  expect(timecode()).toBe("00:00:00:00");
  expect(clips()[0].classList.contains("ed-sel")).toBe(true); // 고르기도 그대로 된다

  press({ key: "ArrowRight", code: "ArrowRight", shiftKey: true }); // 1초 앞으로
  mouse(clips()[0], "pointerdown");
  expect(timecode()).toBe("00:00:01:00");
});

it("컷을 더블클릭하면 그 컷으로 가고, 열 폴더와 타임라인에 넣은 카드의 표를 알린다 — 눈금자는 열지 않는다", () => {
  seed([{ cut: "c2", gen: "x", track: 1 }, { cut: "c2", gen: "y", track: 2 }]); // y 가 위(보이는 것)
  mount();
  act(() => cutCell("c1").click());
  // 기본 확대는 1초 = 20px — c1 은 0~100px, c2 는 100~200px(jsdom 의 줄 왼쪽은 0)
  mouse(document.querySelector(".ed-ruler")!, "dblclick", { clientX: 150 });
  expect(opened).toHaveLength(0);

  mouse(document.querySelector(".ed-lanes")!, "dblclick", { clientX: 150 });
  expect(timecode()).toBe("00:00:05:00");
  expect(opened).toEqual([{
    projectId: "p1", projectName: "P1", path: "e070/c2", focusId: "y",
    marks: { x: { label: "V1 - 선택 카드", lead: false }, y: { label: "V2 - 선택 카드", lead: true } },
  }]);

  mouse(document.querySelector(".ed-lanes")!, "dblclick", { clientX: 50 }); // 아무것도 안 넣은 컷 — 표 없이 연다
  expect(opened[1]).toEqual({ projectId: "p1", projectName: "P1", path: "e070/c1", focusId: null, marks: {} });
});

// 카드 우클릭(Jay 2026-10-08) — 지금 있는 트랙이 뜨고, 고르면 그 트랙에 들어간다. 찬 트랙은 교체, 빈 트랙은 그 자리에 쌓인다.
it("폴더 창의 카드를 우클릭하면 트랙 메뉴가 뜬다 — 찬 트랙을 고르면 교체, 빈 트랙이면 그 자리에 들어간다", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }]);
  mount();
  act(() => cutCell("c1").click());
  expect(peekMarks).toHaveLength(0); // 창이 없으면 표를 알리지 않는다
  mount(0, "e070/c1"); // 창이 떴다
  expect(peekMarks).toEqual([{ a: { label: "V1 - 선택 카드", lead: true } }]);
  mount(0, "e070/c1"); // 다시 그려져도 내용이 같으면 다시 알리지 않는다(알릴 때마다 App 이 다시 그린다)
  expect(peekMarks).toHaveLength(1);

  cardMenu("b");
  expect(menuText()).toEqual(["V3비어 있음", "V2비어 있음", "V1교체"]);
  expect(document.activeElement).toBe(menuItems()[0]); // 메뉴가 초점을 가져간다
  act(() => menuItems()[2].click()); // V1 — a 를 빼고 b 가 들어간다
  expect(trackMenu()).toBeNull();
  expect(stored().clips).toEqual([{ cut: "e070/c1", gen: "b", track: 1, kind: "image", dur: 5, job: "job-b" }]);
  expect(peekMarks[peekMarks.length - 1]).toEqual({ b: { label: "V1 - 선택 카드", lead: true } }); // 창의 표가 그 자리에서 바뀐다
  expect(document.activeElement).toBe(document.querySelector(".ed-root")); // 초점은 열기 전 자리로 돌아온다

  cardMenu("a"); // a 를 V3 에 — 빈 트랙이라 쌓인다(위 트랙이 보인다)
  act(() => menuItems()[0].click());
  expect(storedTracks()).toEqual([["b", 1], ["a", 3]]);
  expect(peekMarks[peekMarks.length - 1]).toEqual({
    b: { label: "V1 - 선택 카드", lead: false }, a: { label: "V3 - 선택 카드", lead: true },
  });

  cardMenu("a"); // 이미 넣은 카드 — 지금 있는 트랙은 고를 수 없고, 다른 트랙을 고르면 옮긴다(찬 자리는 교체)
  expect(menuText()).toEqual(["V3지금 여기 ×", "V2비어 있음", "V1교체"]);
  act(() => menuItems()[2].click());
  expect(storedTracks()).toEqual([["a", 1]]);

  press({ key: "z", code: "KeyZ", ctrlKey: true }); // 한 번 고른 것이 되돌리기 한 단계
  expect(storedTracks()).toEqual([["b", 1], ["a", 3]]);

  // 편집 탭의 이 컷 공유 목록에 없는 카드(다른 공간·다른 컷·못 쓰는 것)는 받지 않는다
  cardMenu("x");
  expect(trackMenu()).toBeNull();
  expect(flashed[flashed.length - 1]).toContain("넣을 수 없습니다");

  cardMenu("b");
  expect(trackMenu()).not.toBeNull();
  mount(0, null); // 창이 닫히면 메뉴도 닫힌다
  expect(trackMenu()).toBeNull();
});

it("트랙 메뉴: Esc 는 메뉴가 먹고, 잠긴 트랙은 고를 수 없고, 떠 있는 동안 뒤 화면의 키는 듣지 않는다", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }], { tracksLocked: [1] });
  mount();
  act(() => cutCell("c1").click());
  mount(0, "e070/c1");
  cardMenu("b");
  expect(menuText()).toEqual(["V3비어 있음", "V2비어 있음", "V1잠김 ×"]); // 잠긴 트랙의 클립은 교체하지 않는다
  expect(document.activeElement).toBe(menuItems()[0]);
  press({ key: "ArrowDown", code: "ArrowDown" }, menuItems()[0]); // 줄은 ↑↓ 로 옮긴다(고를 수 있는 줄만)
  expect(document.activeElement).toBe(menuItems()[1]);
  press({ key: "ArrowDown", code: "ArrowDown" }, menuItems()[1]);
  expect(document.activeElement).toBe(menuItems()[0]);
  expect(timecode()).toBe("00:00:00:00"); // 방향키가 뒤의 타임라인(편집점 이동)으로 새지 않는다
  const tab = press({ key: "Tab", code: "Tab" }, menuItems()[0]); // Tab 은 메뉴를 닫는다 — 초점이 메뉴 밖 단추로 나가지 않게
  expect(trackMenu()).toBeNull();
  expect(tab.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(document.querySelector(".ed-root"));
  cardMenu("b");
  const escape = press({ key: "Escape", code: "Escape" });
  expect(trackMenu()).toBeNull();
  expect(escape.defaultPrevented).toBe(true);

  cardMenu("a"); // 잠긴 트랙에 있는 카드는 어디로도 못 옮긴다 — 고를 줄이 하나도 없다
  expect(menuText()).toEqual(["V3잠김 ×", "V2잠김 ×", "V1지금 여기 ×"]);
  expect(document.activeElement).toBe(trackMenu()); // 단추가 없어도 메뉴가 초점을 받는다
  // 초점이 메뉴 밖에 있어도(Tab 으로 빠져나갔다) 뒤 화면의 편집 키는 실행되지 않는다 — M(북마크)·D(폴더 끄기)
  act(() => document.querySelector<HTMLElement>(".ed-root")!.focus());
  press({ key: "m", code: "KeyM" }, document.querySelector(".ed-root")!);
  press({ key: "d", code: "KeyD" });
  expect(stored().markers).toBeUndefined();
  expect(offCuts()).toEqual(["c3"]);
  mouse(document.body, "mousedown"); // 바깥 누르기
  expect(trackMenu()).toBeNull();
  press({ key: "m", code: "KeyM" }); // 닫히면 다시 듣는다
  expect(stored().markers).toHaveLength(1);
});

// 공유 목록을 끝까지 받기 전에는 job 으로 이은 클립이 어느 카드인지 모른다 — 그때 그 카드를 또 넣으면 같은 생성물이 두 트랙에
//  들어가거나 교체하면서 그 클립의 꺼짐이 사라진다. 그 카드만 막는다: 컷 전체를 막으면 목록이 잘린 시퀀스에서는 영영 안 풀린다.
it("트랙 메뉴: 이미 넣은 클립일 수 있는 카드만 받지 않는다 — job 으로 이은 클립은 다 받은 뒤에 '지금 여기'로 보인다", () => {
  seed([{ cut: "c1", gen: "old-a", job: "job-a", track: 1, off: true }]); // 옛 id — job 으로 카드 a 에 이어진다
  mount();
  act(() => cutCell("c1").click());
  mount(0, "e070/c1");
  cardMenu("a");
  expect(menuText()).toEqual(["V3비어 있음", "V2비어 있음", "V1지금 여기 ×"]);
  act(() => menuItems()[1].click()); // V2 로 옮긴다 — 문서의 그 클립이 옮겨 간다(새 클립이 생기지 않는다)
  expect(stored().clips).toEqual([{ cut: "e070/c1", gen: "old-a", track: 2, kind: "image", dur: 5, job: "job-a", off: true }]);

  cardMenu("a"); // 메뉴가 떠 있는 사이 다시 받기가 시작됐다(또는 목록이 잘렸다) — 그 클립이 어느 카드인지 모른다
  world.known = false;
  mount(0, "e070/c1");
  act(() => menuItems()[0].click());
  expect(trackMenu()).toBeNull();
  expect(flashed[flashed.length - 1]).toContain("이미 넣은 클립일 수 있습니다");
  expect(stored().clips).toHaveLength(1);
  cardMenu("a"); // 그동안에는 그 카드의 메뉴도 열지 않는다
  expect(trackMenu()).toBeNull();
  expect(flashed).toHaveLength(2);

  cardMenu("b"); // 다른 카드는 그대로 넣는다 — 목록이 2,000건에서 잘린 시퀀스에서도 편집이 막히지 않는다
  expect(menuText()).toEqual(["V3비어 있음", "V2교체", "V1비어 있음"]);
  act(() => menuItems()[2].click());
  expect(storedTracks()).toEqual([["old-a", 2], ["b", 1]]);
});

it("빈 폴더는 기본으로 비활성이고, 숨기기를 켜면 타임라인에서 빠진다 — D 로 재생헤드가 있는 폴더를 켜고 끈다", () => {
  mount();
  act(() => cutCell("c1").click());
  expect(cuts()).toEqual(["c1", "c2", "c3"]);
  expect(offCuts()).toEqual(["c3"]); // 공유물도 넣은 것도 없는 폴더
  expect(hideButton().textContent).toContain("1");
  expect([...document.querySelectorAll(".ed-side .folder-tree-row.disabled .folder-tree-name")]
    .map((name) => name.textContent)).toEqual(["c3"]); // 왼쪽 폴더도 회색

  act(() => hideButton().click());
  expect(cuts()).toEqual(["c1", "c2"]);
  expect(hideButton().getAttribute("aria-pressed")).toBe("true");
  expect(document.querySelector(".ed-seq")!.textContent).toContain("컷 2");

  // 재생헤드가 있는 c1 을 끈다 — 숨기기가 켜져 있어 타임라인에서 사라지고 재생헤드는 다음 컷으로 간다
  expect(press({ key: "d", code: "KeyD" }).defaultPrevented).toBe(true);
  expect(cuts()).toEqual(["c2"]);
  expect(document.querySelector(".ed-cutcell.ed-cur")?.textContent).toBe("c2");
  expect(stored()).toMatchObject({ cutsOff: ["e070/c1"], hideOff: true });

  press({ key: "z", code: "KeyZ", ctrlKey: true }); // 되돌리기로 다시 켜진다
  expect(cuts()).toEqual(["c1", "c2"]);

  act(() => hideButton().click()); // 숨기기를 끄면 다 보이고, 빈 폴더도 D 로 켤 수 있다
  expect(cuts()).toEqual(["c1", "c2", "c3"]);
  act(() => cutCell("c3").click());
  press({ key: "d", code: "KeyD" });
  expect(offCuts()).toEqual([]);
  expect(stored().cutsOn).toEqual(["e070/c3"]);
  press({ key: "d", code: "KeyD" }); // 다시 끄면 기본값으로 — 적어 둔 것을 지운다
  expect(offCuts()).toEqual(["c3"]);
  expect(stored().cutsOn).toBeUndefined();
});

it("클립을 고른 채 누른 D 는 그 클립을 끄고, 컷 이름을 누르면 고르기가 풀려 D 가 폴더에 걸린다", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }]);
  mount();
  act(() => cutCell("c1").click()); // 재생헤드 자리는 시퀀스마다 기억된다 — 앞 시험이 둔 자리에 기대지 않는다
  mouse(clips()[0], "pointerdown");
  press({ key: "d", code: "KeyD" });
  expect(clips()[0].classList.contains("ed-off")).toBe(true);
  expect(offCuts()).toEqual(["c3"]); // 폴더는 그대로

  act(() => cutCell("c1").click());
  expect(clips()[0].classList.contains("ed-sel")).toBe(false);
  press({ key: "d", code: "KeyD" });
  expect(offCuts()).toEqual(["c1", "c3"]);
});

it("숨긴 컷의 클립은 고르기에서 빠진다 — D·Delete·Ctrl+A 가 보이지 않는 클립을 건드리지 않는다", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }]);
  mount();
  act(() => cutCell("c1").click());
  press({ key: "d", code: "KeyD" }); // 고른 것이 없다 — c1 폴더를 끈다
  expect(offCuts()).toEqual(["c1", "c3"]);
  mouse(clips()[0], "pointerdown"); // 그 컷의 클립을 고른다
  expect(document.querySelectorAll(".ed-clip.ed-sel")).toHaveLength(1);

  act(() => hideButton().click()); // 숨기면 c1 은 타임라인에 없다
  expect(clips()).toHaveLength(0);
  press({ key: "Delete", code: "Delete" }); // 고른 것이 없으니 아무것도 지우지 않는다
  press({ key: "a", code: "KeyA", ctrlKey: true });
  press({ key: "Delete", code: "Delete" });
  expect(stored().clips).toHaveLength(1);

  act(() => hideButton().click());
  expect(clips()).toHaveLength(1); // 클립은 그대로 남아 있다
  expect(document.querySelectorAll(".ed-clip.ed-sel")).toHaveLength(0);
});

it("공유 목록을 끝까지 받아 보기 전에는 빈 폴더라고 단정하지 않는다", () => {
  world.known = false;
  mount();
  expect(offCuts()).toEqual([]);
});

// 왼쪽 폴더 옆 표시(Jay 2026-10-08) — 공유 & 리뷰 사이드바처럼 새로 들어온 것(+N)·최종(★)·보류(R)가 보인다.
it("왼쪽 폴더 옆에 새 항목·최종·보류가 보이고, 프로젝트 행에도 +N 이 붙는다", () => {
  world.fresh = { p1: 1, p2: 4 };
  mount();
  const row = (name: string) => [...document.querySelectorAll<HTMLElement>(".ed-side .folder-tree-row")]
    .find((item) => item.querySelector(".folder-tree-name")!.textContent === name)!;
  expect(row("c1").querySelector(".folder-tree-newcount")?.textContent).toBe("+1");
  expect(row("c1").querySelector(".folder-review-final")?.textContent).toBe("★1");
  expect(row("c1").querySelector(".folder-review-held")?.textContent).toBe("R1");
  expect(row("c1").querySelector(".folder-review-total")?.textContent).toBe("2");
  expect(row("c2").querySelector(".folder-tree-newcount, .folder-review-final, .folder-review-held")).toBeNull();
  expect(row("c2").querySelector(".folder-review-total")?.textContent).toBe("2");
  expect(row("e070").querySelector(".folder-tree-newcount")?.textContent).toBe("+1"); // 하위 폴더의 것이 위로 모인다
  expect([...document.querySelectorAll(".ed-side .proj-row")].map((item) => item.querySelector(".proj-newcount")?.textContent))
    .toEqual(["+1", "+4"]);
});

it("폴더 창이 닫히면, 그리고 생성물이 바뀌었다는 알림이 오면 공유 목록과 폴더 옆 숫자를 다시 받는다", () => {
  const reload = vi.fn();
  const reloadCounts = vi.fn();
  world.reload = reload;
  world.reloadCounts = reloadCounts;
  mount(0);
  expect(reload).not.toHaveBeenCalled();
  mount(1); // 창이 닫혔다
  expect(reload).toHaveBeenCalledTimes(1);
  expect(reloadCounts).toHaveBeenCalledTimes(1);

  act(() => { window.dispatchEvent(new CustomEvent("ch:library-changed")); });
  act(() => { window.dispatchEvent(new CustomEvent("ch:library-changed")); });
  expect(reload).toHaveBeenCalledTimes(1); // 몰아서 한 번
  act(() => { vi.advanceTimersByTime(500); });
  expect(reload).toHaveBeenCalledTimes(2);
  expect(reloadCounts).toHaveBeenCalledTimes(2);
});

// 오른쪽 칸이 하던 안내는 타임라인 위 막대로 옮겼다 — 워크스페이스를 못 정한 계정의 출구, 공유 목록을 받지 못했을 때.
it("공유 목록의 상태는 타임라인 위 막대에 보인다 — 워크스페이스 미확인의 출구·받지 못함·잘림", () => {
  const bar = () => document.querySelector(".ed-bar")!.textContent!;
  mount(0, null, { scope: "unknown", id: null, name: null });
  expect(bar()).toContain("워크스페이스를 확인한 뒤 공유물을 표시합니다.");
  act(() => document.querySelector<HTMLButtonElement>(".ed-ws-all")!.click());
  expect(document.querySelector(".ed-ws-all")).toBeNull(); // 모든 워크스페이스로 본다 — 안내가 사라진다
  expect(document.querySelector(".ed-pool-sub")!.textContent).not.toContain("워크스페이스");

  const reload = vi.fn();
  world.reload = reload;
  world.state = "error";
  world.error = "HTTP 502";
  mount();
  expect(bar()).toContain("공유 목록을 받지 못했습니다.");
  act(() => [...document.querySelectorAll<HTMLButtonElement>(".ed-bar .ed-link")].find((item) => item.textContent === "다시 시도")!.click());
  expect(reload).toHaveBeenCalledTimes(1);

  world.state = "capped";
  mount();
  expect(bar()).toContain("최대 2,000건까지만 표시합니다.");
});

// ── 트랙 머리 우클릭 메뉴 · 마크 인/아웃 · 북마크(Jay 2026-10-08, 다빈치의 타임라인) ──
const heads = () => [...document.querySelectorAll<HTMLElement>(".ed-head.ed-h-v")];
const headOf = (track: number) => heads().find((head) => head.querySelector("b")!.textContent === `V${track}`)!;
const menuItem = (label: string) => menuItems().find((item) => item.textContent!.includes(label))!;
const bookmarks = () => [...document.querySelectorAll<HTMLButtonElement>(".ed-ruler .ed-mk")];
const nameInput = () => document.querySelector<HTMLInputElement>(".ed-mmenu .ed-mmenu-name")!;

it("트랙 머리 우클릭: 트랙을 더하고 옮기고 지운다 — 클립·잠금이 트랙을 따라가고, 지운 것은 되돌리기로 살린다", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }, { cut: "c1", gen: "b", track: 2 }], { tracksLocked: [3] });
  mount();
  act(() => cutCell("c1").click());
  expect(heads().map((head) => head.querySelector("b")!.textContent)).toEqual(["V3", "V2", "V1"]);
  expect(rightClick(headOf(1)).defaultPrevented).toBe(true);
  expect(menuText()).toEqual(["이 위에 트랙 추가", "트랙 위로 옮기기", "트랙 아래로 옮기기 ×", "트랙 삭제클립 1개", "빈 트랙 모두 삭제"]);
  act(() => menuItem("이 위에 트랙 추가").click());
  expect(trackMenu()).toBeNull();
  expect(heads()).toHaveLength(4);
  expect(storedTracks()).toEqual([["a", 1], ["b", 3]]);
  expect(stored()).toMatchObject({ tracks: 4, tracksLocked: [4] }); // 잠금도 그 트랙을 따라 올라간다
  expect(document.activeElement).toBe(document.querySelector(".ed-root")); // 메뉴가 닫히면 편집 키가 돌아온다

  rightClick(headOf(3));
  expect(menuItem("트랙 위로 옮기기").disabled).toBe(true); // 위(V4)가 잠겨 있다
  act(() => menuItem("트랙 아래로 옮기기").click()); // V3(b) ↔ V2(빈 줄)
  expect(storedTracks()).toEqual([["a", 1], ["b", 2]]);

  rightClick(headOf(4));
  expect(menuItem("트랙 삭제").disabled).toBe(true); // 잠긴 트랙은 못 지운다
  act(() => menuItem("빈 트랙 모두 삭제").click()); // V3·V4(잠겼어도 비었다)가 사라진다
  expect(heads()).toHaveLength(2);
  expect(stored()).toMatchObject({ tracks: 2, tracksLocked: [] });

  rightClick(headOf(2));
  act(() => menuItem("트랙 삭제").click()); // 그 트랙의 클립(b)도 빠진다
  expect(storedTracks()).toEqual([["a", 1]]);
  expect(heads()).toHaveLength(1);
  rightClick(headOf(1));
  expect(menuItem("트랙 삭제").disabled).toBe(true); // 마지막 한 줄
  press({ key: "Escape", code: "Escape" });
  expect(trackMenu()).toBeNull();
  press({ key: "z", code: "KeyZ", ctrlKey: true }); // 되돌리기 — 지운 트랙과 클립이 돌아온다
  expect(storedTracks()).toEqual([["a", 1], ["b", 2]]);
  expect(heads()).toHaveLength(2);

  rightClick(headOf(2)); // 트랙 색 — 머리와 그 줄에 색 띠
  act(() => document.querySelector<HTMLButtonElement>(".ed-hmenu .ed-swatch")!.click());
  expect(stored().trackColors).toEqual({ 2: "#e5484d" });
  expect(headOf(2).style.getPropertyValue("--trk")).toBe("#e5484d");
  expect(document.querySelector<HTMLElement>('.ed-lane[data-track="2"]')!.style.getPropertyValue("--trk")).toBe("#e5484d");
  expect(flashed).toEqual([]);
});

it("마크 인/아웃: I·O 로 찍고 Alt 로 지우고 Shift 로 그 자리에 간다 — 눈금자와 뷰어 타임바에 구간이 보인다", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }]);
  mount();
  act(() => cutCell("c1").click());
  press({ key: "ArrowRight", code: "ArrowRight", shiftKey: true }); // 1초
  press({ key: "i", code: "KeyI" });
  act(() => cutCell("c2").click()); // 5초
  press({ key: "o", code: "KeyO" });
  expect(stored()).toMatchObject({ markIn: { cut: "e070/c1", local: 1 }, markOut: { cut: "e070/c2", local: 0 } });
  const band = document.querySelector<HTMLElement>(".ed-ruler .ed-inout")!;
  expect([band.style.left, band.style.width]).toEqual(["20px", "80px"]); // 1초~5초(20px/초)
  expect(document.querySelector(".ed-ruler .ed-mark-in")).not.toBeNull();
  expect(document.querySelector(".ed-ruler .ed-mark-out")).not.toBeNull();
  expect(document.querySelector(".ed-inout-shade")).not.toBeNull();
  expect(parseFloat(pane("timeline").querySelector<HTMLElement>(".ed-scrub-range")!.style.left)).toBeCloseTo(100 / 15); // 전체 15초의 1초
  expect(pane("source").querySelector(".ed-scrub-range")).toBeNull(); // 소스 판에는 없다
  expect(document.querySelector(".ed-mclear")!.textContent).toContain("00:00:04:00"); // 구간 길이
  expect(pane("timeline").querySelectorAll(".ed-scrub-io")).toHaveLength(2); // 재생바 아래의 인·아웃 꼬리표

  press({ key: "Home", code: "Home" });
  press({ key: "o", code: "KeyO", shiftKey: true }); // 아웃 자리로
  expect(timecode()).toBe("00:00:05:00");
  press({ key: "i", code: "KeyI", shiftKey: true }); // 인 자리로
  expect(timecode()).toBe("00:00:01:00");
  press({ key: "o", code: "KeyO" }); // 아웃을 인과 같은 자리에 찍으면 인이 지워진다
  expect(stored().markIn).toBeUndefined();
  expect(stored().markOut).toEqual({ cut: "e070/c1", local: 1 });
  press({ key: "x", code: "KeyX", altKey: true }); // 둘 다 지우기
  expect(stored().markOut).toBeUndefined();
  expect(document.querySelector(".ed-inout")).toBeNull();
  expect(document.querySelector(".ed-mclear")).toBeNull();
  act(() => pane("timeline").querySelector<HTMLButtonElement>(".ed-t-in")!.click()); // 뷰어 오른쪽 아래의 단추로도 찍는다
  expect(stored().markIn).toEqual({ cut: "e070/c1", local: 1 });
  press({ key: "i", code: "KeyI", altKey: true });
  expect(stored().markIn).toBeUndefined();
});

it("북마크: M 으로 넣고, 누르면 그 자리로 가고, 더블클릭하면 이름·색을 고치고 지운다 — Shift+↑↓ 로 오간다", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }]);
  mount();
  act(() => cutCell("c1").click());
  press({ key: "ArrowRight", code: "ArrowRight", shiftKey: true }); // 1초
  press({ key: "m", code: "KeyM" });
  act(() => cutCell("c2").click()); // 5초
  act(() => document.querySelector<HTMLButtonElement>(".ed-mbtn-mk")!.click()); // 단추로도 넣는다
  expect(stored().markers).toEqual([
    { cut: "e070/c1", local: 1, color: "#1287ff" }, { cut: "e070/c2", local: 0, color: "#1287ff" }, // 새 북마크의 색(기본 파랑)
  ]);
  expect(stored().muted).toBeUndefined(); // M 은 이제 소리 끄기가 아니다(소리는 A1 의 M 단추)
  expect(bookmarks().map((item) => item.style.left)).toEqual(["20px", "100px"]);
  expect(pane("timeline").querySelectorAll(".ed-scrub-mk")).toHaveLength(2);

  press({ key: "Home", code: "Home" });
  press({ key: "ArrowDown", code: "ArrowDown", shiftKey: true }); // 뒤 북마크로
  expect(timecode()).toBe("00:00:01:00");
  press({ key: "ArrowDown", code: "ArrowDown", shiftKey: true });
  expect(timecode()).toBe("00:00:05:00");
  press({ key: "ArrowDown", code: "ArrowDown", shiftKey: true }); // 더 없으면 그대로
  expect(timecode()).toBe("00:00:05:00");
  press({ key: "ArrowUp", code: "ArrowUp", shiftKey: true });
  expect(timecode()).toBe("00:00:01:00");
  act(() => bookmarks()[1].click()); // 누르면 그 자리로
  expect(timecode()).toBe("00:00:05:00");

  mouse(bookmarks()[0], "dblclick"); // 편집 창 — 이름·색·지우기
  expect(document.activeElement).toBe(nameInput());
  expect(opened).toHaveLength(0); // 눈금자의 더블클릭은 컷의 폴더 창을 열지 않는다
  act(() => document.querySelectorAll<HTMLButtonElement>(".ed-mmenu .ed-swatch")[3].click()); // 색은 누르는 즉시 바뀐다
  expect(document.querySelectorAll(".ed-mmenu .ed-swatch")).toHaveLength(16); // 다빈치의 마커 색 16가지
  expect(stored().markers[0].color).toBe("#f09d00");
  expect(bookmarks()[0].style.getPropertyValue("--mk")).toBe("#f09d00");
  typeIn(nameInput(), "여기부터 다시");
  press({ key: "m", code: "KeyM" }, nameInput()); // 입력칸의 글자는 편집 키가 아니다
  expect(stored().markers).toHaveLength(2);
  press({ key: "Enter", code: "Enter", isComposing: true }, nameInput()); // 한글 조합 중의 Enter 는 글자 확정 — 닫지 않는다
  expect(document.querySelector(".ed-mmenu")).not.toBeNull();
  expect(stored().markers[0].name).toBeUndefined();
  press({ key: "Enter", code: "Enter" }, nameInput()); // Enter = 저장하고 닫는다
  expect(document.querySelector(".ed-mmenu")).toBeNull();
  expect(stored().markers[0]).toEqual({ cut: "e070/c1", local: 1, color: "#f09d00", name: "여기부터 다시" });
  expect(bookmarks()[0].title).toContain("여기부터 다시");
  expect(document.activeElement).toBe(document.querySelector(".ed-root"));

  mouse(bookmarks()[0], "dblclick");
  typeIn(nameInput(), "버릴 이름");
  press({ key: "Escape", code: "Escape" }); // Esc = 버린다
  expect(stored().markers[0].name).toBe("여기부터 다시");
  rightClick(bookmarks()[0]); // 우클릭으로도 연다
  typeIn(nameInput(), "바깥을 눌러 저장");
  mouse(document.body, "mousedown"); // 바깥 누르기 = 저장
  expect(stored().markers[0].name).toBe("바깥을 눌러 저장");

  press({ key: "m", code: "KeyM" }); // 북마크가 있는 자리(5초)에서 M = 그 북마크의 편집 창
  expect(document.querySelector(".ed-mmenu .ed-tmenu-head")!.textContent).toContain("00:00:05:00");
  act(() => menuItem("북마크 지우기").click());
  expect(stored().markers).toHaveLength(1);
  act(() => cutCell("c1").click());
  press({ key: "ArrowRight", code: "ArrowRight", shiftKey: true });
  press({ key: "m", code: "KeyM", altKey: true }); // Alt+M = 재생헤드 자리의 북마크 지우기
  expect(stored().markers).toBeUndefined();
  expect(bookmarks()).toHaveLength(0);
});

// ── 다빈치의 뷰어·재생바에 맞춘 것(Jay 2026-10-08): 북마크 색 메뉴 · 뷰어의 마크 인/아웃·구간 반복 단추 · 소스 테이프 ──
it("북마크 색 메뉴: 새 북마크의 색을 고르고(이 브라우저에 남는다) 모두 지운다 — 재생바에는 북마크가 그 색으로 보인다", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }]);
  mount();
  act(() => cutCell("c1").click());
  const colorButton = () => document.querySelector<HTMLButtonElement>(".ed-mbtn-color")!;
  act(() => colorButton().click());
  expect(menuText()).toEqual(["모두 지우기× ×", "파랑", "청록", "초록", "노랑", "빨강", "분홍", "보라", "자홍", "장미", "라벤더", "하늘",
    "민트", "레몬", "모래", "코코아", "크림"]); // 다빈치의 마커 색 메뉴 — 북마크가 없으면 '모두 지우기'는 흐리다
  expect(document.activeElement).toBe(menuItem("파랑")); // 지금 색
  act(() => menuItem("빨강").click());
  expect(document.querySelector(".ed-cmenu")).toBeNull();
  expect(JSON.parse(localStorage.getItem(UI_KEY)!).markerColor).toBe("#e12401");
  expect(document.querySelector<HTMLElement>(".ed-mbtn-mk")!.style.getPropertyValue("--mk")).toBe("#e12401");
  expect(stored().markers).toBeUndefined(); // 색 고르기는 편집이 아니다
  expect(document.activeElement).toBe(document.querySelector(".ed-root"));

  press({ key: "m", code: "KeyM" });
  press({ key: "ArrowRight", code: "ArrowRight", shiftKey: true });
  press({ key: "m", code: "KeyM" });
  expect(stored().markers).toEqual([{ cut: "e070/c1", local: 0, color: "#e12401" }, { cut: "e070/c1", local: 1, color: "#e12401" }]);
  const dots = pane("timeline").querySelectorAll<HTMLElement>(".ed-scrub-mk");
  expect(dots).toHaveLength(2);
  expect(dots[0].style.background).toBe("rgb(225, 36, 1)");

  act(() => colorButton().click());
  expect(menuItem("빨강").getAttribute("aria-checked")).toBe("true");
  // 메뉴가 떠 있는 사이 다른 창이 이 편집을 바꾸면 닫힌다 — 그 창이 넣은 북마크까지 '모두 지우기'로 지우지 않게
  localStorage.setItem(DOC_KEY, JSON.stringify({ ...stored(), muted: true }));
  act(() => { window.dispatchEvent(new StorageEvent("storage", { key: DOC_KEY })); });
  expect(document.querySelector(".ed-cmenu")).toBeNull();
  expect(stored().markers).toHaveLength(2);
  act(() => colorButton().click());
  act(() => menuItem("모두 지우기").click());
  expect(stored().markers).toBeUndefined();
  expect(bookmarks()).toHaveLength(0);
  press({ key: "z", code: "KeyZ", ctrlKey: true }); // 되돌리기 한 번에 돌아온다
  expect(stored().markers).toHaveLength(2);
  expect(flashed).toEqual(["다른 창에서 바꾼 편집을 불러왔습니다."]);
});

it("뷰어 오른쪽 아래: 마크 인·마크 아웃 단추와 구간 반복 재생 — 켜면 구간 처음에서 틀고, 구간이 사라지면 꺼진다", () => {
  seed([{ cut: "c1", gen: "a", track: 1 }]);
  mount();
  act(() => cutCell("c1").click());
  const tl = (name: string) => pane("timeline").querySelector<HTMLButtonElement>(`.ed-t-${name}`)!;
  expect(tl("range").disabled).toBe(true); // 되풀이할 구간이 없다
  press({ key: "ArrowRight", code: "ArrowRight", shiftKey: true }); // 1초
  act(() => tl("in").click());
  act(() => cutCell("c2").click()); // 5초
  act(() => tl("out").click());
  expect(stored()).toMatchObject({ markIn: { cut: "e070/c1", local: 1 }, markOut: { cut: "e070/c2", local: 0 } });
  expect(tl("range").disabled).toBe(false);
  expect(document.querySelector(".ed-mbtn-in")).toBeNull(); // 막대에는 마크 단추가 없다(뷰어에 있다)

  act(() => cutCell("c3").click()); // 10초 — 구간 밖
  act(() => tl("range").click());
  expect(tl("range").getAttribute("aria-pressed")).toBe("true");
  expect(timecode()).toBe("00:00:01:00"); // 구간 처음으로 가서
  expect(playingIn("timeline")).toBe(true); // 튼다
  expect(tl("loop").getAttribute("aria-pressed")).toBe("false"); // 전체 반복과는 따로다
  act(() => tl("range").click()); // 끄면 재생은 그대로 두고 구간만 풀린다
  expect(tl("range").getAttribute("aria-pressed")).toBe("false");
  expect(playingIn("timeline")).toBe(true);
  act(() => tl("stop").click());

  press({ key: "/", code: "Slash", altKey: true }); // Alt+/ 도 같은 길 — 좁은 판에서 단추가 숨어도 켜고 끌 수 있다
  expect(tl("range").getAttribute("aria-pressed")).toBe("true");
  expect(playingIn("timeline")).toBe(true);
  press({ key: "/", code: "Slash", altKey: true });
  expect(tl("range").getAttribute("aria-pressed")).toBe("false");
  act(() => tl("stop").click());

  act(() => tl("range").click());
  expect(tl("range").getAttribute("aria-pressed")).toBe("true");
  press({ key: "x", code: "KeyX", altKey: true }); // 구간을 지우면 같이 꺼진다
  expect(tl("range").disabled).toBe(true);
  act(() => tl("stop").click());
  act(() => cutCell("c1").click());
  press({ key: "i", code: "KeyI" });
  act(() => cutCell("c2").click());
  press({ key: "o", code: "KeyO" });
  expect(tl("range").disabled).toBe(false);
  expect(tl("range").getAttribute("aria-pressed")).toBe("false"); // 새로 찍은 구간이 말없이 돌지 않는다
});

it("소스 테이프: 이 컷의 풀 목록을 이어서 본다 — 풀에서 고르면 그 카드로 가고, 소스 클립과는 같은 판의 두 방식이다", () => {
  world.gens = [...world.gens, videoGen()]; // c1 = 그림 a · 그림 b · 영상 v
  localStorage.setItem(UI_KEY, JSON.stringify({ dual: true, views: ["source", "timeline"] }));
  mount();
  act(() => cutCell("c1").click());
  pickMode("source", "소스 테이프");
  expect(paneModes()).toEqual(["tape", "timeline"]);
  const tape = pane("tape");
  expect(tape.querySelector(".ed-vpick-btn")!.textContent).toBe("소스 테이프");
  expect(tape.querySelector(".ed-vtotal")!.textContent).toBe("00:00:15:00"); // 5초씩 셋(영상은 길이를 재기 전이라 기본 5초)
  expect(tape.querySelector<HTMLImageElement>("img.ed-media")!.getAttribute("src")).toBe("/media/a.png"); // 첫 카드부터
  expect(tape.querySelector(".ed-chip-l")!.textContent).toBe("e070 / c1 · 1/3");
  expect(tape.querySelectorAll(".ed-scrub-track > i")).toHaveLength(2); // 재생바의 클립 경계
  expect(tape.querySelector(".ed-t-in")).toBeNull(); // 소스 판에는 마크 단추가 없다

  act(() => poolCards()[2].click()); // 풀에서 영상 v 를 고르면 테이프가 그 카드의 처음으로 간다
  expect(tape.querySelector(".ed-vtop > .ed-vtc")!.textContent).toBe("00:00:10:00");
  expect(tape.querySelector<HTMLVideoElement>("video.ed-media")!.getAttribute("src")).toBe("/media/v.mp4");
  expect(tape.querySelector(".ed-chip-l")!.textContent).toBe("e070 / c1 · 3/3");
  expect(tape.querySelector(".ed-chip-r")!.textContent).toBe("리버 · seedance");
  press({ key: "ArrowUp", code: "ArrowUp" }); // 방금 고른 판이 재생 키를 받는다 — ↑ = 앞 클립 경계
  expect(tape.querySelector(".ed-vtop > .ed-vtc")!.textContent).toBe("00:00:05:00");
  expect(tape.querySelector(".ed-chip-l")!.textContent).toBe("e070 / c1 · 2/3");
  expect(timecode()).toBe("00:00:00:00"); // 타임라인은 그대로다
  expect(localStorage.getItem(DOC_KEY)).toBeNull(); // 테이프는 편집 문서를 건드리지 않는다

  act(() => cutCell("c2").click()); // 다른 컷으로 가면 그 컷의 목록이 테이프가 된다
  expect(tape.querySelector(".ed-vtotal")!.textContent).toBe("00:00:10:00");
  expect(tape.querySelector<HTMLImageElement>("img.ed-media")!.getAttribute("src")).toBe("/media/x.png");
  act(() => cutCell("c3").click()); // 빈 폴더
  expect(tape.textContent).toContain("이 컷 폴더에 공유된 생성물이 없습니다.");

  pickMode("timeline", "소스 클립"); // 오른쪽에서 소스 클립을 고른다 — 소스 판은 하나라 왼쪽(테이프)과 자리를 바꾼다
  expect(paneModes()).toEqual(["timeline", "source"]);
  expect(JSON.parse(localStorage.getItem(UI_KEY)!).views).toEqual(["timeline", "source"]);
});

it("저장된 화면: 소스 클립과 소스 테이프를 두 판에 같이 둔 값·색이 아닌 값은 받지 않는다", () => {
  localStorage.setItem(UI_KEY, JSON.stringify({ dual: true, views: ["source", "tape"], markerColor: "red" }));
  mount();
  expect(paneModes()).toEqual(["source", "timeline"]); // 기본 화면으로
  expect(document.querySelector<HTMLElement>(".ed-mbtn-mk")!.style.getPropertyValue("--mk")).toBe("#1287ff");
});
