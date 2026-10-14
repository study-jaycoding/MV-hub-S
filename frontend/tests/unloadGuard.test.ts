// @vitest-environment jsdom
// 나갈 때 묻기(lib/unloadGuard) — 쥔 쪽이 있는 동안만 묻고, 반드시 새로고침해야 하는 길(계정 전환·로그아웃)은 풀고 새로고침한다.
import { afterEach, expect, it, vi } from "vitest";
import { holdUnload, reloadIfFree, reloadNow, unloadHeld, unsavedNote, unsavedPlaces } from "../src/lib/unloadGuard";

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

it("reloadIfFree 는 쥔 쪽이 있으면 새로고침하지 않고 거짓을 준다 — 확인 창에 붙일 한 줄도 그때만 있다", () => {
  const reload = vi.fn();
  vi.stubGlobal("location", { href: "http://localhost:3000/", reload });
  holdUnload("a", true);
  expect([reloadIfFree(), reload.mock.calls.length, unsavedNote().includes("저장하지 못한 변경")]).toEqual([false, 0, true]);
  expect(leaving()).toBe(true); // 문지기는 그대로다
  holdUnload("a", false);
  expect([unsavedNote(), reloadIfFree(), reload.mock.calls.length]).toEqual(["", true, 1]);
});

// 56회차 — 편집 탭만 쥐던 문지기를 캔버스·작업표 설명·부분 수정 창도 쥔다. 안내 글은 실제로 쥔 곳을 말한다.
it("안내 글은 저장하지 못한 것을 쥔 곳의 이름을 말한다", () => {
  holdUnload("edit-docs", true);
  expect(unsavedPlaces()).toBe("편집 탭");
  holdUnload("scene-save", true);
  expect(unsavedPlaces()).toBe("편집 탭·캔버스");
  expect(unsavedNote()).toContain("편집 탭·캔버스에 저장하지 못한 변경이 있습니다");
  holdUnload("edit-docs", false);
  holdUnload("scene-save", false);
  expect(unsavedPlaces()).toBe("");
});

it("reloadNow 는 문지기를 풀고 새로고침한다 — 머무르기를 고를 틈을 주지 않는다", () => {
  const reload = vi.fn(() => { expect(leaving()).toBe(false); }); // 새로고침하는 순간에는 이미 풀려 있다
  vi.stubGlobal("location", { href: "http://localhost:3000/", reload });
  holdUnload("a", true);
  reloadNow();
  expect(reload).toHaveBeenCalledTimes(1);
  expect(leaving()).toBe(false);
});
