// @vitest-environment jsdom
// 편집 탭 조립 — 컷 목록이 '시퀀스가 있는 프로젝트'의 폴더에서 나오는지, 폴더 고르기의 시퀀스 판정, 편집 키.
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditTree } from "../src/lib/useEditSequence";

const trees = vi.hoisted(() => ({
  p1: { state: "ready", complete: true, note: null, roots: [{ name: "e070", path: "e070", children: [
    { name: "c1", path: "e070/c1" }, { name: "c2", path: "e070/c2" },
  ] }, { name: "e080", path: "e080", children: [{ name: "k9", path: "e080/k9" }] }] },
  p2: { state: "ready", complete: true, note: null, roots: [{ name: "other", path: "other" }, { name: "e070", path: "e070", children: [
    { name: "c1", path: "e070/c1" }, { name: "c2", path: "e070/c2" },
  ] }] },
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
import { clearUndo, keepUnsavedEditDoc } from "../src/lib/editTimelineStore";

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
  // jsdom 에는 ResizeObserver 가 없다 — 길이 조절 창(떠 있는 창, lib/useFloatingPanel)이 쓴다
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  // 저장 못 한 편집·되돌리기 단계는 모듈에 남는다(같은 문서 키를 쓰는 다음 시험이 그 문서로 시작한다) — 시험마다 비운다
  for (const key of ["mvhub.editDoc:local:p1:e070", "mvhub.editDoc:local:p1:e080", "mvhub.editDoc:local:p2:e070"]) {
    keepUnsavedEditDoc(key, null);
    clearUndo(key);
  }
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

// 19회차(조작 규칙 46): D(컷 켜고 끄기)는 화면 상태의 컷(view.cut)을 썼는데, 그것은 재생 위치보다 한 박자 늦다. 시퀀스를 바꾼 그 박자에
//  재생헤드는 이미 새 시퀀스의 자리에 그려졌고 편집 문서도 새것인데, D 는 앞 시퀀스에서 보던 컷을 새 문서에 '끈 컷'으로 적었다.
const stale = (click: () => void) => act(() => {
  flushSync(click); // 시퀀스를 바꿨다 — 그리고 그 박자에
  document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "d", code: "KeyD" }));
});
const cutsOffIn = (key: string) => (JSON.parse(localStorage.getItem(key) ?? "{}") as { cutsOff?: string[] }).cutsOff ?? [];

it("시퀀스를 바꾼 그 박자의 D 는 재생헤드가 옮겨 간 새 시퀀스의 컷에 걸린다 — 앞 시퀀스의 컷을 새 문서에 적지 않는다", () => {
  mount();
  expect(current()).toMatch(/^c[12]$/); // 재생헤드는 e070 의 컷에 있다(앞 시험이 남긴 자리일 수 있다)
  stale(() => folderRow("e080").click());
  expect(cuts()).toEqual(["k9"]);
  expect(cutsOffIn("mvhub.editDoc:local:p1:e080")).toEqual(["e080/k9"]); // 전엔 ["e070/c1"] 같은, 이 시퀀스에 없는 컷이 적혔다
});

