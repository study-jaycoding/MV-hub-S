// @vitest-environment jsdom
// 단축키 등록부(lib/shortcuts) — 2026-10-10 점검에서 나온 재지정 구멍.
//  · 고정 키(Enter·방향키·캔버스의 Ctrl+Z 등)는 지정할 수 없다 — 전엔 받아서 프롬프트의 Enter 에 도크가 숨었다
//  · Shift 는 Ctrl·Alt 와 함께일 때만 센다 — 전엔 Ctrl+X 로 정한 것이 Ctrl+Shift+X 에도 발동했다
//  · 충돌은 같이 켜지는 화면끼리만 — 코멘트(라이브러리)와 연결(보드)은 둘 다 c 를 쓴다(기본값). 전엔 코멘트를 c 로 되돌릴 수 없었다
//  · 다른 탭에서 바꾼 항목을 이 탭의 낡은 사본으로 덮지 않는다
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Shortcuts = typeof import("../src/lib/shortcuts");
let shortcuts: Shortcuts;
const key = (name: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  ({ key: name, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
const stored = () => JSON.parse(localStorage.getItem("ch.shortcuts") || "{}");

beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  shortcuts = await import("../src/lib/shortcuts");
});
afterEach(() => localStorage.clear());

it("Shift 는 Ctrl·Alt 와 함께일 때만 바인딩에 든다 — 글자만 바꾸는 Shift(#, R)는 그대로", () => {
  const { eventToBinding, matchShortcut, prettyBinding } = shortcuts;
  expect(eventToBinding(key("x", { ctrlKey: true }))).toBe("mod+x");
  expect(eventToBinding(key("X", { ctrlKey: true, shiftKey: true }))).toBe("mod+shift+x");
  expect(eventToBinding(key("#", { shiftKey: true }))).toBe("#");
  expect(eventToBinding(key("R", { shiftKey: true }))).toBe("r");
  expect(eventToBinding(key("Shift", { shiftKey: true }))).toBeNull();
  expect(matchShortcut(key("a", { ctrlKey: true }), "selectAll")).toBe(true);
  expect(matchShortcut(key("A", { ctrlKey: true, shiftKey: true }), "selectAll")).toBe(false);
  expect(matchShortcut(key("R", { shiftKey: true }), "colorRed")).toBe(true);
  expect(prettyBinding("mod+shift+x")).toBe("Ctrl/⌘ + Shift + X");
  expect(prettyBinding("arrowright")).toBe("→"); // 거절 안내에 "Arrowright" 로 나왔다
  expect(prettyBinding("mod+arrowup")).toBe("Ctrl/⌘ + ↑");
});

it("고정 키는 지정할 수 없다 — 격자·캔버스·브라우저가 쓰는 키와 입력기 키", () => {
  const { isReservedBinding, SHORTCUTS } = shortcuts;
  for (const fixed of ["enter", "escape", "tab", "space", "arrowleft", "delete", "backspace", "process", "f", "y", "s", "mod+z", "mod+shift+z", "mod+c", "mod+v", "mod+g", "mod+shift+c", "mod+shift+x", "mod+w", "f5", "mod+f5"]) {
    expect(isReservedBinding(fixed), fixed).toBe(true);
  }
  for (const free of ["1", "q", "mod+k", "alt+r", "mod+shift+k", "#"]) expect(isReservedBinding(free), free).toBe(false);
  for (const def of SHORTCUTS) expect(isReservedBinding(def.def), def.id).toBe(false); // 기본값은 전부 지정 가능한 키
});

it("충돌은 같이 켜지는 화면끼리만 — 코멘트와 보드 연결은 같은 c 를 쓴다", () => {
  const { conflictOf, setBinding, getBinding } = shortcuts;
  expect(conflictOf("c", "comment")).toBeNull(); // 보드의 c(연결)와는 충돌이 아니다
  expect(conflictOf("c", "boardConnect")).toBeNull();
  setBinding("comment", "x");
  expect(getBinding("comment")).toBe("x");
  expect(conflictOf("c", "comment")).toBeNull(); // 다시 c 로 돌아갈 수 있다
  expect(conflictOf("h", "comment")).toBe("showHistory"); // 같은 화면(라이브러리)끼리는 충돌
  expect(conflictOf("a", "boardConnect")).toBe("boardArrange"); // 같은 화면(보드)끼리
  expect(conflictOf("r", "comment")).toBe("colorRed"); // 어디서나 듣는 키와는 충돌
  expect(conflictOf("c", "colorRed")).not.toBeNull();
});

it("다른 탭에서 바꾼 항목을 덮지 않는다 — 저장 직전에 다시 읽고, storage 이벤트로 바로 따른다", () => {
  const { setBinding, resetBinding, getBinding } = shortcuts;
  setBinding("colorRed", "1");
  // 다른 탭이 초록을 2 로 바꿨다(이 탭의 사본은 모른다)
  localStorage.setItem("ch.shortcuts", JSON.stringify({ colorRed: "1", colorGreen: "2" }));
  setBinding("colorBlue", "3");
  expect(stored()).toEqual({ colorRed: "1", colorGreen: "2", colorBlue: "3" });
  localStorage.setItem("ch.shortcuts", JSON.stringify({ colorRed: "1", colorGreen: "2", colorBlue: "3", comment: "x" }));
  resetBinding("colorRed");
  expect(stored()).toEqual({ colorGreen: "2", colorBlue: "3", comment: "x" });
  // 다른 탭의 변경을 알리는 storage 이벤트 — 조회가 바로 새 값을 본다
  localStorage.setItem("ch.shortcuts", JSON.stringify({ colorGreen: "9" }));
  window.dispatchEvent(new StorageEvent("storage", { key: "ch.shortcuts" }));
  expect(getBinding("colorGreen")).toBe("9");
  expect(getBinding("colorBlue")).toBe("b");
});

it("저장돼 있던 고정 키·깨진 값은 읽을 때 걸러 기본값으로 돌아간다 — 막기 전에 저장한 Enter 가 계속 듣지 않게", async () => {
  localStorage.setItem("ch.shortcuts", JSON.stringify({ comment: "enter", colorRed: "1", colorGreen: 5, tag: "mod+shift+c" }));
  vi.resetModules();
  const fresh = await import("../src/lib/shortcuts");
  expect(fresh.getBinding("comment")).toBe("c");
  expect(fresh.getBinding("colorRed")).toBe("1");
  expect(fresh.getBinding("colorGreen")).toBe("g");
  expect(fresh.getBinding("tag")).toBe("#");
});
