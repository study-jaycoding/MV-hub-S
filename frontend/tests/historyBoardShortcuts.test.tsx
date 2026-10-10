// @vitest-environment jsdom
// 계보 보드의 단축키(2026-10-10 점검).
//  · 선택 없이 a(다시 정렬) = 지금 보는 계보의 노드만 — 수동 배치 저장소는 모든 계보를 한 곳에 담아, 통째로 비우면 다른 계보에서
//    손으로 놓은 자리까지 사라졌다.
//  · d(비활성)는 길게 눌러도 한 번 — 누르고 있으면 켬·끔이 번갈아 뒤집혔다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/lib/deactivated", () => ({ toggleDisabledGen: vi.fn() }));

import { useHistoryBoardShortcuts } from "../src/components/history/useHistoryBoardShortcuts";
import { toggleDisabledGen } from "../src/lib/deactivated";
import type { XY } from "../src/lib/historyGraphLayout";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

const at = (x: number): XY => ({ x, y: 0 });
function mount(selected: string[], positions: Record<string, XY>) {
  const state = { positions, cleared: 0 };
  const setManualPos = (update: Record<string, XY> | ((prev: Record<string, XY>) => Record<string, XY>)) => {
    state.positions = typeof update === "function" ? update(state.positions) : update;
  };
  const selectedRef = { current: new Set(selected) };
  const nodeIdsRef = { current: ["a", "b"] }; // 지금 보는 계보
  const setSelected = () => { state.cleared += 1; };
  function Board() { useHistoryBoardShortcuts({ focusId: "a", selectedRef, nodeIdsRef, setManualPos, setSelected }); return null; }
  act(() => root.render(<Board />));
  return state;
}
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); });

it("선택 없이 a 는 지금 보는 계보의 노드만 자동 자리로 돌린다 — 다른 계보의 수동 배치는 남는다", () => {
  const state = mount([], { a: at(1), b: at(2), other: at(9) });
  press("a");
  expect(state.positions).toEqual({ other: at(9) });
});

it("선택이 있으면 고른 노드만 돌린다", () => {
  const state = mount(["b"], { a: at(1), b: at(2), other: at(9) });
  press("a");
  expect(state.positions).toEqual({ a: at(1), other: at(9) });
});

it("d 는 길게 눌러도 한 번만 뒤집는다", () => {
  mount(["a"], {});
  press("d");
  press("d", { repeat: true });
  press("d", { repeat: true });
  expect(toggleDisabledGen).toHaveBeenCalledTimes(1);
});

// 2026-10-11(7회차): 글자 입력 대상의 판정은 isTypingTarget 하나로. 전엔 INPUT 이면 전부 양보해 체크박스에 초점이 남으면 d·a 가
//  죽었고, select 는 양보하지 않아 글자 키가 목록 고르기와 보드에 같이 먹었다.
it("체크박스에 초점이 남아 있어도 d·a 가 먹는다 — 글 칸과 select 에서는 먹지 않는다", () => {
  const state = mount(["a"], { a: at(1), b: at(2) });
  const add = (html: string) => {
    const holder = document.createElement("div"); holder.innerHTML = html;
    const el = holder.firstElementChild as HTMLElement; document.body.append(el);
    return el;
  };
  const fire = (key: string, target: HTMLElement) =>
    act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
  const text = add('<input type="text">'); const select = add("<select><option>x</option></select>"); const check = add('<input type="checkbox">');
  try {
    fire("d", text); fire("a", text); fire("d", select); fire("a", select);
    expect(toggleDisabledGen).not.toHaveBeenCalled();
    expect(state.positions).toEqual({ a: at(1), b: at(2) });
    fire("d", check); fire("a", check);
    expect(toggleDisabledGen).toHaveBeenCalledTimes(1);
    expect(state.positions).toEqual({ b: at(2) });
  } finally {
    text.remove(); select.remove(); check.remove();
  }
});

// 2026-10-11(7회차): Esc 가 계보 선택을 풀지 않았다. 보드에 붙인 시험은 tests/round7Windows.test.tsx.
it("Esc 는 고른 것이 있을 때만 선택을 비운다 — 자리와 비활성은 건드리지 않는다", () => {
  const none = mount([], { a: at(1) });
  press("Escape");
  expect(none.cleared).toBe(0);
  const some = mount(["a"], { a: at(1) });
  press("Escape");
  expect(some.cleared).toBe(1);
  expect(some.positions).toEqual({ a: at(1) });
  expect(toggleDisabledGen).not.toHaveBeenCalled();
});