// Codex 코드 리뷰: '지금 배치에 있는 컷인가'만 봐서는 모자란다 — 다른 프로젝트에 같은 이름의 컷이 있으면 그 검사를 통과해, 재생헤드가 없는 컷이 꺼진다.
it("다른 프로젝트의 같은 이름 시퀀스로 바꾼 그 박자의 D 도 재생헤드의 컷에 걸린다(앞 프로젝트에서 보던 컷과 이름이 같은 컷이 아니다)", () => {
  localStorage.setItem("mvhub.editDoc:local:p2:e070", JSON.stringify({ v: 1, tracksOff: [], tracksLocked: [], clips: [
    { cut: "e070/c1", gen: "g1", track: 1, kind: "video", dur: 5 }, { cut: "e070/c2", gen: "g2", track: 1, kind: "video", dur: 5 },
  ] }));
  mount();
  act(() => folderRow("c2").click()); // P1 의 e070/c2 에 재생헤드
  expect(current()).toBe("c2");
  act(() => projectRow(1).click()); // P2 를 펼친다 — 같은 이름의 시퀀스 e070 이 있다
  stale(() => folderRow("e070").click());
  expect(current()).toBe("c1"); // 새 시퀀스에서 재생헤드는 처음 컷에 있다
  expect(cutsOffIn("mvhub.editDoc:local:p2:e070")).toEqual(["e070/c1"]); // 전엔 ["e070/c2"]
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
  localStorage.setItem("mvhub.editDoc:local:p1:e070", JSON.stringify({ v: 1, tracksOff: [], tracksLocked: [], clips: [
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

// 11회차(조작 규칙 38): 편집 키의 토글·찍기(Space·D·I·O·M·W·L·J)가 길게 누르면 반복 keydown 마다 다시 실행됐다 — 비활성이 뒤집히고,
//  재생 중의 I·O·M 은 지나가는 프레임마다 찍혔다.
it("편집 키 — 길게 눌러도 토글은 한 번만 한다(D). 기본 동작은 반복에도 막고, 반복이 뜻인 이동 키는 그대로다", () => {
  localStorage.setItem("mvhub.editDoc:local:p1:e070", JSON.stringify({ v: 1, tracksOff: [], tracksLocked: [], clips: [
    { cut: "e070/c1", gen: "g1", track: 1, kind: "video", dur: 5 }, { cut: "e070/c2", gen: "g2", track: 1, kind: "video", dur: 5 },
  ] }));
  mount();
  const off = () => document.querySelectorAll(".ed-clip.ed-off").length;
  press({ key: "a", code: "KeyA", ctrlKey: true }); // 클립 둘을 고른다
  press({ key: "d", code: "KeyD" });
  expect(off()).toBe(2);
  const held = [1, 2, 3].map(() => press({ key: "d", code: "KeyD", repeat: true })); // 길게 눌러 반복된 keydown 셋
  expect([held.every((event) => event.defaultPrevented), off()]).toEqual([true, 2]); // 뒤집힌다면 꺼진 것이 0 이다

  press({ key: "d", code: "KeyD" }); // 다시 켠다(꺼진 클립뿐이면 재생헤드가 갈 곳이 없다)
  press({ key: "Home", code: "Home" });
  press({ key: "ArrowRight", code: "ArrowRight" });
  const first = timecode();
  press({ key: "ArrowRight", code: "ArrowRight", repeat: true }); // 프레임 이동은 반복이 뜻이다
  expect([first, timecode()]).toEqual(["00:00:00:01", "00:00:00:02"]);

  // Alt+M(재생헤드 자리의 북마크 지우기)도 한 번뿐이다 — 재생 중에 길게 누르면 지나가는 북마크가 줄줄이 지워졌다(Codex 코드 리뷰).
  const marks = () => document.querySelectorAll(".ed-ruler .ed-mk").length;
  press({ key: "m", code: "KeyM" }); // 2프레임 자리에 북마크
  press({ key: "ArrowRight", code: "ArrowRight" });
  press({ key: "m", code: "KeyM" }); // 3프레임 자리에 하나 더
  expect(marks()).toBe(2);
  press({ key: "m", code: "KeyM", altKey: true }); // 누른 자리(3프레임)의 것을 지운다
  expect(marks()).toBe(1);
  press({ key: "ArrowLeft", code: "ArrowLeft" }); // 누르고 있는 사이에 재생헤드가 다른 북마크 위로 왔다
  expect(press({ key: "m", code: "KeyM", altKey: true, repeat: true }).defaultPrevented).toBe(true);
  expect(marks()).toBe(1);
});

// 2026-10-12 격리 실측(두 빌드 3/3): 클립을 끌다 놓는 이벤트를 놓치면 클립이 translateY 를 단 채 남았다 — 그 클립을 다시 눌러야 풀렸다.
it("클립을 끌다 놓는 이벤트를 놓치면(포인터 쥐기를 잃음) 끌던 만큼 어긋난 채 남지 않는다 — 옮기지도 않는다", () => {
  const docKey = "mvhub.editDoc:local:p1:e070";
  localStorage.setItem(docKey, JSON.stringify({ v: 1, tracksOff: [], tracksLocked: [], clips: [
    { cut: "e070/c1", gen: "g1", track: 1, kind: "video", dur: 5 }, { cut: "e070/c2", gen: "g2", track: 1, kind: "video", dur: 5 },
  ] }));
  // jsdom 에는 포인터 쥐기가 없다 — 쥔 요소를 기억하는 흉내
  let held: Element | null = null;
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const saved = { set: proto.setPointerCapture, has: proto.hasPointerCapture, release: proto.releasePointerCapture };
  proto.setPointerCapture = function (this: Element) { held = this; };
  proto.hasPointerCapture = function (this: Element) { return held === this; };
  proto.releasePointerCapture = function (this: Element) { if (held === this) held = null; };
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
    proto.releasePointerCapture = saved.release;
    pointDoc.elementsFromPoint = savedPoint;
  }
});

// Jay 2026-10-13 — 타임라인의 클립을 휠 클릭 = 길이 조절 창(뒤를 자른다). 영상만이다.
it("클립을 휠 클릭하면 길이 조절 창이 뜬다 — 걸음마다 저장하고, 닫은 뒤 Ctrl+Z 한 번에 줄이기 전으로 돌아간다", () => {
  const docKey = "mvhub.editDoc:local:p1:e070";
  localStorage.setItem(docKey, JSON.stringify({ v: 1, tracksOff: [], tracksLocked: [], clips: [
    { cut: "e070/c1", gen: "g1", track: 1, kind: "video", dur: 5 }, { cut: "e070/c1", gen: "g2", track: 2, kind: "image", dur: 5 },
  ] }));
  mount();
  const trimOf = () => (JSON.parse(localStorage.getItem(docKey)!) as { clips: { gen: string; trim?: number }[] })
    .clips.find((clip) => clip.gen === "g1")!.trim;
  const clipOn = (track: string) => [...document.querySelectorAll<HTMLElement>(".ed-clip")]
    .find((clip) => clip.closest<HTMLElement>("[data-track]")!.dataset.track === track)!;
  const wheelClick = (clip: HTMLElement) => act(() => {
    clip.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1, clientX: 50, clientY: 50 }));
  });
  wheelClick(clipOn("2")); // 그림 — 창이 뜨지 않는다
  expect(document.querySelector(".ed-trim")).toBeNull();
  wheelClick(clipOn("1"));
  const pop = document.querySelector<HTMLElement>(".ed-trim")!;
  expect(pop.textContent).toContain("c1 · V1");
  const button = (label: string) => [...pop.querySelectorAll("button")]
    .find((item) => item.textContent === label || item.getAttribute("aria-label") === label)!;
  expect(button("원본 길이로").getAttribute("aria-disabled")).toBe("true"); // 아직 줄이지 않았다(꺼진 단추도 초점은 받는다 — disabled 가 아니다)
  act(() => button("−10f").click());
  act(() => button("−1f").click());
  expect(trimOf()).toBeCloseTo(109 / 24);
  // 띠의 채움(쓰는 구간의 끝) — 값이 비면 띠가 통째로 안 그려진다(2026-10-14 격리 실측: 식이 빠져 "%" 만 들어가 있었다)
  const fill = pop.querySelector<HTMLInputElement>(".ed-trim-range")!.style.getPropertyValue("--fill");
  expect([fill.endsWith("%"), Math.round(parseFloat(fill) * 100)]).toEqual([true, Math.round((108 / 119) * 10000)]);
  press({ key: "ArrowLeft", shiftKey: true }, pop.querySelector("input")!); // Shift+← = 10프레임
  expect(trimOf()).toBeCloseTo(99 / 24);
  expect(clipOn("1").textContent).toContain("4.1s / 5.0s"); // 타임라인의 클립에 쓰는 길이 / 원본 길이
  press({ key: "Delete", code: "Delete" }, pop); // 창 안에서 난 키는 뒤의 편집 키가 듣지 않는다(창은 편집 화면 밖 — body 에 그려진다)
  expect([document.querySelectorAll(".ed-clip").length, pop.parentElement]).toEqual([2, document.body]);
  act(() => button("닫기").click());
  expect(document.querySelector(".ed-trim")).toBeNull();
  press({ key: "z", code: "KeyZ", ctrlKey: true }); // 창을 한 번 연 동안의 걸음 셋이 되돌리기 한 단계다
  expect(trimOf()).toBeUndefined();
  press({ key: "z", code: "KeyZ", ctrlKey: true, shiftKey: true });
  expect(trimOf()).toBeCloseTo(99 / 24);
  // 끝까지 늘리면 '원본 길이로'와 같다 — 줄임을 지운다
  wheelClick(clipOn("1"));
  const again = document.querySelector<HTMLElement>(".ed-trim")!;
  act(() => [...again.querySelectorAll("button")].find((item) => item.textContent === "원본 길이로")!.click());
  expect(trimOf()).toBeUndefined();
});

// Codex 코드 리뷰 2회째 P1: 슬라이더를 끄는 도중 저장이 실패하고(저장 안 됨) 다른 창이 저장하면, 첫 걸음은 버려지지만 **같은 끌기의
//  다음 걸음**이 '알고 이어 가는 편집'으로 저장돼 다른 창의 저장을 덮었다. 충돌을 알게 되면 창을 닫아 그 조절을 끝낸다.
const TRIM_DOC = { v: 1, tracksOff: [], tracksLocked: [], clips: [{ cut: "e070/c1", gen: "g1", track: 1, kind: "video", dur: 5 }] };
const THEIRS = JSON.stringify({ ...TRIM_DOC, clips: [{ cut: "e070/c1", gen: "theirs", track: 1, kind: "video", dur: 5 }] });
const openTrimOn = (docKey: string) => {
  localStorage.setItem(docKey, JSON.stringify(TRIM_DOC));
  mount();
  act(() => {
    document.querySelector<HTMLElement>(".ed-clip")!
      .dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1, clientX: 50, clientY: 50 }));
  });
  const pop = document.querySelector<HTMLElement>(".ed-trim")!;
  return (label: string) => act(() => [...pop.querySelectorAll("button")]
    .find((item) => item.textContent === label || item.getAttribute("aria-label") === label)!.click());
};

