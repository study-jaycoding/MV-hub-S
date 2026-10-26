// @vitest-environment jsdom
// 편집 탭 미디어 풀 — 메타데이터 보기가 좁을 때(Jay 2026-10-23 ⑥ "그림 그대로"): 글은 줄마다 한 줄, 표는 자기 줄, 글 칸이 150px 보다 좁으면
//  글이 썸네일 아래로·썸네일은 칸 폭. jsdom 에는 배치가 없다 — 풀 몸통의 폭(clientWidth)과 ResizeObserver 는 시험이 대신한다.
//  실제 CSS 의 모양은 헤드리스 크롬으로 따로 본다(docs/status/편집탭_메타데이터_좁은칸_2026-10-23.md).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditCardMenu } from "../src/components/timeline/EditTab";
import type { EditTree } from "../src/lib/useEditSequence";
import type { Generation } from "../src/types";

const gen = (id: string, extra: Partial<Generation> = {}) => ({
  id, job_id: `job-${id}`, status: "done", params: {}, prompt: `prompt ${id}`, folder_path: "e070/c1", project_id: "p1",
  shared: true, is_final: false, is_held: false, is_mine: false, tags: [], auto_tags: [], color: null,
  creator_uid: "u-river", creator_name: "리버", model: "seedance_2_0",
  assets: [{ id: `a-${id}`, generation_id: id, type: "image", file_path: `/media/${id}.png`, thumbnail_path: null, source_url: null, cached: true }],
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
    name: "e070", path: "e070", count: 2, newCount: 0, reviewCounts: counts, children: [
      { name: "c1", path: "e070/c1", count: 2, newCount: 0, reviewCounts: counts }] }] } as unknown as EditTree;
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
import { metaStacked } from "../src/components/timeline/EditPool";

let host: HTMLDivElement;
let root: Root;
let poolWidth = 400; // 풀 몸통(.ed-pbody)의 안쪽 폭(padding 포함 · 스크롤 막대 뺀 것)
const watchers: (() => void)[] = [];
const cardMenuRef: { current: EditCardMenu | null } = { current: null };
const rows = () => [...document.querySelectorAll<HTMLElement>(".ed-prow-meta")];
const body = () => document.querySelector<HTMLElement>(".ed-pbody")!;
const resize = (width: number) => {
  poolWidth = width;
  act(() => watchers.forEach((fire) => fire()));
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem("ch.editTimeline.last:local", JSON.stringify({ projectId: "p1", seq: "e070" }));
  localStorage.setItem("ch.editTimeline.ui", JSON.stringify({ view: "meta", size: 118 }));
  localStorage.setItem("mvhub.editDoc:local:p1:e070", JSON.stringify({ v: 1, tracksOff: [], tracksLocked: [], clips: [
    { cut: "e070/c1", gen: "a", track: 1, kind: "image", dur: 5 },
  ] }));
  for (const method of ["load", "pause"] as const) vi.spyOn(HTMLMediaElement.prototype, method).mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("ed-pbody") ? poolWidth : 0;
  });
  watchers.length = 0;
  vi.stubGlobal("ResizeObserver", class {
    constructor(private fire: () => void) { watchers.push(() => this.fire()); }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  poolWidth = 400;
  world.gens = [gen("a"), gen("b", { creator_name: "아주 긴 이름의 작업자", model: "seedance_2_0_reference_long_model_name" })];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(
    <EditTab authKey="auth" authReady workspace={{ scope: "team", id: "w1", name: "W" }} keysActive
      flash={() => {}} onOpenCutFolder={() => {}} reloadSignal={0}
      peekPath={null} onPeekMarks={() => {}} cardMenuRef={cardMenuRef} onPreview={() => {}} onCompare={() => {}}
      resolve={{ send: () => {}, sendTimeline: () => new Promise<never>(() => {}), busy: false, pendingCount: 0, timelineBusy: false }}
      onFolderAction={() => {}} />,
  ));
  act(() => [...document.querySelectorAll<HTMLButtonElement>(".ed-cutcell")].find((cell) => cell.textContent === "c1")!.click());
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("글 칸 = 풀 안쪽 폭 − 여백(48) − 썸네일 — 150px 보다 좁으면 아래로", () => {
  expect([metaStacked(316, 118), metaStacked(315, 118), metaStacked(400, 240), metaStacked(720, 240)]).toEqual([false, true, true, false]);
});

it("넓으면 썸네일 옆에 글 — 줄마다 한 줄(올리면 전체 글), 넣은 트랙 표는 이름 옆이 아니라 자기 줄", () => {
  expect(body().classList.contains("ed-pstack")).toBe(false);
  const placed = rows().find((row) => row.classList.contains("ed-placed"))!;
  const other = rows().find((row) => !row.classList.contains("ed-placed"))!;
  expect(placed.querySelector<HTMLElement>(".ed-pthumb")!.style.width).toBe("118px"); // 크기 슬라이더 값 그대로
  const name = placed.querySelector(".ed-pinfo b")!;
  expect([name.textContent, name.querySelector(".ed-pline")!.getAttribute("title")]).toEqual(["S리버 · seedance_2_0", "리버 · seedance_2_0"]);
  expect(name.querySelector(".cd-mark")).toBeNull(); // 표가 이름을 밀어내지 않는다
  expect(placed.querySelector(".ed-pmarks")!.textContent).toBe("V1 - 선택 카드");
  expect(other.querySelector(".ed-pmarks")).toBeNull(); // 표가 없으면 그 줄도 없다
  expect([...other.querySelectorAll(".ed-pinfo > .ed-pline")].map((line) => line.getAttribute("title"))).toHaveLength(1); // 날짜·길이 한 줄
  expect(other.querySelector(".ed-pinfo b .ed-pline")!.getAttribute("title")).toBe("아주 긴 이름의 작업자 · seedance_2_0_reference_long_model_name");
});

it("풀을 좁히면 글이 썸네일 아래로 — 썸네일은 칸 폭, 다시 넓히면 옆으로", () => {
  resize(300); // 300 − 48 − 118 = 134 < 150
  expect(body().classList.contains("ed-pstack")).toBe(true);
  expect(rows().map((row) => row.querySelector<HTMLElement>(".ed-pthumb")!.style.width)).toEqual(["100%", "100%"]);
  resize(500);
  expect(body().classList.contains("ed-pstack")).toBe(false);
  expect(rows()[0].querySelector<HTMLElement>(".ed-pthumb")!.style.width).toBe("118px");
});
