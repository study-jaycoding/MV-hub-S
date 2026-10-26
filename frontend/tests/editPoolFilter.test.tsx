// @vitest-environment jsdom
// 편집 탭(Jay 2026-10-23) — 왼쪽 아래 '컬러 · 전역 태그 · 생성자'로 미디어 풀을 거른다. 처음엔 접혀 있고 접고 편 것은 기억한다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditCardMenu } from "../src/components/timeline/EditTab";
import type { EditTree } from "../src/lib/useEditSequence";
import type { Generation } from "../src/types";

const gen = (id: string, cut: string, extra: Partial<Generation> = {}) => ({
  id, job_id: `job-${id}`, status: "done", params: {}, prompt: `prompt ${id}`, folder_path: `e070/${cut}`, project_id: "p1",
  shared: true, is_final: false, is_held: false, is_mine: false, tags: [], auto_tags: [], color: null,
  creator_uid: "u-river", creator_name: "리버", model: "seedance",
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
  const counts = { final: 0, held: 0, shared: 4 };
  const tree = { state: "ready", complete: true, note: null, roots: [{
    name: "e070", path: "e070", count: 5, newCount: 0, reviewCounts: counts, children: ["c1", "c2"].map((name) => (
      { name, path: `e070/${name}`, count: 4, newCount: 0, reviewCounts: counts })) }] } as unknown as EditTree;
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
import { poolFacets, poolFilterPass } from "../src/components/timeline/EditPool";
import { saveDisabledGen } from "../src/lib/deactivated";
import { NO_POOL_FILTER } from "../src/lib/editTimelineStore";

let host: HTMLDivElement;
let root: Root;
const cardMenuRef: { current: EditCardMenu | null } = { current: null };
const UI_KEY = "ch.editTimeline.ui";
const DOC_KEY = "mvhub.editDoc:local:p1:e070";
const mount = () => {
  act(() => root.render(
    <EditTab authKey="auth" authReady workspace={{ scope: "team", id: "w1", name: "W" }} keysActive
      flash={() => {}} onOpenCutFolder={() => {}} reloadSignal={0}
      peekPath={null} onPeekMarks={() => {}} cardMenuRef={cardMenuRef} onPreview={() => {}} onCompare={() => {}}
      resolve={{ send: () => {}, sendTimeline: () => new Promise<never>(() => {}), busy: false, pendingCount: 0, timelineBusy: false }}
      onFolderAction={() => {}} />,
  ));
  act(() => [...document.querySelectorAll<HTMLButtonElement>(".ed-cutcell")].find((cell) => cell.textContent === "c1")!.click());
};
const toggle = () => document.querySelector<HTMLButtonElement>(".sidebar-foot-toggle")!;
const foot = () => document.querySelector<HTMLElement>(".sidebar-foot")!;
const rows = () => [...document.querySelectorAll(".ed-prow-meta")].map((row) => row.querySelector(".ed-pinfo b")!.textContent);
const sub = () => document.querySelector(".ed-pool-sub")!.textContent;
const creator = (name: string) => [...foot().querySelectorAll<HTMLButtonElement>(".creator-pick")].find((item) => item.textContent!.includes(name))!;
const click = (target: HTMLElement) => act(() => target.click());

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem("ch.editTimeline.last:local", JSON.stringify({ projectId: "p1", seq: "e070" }));
  localStorage.setItem(UI_KEY, JSON.stringify({ view: "meta" }));
  localStorage.setItem(DOC_KEY, JSON.stringify({ v: 1, tracksOff: [], tracksLocked: [], clips: [
    { cut: "e070/c1", gen: "a", track: 1, kind: "image", dur: 5 },
  ] }));
  for (const method of ["load", "pause"] as const) vi.spyOn(HTMLMediaElement.prototype, method).mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  world.gens = [
    gen("a", "c1", { color: "#ff5722", auto_tags: ["밤씬"] }),
    gen("b", "c1", { is_final: true }),
    gen("c", "c1", { creator_uid: "u-oji", creator_name: "오지짱", color: "#2196f3" }),
    gen("d", "c1", { creator_uid: "u-oji", creator_name: "오지짱", auto_tags: ["밤씬", "비"] }),
    gen("x", "c2"),
  ];
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

it("처음엔 접혀 있고, 펼친 것은 다시 열어도 그대로다 — 이름은 공유 탭의 것과 같다", () => {
  mount();
  expect(toggle().textContent).toContain("컬러 · 전역 태그 · 생성자");
  expect([toggle().getAttribute("aria-expanded"), foot().hidden]).toEqual(["false", true]);
  click(toggle());
  expect([toggle().getAttribute("aria-expanded"), foot().hidden]).toEqual(["true", false]);
  act(() => root.unmount());
  root = createRoot(host);
  mount();
  expect(foot().hidden).toBe(false);
  // 생성자는 이 시퀀스의 공유물로 센다(많은 순) · 전역 태그는 붙은 것들
  expect([...foot().querySelectorAll(".creator-pick")].map((item) => item.textContent)).toEqual(["리버3", "오지짱2"]);
  expect([...foot().querySelectorAll(".auto-tag-name")].map((item) => item.textContent)).toEqual(["밤씬", "비"]);
});

it("생성자·색·골드·회색·전역 태그로 풀만 거른다 — 타임라인은 그대로, 접어 두면 켠 개수가 보인다", () => {
  saveDisabledGen(new Set(["b"]));
  mount();
  expect(rows()).toHaveLength(4);
  click(toggle());
  click(creator("오지짱"));
  expect(rows().every((text) => text!.includes("오지짱"))).toBe(true);
  expect(sub()).toContain("찾은 것 2개");
  click(creator("오지짱")); // 다시 누르면 해제
  expect(rows()).toHaveLength(4);

  click(foot().querySelector<HTMLButtonElement>(".af-dot[title^='R ']")!); // 빨강 = 그 색 카드만(a)
  expect(rows()).toHaveLength(1);
  click(foot().querySelector<HTMLButtonElement>(".af-dot[title^='B ']")!); // 파랑을 더하면 둘 중 하나(a·c)
  expect(rows()).toHaveLength(2);
  click(foot().querySelector<HTMLButtonElement>(".af-dot[title^='R ']")!);
  click(foot().querySelector<HTMLButtonElement>(".af-dot[title^='B ']")!);
  click(foot().querySelector<HTMLButtonElement>(".af-dot-gold")!); // 최종만(b)
  expect(rows()).toHaveLength(1);
  click(foot().querySelector<HTMLButtonElement>(".af-dot-gold")!);
  click(foot().querySelector<HTMLButtonElement>(".af-dot-gray")!); // 비활성(b) 숨기기
  expect(rows()).toHaveLength(3);
  click(foot().querySelector<HTMLButtonElement>(".af-dot-gray")!);
  click([...foot().querySelectorAll<HTMLButtonElement>(".auto-tag-name")].find((item) => item.textContent === "비")!);
  expect(rows()).toHaveLength(1); // d
  expect(document.querySelectorAll(".ed-tl .ed-clip")).toHaveLength(1); // 타임라인의 클립(a)은 그대로

  click(toggle()); // 접어도 거르기는 남고, 켠 개수가 단추에
  expect(toggle().querySelector(".ed-foot-count")!.textContent).toBe("1");
  expect(rows()).toHaveLength(1);
  expect(JSON.parse(localStorage.getItem(UI_KEY)!).poolFilter.autoTags).toEqual(["비"]);
});

it("거르기 함수 — 빈 값이면 거르지 않고(null), 같은 칸 안은 하나라도, 칸끼리는 모두 맞아야 한다", () => {
  expect(poolFilterPass(NO_POOL_FILTER, new Set())).toBeNull();
  const pass = poolFilterPass({ ...NO_POOL_FILTER, colors: ["#FF5722"], autoTags: ["비", "밤씬"] }, new Set())!;
  expect(world.gens.map((item) => pass(item as Generation))).toEqual([true, false, false, false, false]); // 색은 대소문자 무시
  expect(poolFacets(world.gens as Generation[]).creators.map((item) => [item.name, item.count])).toEqual([["리버", 3], ["오지짱", 2]]);
});
