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
      reloadCounts: () => {}, freshByProject: {},
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
  <EditTab authKey="auth" authReady workspace={{ scope: "team", id: "w1", name: "W" }} keysActive={keysActive} flash={() => {}}
    onOpenCutFolder={() => {}} reloadSignal={0} peekPath={null} onPeekMarks={() => {}} cardMenuRef={{ current: null }} onPreview={() => {}} onCompare={() => {}}
    resolve={{ send: () => {}, busy: false, pendingCount: 0 }} />,
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
  // 상단바 단추에 남은 초점(창을 Esc 로 닫은 뒤의 로고·알림·계정)은 다른 창이 아니다 — 편집 키가 먹고, Space 는 그 단추를 또 누르지 않는다
  const bar = document.createElement("div"); bar.className = "topbar";
  const bell = document.createElement("button"); bar.appendChild(bell); document.body.appendChild(bar);
  document.dispatchEvent(new Event("pointerdown")); // 마우스로 눌렀다
  expect(press({ key: "End", code: "End" }, bell).defaultPrevented).toBe(true);
  expect(timecode()).toBe("00:00:10:00");
  expect(press({ key: " ", code: "Space" }, bell).defaultPrevented).toBe(true); // 재생 — 단추는 다시 눌리지 않는다
  press({ key: " ", code: "Space" }, bell); // 다시 멈춤
  press({ key: "Tab", code: "Tab" }, bell); // Tab 으로 옮겨 온 초점이면 Space 는 그 단추의 것
  expect(press({ key: " ", code: "Space" }, bell).defaultPrevented).toBe(false);
  expect(press({ key: "Home", code: "Home" }, bell).defaultPrevented).toBe(true);
  bar.remove();
  expect(timecode()).toBe("00:00:00:00");

  mount(false); // 위에 관리자 창 등이 떠 있다
  expect(press({ key: "End", code: "End" }).defaultPrevented).toBe(false);
  expect(timecode()).toBe("00:00:00:00");
});

it("편집 키 — 위에 Esc 로 닫히는 창·메뉴가 떠 있으면 쉰다(풀·뷰어 메뉴가 뜬 채 Delete·Space 가 뒤에 먹었다). 앱이 늘 막아 두는 Ctrl+A 는 듣는다", async () => {
  const { useEscapeClose } = await import("../src/lib/useEscapeClose");
  function Layer() { useEscapeClose(() => {}); return null; }
  const draw = (layer: boolean) => act(() => root.render(<>
    {layer ? <Layer /> : null}
    <EditTab authKey="auth" authReady workspace={{ scope: "team", id: "w1", name: "W" }} keysActive flash={() => {}}
      onOpenCutFolder={() => {}} reloadSignal={0} peekPath={null} onPeekMarks={() => {}} cardMenuRef={{ current: null }} onPreview={() => {}} onCompare={() => {}}
      resolve={{ send: () => {}, busy: false, pendingCount: 0 }} />
  </>));
  // 시퀀스에 클립 둘을 놓아 둔다(문서는 localStorage — 계정 local · p1 · e070)
  localStorage.setItem("ch.editTimeline:local:p1:e070", JSON.stringify({ v: 1, tracksOff: [], tracksLocked: [], clips: [
    { cut: "e070/c1", gen: "g1", track: 1, kind: "video", dur: 5 }, { cut: "e070/c2", gen: "g2", track: 1, kind: "video", dur: 5 },
  ] }));
  draw(true);
  expect(press({ key: "End", code: "End" }).defaultPrevented).toBe(false);
  expect(press({ key: " ", code: "Space" }).defaultPrevented).toBe(false);
  expect(timecode()).toBe("00:00:00:00");
  draw(false);
  expect(press({ key: "End", code: "End" }).defaultPrevented).toBe(true);
  expect(timecode()).toBe("00:00:10:00");

  // 앱은 입력칸 밖의 Ctrl+A 를 캡처 단계에서 늘 막아 둔다(화면 글자를 긁지 않게) — 그렇다고 편집 화면이 '남이 쓴 키'로 보고 손을 떼면 안 된다
  const guard = (event: KeyboardEvent) => { if (event.ctrlKey && event.key === "a") event.preventDefault(); };
  window.addEventListener("keydown", guard, true);
  try {
    press({ key: "a", code: "KeyA", ctrlKey: true });
    expect(document.querySelectorAll(".ed-clip").length).toBe(2);
    expect(document.querySelectorAll(".ed-clip.ed-sel").length).toBe(2);
  } finally {
    window.removeEventListener("keydown", guard, true);
  }
});