it("길이 조절 중에 저장 못 한 편집과 다른 창의 저장이 겹치면 창을 닫는다 — 같은 조절의 다음 걸음이 그 저장을 덮지 않는다", () => {
  const docKey = "mvhub.editDoc:local:p1:e070";
  const press1f = openTrimOn(docKey);
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  press1f("−1f"); // 저장 실패 — 편집은 메모리에만 있다. 창은 그대로다
  expect(document.querySelector(".ed-trim")).not.toBeNull();
  setItem.mockRestore();
  localStorage.setItem(docKey, THEIRS); // 다른 창이 저장했다 — 알림(storage)은 아직 안 왔다
  press1f("−1f"); // 같은 조절의 다음 걸음 — 버리고 창을 닫는다
  expect(document.querySelector(".ed-trim")).toBeNull();
  expect(localStorage.getItem(docKey)).toBe(THEIRS);
});

it("길이 조절 창이 떠 있는 동안 다른 창의 저장 알림이 먼저 와도(저장 못 한 편집이 있을 때) 창을 닫는다", () => {
  const docKey = "mvhub.editDoc:local:p1:e070";
  const press1f = openTrimOn(docKey);
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  press1f("−1f");
  setItem.mockRestore();
  localStorage.setItem(docKey, THEIRS);
  act(() => { window.dispatchEvent(new StorageEvent("storage", { key: docKey })); });
  expect(document.querySelector(".ed-trim")).toBeNull();
  expect(localStorage.getItem(docKey)).toBe(THEIRS);
});

