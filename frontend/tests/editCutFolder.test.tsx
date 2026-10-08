// @vitest-environment jsdom
// 편집 탭(Jay 2026-10-08) — 그림을 누르면 그 컷으로 · 컷 더블클릭 = 공유 & 리뷰의 폴더 창 열기(무엇을 열지만 App 에 알린다) ·
// 그 창의 카드 우클릭 = 넣을 트랙 고르기(찬 트랙은 교체) · 빈 폴더 기본 비활성과 숨기기 · D 로 폴더 켜고 끄기 ·
// 왼쪽 폴더 옆의 새 항목·최종·보류 표시 · 공유 목록과 폴더 옆 숫자 다시 받기. 오른쪽 '이 컷의 생성물' 칸은 없다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditCardMenu, EditCutFolder } from "../src/components/timeline/EditTab";
import type { EditTree } from "../src/lib/useEditSequence";
import type { CardMark, Generation } from "../src/types";

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
// peekPath = 폴더 창이 떠 있는 컷(없으면 null). 창은 App 의 것이라 여기서는 떠 있다는 사실만 넘긴다.
const mount = (reloadSignal = 0, peekPath: string | null = null, ws: typeof workspace | { scope: "unknown"; id: null; name: null } = workspace) =>
  act(() => root.render(
    <EditTab authKey="auth" authReady workspace={ws} keysActive flash={flash}
      onOpenCutFolder={onOpenCutFolder} reloadSignal={reloadSignal}
      peekPath={peekPath} onPeekMarks={onPeekMarks} cardMenuRef={cardMenuRef} />,
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

it("오른쪽 '이 컷의 생성물' 칸은 없다 — 뷰어가 폭을 다 쓰고, 빈 자리는 넣는 방법을 알려 준다", () => {
  mount();
  expect(document.querySelector(".ed-pool, .ed-card")).toBeNull();
  expect(document.querySelector(".ed-top")!.children).toHaveLength(1); // 뷰어 하나
  expect(document.querySelector<HTMLElement>(".ed-slot")!.title).toContain("우클릭");
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

// 공유 목록을 다시 받는 동안에는 job 으로 이은 클립이 어느 카드인지 모른다 — 그때 넣으면 같은 생성물이 두 트랙에 들어가거나
//  교체하면서 그 클립의 꺼짐이 사라진다(Codex 코드 리뷰).
it("트랙 메뉴: 그 컷에 확인 못 한 클립이 있는 동안은 넣지 않는다 — job 으로 이은 클립은 받은 뒤에 '지금 여기'로 보인다", () => {
  seed([{ cut: "c1", gen: "old-a", job: "job-a", track: 1, off: true }]); // 옛 id — job 으로 카드 a 에 이어진다
  mount();
  act(() => cutCell("c1").click());
  mount(0, "e070/c1");
  cardMenu("a");
  expect(menuText()).toEqual(["V3비어 있음", "V2비어 있음", "V1지금 여기 ×"]);
  act(() => menuItems()[1].click()); // V2 로 옮긴다 — 문서의 그 클립이 옮겨 간다(새 클립이 생기지 않는다)
  expect(stored().clips).toEqual([{ cut: "e070/c1", gen: "old-a", track: 2, kind: "image", dur: 5, job: "job-a", off: true }]);

  cardMenu("b"); // 메뉴가 떠 있는 사이 다시 받기가 시작됐다
  world.known = false;
  mount(0, "e070/c1");
  act(() => menuItems()[0].click());
  expect(trackMenu()).toBeNull();
  expect(flashed[flashed.length - 1]).toContain("확인하지 못한 클립");
  expect(stored().clips).toHaveLength(1);

  cardMenu("a"); // 받는 동안에는 메뉴도 열지 않는다
  expect(trackMenu()).toBeNull();
  expect(flashed).toHaveLength(2);

  world.known = true; // 다 받으면 다시 된다
  mount(0, "e070/c1");
  cardMenu("b");
  expect(menuText()).toEqual(["V3비어 있음", "V2교체", "V1비어 있음"]);
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
