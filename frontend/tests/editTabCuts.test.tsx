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
  const button = (label: string) => [...pop.querySelectorAll("button")].find((item) => item.textContent === label)!;
  expect(button("원본 길이로").disabled).toBe(true); // 아직 줄이지 않았다
  act(() => button("−10f").click());
  act(() => button("−1f").click());
  expect(trimOf()).toBeCloseTo(109 / 24);
  press({ key: "ArrowLeft", shiftKey: true }, pop.querySelector("input")!); // Shift+← = 10프레임
  expect(trimOf()).toBeCloseTo(99 / 24);
  expect(clipOn("1").textContent).toContain("4.1s / 5.0s"); // 타임라인의 클립에 쓰는 길이 / 원본 길이
  press({ key: "Delete" }); // 창이 떠 있는 동안 뒤의 편집 키는 쉰다
  expect(document.querySelectorAll(".ed-clip")).toHaveLength(2);
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
  return (label: string) => act(() => [...pop.querySelectorAll("button")].find((item) => item.textContent === label)!.click());
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