// 휠 단추가 없는 마우스·트랙패드의 길 — 클립 우클릭 메뉴에서도 같은 창을 연다.
it("클립 우클릭 메뉴의 '길이 조절'로도 같은 창이 열린다", () => {
  localStorage.setItem("mvhub.editDoc:local:p1:e070", JSON.stringify(TRIM_DOC));
  mount();
  act(() => {
    document.querySelector<HTMLElement>(".ed-clip")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 40 }));
  });
  const row = [...document.querySelectorAll<HTMLButtonElement>(".ed-tmenu-item")].find((item) => item.textContent?.includes("길이 조절"))!;
  act(() => row.click());
  const pop = document.querySelector<HTMLElement>(".ed-trim")!;
  expect([pop.getAttribute("role"), pop.textContent?.includes("c1 · V1")]).toEqual(["dialog", true]);
});

// Codex 코드 리뷰 2회째(끌기 공통): 왼쪽으로 끄는 중에 휠 단추를 같이 누르면 pointerup 은 **마지막 단추가 떼일 때에야** 온다 —
//  왼쪽만 떼도 끌기가 이어지고, 나중에 휠을 떼는 것이 놓기가 됐다. 왼쪽이 떼어진 채 온 움직임에서 끌기를 버린다.
it("클립 끌기는 왼쪽 단추의 놓기만 확정이다 — 휠을 같이 누른 채 왼쪽을 떼면 버리고, 끄는 중의 휠 클릭·우클릭은 창을 열지 않는다", () => {
  const docKey = "mvhub.editDoc:local:p1:e070";
  localStorage.setItem(docKey, JSON.stringify(TRIM_DOC));
  let held: Element | null = null;
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const saved = { set: proto.setPointerCapture, has: proto.hasPointerCapture, release: proto.releasePointerCapture };
  proto.setPointerCapture = function (this: Element) { held = this; };
  proto.hasPointerCapture = function (this: Element) { return held === this; };
  proto.releasePointerCapture = function (this: Element) { if (held === this) held = null; };
  const pointDoc = document as unknown as { elementsFromPoint?: unknown };
  const savedPoint = pointDoc.elementsFromPoint;
  try {
    mount();
    const clip = document.querySelector<HTMLElement>(".ed-clip")!;
    const other = [...document.querySelectorAll<HTMLElement>("[data-track]")].find((lane) => lane.dataset.track !== "1")!;
    pointDoc.elementsFromPoint = () => [other]; // 마우스 밑은 다른 트랙 — 놓기로 치면 클립이 그리로 간다
    const send = (type: string, init: MouseEventInit) => act(() => {
      clip.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, ...init }), { pointerId: 1 }));
    });
    const before = localStorage.getItem(docKey);
    send("pointerdown", { button: 0, buttons: 1, clientY: 100 });
    send("pointermove", { buttons: 1, clientY: 42 });
    expect(clip.style.transform).toBe("translateY(-58px)");
    // 끄는 중의 휠 클릭·우클릭 — 길이 조절 창도 클립 메뉴도 뜨지 않는다
    send("auxclick", { button: 1, buttons: 1, clientY: 42 });
    send("contextmenu", { button: 2, buttons: 1, clientY: 42 });
    expect([document.querySelector(".ed-trim"), document.querySelector(".ed-tmenu")]).toEqual([null, null]);
    expect(clip.style.transform).toBe("translateY(-58px)"); // 끌기는 이어진다
    send("pointermove", { buttons: 5, clientY: 40 }); // 휠을 같이 눌렀다
    send("pointermove", { buttons: 4, clientY: 40 }); // 왼쪽만 뗐다(pointerup 은 아직 안 온다) — 여기서 버린다
    expect(clip.style.transform).toBe("");
    send("pointerup", { button: 1, buttons: 0, clientY: 40 }); // 나중에 휠을 뗀 것은 놓기가 아니다
    expect(localStorage.getItem(docKey)).toBe(before);
    // 왼쪽을 누른 채 끝까지 끌다가, 놓는 순간의 단추가 왼쪽이 아니면(다른 단추의 pointerup) 그것도 놓기가 아니다
    held = null;
    send("pointerdown", { button: 0, buttons: 1, clientY: 100 });
    send("pointermove", { buttons: 1, clientY: 42 });
    send("pointerup", { button: 1, buttons: 0, clientY: 42 });
    expect([clip.style.transform, localStorage.getItem(docKey)]).toEqual(["", before]);
    // 보통의 놓기는 그대로 옮긴다
    held = null;
    send("pointerdown", { button: 0, buttons: 1, clientY: 100 });
    send("pointermove", { buttons: 1, clientY: 42 });
    send("pointerup", { button: 0, buttons: 0, clientY: 42 });
    expect(JSON.parse(localStorage.getItem(docKey)!).clips[0].track).toBe(Number(other.dataset.track));
  } finally {
    proto.setPointerCapture = saved.set;
    proto.hasPointerCapture = saved.has;
    proto.releasePointerCapture = saved.release;
    pointDoc.elementsFromPoint = savedPoint;
  }
});

