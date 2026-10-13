// @vitest-environment jsdom
// 편집 탭이 가만히 있을 때·재생할 때 하지 말아야 할 일(2026-10-13 격리 실측에서 나온 것):
//  · 밑의 탭(공유 & 리뷰)의 15초 폴링 틱에 공유 목록 전체를 다시 받지 않는다 — 왼쪽의 숫자만.
//  · 프레임마다 고치는 타임코드는 글자 노드를 갈아 끼우지 않는다(갈아 끼우면 문서 전체의 스타일을 다시 계산한다).
//  · 소스 판이 안 보이면 풀에서 고른 영상을 올리지 않는다(판을 올릴 때 올리고, 보던 자리는 남는다).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditCardMenu } from "../src/components/timeline/EditTab";
import { APP_EVENTS, dispatchAppEvent, LIBRARY_POLL_TICK } from "../src/lib/appEvents";
import type { EditTree } from "../src/lib/useEditSequence";
import type { Generation } from "../src/types";

const gen = (id: string, cut: string, type: "image" | "video" = "image") => ({
  id, job_id: `job-${id}`, status: "done", params: {}, prompt: `prompt ${id}`, folder_path: `e070/${cut}`,
  shared: true, is_final: false, is_held: false, is_mine: false, creator_name: "리버", model: "seedance",
  assets: [{ id: `a-${id}`, generation_id: id, type, file_path: `/media/${id}.${type === "video" ? "mp4" : "png"}`,
    thumbnail_path: null, source_url: null, cached: true }],
} as unknown as Generation);

const world = vi.hoisted(() => ({ gens: [] as unknown[], reload: (() => {}) as () => void, reloadCounts: (() => {}) as () => void }));
vi.mock("../src/lib/resolveTransfer", async () => ({
  ...(await vi.importActual<typeof import("../src/lib/resolveTransfer")>("../src/lib/resolveTransfer")),
  getResolveConnectionStatus: () => Promise.reject(new Error("안 물었다")),
}));
vi.mock("../src/lib/useEditSequence", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/useEditSequence")>("../src/lib/useEditSequence");
  const counts = { final: 0, held: 0, shared: 2 };
  const tree = { state: "ready", complete: true, note: null, roots: [{
    name: "e070", path: "e070", count: 4, newCount: 0, reviewCounts: counts, children: ["c1", "c2"].map((name) => (
      { name, path: `e070/${name}`, count: 2, newCount: 0, reviewCounts: counts })) }] } as unknown as EditTree;
  return {
    ...actual,
    useEditProjects: () => ({
      projects: [{ id: "p1", name: "P1" }], projectsState: "ok", tree, reload: () => {},
      reloadCounts: () => world.reloadCounts(), freshByProject: {},
    }),
    useEditGenerations: () => ({
      state: "ok", gens: world.gens, error: null, complete: true, known: true, reload: () => world.reload(),
    }),
  };
});
vi.mock("../src/lib/useDisabledFolders", () => ({ useDisabledFolders: () => ({}) }));

import { EditTab } from "../src/components/timeline/EditTab";

