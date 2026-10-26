// @vitest-environment jsdom
// 편집 탭 단축키 — 화면에서: 기본값 호환(먹음/넘김), 지정을 바꾸면 키·툴팁이 바로 따름, H 단추와 단축키 창(칸 받기·휠·Esc 두 단계).
//  설계 = docs/status/편집탭_단축키설정_설계_2026-10-23.md(Codex 4차 승인) · 구현 계약 = docs/status/편집탭_단축키설정_구현_2026-10-23.md.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditTree } from "../src/lib/useEditSequence";

const tree = vi.hoisted(() => ({ state: "ready", complete: true, note: null, roots: [{ name: "e070", path: "e070", children: [
  { name: "c1", path: "e070/c1" }, { name: "c2", path: "e070/c2" },
] }] }));
vi.mock("../src/lib/useEditSequence", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/useEditSequence")>("../src/lib/useEditSequence");
  return {
    ...actual,
    useEditProjects: () => ({
      projects: [{ id: "p1", name: "P1" }], projectsState: "ok", tree: tree as EditTree, reload: () => {}, reloadCounts: () => {}, freshByProject: {},
    }),
    useEditGenerations: () => ({ state: "ok", gens: [], error: null, complete: true, reload: () => {} }),
  };
});

import { EditTab } from "../src/components/timeline/EditTab";
import { resetAllEditShortcuts, setSlot, slotsOf } from "../src/lib/editShortcuts";
import { setLang } from "../src/lib/i18n";
import { clearUndo, keepUnsavedEditDoc } from "../src/lib/editTimelineStore";

const DOC = "mvhub.editDoc:local:p1:e070";
let host: HTMLDivElement;
let root: Root;
const timecode = () => document.querySelector(".ed-tc")!.textContent;
const press = (init: KeyboardEventInit, target: EventTarget = document.body) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
};
const roll = (init: WheelEventInit, target: EventTarget = document.querySelector(".ed-scroll")!) => {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
};
const selectedCount = () => document.querySelectorAll(".ed-clip.ed-sel").length;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="편집 탭 단축키"]');
const row = (label: string) => [...document.querySelectorAll<HTMLElement>(".ed-sc-float .sc-row")]
  .find((item) => item.querySelector(".sc-label")?.textContent === label)!;
const slotPick = (label: string, index: number) => row(label).querySelectorAll<HTMLButtonElement>(".ed-sc-pick")[index];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  localStorage.setItem("ch.editTimeline.last:local", JSON.stringify({ projectId: "p1", seq: "e070" }));
  localStorage.setItem(DOC, JSON.stringify({ v: 1, tracksOff: [], tracksLocked: [], clips: [
    { cut: "e070/c1", gen: "g1", track: 1, kind: "video", dur: 5 }, { cut: "e070/c2", gen: "g2", track: 1, kind: "video", dur: 5 },
  ] }));
  for (const method of ["load", "pause"] as const) vi.spyOn(HTMLMediaElement.prototype, method).mockImplementation(() => {});
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(
    <EditTab authKey="auth" authReady workspace={{ scope: "team", id: "w1", name: "W" }} keysActive flash={() => {}}
      onOpenCutFolder={() => {}} reloadSignal={0} peekPath={null} onPeekMarks={() => {}} cardMenuRef={{ current: null }} onPreview={() => {}} onCompare={() => {}}
      resolve={{ send: () => {}, busy: false, pendingCount: 0 }} />,
  ));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  keepUnsavedEditDoc(DOC, null);
  clearUndo(DOC);
  act(() => resetAllEditShortcuts());
});