// 되돌려 확인(2026-10-13)에서 홀로 살아남은 줄 — 버린 걸음(stopped)에 창을 닫는 것. 충돌은 conflict 효과가, 다른 창의 문서를 받아들인
//  것은 rev 효과가 먼저 닫아 준다. 이 줄만 일하는 것은 '떠나는 중'(로그아웃 응답 대기 — lib/unloadGuard)이다.
it("길이 조절 중에 로그아웃 응답을 기다리게 되면(떠나는 중) 다음 걸음은 버리고 창을 닫는다", async () => {
  const { setLeaving } = await import("../src/lib/unloadGuard");
  const docKey = "mvhub.editDoc:local:p1:e070";
  const press1f = openTrimOn(docKey);
  const before = localStorage.getItem(docKey);
  setLeaving(true);
  try {
    press1f("−1f");
    expect([document.querySelector(".ed-trim"), localStorage.getItem(docKey)]).toEqual([null, before]);
  } finally {
    setLeaving(false);
  }
});

// Codex 코드 리뷰 3회째 P1: 충돌(T1)을 알고 길이 조절을 다시 연 것은 '알고 하는 편집'이다. 그런데 그 조절 도중 다른 창이 **또** 저장하면(T2)
//  그것까지 안 것은 아니다 — 전에는 충돌이 이미 켜져 있다는 이유로 T2 를 새 충돌로 보지 않아, 다음 걸음이 T2 를 덮었다.
it("충돌을 알고 길이 조절을 다시 연 뒤에도, 그 조절 도중 다른 창이 또 저장하면 다시 창을 닫는다 — 새 저장을 덮지 않는다", () => {
  const docKey = "mvhub.editDoc:local:p1:e070";
  const T2 = JSON.stringify({ ...TRIM_DOC, clips: [{ cut: "e070/c1", gen: "theirs2", track: 1, kind: "video", dur: 5 }] });
  const fail = () => vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  const wheel = () => act(() => {
    document.querySelector<HTMLElement>(".ed-clip")!
      .dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1, clientX: 50, clientY: 50 }));
  });
  const step = () => act(() => {
    [...document.querySelector<HTMLElement>(".ed-trim")!.querySelectorAll("button")].find((item) => item.textContent === "−1f")!.click();
  });
  openTrimOn(docKey);
  let setItem = fail();
  step(); // 저장 실패 — 저장 안 됨
  setItem.mockRestore();
  localStorage.setItem(docKey, THEIRS); // T1
  setItem = fail(); // 이 창의 저장은 계속 실패한다
  step(); // T1 을 처음 안다 — 버리고 닫는다
  expect(document.querySelector(".ed-trim")).toBeNull();
  wheel(); // 알고 다시 연다
  step(); // 알고 하는 편집 — 받는다(저장은 또 실패해 충돌은 그대로다)
  expect(document.querySelector(".ed-trim")).not.toBeNull();
  setItem.mockRestore();
  localStorage.setItem(docKey, T2); // 그 조절 도중 다른 창이 또 저장했다
  step(); // T2 는 처음 안 것 — 버리고 닫는다
  expect(document.querySelector(".ed-trim")).toBeNull();
  expect(localStorage.getItem(docKey)).toBe(T2);
});

