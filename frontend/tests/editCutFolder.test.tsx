// @vitest-environment jsdom
// 편집 탭(Jay 2026-10-08) — 생성물 카드의 모양과 표("V1 - 선택 카드") · 그림을 누르면 그 컷으로 · 컷 더블클릭 = 공유 & 리뷰의
// 폴더 창 열기(무엇을 열지만 App 에 알린다) · 빈 폴더 기본 비활성과 숨기기 · D 로 폴더 켜고 끄기 · 공유 목록 다시 받기.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditCutFolder } from "../src/components/timeline/EditTab";
import type { EditTree } from "../src/lib/useEditSequence";
import type { Generation } from "../src/types";

const gen = (id: string, cut: string, extra: Partial<Generation> = {}) => ({
  id, job_id: `job-${id}`, status: "done", params: {}, prompt: `prompt ${id}`, folder_path: `e070/${cut}`,
  shared: true, is_final: false, is_held: false, is_mine: false, creator_name: "리버",
  assets: [{ id: `a-${id}`, generation_id: id, type: "image", file_path: `/media/${id}.png`,
    thumbnail_path: null, source_url: null, cached: true }],
  ...extra,
} as unknown as Generation);

const world = vi.hoisted(() => ({ gens: [] as unknown[], known: true, reload: (() => {}) as () => void }));
vi.mock("../src/lib/useEditSequence", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/useEditSequence")>("../src/lib/useEditSequence");
  const tree = { state: "ready", complete: true, note: null, roots: [{ name: "e070", path: "e070", children: [
    { name: "c1", path: "e070/c1" }, { name: "c2", path: "e070/c2" }, { name: "c3", path: "e070/c3" },
  ] }] } as unknown as EditTree;
  return {
    ...actual,
    useEditProjects: () => ({ projects: [{ id: "p1", name: "P1" }], projectsState: "ok", tree, reload: () => {} }),
    useEditGenerations: () => ({
      state: "ok", gens: world.gens, error: null, complete: world.known, known: world.known, reload: world.reload,
    }),
  };
});
vi.mock("../src/lib/useDisabledFolders", () => ({ useDisabledFolders: () => ({}) }));

import { EditTab } from "../src/components/timeline/EditTab";

let host: HTMLDivElement;
let root: Root;
const opened: EditCutFolder[] = [];
const onOpenCutFolder = (target: EditCutFolder) => { opened.push(target); };
const flash = () => {};
const workspace = { scope: "team" as const, id: "w1", name: "W" };
const mount = (reloadSignal = 0) => act(() => root.render(
  <EditTab authKey="auth" authReady workspace={workspace} keysActive flash={flash}
    onOpenCutFolder={onOpenCutFolder} reloadSignal={reloadSignal} />,
));
const timecode = () => document.querySelector(".ed-tc")!.textContent;
const cuts = () => [...document.querySelectorAll(".ed-cutcell")].map((cell) => cell.textContent);
const offCuts = () => [...document.querySelectorAll(".ed-cutcell.ed-cutoff")].map((cell) => cell.textContent);
const cutCell = (name: string) => [...document.querySelectorAll<HTMLButtonElement>(".ed-cutcell")].find((cell) => cell.textContent === name)!;
const clips = () => [...document.querySelectorAll<HTMLElement>(".ed-clip")];
const poolCards = () => [...document.querySelectorAll<HTMLButtonElement>(".ed-pool .ed-card")];
const hideButton = () => document.querySelector<HTMLButtonElement>(".ed-toggle")!;
const mouse = (target: Element, type: string, init: MouseEventInit = {}) =>
  act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init })); });
const press = (init: KeyboardEventInit) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => { document.body.dispatchEvent(event); });
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
  world.reload = () => {};
  opened.length = 0;
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

it("오른쪽 칸의 카드는 라이브러리 카드 모양이고, 넣은 카드에 트랙과 함께 '선택 카드' 표가 붙는다 — 지금 보이는 것만 라임", () => {
  mount();
  const [a, b] = poolCards();
  expect(a.querySelector(".card.card-grid.st-shared")).not.toBeNull(); // 공유 = 라임 테두리
  expect(b.querySelector(".card.st-final .card-sf.final .card-final-star")).not.toBeNull(); // 최종 = 골드·★
  expect(a.querySelector(".creator-badge")?.textContent).toContain("리버"); // 남이 만든 것만 작성자 배지
  expect(b.querySelector(".creator-badge")).toBeNull();
  expect(a.querySelector(".card.selected, .card-bottom")).toBeNull(); // 아직 안 넣었다

  act(() => a.click());
  expect(poolCards()[0].querySelector(".card.selected .card-bottom > .card-here")?.textContent).toBe("V1 - 선택 카드");
  act(() => poolCards()[1].click()); // 위로 쌓는다 — 위 트랙이 보인다
  expect(poolCards()[1].querySelector(".card-here")?.textContent).toBe("V2 - 선택 카드");
  expect(poolCards()[0].querySelector(".card-here")).toBeNull();
  expect(poolCards()[0].querySelector(".card.selected .card-bottom > .card-folder.static")?.textContent).toBe("V1 - 선택 카드"); // 깔린 것은 옅게
});