// 2026-10-12 격리 실측(두 빌드 3/3): 클립을 끌다 놓는 이벤트를 놓치면 클립이 translateY 를 단 채 남았다 — 그 클립을 다시 눌러야 풀렸다.
it("클립을 끌다 놓는 이벤트를 놓치면(포인터 쥐기를 잃음) 끌던 만큼 어긋난 채 남지 않는다 — 옮기지도 않는다", () => {
  const docKey = "ch.editTimeline:local:p1:e070";
  localStorage.setItem(docKey, JSON.stringify({ v: 1, tracksOff: [], tracksLocked: [], clips: [
    { cut: "e070/c1", gen: "g1", track: 1, kind: "video", dur: 5 }, { cut: "e070/c2", gen: "g2", track: 1, kind: "video", dur: 5 },
  ] }));
  // jsdom 에는 포인터 쥐기가 없다 — 쥔 요소를 기억하는 흉내
  let held: Element | null = null;
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const saved = { set: proto.setPointerCapture, has: proto.hasPointerCapture };
  proto.setPointerCapture = function (this: Element) { held = this; };
  proto.hasPointerCapture = function (this: Element) { return held === this; };
  const pointDoc = document as unknown as { elementsFromPoint?: unknown };
  const savedPoint = pointDoc.elementsFromPoint;
  try {
    mount();
    const clip = document.querySelector<HTMLElement>(".ed-clip")!;
    const laneOf = () => document.querySelector<HTMLElement>(".ed-clip")!.closest<HTMLElement>("[data-track]")!.dataset.track;
    // 마우스 밑은 다른 트랙이다 — 놓친 끌기를 '놓은 것'으로 확정하면 클립이 그 트랙으로 간다
    const other = [...document.querySelectorAll<HTMLElement>("[data-track]")].find((lane) => lane.dataset.track !== laneOf())!;
    expect(other).toBeTruthy();
    pointDoc.elementsFromPoint = () => [other];
    const home = laneOf();
    const pointer = (type: string, clientY: number, buttons: number) => act(() => {
      clip.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons, clientX: 10, clientY }), { pointerId: 1 }));
    });
    pointer("pointerdown", 100, 1);
    pointer("pointermove", 42, 1); // 58px 위로 — 끌기가 시작됐다
    expect(clip.style.transform).toBe("translateY(-58px)");
    const before = localStorage.getItem(docKey);
    held = null; // 놓는 이벤트 없이 쥐기를 잃었다(창 밖에서 뗌) — 브라우저는 lostpointercapture 만 보낸다
    pointer("lostpointercapture", 42, 0);
    expect([clip.style.transform, clip.style.zIndex]).toEqual(["", ""]);
    pointer("pointermove", 10, 0); // 뗀 마우스를 따라오지 않는다
    pointer("pointerup", 10, 0); // 뒤늦게 온 놓기도 옮기지 않는다
    expect(clip.style.transform).toBe("");
    expect([laneOf(), localStorage.getItem(docKey)]).toEqual([home, before]);
  } finally {
    proto.setPointerCapture = saved.set;
    proto.hasPointerCapture = saved.has;
    pointDoc.elementsFromPoint = savedPoint;
  }
});