// Jay 2026-10-13 밤: 길이 조절은 **떠 있는 창**이다 — 떠 있어도 타임라인을 쓴다. 키는 초점을 따른다: 창 안이면 창의 것(←/→ = 길이),
//  타임라인이면 타임라인의 것(←/→ = 재생헤드). 끝에 닿은 단추는 꺼지지 않고(aria-disabled) 초점을 지킨다 — disabled 로 끄면 초점이 body 로
//  떨어져 키가 창을 떠난다(같은 날 격리 실측: 그때 ←/→ 가 죽었다).
it("길이 조절 창은 떠 있는 창이다 — 키는 초점을 따르고, 밖을 눌러도·다른 메뉴를 여닫아도 떠 있고, 숫자를 직접 친다", () => {
  const docKey = "mvhub.editDoc:local:p1:e070";
  const press1f = openTrimOn(docKey);
  const pop = () => document.querySelector<HTMLElement>(".ed-trim");
  const button = (label: string) => [...pop()!.querySelectorAll("button")].find((item) => item.textContent === label)!;
  const trim = () => (JSON.parse(localStorage.getItem(docKey)!) as { clips: { trim?: number }[] }).clips[0].trim;
  const code = timecode();
  expect(pop()!.contains(document.activeElement)).toBe(true); // 열면 초점이 창으로 온다
  press1f("−1f");
  press1f("+1f"); // 끝까지 — 줄임이 지워진다
  expect(trim()).toBeUndefined();
  expect([button("+1f").disabled, button("+1f").getAttribute("aria-disabled")]).toEqual([false, "true"]);
  button("+1f").focus(); // 끝에 닿은 단추에 초점이 그대로 있다
  const left = press({ key: "ArrowLeft", code: "ArrowLeft" }, button("+1f"));
  expect([trim(), left.defaultPrevented, timecode()]).toEqual([119 / 24, true, code]);
  press({ key: "ArrowLeft", code: "ArrowLeft", shiftKey: true }, pop()!);
  expect(trim()).toBeCloseTo(109 / 24);
  // 초점이 타임라인(여기서는 body)이면 화살표는 재생헤드의 것이다 — 길이는 그대로
  press({ key: "ArrowRight", code: "ArrowRight" });
  expect(trim()).toBeCloseTo(109 / 24);
  expect(timecode()).not.toBe(code);
  // 밖을 눌러도 닫히지 않는다 · 다른 메뉴(클립 우클릭)를 여닫아도 떠 있다
  act(() => { document.querySelector(".ed-root")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  act(() => {
    document.querySelector<HTMLElement>(".ed-clip")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 40 }));
  });
  expect(document.querySelector(".ed-tmenu")).not.toBeNull();
  press({ key: "Escape", code: "Escape" });
  expect([document.querySelector(".ed-tmenu"), !!pop()]).toEqual([null, true]);
  // 숫자 칸 — 초 칸에 2 를 치고 Enter = 48프레임. 칸 안의 화살표는 칸의 것이다(길이를 건드리지 않는다)
  const seconds = pop()!.querySelector<HTMLInputElement>(".ed-trim-num")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(seconds, "2");
    seconds.dispatchEvent(new Event("input", { bubbles: true }));
  });
  press({ key: "ArrowLeft", code: "ArrowLeft" }, seconds);
  expect(trim()).toBeCloseTo(109 / 24);
  press({ key: "Enter", code: "Enter" }, seconds);
  expect(trim()).toBeCloseTo(2);
  // 창 안의 Ctrl+Z — 창을 연 뒤의 걸음들이 되돌리기 한 단계다
  press({ key: "z", code: "KeyZ", ctrlKey: true }, pop()!);
  expect(trim()).toBeUndefined();
  // 창 안의 Esc 로 닫는다 — 초점은 편집 화면으로 돌아가 키가 바로 타임라인의 것이다(창과 함께 사라져 body 로 떨어지지 않는다)
  button("−1f").focus();
  press({ key: "Escape", code: "Escape" }, button("−1f"));
  expect([pop(), document.activeElement]).toEqual([null, document.querySelector(".ed-root")]);
});

