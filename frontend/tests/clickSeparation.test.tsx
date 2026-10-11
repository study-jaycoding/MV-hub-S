// @vitest-environment jsdom
// 단일/더블클릭 가르기(lib/useClickSeparation) — 보드(캔버스·계보)는 훅 하나를 모든 카드의 S 단추가 같이 쓴다.
// 2026-10-12(조작 점검 10회차, Codex 검토): 대상을 가리지 않아, 앞 카드의 대기(220ms) 중에 누른 다른 카드의 S 가 '둘째 클릭'으로
//  버려지고 앞 카드의 확인만 뒤늦게 떴다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useClickSeparation } from "../src/lib/useClickSeparation";

let host: HTMLDivElement;
let root: Root;
let hook: ReturnType<typeof useClickSeparation>;
function Harness() { hook = useClickSeparation(220); return null; }

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(<Harness />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("같은 대상의 둘째 클릭은 무시하고(더블클릭으로 가는 길), 더블클릭이 오면 단일은 실행하지 않는다", () => {
  const single = vi.fn(); const double = vi.fn();
  hook.onClick(single, "a");
  hook.onClick(single, "a");
  hook.onDouble(double);
  vi.advanceTimersByTime(500);
  expect([single.mock.calls.length, double.mock.calls.length]).toEqual([0, 1]);
  hook.onClick(single, "a"); // 그 뒤의 한 번 클릭은 220ms 뒤에 실행된다
  vi.advanceTimersByTime(219);
  expect(single).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(single).toHaveBeenCalledTimes(1);
});

it("대기 중에 다른 대상을 누르면 그 클릭을 버리지 않는다 — 앞 대상의 예약을 거두고 새 대상의 것을 실행한다", () => {
  const forA = vi.fn(); const forB = vi.fn();
  hook.onClick(forA, "a");
  vi.advanceTimersByTime(100);
  hook.onClick(forB, "b"); // A 의 대기(220ms) 중
  vi.advanceTimersByTime(219);
  expect([forA.mock.calls.length, forB.mock.calls.length]).toEqual([0, 0]); // B 는 누른 때부터 220ms 를 다시 기다린다
  vi.advanceTimersByTime(1);
  expect([forA.mock.calls.length, forB.mock.calls.length]).toEqual([0, 1]);
});

it("대상을 주지 않으면 전과 같다 — 대기 중의 클릭은 전부 무시한다(카드마다 제 훅을 쓰는 격자)", () => {
  const first = vi.fn(); const second = vi.fn();
  hook.onClick(first);
  hook.onClick(second);
  vi.advanceTimersByTime(220);
  expect([first.mock.calls.length, second.mock.calls.length]).toEqual([1, 0]);
});