it("타임라인의 그림을 누르면 그 컷으로 간다 — 이미 그 컷이면 보던 자리 그대로", () => {
  mount();
  act(() => poolCards()[0].click()); // c1 에 하나
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
  mount();
  act(() => cutCell("c2").click());
  act(() => poolCards()[0].click()); // x → V1
  act(() => poolCards()[1].click()); // y → V2(보이는 것)
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
  expect(JSON.parse(localStorage.getItem("ch.editTimeline:local:p1:e070")!)).toMatchObject({ cutsOff: ["e070/c1"], hideOff: true });

  press({ key: "z", code: "KeyZ", ctrlKey: true }); // 되돌리기로 다시 켜진다
  expect(cuts()).toEqual(["c1", "c2"]);

  act(() => hideButton().click()); // 숨기기를 끄면 다 보이고, 빈 폴더도 D 로 켤 수 있다
  expect(cuts()).toEqual(["c1", "c2", "c3"]);
  act(() => cutCell("c3").click());
  press({ key: "d", code: "KeyD" });
  expect(offCuts()).toEqual([]);
  expect(JSON.parse(localStorage.getItem("ch.editTimeline:local:p1:e070")!).cutsOn).toEqual(["e070/c3"]);
  press({ key: "d", code: "KeyD" }); // 다시 끄면 기본값으로 — 적어 둔 것을 지운다
  expect(offCuts()).toEqual(["c3"]);
  expect(JSON.parse(localStorage.getItem("ch.editTimeline:local:p1:e070")!).cutsOn).toBeUndefined();
});

it("클립을 고른 채 누른 D 는 그 클립을 끄고, 컷 이름을 누르면 고르기가 풀려 D 가 폴더에 걸린다", () => {
  mount();
  act(() => cutCell("c1").click()); // 재생헤드 자리는 시퀀스마다 기억된다 — 앞 시험이 둔 자리에 기대지 않는다
  act(() => poolCards()[0].click());
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
  mount();
  act(() => cutCell("c1").click());
  act(() => poolCards()[0].click()); // c1 에 하나
  press({ key: "d", code: "KeyD" }); // 고른 것이 없다 — c1 폴더를 끈다
  expect(offCuts()).toEqual(["c1", "c3"]);
  mouse(clips()[0], "pointerdown"); // 그 컷의 클립을 고른다
  expect(document.querySelectorAll(".ed-clip.ed-sel")).toHaveLength(1);

  act(() => hideButton().click()); // 숨기면 c1 은 타임라인에 없다
  expect(clips()).toHaveLength(0);
  press({ key: "Delete", code: "Delete" }); // 고른 것이 없으니 아무것도 지우지 않는다
  press({ key: "a", code: "KeyA", ctrlKey: true });
  press({ key: "Delete", code: "Delete" });
  expect(JSON.parse(localStorage.getItem("ch.editTimeline:local:p1:e070")!).clips).toHaveLength(1);

  act(() => hideButton().click());
  expect(clips()).toHaveLength(1); // 클립은 그대로 남아 있다
  expect(document.querySelectorAll(".ed-clip.ed-sel")).toHaveLength(0);
});

it("공유 목록을 끝까지 받아 보기 전에는 빈 폴더라고 단정하지 않는다", () => {
  world.known = false;
  mount();
  expect(offCuts()).toEqual([]);
});

it("폴더 창이 닫히면, 그리고 생성물이 바뀌었다는 알림이 오면 공유 목록을 다시 받는다", () => {
  const reload = vi.fn();
  world.reload = reload;
  mount(0);
  expect(reload).not.toHaveBeenCalled();
  mount(1); // 창이 닫혔다
  expect(reload).toHaveBeenCalledTimes(1);

  act(() => { window.dispatchEvent(new CustomEvent("ch:library-changed")); });
  act(() => { window.dispatchEvent(new CustomEvent("ch:library-changed")); });
  expect(reload).toHaveBeenCalledTimes(1); // 몰아서 한 번
  act(() => { vi.advanceTimersByTime(500); });
  expect(reload).toHaveBeenCalledTimes(2);
});