// 떠 있는 채 다른 클립을 휠 클릭하면 창이 그 클립으로 바뀐다(창은 하나) — 걸음은 새 클립의 것이고, 되돌리기 묶음도 따로다.
it("길이 조절 창이 떠 있는 채 다른 클립을 휠 클릭하면 창이 그 클립으로 바뀐다", () => {
  const docKey = "mvhub.editDoc:local:p1:e070";
  localStorage.setItem(docKey, JSON.stringify({ v: 1, tracksOff: [], tracksLocked: [], clips: [
    { cut: "e070/c1", gen: "g1", track: 1, kind: "video", dur: 5 }, { cut: "e070/c2", gen: "g2", track: 1, kind: "video", dur: 5 },
  ] }));
  mount();
  const wheel = (index: number) => act(() => {
    document.querySelectorAll<HTMLElement>(".ed-clip")[index]
      .dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1, clientX: 50, clientY: 50 }));
  });
  const step = () => act(() => {
    [...document.querySelector<HTMLElement>(".ed-trim")!.querySelectorAll("button")].find((item) => item.textContent === "−1f")!.click();
  });
  const trims = () => (JSON.parse(localStorage.getItem(docKey)!) as { clips: { trim?: number }[] }).clips.map((clip) => clip.trim);
  wheel(0);
  step();
  // 초 칸에 치다 만 값이 있는 채 다른 클립으로 바꾼다 — 그 값은 앞 클립의 것이라 버린다(초점이 창으로 옮겨지며 칸이 blur 되는데,
  //  그때 적용하면 새 클립에 들어간다)
  const seconds = document.querySelector<HTMLInputElement>(".ed-trim .ed-trim-num")!;
  act(() => {
    seconds.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(seconds, "2");
    seconds.dispatchEvent(new Event("input", { bubbles: true }));
  });
  wheel(1);
  expect(trims()).toEqual([119 / 24, undefined]);
  expect(document.querySelectorAll(".ed-trim")).toHaveLength(1);
  expect(document.querySelector(".ed-trim")!.textContent).toContain("c2 · V1");
  step();
  expect(trims()).toEqual([119 / 24, 119 / 24]);
  press({ key: "z", code: "KeyZ", ctrlKey: true }, document.querySelector<HTMLElement>(".ed-trim")!); // 둘째 클립의 걸음만 되돌린다
  expect(trims()).toEqual([119 / 24, undefined]);
});

