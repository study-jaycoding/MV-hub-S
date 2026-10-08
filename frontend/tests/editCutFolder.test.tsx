// @vitest-environment jsdom
// 편집 탭(Jay 2026-10-08) — 미디어 풀(폴더 목록 옆: 보기 방식·크기·검색·정렬, 고르기·넣기/빼기·우클릭 트랙 메뉴) ·
// 싱글/듀얼 뷰어 · 그림을 누르면 그 컷으로 · 컷 더블클릭 = 공유 & 리뷰의 폴더 창 열기(무엇을 열지만 App 에 알린다) ·
// 그 창의 카드 우클릭 = 넣을 트랙 고르기(찬 트랙은 교체) · 빈 폴더 기본 비활성과 숨기기 · D 로 폴더 켜고 끄기 ·
// 왼쪽 폴더 옆의 새 항목·최종·보류 표시 · 공유 목록과 폴더 옆 숫자 다시 받기.
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
// peekPath = 폴더 창이 떠 있는 컷(없으면 null). 창은 App 의 것이라 여기서는 떠 있다는 사실만 넘긴다.
const mount = (reloadSignal = 0, peekPath: string | null = null, ws: typeof workspace | { scope: "unknown"; id: null; name: null } = workspace) =>
  act(() => root.render(
    <EditTab authKey="auth" authReady workspace={ws} keysActive flash={flash}
      onOpenCutFolder={onOpenCutFolder} reloadSignal={reloadSignal}
      peekPath={peekPath} onPeekMarks={onPeekMarks} cardMenuRef={cardMenuRef} onPreview={onPreview} onCompare={onCompare} />,
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
  expect([...document.querySelector(".ed-top")!.children].map((item) => item.classList[0]))
    .toEqual(["ed-pool-side", "sidebar-resize-handle", "ed-view"]); // 풀 · 폭 조절 손잡이 · 뷰어
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
  expect(bar()).toBeNull(); // 한 장으로는 비교할 것이 없다
  mouse(poolCards()[1], "click", { ctrlKey: true });
  expect(document.querySelectorAll(".ed-pool .ed-picked")).toHaveLength(2);
  expect(bar()!.textContent).toContain("2개 선택");
  act(() => bar()!.querySelector<HTMLButtonElement>(".ed-psel-btn")!.click());
  expect(compared.map((gens) => gens.map((item) => item.id))).toEqual([["a", "b"]]);

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
  expect(JSON.parse(localStorage.getItem(UI_KEY)!)).toEqual({ view: "list", size: 200, sort: "placed", dual: false });

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

// 싱글/듀얼 뷰어(Jay 2026-10-08) — 듀얼이면 왼쪽에 미디어 풀에서 고른 생성물(소스), 오른쪽에 타임라인.
it("듀얼 뷰어: 미디어 풀에서 고른 생성물이 소스 뷰어에 뜬다 — 컷을 옮겨도 남고, 싱글로 돌리면 사라진다", () => {
  world.gens = [...world.gens, gen("v", "c1", { assets: [{ id: "a-v", generation_id: "v", type: "video", file_path: "/media/v.mp4",
    thumbnail_path: null, source_url: null, cached: true }] as Generation["assets"], model: "seedance" })];
  mount();
  act(() => cutCell("c1").click());
  const dual = () => document.querySelector<HTMLButtonElement>(".ed-dual")!;
  const source = () => document.querySelector<HTMLElement>(".ed-src");
  expect(source()).toBeNull(); // 기본 = 싱글
  expect(dual().getAttribute("aria-pressed")).toBe("false");

  act(() => dual().click());
  expect([...document.querySelector(".ed-top")!.children].map((item) => item.className))
    .toEqual(["ed-pool-side", "sidebar-resize-handle", "ed-view ed-src", "ed-view"]);
  expect(source()!.textContent).toContain("미디어 풀에서 생성물을 고르면 여기에서 봅니다.");
  act(() => poolCards()[0].click()); // 그림
  expect(source()!.querySelector<HTMLImageElement>("img.ed-media")!.getAttribute("src")).toBe("/media/a.png");
  act(() => poolCards()[2].click()); // 영상 — 브라우저 기본 재생 막대
  const video = source()!.querySelector<HTMLVideoElement>("video.ed-media")!;
  expect(video.getAttribute("src")).toBe("/media/v.mp4");
  expect(video.controls).toBe(true);
  expect(source()!.querySelector(".ed-src-info")!.textContent).toBe("리버 · seedance");
  mouse(poolCards()[0], "click", { ctrlKey: true }); // 여러 장을 고르면 마지막에 고른 것이 소스다
  expect(source()!.querySelector<HTMLImageElement>("img.ed-media")!.getAttribute("src")).toBe("/media/a.png");
  act(() => poolCards()[2].click());
  expect(localStorage.getItem(DOC_KEY)).toBeNull(); // 소스로 보는 것은 타임라인을 바꾸지 않는다

  act(() => cutCell("c2").click()); // 다른 컷으로 가도 소스는 그대로다
  expect(source()!.querySelector("video.ed-media")).not.toBeNull();
  expect(document.querySelector(".ed-pool .ed-picked")).toBeNull(); // 이 컷의 풀에는 그 카드가 없다

  expect(JSON.parse(localStorage.getItem(UI_KEY)!).dual).toBe(true);
  act(() => dual().click());
  expect(source()).toBeNull();
  expect(JSON.parse(localStorage.getItem(UI_KEY)!).dual).toBe(false);
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
  // 초점이 메뉴 밖에 있어도(Tab 으로 빠져나갔다) 뒤 화면의 편집 키는 실행되지 않는다 — M(소리 끄기)·D(폴더 끄기)
  act(() => document.querySelector<HTMLElement>(".ed-root")!.focus());
  press({ key: "m", code: "KeyM" }, document.querySelector(".ed-root")!);
  press({ key: "d", code: "KeyD" });
  expect(stored().muted).toBeUndefined();
  expect(offCuts()).toEqual(["c3"]);
  mouse(document.body, "mousedown"); // 바깥 누르기
  expect(trackMenu()).toBeNull();
  press({ key: "m", code: "KeyM" }); // 닫히면 다시 듣는다
  expect(stored().muted).toBe(true);
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
