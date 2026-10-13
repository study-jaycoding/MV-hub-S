// @vitest-environment jsdom
// 나갈 때 묻기(lib/unloadGuard) — 쥔 쪽이 있는 동안만 묻고, 반드시 새로고침해야 하는 길(계정 전환·로그아웃)은 풀고 새로고침한다.
import { afterEach, expect, it, vi } from "vitest";
import { holdUnload, reloadNow, unloadHeld } from "../src/lib/unloadGuard";

const leaving = () => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

afterEach(() => {
  holdUnload("a", false);
  holdUnload("b", false);
  vi.unstubAllGlobals();
});

it("쥔 쪽이 하나라도 있으면 묻고, 다 놓으면 묻지 않는다", () => {
  expect([leaving(), unloadHeld()]).toEqual([false, false]);
  holdUnload("a", true);
  holdUnload("b", true);
  holdUnload("a", true); // 같은 이름은 한 번이다
  expect([leaving(), unloadHeld()]).toEqual([true, true]);
  holdUnload("a", false);
  expect(leaving()).toBe(true);
  holdUnload("b", false);
  expect([leaving(), unloadHeld()]).toEqual([false, false]);
});

it("reloadNow 는 문지기를 풀고 새로고침한다 — 머무르기를 고를 틈을 주지 않는다", () => {
  const reload = vi.fn(() => { expect(leaving()).toBe(false); }); // 새로고침하는 순간에는 이미 풀려 있다
  vi.stubGlobal("location", { href: "http://localhost:3000/", reload });
  holdUnload("a", true);
  reloadNow();
  expect(reload).toHaveBeenCalledTimes(1);
  expect(leaving()).toBe(false);
});
