// @vitest-environment jsdom
// 캔버스의 Ctrl+A — 캔버스가 안 받으면 브라우저가 화면 글자를 통째로 선택한다(씬 탭·검색칸·상태줄이 파랗게 반전, 2026-09-20 실측).
// 계약: 전체 선택을 부르고 기본 동작을 막는다 · 결과 팝업·노드 선택기가 떠 있으면 선택은 그대로 두되 기본 동작은 막는다 · 입력칸에서는 손대지 않는다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSceneKeyboardShortcuts } from "../src/lib/useSceneKeyboardShortcuts";

type Actions = Parameters<typeof useSceneKeyboardShortcuts>[0];
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

function mount(state: { popup?: boolean; picker?: boolean }) {
  const onSelectAll = vi.fn();
  // 이 시험이 보는 것은 세 상태 판정과 onSelectAll 뿐 — 나머지 액션은 불리면 안 되므로 부르면 실패하는 가짜로 채운다.
  const actions = new Proxy(
    { isTextEditing: () => false, isPopupOpen: () => !!state.popup, isPickerOpen: () => !!state.picker, selectionCount: () => 0, onSelectAll },
    { get: (target, name) => (name in target ? target[name as keyof typeof target] : () => { throw new Error(`unexpected action: ${String(name)}`); }) },
  ) as unknown as Actions;
  function Harness() { useSceneKeyboardShortcuts(actions); return <input className="probe-input" />; }
  act(() => root.render(<Harness />));
  return onSelectAll;
}
function pressCtrlA(target: EventTarget = document.body) {
  const event = new KeyboardEvent("keydown", { key: "a", code: "KeyA", ctrlKey: true, bubbles: true, cancelable: true });
  act(() => { target.dispatchEvent(event); });
  return event.defaultPrevented;
}

it("캔버스에서 Ctrl+A 는 전체 선택을 부르고 브라우저의 글자 전체 선택을 막는다", () => {
  const onSelectAll = mount({});
  expect(pressCtrlA()).toBe(true);
  expect(onSelectAll).toHaveBeenCalledTimes(1);
});

it("결과 팝업이나 노드 선택기가 떠 있으면 선택은 그대로 두고 글자 전체 선택만 막는다", () => {
  for (const state of [{ popup: true }, { picker: true }]) {
    const onSelectAll = mount(state);
    expect(pressCtrlA()).toBe(true);
    expect(onSelectAll).not.toHaveBeenCalled();
  }
});

it("입력칸에서는 손대지 않는다 — 입력한 글자의 전체 선택은 브라우저 몫", () => {
  const onSelectAll = mount({});
  expect(pressCtrlA(host.querySelector(".probe-input")!)).toBe(false);
  expect(onSelectAll).not.toHaveBeenCalled();
});