// Codex 코드 리뷰 6회째: 창 안에서 난 키가 창 밖으로 나가면, 편집 탭이 연 폴더 창이 떠 있을 때 라이브러리 단축키(window 의 버블 단계 —
//  lib/useGenerationKeyboardActions)가 받아 뒤 폴더 창의 고른 카드에 색(R)·비활성(D)이 걸렸다. 그쪽은 키가 어디서 났는지 보지 않는다.
it("길이 조절 창 안에서 난 키는 창 밖(window)의 단축키에 닿지 않는다 — 창 밖에서 난 키는 그대로 간다", () => {
  openTrimOn("mvhub.editDoc:local:p1:e070");
  const pop = document.querySelector<HTMLElement>(".ed-trim")!;
  const heard: string[] = [];
  const listen = (event: KeyboardEvent) => { heard.push(event.key); };
  window.addEventListener("keydown", listen);
  try {
    const button = [...pop.querySelectorAll("button")].find((item) => item.textContent === "−1f")!;
    press({ key: "r", code: "KeyR" }, button);
    press({ key: "d", code: "KeyD" }, button);
    press({ key: "Delete", code: "Delete" }, pop);
    press({ key: "ArrowLeft", code: "ArrowLeft" }, button);
    press({ key: "2", code: "Digit2" }, pop.querySelector(".ed-trim-num")!); // 숫자 칸에 치는 글자도 밖으로는 안 나간다
    expect(heard).toEqual([]);
    press({ key: "r", code: "KeyR" });
    expect(heard).toEqual(["r"]);
  } finally {
    window.removeEventListener("keydown", listen);
  }
});

// 2026-10-13 격리 실측: 숫자 칸에 치다가 Esc 를 누르면 친 값이 **적용된 채** 닫혔다 — 닫히며 초점이 편집 화면으로 옮겨질 때 칸이 blur 되고,
//  그 blur 가 적용을 불렀다. Esc 는 취소다.
it("길이 조절 창: 숫자 칸에 치다가 Esc 를 누르면 그 값은 버리고 닫는다", () => {
  const docKey = "mvhub.editDoc:local:p1:e070";
  openTrimOn(docKey);
  const trim = () => (JSON.parse(localStorage.getItem(docKey)!) as { clips: { trim?: number }[] }).clips[0].trim;
  const seconds = document.querySelector<HTMLInputElement>(".ed-trim .ed-trim-num")!;
  act(() => {
    seconds.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(seconds, "2");
    seconds.dispatchEvent(new Event("input", { bubbles: true }));
  });
  press({ key: "Escape", code: "Escape" }, seconds);
  expect([document.querySelector(".ed-trim"), trim()]).toEqual([null, undefined]);
});