it("기본값 호환 — Esc 는 Shift 가 붙어도 닿고 Ctrl·Alt 가 붙으면 넘긴다 · 숫자패드·Ctrl+Shift+R·고른 것 없는 Alt+↑", () => {
  press({ key: "a", code: "KeyA", ctrlKey: true });
  expect(selectedCount()).toBe(2);
  expect(press({ key: "Escape", code: "Escape", ctrlKey: true }).defaultPrevented).toBe(false);
  expect(press({ key: "Escape", code: "Escape", altKey: true }).defaultPrevented).toBe(false);
  expect(selectedCount()).toBe(2);
  expect(press({ key: "Escape", code: "Escape", shiftKey: true }).defaultPrevented).toBe(true); // 고르기를 푼다 + 기본 동작을 막는다
  expect(selectedCount()).toBe(0);
  expect(press({ key: "Escape", code: "Escape" }).defaultPrevented).toBe(false); // 풀 것이 없다

  const width = () => parseFloat(document.querySelector<HTMLElement>(".ed-clip")!.style.width);
  const near = (value: number, want: number) => expect(Math.abs(value - want)).toBeLessThanOrEqual(1); // 클립 폭은 px 로 반올림된다
  const w0 = width();
  expect(press({ key: "-", code: "NumpadSubtract", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true); // 축소 ×0.8
  const w1 = width();
  near(w1, w0 * 0.8);
  expect(press({ key: "_", code: "Minus", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
  expect(width()).toBe(w1);
  expect(press({ key: "+", code: "Equal", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true); // 확대 ×1.25
  near(width(), w0);
  expect(press({ key: "+", code: "BracketRight", ctrlKey: true }).defaultPrevented).toBe(true); // 자판이 달라도 key '+' 면 확대(옛 onKey 와 같다)
  near(width(), w0 * 1.25);
  expect(roll({ deltaY: -30, altKey: true }).defaultPrevented).toBe(true); // Alt+휠↑ = ×1.15
  near(width(), w0 * 1.25 * 1.15);
  expect(press({ key: "R", code: "KeyR", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false); // 브라우저의 강력 새로고침
  expect(press({ key: "r", code: "KeyR", ctrlKey: true }).defaultPrevented).toBe(true); // 속도 막대(대상 없음 — 까닭만 알린다)

  press({ key: "End", code: "End" });
  const end = timecode();
  expect(press({ key: "ArrowUp", code: "ArrowUp", altKey: true }).defaultPrevented).toBe(false); // 고른 것이 없다 — 일반 ↑ 로 가지 않는다
  expect(timecode()).toBe(end);
  expect(press({ key: "Home", code: "Home", shiftKey: true }).defaultPrevented).toBe(true); // Shift 가 붙어도 처음
  expect(timecode()).toBe("00:00:00:00");
  expect(press({ key: "M", code: "KeyM", shiftKey: true }).defaultPrevented).toBe(true); // Shift 가 붙어도 북마크
  expect(document.querySelectorAll(".ed-ruler .ed-mk").length).toBe(1);
});

it("지정을 바꾸면 키·툴팁이 바로 따른다 — 빼앗긴 기본 키는 넘긴다", () => {
  press({ key: "Home", code: "Home" }); // 재생 위치는 앞 시험이 남긴 자리일 수 있다
  const play = () => document.querySelector<HTMLButtonElement>(".ed-play")!;
  expect(play().getAttribute("aria-label")).toBe("재생/정지 (Space)");
  act(() => { setSlot("end", 0, "KeyE"); setSlot("play", 0, "KeyP"); });
  expect(play().getAttribute("aria-label")).toBe("재생/정지 (P)");
  expect(press({ key: "End", code: "End" }).defaultPrevented).toBe(false);
  expect(timecode()).toBe("00:00:00:00");
  expect(press({ key: "e", code: "KeyE" }).defaultPrevented).toBe(true);
  expect(timecode()).toBe("00:00:10:00");
  // 휠도 지도를 따른다 — 좌우 넘기기를 비워도 타임라인 안의 Ctrl+휠은 막는다(브라우저 확대가 되살아나지 않게)
  act(() => { setSlot("scrollX", 0, null); });
  expect(roll({ deltaY: 40, ctrlKey: true }).defaultPrevented).toBe(true);
  expect(roll({ deltaY: 40 }).defaultPrevented).toBe(false); // 수식키 없는 휠은 브라우저 스크롤
});

it("H 단추 — 옛 －·＋ 자리 · 창이 열린 동안 편집 키는 쉬고, 칸을 누르면 다음 키를 받는다 · Esc 는 받기 취소 → 창 닫기", () => {
  expect([...document.querySelectorAll(".ed-zbtn")].map((button) => button.textContent)).toEqual(["H"]);
  press({ key: "Home", code: "Home" }); // 재생 위치는 앞 시험이 남긴 자리일 수 있다(엔진이 기억한다)
  act(() => document.querySelector<HTMLButtonElement>(".ed-hkbtn")!.click());
  expect(dialog()).not.toBeNull();
  expect(press({ key: "End", code: "End" }).defaultPrevented).toBe(false); // 편집 키가 쉰다
  expect(timecode()).toBe("00:00:00:00");

  act(() => slotPick("끝", 1).click());
  expect(slotPick("끝", 1).textContent).toBe("키를 누르세요…");
  press({ key: "Backspace", code: "Backspace" }); // 받는 중의 Backspace 는 보통 키 — '고른 클립 빼기'와 겹쳐 쓰지 않는다
  expect(document.querySelector(".ed-sc-float .sc-warn")?.textContent).toContain("고른 클립 빼기");
  press({ key: "e", code: "KeyE" });
  expect(slotsOf("end")).toEqual(["End", "KeyE"]);
  expect(slotPick("끝", 1).textContent).toBe("E");

  act(() => slotPick("확대", 0).click());
  press({ key: "Escape", code: "Escape" }); // 받기 취소 — 창은 그대로
  expect(dialog()).not.toBeNull();
  expect(slotPick("확대", 0).textContent).toBe("Ctrl/⌘ + =");
  press({ key: "Escape", code: "Escape" }); // 창 닫기
  expect(dialog()).toBeNull();
  expect(press({ key: "e", code: "KeyE" }).defaultPrevented).toBe(true);
  expect(timecode()).toBe("00:00:10:00");
});

// Codex 묶음 검토 R4(2026-10-23) — 영어 화면에서 'clear' 로 찾으면 Esc 고정 줄('Clear selection · close window')이 빠졌다: 찾는 글만 소문자로 바꿨다.
it("영어 화면의 찾기 — 대문자로 시작하는 고정 줄(Esc)과 동작 줄이 소문자 검색에 걸린다", () => {
  setLang("en");
  try {
    act(() => document.querySelector<HTMLButtonElement>(".ed-hkbtn")!.click());
    const search = document.querySelector<HTMLInputElement>('.ed-sc-float input[aria-label="Search shortcuts"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => { setValue.call(search, "clear"); search.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(document.querySelector(".ed-sc-float .ed-sc-fixed")?.textContent).toContain("Clear selection · close window");
    expect([...document.querySelectorAll(".ed-sc-float .sc-row .sc-label")].map((label) => label.textContent))
      .toEqual(expect.arrayContaining(["Clear in", "Clear out", "Clear in and out"]));
  } finally {
    setLang("ko");
  }
});

it("창 — 숫자패드 Shift 는 같은 칸 · 휠 칸 받기(판정 전에 기본 동작을 막고 같은 몸짓을 먹음) · 지정 불가 안내 · 비우기·↺", () => {
  act(() => document.querySelector<HTMLButtonElement>(".ed-hkbtn")!.click());
  act(() => slotPick("축소", 0).click());
  press({ key: "-", code: "NumpadSubtract", ctrlKey: true, shiftKey: true });
  expect(slotsOf("zoomOut")).toEqual(["mod+Minus", "alt+wheeldown"]); // Ctrl+- 칸 그대로
  expect(slotPick("축소", 0).textContent).toBe("Ctrl/⌘ + -");

  act(() => slotPick("다음 편집점", 1).click());
  press({ key: "R", code: "KeyR", ctrlKey: true, shiftKey: true });
  expect(document.querySelector(".ed-sc-float .sc-warn")?.textContent).toContain("브라우저가 가져가는 키");
  press({ key: "Tab", code: "Tab" });
  expect(document.querySelector(".ed-sc-float .sc-warn")?.textContent).toContain("앱이 고정한 키");
  expect(roll({ deltaY: -30, altKey: true }, document.body).defaultPrevented).toBe(true); // 휠을 못 받는 동작 — 먹기만
  expect(slotsOf("editNext")).toEqual(["ArrowDown", null]);
  press({ key: "Escape", code: "Escape" });

  // 좌우 넘기기 칸을 비우고, 확대의 둘째 칸에 Ctrl+휠↑ 을 받는다
  act(() => row("좌우로 넘기기").querySelector<HTMLButtonElement>(".ed-sc-x")!.click());
  expect(slotsOf("scrollX")).toEqual([null, null]);
  expect(row("좌우로 넘기기").querySelector(".ed-sc-none")?.textContent).toBe("없음");
  // 받는 휠 — 판정 전에 기본 동작을 막고 전파를 끊는다 · 칸을 정한 뒤에도 마지막 휠 뒤 300ms 동안 다음 휠이 없을 때까지 같은 몸짓을 먹는다
  let clock = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const reached = vi.fn();
  document.body.addEventListener("wheel", reached);
  act(() => slotPick("확대", 1).click());
  expect(roll({ deltaY: -30, ctrlKey: true }, document.body).defaultPrevented).toBe(true);
  expect(slotsOf("zoomIn")).toEqual(["mod+Equal", "ctrl+wheelup"]);
  clock = 1250; // 250ms 뒤 — 관성
  expect(roll({ deltaY: -30, ctrlKey: true }, document.body).defaultPrevented).toBe(true);
  clock = 1500; // 마지막(1250) 뒤 250ms — 아직 같은 몸짓(첫 휠 기준이면 풀렸을 때)
  expect(roll({ deltaY: -5, ctrlKey: true }, document.body).defaultPrevented).toBe(true);
  expect(reached).not.toHaveBeenCalled();
  clock = 1850; // 마지막(1500) 뒤 350ms — 풀렸다: 창 밖의 휠은 다시 제 갈 길
  expect(roll({ deltaY: -5 }, document.body).defaultPrevented).toBe(false);
  expect(reached).toHaveBeenCalledTimes(1);
  document.body.removeEventListener("wheel", reached);
  expect(slotsOf("zoomIn")).toEqual(["mod+Equal", "ctrl+wheelup"]);

  act(() => row("확대").querySelector<HTMLButtonElement>(".sc-reset")!.click());
  expect(slotsOf("zoomIn")).toEqual(["mod+Equal", "alt+wheelup"]);
  act(() => [...document.querySelectorAll<HTMLButtonElement>(".ed-sc-float .settings-action")].find((button) => button.textContent === "전체 기본값 복원")!.click());
  expect(slotsOf("scrollX")).toEqual(["ctrl+wheel", null]);
});
