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
  const state = { positions };
  const setManualPos = (update: Record<string, XY> | ((prev: Record<string, XY>) => Record<string, XY>)) => {
    state.positions = typeof update === "function" ? update(state.positions) : update;
  };
  const selectedRef = { current: new Set(selected) };
  const nodeIdsRef = { current: ["a", "b"] }; // 지금 보는 계보
  function Board() { useHistoryBoardShortcuts({ focusId: "a", selectedRef, nodeIdsRef, setManualPos }); return null; }
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