let host: HTMLDivElement;
let root: Root;
const cardMenuRef: { current: EditCardMenu | null } = { current: null };
const mount = () => {
  act(() => root.render(
    <EditTab authKey="auth" authReady workspace={{ scope: "team", id: "w1", name: "W" }} keysActive
      flash={() => {}} onOpenCutFolder={() => {}} reloadSignal={0}
      peekPath={null} onPeekMarks={() => {}} cardMenuRef={cardMenuRef} onPreview={() => {}} onCompare={() => {}}
      resolve={{ send: () => {}, sendTimeline: () => new Promise<never>(() => {}), busy: false, pendingCount: 0, timelineBusy: false }}
      onFolderAction={() => {}} />,
  ));
  // 재생헤드의 마지막 자리는 시험 사이에도 남는다 — c1 에서 시작한다(풀은 재생헤드가 있는 컷을 보여 준다)
  act(() => [...document.querySelectorAll<HTMLButtonElement>(".ed-cutcell")].find((cell) => cell.textContent === "c1")!.click());
};
const pane = (mode: string) => document.querySelector<HTMLElement>(`.ed-top > .ed-view[data-view="${mode}"]`)!;
const pickMode = (from: string, label: string) => {
  act(() => pane(from).querySelector<HTMLButtonElement>(".ed-vpick-btn")!.click());
  act(() => [...pane(from).querySelectorAll<HTMLButtonElement>(".ed-pop-item")].find((item) => item.textContent!.includes(label))!.click());
};
const poolCards = () => [...document.querySelectorAll<HTMLButtonElement>(".ed-pool .ed-card")];
const press = (init: KeyboardEventInit) => act(() => {
  document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem("ch.editTimeline.last:local", JSON.stringify({ projectId: "p1", seq: "e070" }));
  for (const method of ["load", "pause"] as const) vi.spyOn(HTMLMediaElement.prototype, method).mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  Object.assign(Element.prototype, { setPointerCapture() {}, hasPointerCapture: () => false, releasePointerCapture() {} });
  world.gens = [gen("a", "c1"), gen("v", "c1", "video"), gen("x", "c2")];
  world.reload = vi.fn();
  world.reloadCounts = vi.fn();
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

it("밑의 탭의 15초 폴링 틱에는 왼쪽의 숫자만 다시 받는다 — 공유 목록은 실제 변경 알림에만 다시 받는다", () => {
  mount();
  act(() => { dispatchAppEvent(APP_EVENTS.libraryChanged, LIBRARY_POLL_TICK); }); // 공유 & 리뷰 목록의 유휴 폴링이 끝났다
  act(() => { vi.advanceTimersByTime(1000); });
  expect(world.reload).not.toHaveBeenCalled();
  expect(world.reloadCounts).toHaveBeenCalledTimes(1);

  act(() => { dispatchAppEvent(APP_EVENTS.libraryChanged); }); // 실제 변경(공유 해제·삭제·담기)
  expect(world.reload).not.toHaveBeenCalled(); // 0.4초 몰아서
  act(() => { vi.advanceTimersByTime(400); });
  expect(world.reload).toHaveBeenCalledTimes(1);
  expect(world.reloadCounts).toHaveBeenCalledTimes(2);

  act(() => { dispatchAppEvent(APP_EVENTS.libraryChanged); }); // 변경 알림을 기다리는 사이에 온 틱은 그 조회를 지우지 않는다
  act(() => { dispatchAppEvent(APP_EVENTS.libraryChanged, LIBRARY_POLL_TICK); });
  act(() => { vi.advanceTimersByTime(400); });
  expect(world.reload).toHaveBeenCalledTimes(2);
});

it("타임코드는 글자 노드를 갈아 끼우지 않고 값만 고친다 — 막대와 뷰어 둘 다", () => {
  mount();
  const bar = document.querySelector(".ed-tc")!;
  const viewer = pane("timeline").querySelector(".ed-vtop > .ed-vtc")!;
  const nodes = [bar.firstChild, viewer.firstChild];
  expect(nodes.map((node) => node?.nodeType)).toEqual([Node.TEXT_NODE, Node.TEXT_NODE]);
  press({ key: "ArrowRight", code: "ArrowRight" }); // 한 프레임
  expect([bar.textContent, viewer.textContent]).toEqual(["00:00:00:01", "00:00:00:01"]);
  press({ key: "ArrowRight", code: "ArrowRight", shiftKey: true }); // 1초
  expect([bar.textContent, viewer.textContent]).toEqual(["00:00:01:01", "00:00:01:01"]);
  expect([bar.firstChild, viewer.firstChild]).toEqual(nodes); // 같은 노드다(자식 목록이 바뀌지 않았다)
  expect([bar.childNodes.length, viewer.childNodes.length]).toEqual([1, 1]);
});

it("소스 판이 안 보이면 풀에서 고른 영상을 올리지 않는다 — 판을 올리면 올리고, 내렸다 올려도 보던 자리 그대로", () => {
  mount();
  const sourceVideo = () => pane("source").querySelector<HTMLVideoElement>("video.ed-media");
  act(() => poolCards()[1].click()); // 싱글 뷰어(타임라인) — 영상 카드를 고른다
  expect(pane("source").hidden).toBe(true);
  expect(sourceVideo()?.getAttribute("src") ?? null).toBeNull(); // 안 보이는 판은 받지 않는다

  pickMode("timeline", "소스 클립"); // 판을 소스로
  expect(sourceVideo()!.getAttribute("src")).toBe("/media/v.mp4");
  press({ key: "ArrowRight", code: "ArrowRight", shiftKey: true }); // 소스의 1초 자리
  const at = () => pane("source").querySelector(".ed-vtop > .ed-vtc")!.textContent;
  expect(at()).toBe("00:00:01:00");

  pickMode("source", "타임라인"); // 내렸다가
  expect(sourceVideo()?.getAttribute("src") ?? null).toBeNull();
  pickMode("timeline", "소스 클립"); // 다시 올린다
  expect(sourceVideo()!.getAttribute("src")).toBe("/media/v.mp4");
  expect(at()).toBe("00:00:01:00");
});
