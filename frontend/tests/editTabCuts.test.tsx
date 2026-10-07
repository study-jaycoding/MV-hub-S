// @vitest-environment jsdom
// 편집 탭 조립 — 컷 목록이 '시퀀스가 있는 프로젝트'의 폴더에서 나오는지, 폴더 고르기의 시퀀스 판정, 편집 키.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditTree } from "../src/lib/useEditSequence";

const trees = vi.hoisted(() => ({
  p1: { state: "ready", complete: true, note: null, roots: [{ name: "e070", path: "e070", children: [
    { name: "c1", path: "e070/c1" }, { name: "c2", path: "e070/c2" },
  ] }] },
  p2: { state: "ready", complete: true, note: null, roots: [{ name: "other", path: "other" }] },
  none: { state: "idle", complete: false, note: null, roots: [] },
}));
vi.mock("../src/lib/useEditSequence", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/useEditSequence")>("../src/lib/useEditSequence");
  return {
    ...actual,
    useEditProjects: ({ projectId }: { projectId: string | null }) => ({
      projects: [{ id: "p1", name: "P1" }, { id: "p2", name: "P2" }], projectsState: "ok",
      tree: (trees[(projectId ?? "none") as keyof typeof trees] ?? trees.none) as EditTree, reload: () => {},
    }),
    useEditGenerations: () => ({ state: "ok", gens: [], error: null, complete: true, reload: () => {} }),
  };
});

import { EditTab } from "../src/components/timeline/EditTab";

let host: HTMLDivElement;
let root: Root;
const cuts = () => [...document.querySelectorAll(".ed-cutcell")].map((cell) => cell.textContent);
const current = () => document.querySelector(".ed-cutcell.ed-cur")?.textContent;
const projectRow = (index: number) => document.querySelectorAll<HTMLButtonElement>(".ed-side .proj-row")[index];
const folderRow = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".ed-side .folder-tree-row")].find((row) => row.textContent?.includes(name))!;
const timecode = () => document.querySelector(".ed-tc")!.textContent;
const press = (init: KeyboardEventInit, target: EventTarget = document.body) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  localStorage.setItem("ch.editTimeline.last:local", JSON.stringify({ projectId: "p1", seq: "e070" }));
  for (const method of ["load", "pause"] as const) vi.spyOn(HTMLMediaElement.prototype, method).mockImplementation(() => {});
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
const mount = (keysActive = true) => act(() => root.render(
  <EditTab authKey="auth" authReady workspace={{ scope: "team", id: "w1", name: "W" }} keysActive={keysActive} flash={() => {}} />,
));

it("다른 프로젝트를 펼쳐 둘러봐도 지금 시퀀스의 컷은 그대로다", () => {
  mount();
  expect(cuts()).toEqual(["c1", "c2"]); // 공유물이 없어도 폴더가 있으면 자리가 잡힌다
  act(() => projectRow(1).click()); // P2 를 펼친다
  expect(document.querySelector(".ed-side .folder-tree-row")?.textContent).toContain("other");
  expect(cuts()).toEqual(["c1", "c2"]);
  act(() => projectRow(1).click()); // 접어도
  expect(cuts()).toEqual(["c1", "c2"]);
});

it("하위 폴더가 없는 폴더를 고르면 부모가 시퀀스고 그 컷으로 간다", () => {
  mount();
  expect(current()).toBe("c1");
  act(() => folderRow("c2").click());
  expect(cuts()).toEqual(["c1", "c2"]);
  expect(current()).toBe("c2");
  expect(timecode()).toBe("00:00:05:00");
  expect(JSON.parse(localStorage.getItem("ch.editTimeline.last:local")!)).toEqual({ projectId: "p1", seq: "e070" });
});

it("편집 키 — 쓴 키만 기본 동작을 막고, 입력칸·다른 창·위에 뜬 창이 있을 때는 듣지 않는다", () => {
  mount();
  expect(press({ key: "End", code: "End" }).defaultPrevented).toBe(true);
  expect(timecode()).toBe("00:00:10:00");
  expect(press({ key: "ArrowLeft", code: "ArrowLeft" }).defaultPrevented).toBe(true);
  expect(timecode()).toBe("00:00:09:23");
  expect(press({ key: "ㅗ", code: "Home" }).defaultPrevented).toBe(false); // 모르는 키는 건드리지 않는다
  expect(press({ key: "Home", code: "Home" }).defaultPrevented).toBe(true);
  expect(press({ key: "=", code: "Equal", ctrlKey: true }).defaultPrevented).toBe(true); // 페이지 확대 대신 타임라인 확대
  expect(press({ key: "c", code: "KeyC", ctrlKey: true }).defaultPrevented).toBe(false);
  expect(press({ key: "Delete", code: "Delete" }).defaultPrevented).toBe(false); // 고른 클립이 없다

  const input = document.createElement("input");
  document.body.appendChild(input);
  expect(press({ key: "End", code: "End" }, input).defaultPrevented).toBe(false);
  input.remove();
  const elsewhere = document.createElement("div"); // 편집 화면 밖의 다른 창
  document.body.appendChild(elsewhere);
  expect(press({ key: "End", code: "End" }, elsewhere).defaultPrevented).toBe(false);
  elsewhere.remove();
  expect(timecode()).toBe("00:00:00:00");

  mount(false); // 위에 관리자 창 등이 떠 있다
  expect(press({ key: "End", code: "End" }).defaultPrevented).toBe(false);
  expect(timecode()).toBe("00:00:00:00");
});
