// @vitest-environment jsdom
// 재생헤드의 볼록 표시(다빈치, Jay 2026-10-23) — 지금 뷰어에 보이는 클립의 트랙 줄에 있다. 줄 번호(--ph-row)는 위에서부터(맨 위 비디오
//  트랙 V3 = 0 — 맨 위 빈 트랙 줄은 없앴다, 같은 날 Jay).
//  c1: V1 만 · c2: V1 위에 V2(위가 보인다) · c3: 클립 없음 · c4: V3 를 꺼 두었다(트랙 끔 — 보이는 것은 아래 V1).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditCardMenu } from "../src/components/timeline/EditTab";
import type { EditTree } from "../src/lib/useEditSequence";
import type { Generation } from "../src/types";

const gen = (id: string, cut: string) => ({
  id, job_id: `job-${id}`, status: "done", params: {}, prompt: `prompt ${id}`, folder_path: `e070/${cut}`, project_id: "p1",
  shared: true, is_final: false, is_held: false, is_mine: false, tags: [], creator_name: "리버", model: "seedance",
  assets: [{ id: `a-${id}`, generation_id: id, type: "image", file_path: `/media/${id}.png`, thumbnail_path: null, source_url: null, cached: true }],
} as unknown as Generation);

const world = vi.hoisted(() => ({ gens: [] as unknown[] }));
vi.mock("../src/lib/resolveTransfer", async () => ({
  ...(await vi.importActual<typeof import("../src/lib/resolveTransfer")>("../src/lib/resolveTransfer")),
  getResolveConnectionStatus: () => Promise.reject(new Error("안 물었다")),
}));
vi.mock("../src/lib/useEditSequence", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/useEditSequence")>("../src/lib/useEditSequence");
  const counts = { final: 0, held: 0, shared: 1 };
  const tree = { state: "ready", complete: true, note: null, roots: [{
    name: "e070", path: "e070", count: 5, newCount: 0, reviewCounts: counts, children: ["c1", "c2", "c3", "c4"].map((name) => (
      { name, path: `e070/${name}`, count: 1, newCount: 0, reviewCounts: counts })) }] } as unknown as EditTree;
  return {
    ...actual,
    useEditProjects: () => ({
      projects: [{ id: "p1", name: "P1" }], projectsState: "ok", tree, reload: () => {}, reloadCounts: () => {}, reloadFresh: () => {}, freshByProject: {},
    }),
    useEditGenerations: () => ({ state: "ok", gens: world.gens, error: null, complete: true, known: true, reload: () => {}, reloadIds: () => {} }),
  };
});
vi.mock("../src/lib/useDisabledFolders", () => ({ useDisabledFolders: () => ({}) }));

import { EditTab } from "../src/components/timeline/EditTab";

let host: HTMLDivElement;
let root: Root;
const cardMenuRef: { current: EditCardMenu | null } = { current: null };
const DOC_KEY = "mvhub.editDoc:local:p1:e070";
const knobRow = () => document.querySelector<HTMLElement>(".ed-phead .ed-phead-knob")?.style.getPropertyValue("--ph-row") ?? null;
const goCut = (name: string) => act(() => [...document.querySelectorAll<HTMLButtonElement>(".ed-cutcell")].find((cell) => cell.textContent === name)!.click());

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem("ch.editTimeline.last:local", JSON.stringify({ projectId: "p1", seq: "e070" }));
  localStorage.setItem(DOC_KEY, JSON.stringify({
    v: 1, tracksOff: [3], tracksLocked: [],
    clips: [
      { cut: "e070/c1", gen: "a", track: 1, kind: "image", dur: 5 },
      { cut: "e070/c2", gen: "b", track: 1, kind: "image", dur: 5 },
      { cut: "e070/c2", gen: "c", track: 2, kind: "image", dur: 5 },
      { cut: "e070/c4", gen: "d", track: 1, kind: "image", dur: 5 },
      { cut: "e070/c4", gen: "e", track: 3, kind: "image", dur: 5 },
    ],
  }));
  for (const method of ["load", "pause"] as const) vi.spyOn(HTMLMediaElement.prototype, method).mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  Object.assign(Element.prototype, { setPointerCapture() {}, hasPointerCapture: () => false, releasePointerCapture() {} });
  world.gens = [gen("a", "c1"), gen("b", "c2"), gen("c", "c2"), gen("d", "c4"), gen("e", "c4")];
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
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("볼록 표시는 보이는 클립의 트랙 줄에 있고, 위에 깔린 트랙이 보이면 그 줄로 옮긴다", () => {
  goCut("c1");
  expect(knobRow()).toBe("2"); // V3·V2·V1 중 V1
  goCut("c2");
  expect(knobRow()).toBe("1"); // V1 위의 V2 가 보인다
});

// 재생헤드의 선을 잡아 끌기(Jay 2026-10-26 — 다빈치는 머리 밑의 선을 잡아도 끌린다). jsdom 의 줄은 폭 0 이라 시각 = clientX ÷ 20px
it("재생헤드의 선(눈금자 밑)을 잡아 끌어도 옮겨진다 — 누르기만으로는 안 움직이고, 누른 자리와 선의 틈을 쥔 채 따라간다", () => {
  goCut("c2"); // 5초 = 100px
  const tc = () => document.querySelector(".ed-tc")!.textContent;
  const fire = (el: Element, type: string, init: MouseEventInit = {}) =>
    act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init })); });
  const grab = document.querySelector<HTMLElement>(".ed-phead .ed-phead-grab")!;
  const zero = { top: 0, bottom: 0, height: 0, y: 0, toJSON() {} };
  const box = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return (this.classList.contains("ed-phead") ? { ...zero, left: 99, right: 101, width: 2, x: 99 } : { ...zero, left: 0, right: 0, width: 0, x: 0 }) as DOMRect;
  });
  fire(grab, "pointerdown", { clientX: 103 }); // 선에서 3px 오른쪽을 잡았다
  expect(tc()).toBe("00:00:05:00"); // 누르기만으로는 그대로
  const captured = vi.spyOn(Element.prototype, "hasPointerCapture").mockReturnValue(true);
  fire(grab, "pointermove", { clientX: 143, buttons: 1 }); // 40px = 2초 오른쪽으로
  expect(tc()).toBe("00:00:07:00");
  fire(grab, "pointermove", { clientX: 83, buttons: 1 }); // 왼쪽으로 1초 앞까지
  expect(tc()).toBe("00:00:04:00");
  fire(grab, "pointermove", { clientX: 200, buttons: 0 }); // 왼쪽 단추가 떼어진 채 온 움직임 — 거기서 끝(놓기를 놓쳤다)
  expect(tc()).toBe("00:00:04:00");
  captured.mockRestore();
  box.mockRestore();
  expect(document.querySelectorAll(".ed-clip.ed-sel").length).toBe(0); // 밑의 클립을 고르지 않았다
});

it("보이는 클립이 없으면(빈 컷) 볼록 표시가 없고, 꺼 둔 트랙은 건너뛴다", () => {
  goCut("c3");
  expect(knobRow()).toBeNull();
  goCut("c4");
  expect(knobRow()).toBe("2"); // V3 은 꺼져 있다 — 보이는 것은 V1
});
