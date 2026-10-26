// @vitest-environment jsdom
// 편집 탭 단축키 등록부(lib/editShortcuts) — 기본 동작 표·입력 정규화·찾기·예약·겹침·저장값 고치기·칸 하나 쓰기·글자.
//  설계 = docs/status/편집탭_단축키설정_설계_2026-10-23.md(Codex 4차 승인).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  droppedOnLoad, EDIT_ACTIONS, fillKeys, findKeyAction, findWheelAction, hintOf, keySlot, pairHint, reservedOf, resetAction,
  resetAllEditShortcuts, setSlot, shiftShadows, slotsOf, slotText, wheelSlots,
} from "../src/lib/editShortcuts";

const KEY = "ch.editShortcuts";
const ev = (init: Partial<{ key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }>) =>
  ({ key: "", code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init });
const wheel = (init: Partial<{ altKey: boolean; shiftKey: boolean; ctrlKey: boolean; deltaX: number; deltaY: number }>) =>
  ({ altKey: false, shiftKey: false, ctrlKey: false, deltaX: 0, deltaY: 0, ...init });
// 다른 탭이 저장값을 바꾼 것처럼 — storage 알림으로 다시 읽는다(읽을 때 고치기를 거친다)
const reload = (value: unknown) => {
  localStorage.setItem(KEY, JSON.stringify(value));
  window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
};

beforeEach(() => localStorage.clear());
afterEach(() => resetAllEditShortcuts());

describe("기본 동작 표 — 지금 onKey·휠 그대로", () => {
  it("모든 동작은 칸이 둘이고, 기본 칸끼리 겹치지 않는다", () => {
    const all = EDIT_ACTIONS.flatMap((def) => def.def.filter((slot): slot is string => slot !== null));
    expect(EDIT_ACTIONS.every((def) => def.def.length === 2)).toBe(true);
    expect(new Set(all).size).toBe(all.length);
    expect(all.filter((slot) => reservedOf(slot))).toEqual([]);
  });
  it.each([
    ["Space", "play"], ["shift+Space", "play"], ["KeyL", "shuttleFwd"], ["shift+KeyK", "stop"], ["KeyJ", "shuttleBack"],
    ["ArrowRight", "frameNext"], ["shift+ArrowRight", "secNext"], ["ArrowUp", "editPrev"], ["shift+ArrowUp", "markerPrev"],
    ["Home", "home"], ["shift+Home", "home"], ["alt+Slash", "rangeLoop"], ["alt+shift+Slash", "rangeLoop"], ["KeyW", "linked"],
    ["mod+KeyZ", "undo"], ["mod+shift+KeyZ", "redo"], ["mod+KeyA", "selectAll"], ["mod+shift+KeyA", "selectAll"],
    ["Delete", "remove"], ["shift+Backspace", "remove"], ["KeyD", "toggleOff"], ["alt+ArrowUp", "clipsUp"], ["alt+shift+ArrowDown", "clipsDown"],
    ["mod+KeyR", "retime"], ["KeyI", "markIn"], ["shift+KeyI", "goIn"], ["alt+KeyI", "clearIn"], ["alt+shift+KeyX", "clearBoth"],
    ["KeyM", "bookmark"], ["shift+KeyM", "bookmark"], ["alt+KeyM", "bookmarkRemove"], ["mod+Equal", "zoomIn"], ["mod+shift+Equal", "zoomIn"],
    ["mod+Minus", "zoomOut"], ["shift+KeyZ", "fit"],
  ])("%s → %s", (slot, id) => expect(findKeyAction(slot)).toBe(id));
  it.each(["KeyZ", "shift+KeyX", "mod+shift+Minus", "mod+ArrowLeft", "alt+KeyL", "mod+Space"])("%s → 없음(넘김)", (slot) => {
    expect(findKeyAction(slot)).toBeNull();
  });
  it("휠 — 우선순위 Alt → Shift → Ctrl · Ctrl 은 ctrlKey 만 · 방향은 deltaY || deltaX", () => {
    expect(findWheelAction(wheel({ altKey: true, deltaY: -10 }))).toBe("zoomIn");
    expect(findWheelAction(wheel({ altKey: true, ctrlKey: true, deltaY: 10 }))).toBe("zoomOut");
    expect(findWheelAction(wheel({ shiftKey: true, deltaX: -10 }))).toBe("laneUp"); // 크롬은 Shift+휠을 deltaX 로 준다
    expect(findWheelAction(wheel({ shiftKey: true, ctrlKey: true, deltaY: 10 }))).toBe("laneDown");
    expect(findWheelAction(wheel({ ctrlKey: true, deltaY: 30 }))).toBe("scrollX");
    expect(wheelSlots(wheel({ deltaY: 10 }))).toBeNull(); // 수식키 없는 휠은 브라우저 것
    expect(wheelSlots(wheel({ altKey: true }))).toBeNull();
  });
});

// 옛 EditTab.onKey(HEAD 1504c892) 의 if/else 사슬을 그대로 옮긴 기준 — 동작 이름(먹음)만 돌려준다. 입구(입력칸·위에 뜬 창·defaultPrevented·
//  Ctrl+A 예외)와 Space 의 Tab 초점 양보는 화면 시험(editTabCuts·editShortcutsUi)이 본다. 새 처리는 EditTab.onKey 와 같은 순서로 등록부를 부른다.
describe("기본값 호환 표 — 옛 onKey 와 키마다 같은 동작·같은 먹음/넘김", () => {
  type State = { picked: boolean; cut: boolean; retime: boolean };
  type Ev = ReturnType<typeof ev>;
  function legacy(e: Ev, s: State): string | null {
    const { code, key } = e;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.altKey) return null;
    if (mod && code === "KeyZ") return e.shiftKey ? "redo" : "undo";
    if (mod && code === "KeyA") return "selectAll";
    if (mod && !e.shiftKey && code === "KeyR") return "retime";
    if (mod && (key === "=" || key === "+")) return "zoomIn";
    if (mod && key === "-") return "zoomOut";
    if (mod) return null;
    if (e.altKey && key === "ArrowUp" && s.picked) return "clipsUp";
    if (e.altKey && key === "ArrowDown" && s.picked) return "clipsDown";
    if (e.altKey && code === "KeyI") return "clearIn";
    if (e.altKey && code === "KeyO") return "clearOut";
    if (e.altKey && code === "KeyX") return "clearBoth";
    if (e.altKey && code === "KeyM") return "bookmarkRemove";
    if (e.altKey && code === "Slash") return "rangeLoop";
    if (e.altKey) return null;
    if (e.shiftKey && code === "KeyZ") return "fit";
    if (e.shiftKey && code === "KeyI") return "goIn";
    if (e.shiftKey && code === "KeyO") return "goOut";
    if (e.shiftKey && key === "ArrowUp") return "markerPrev";
    if (e.shiftKey && key === "ArrowDown") return "markerNext";
    if (code === "Space") return "play";
    if (code === "KeyL") return "shuttleFwd";
    if (code === "KeyJ") return "shuttleBack";
    if (code === "KeyK") return "stop";
    if (key === "ArrowLeft") return e.shiftKey ? "secPrev" : "framePrev";
    if (key === "ArrowRight") return e.shiftKey ? "secNext" : "frameNext";
    if (key === "ArrowUp") return "editPrev";
    if (key === "ArrowDown") return "editNext";
    if (key === "Home") return "home";
    if (key === "End") return "end";
    if ((key === "Delete" || key === "Backspace") && s.picked) return "remove";
    if (code === "KeyD" && (s.picked || s.cut)) return "toggleOff";
    if (code === "KeyI") return "markIn";
    if (code === "KeyO") return "markOut";
    if (code === "KeyM") return "bookmark";
    if (code === "KeyW") return "linked";
    if (key === "Escape" && (s.retime || s.picked)) return "escape";
    return null;
  }
  const OWNS: Partial<Record<string, (s: State) => boolean>> = {
    remove: (s) => s.picked, clipsUp: (s) => s.picked, clipsDown: (s) => s.picked, toggleOff: (s) => s.picked || s.cut,
  };
  function current(e: Ev, s: State): string | null {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.altKey) return null;
    if (e.key === "Escape") return mod || e.altKey || !(s.retime || s.picked) ? null : "escape";
    const input = keySlot(e);
    if (!input || reservedOf(input)) return null;
    const id = findKeyAction(input);
    return id && (OWNS[id]?.(s) ?? true) ? id : null;
  }
  // [code, key, Shift 를 누른 key] — 글자·기호·숫자패드·이름 있는 키·자판이 다른 기호(독일식 '+' = BracketRight, '-' = Slash)·입력기 글자
  const KEYS: [string, string, string][] = [
    ...["A", "D", "I", "J", "K", "L", "M", "O", "Q", "R", "W", "X", "Z"].map((c): [string, string, string] => [`Key${c}`, c.toLowerCase(), c]),
    ["Space", " ", " "], ["Slash", "/", "?"], ["Equal", "=", "+"], ["Minus", "-", "_"], ["Digit1", "1", "!"],
    ["NumpadAdd", "+", "+"], ["NumpadSubtract", "-", "-"], ["BracketRight", "+", "*"], ["Slash", "-", "_"], ["KeyI", "ㅑ", "ㅑ"], ["Home", "ㅗ", "ㅗ"],
    ["Minus", "ß", "?"], ["Equal", "´", "`"], ["Digit0", "0", "="], // 물리 Minus·Equal 에서 다른 글자 · '=' 가 Shift+0 인 자판(독일식)
    ...["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Delete", "Backspace", "Escape", "Tab", "Enter", "F5"]
      .map((name): [string, string, string] => [name, name, name]),
  ];
  const MODS = [false, true].flatMap((ctrlKey) => [false, true].flatMap((altKey) => [false, true].map((shiftKey) => ({ ctrlKey, altKey, shiftKey }))));
  const STATES = [false, true].flatMap((picked) => [false, true].flatMap((cut) => [false, true].map((retime) => ({ picked, cut, retime }))));
  it("Ctrl·⌘·Alt·Shift 조합 × 고른 것·지금 컷·속도 막대 상태 — 차이 0", () => {
    const diffs: string[] = [];
    let count = 0;
    for (const [code, key, shifted] of KEYS) {
      for (const mods of [...MODS, ...MODS.filter((m) => !m.ctrlKey).map((m) => ({ ...m, metaKey: true }))]) {
        const event = ev({ code, key: mods.shiftKey ? shifted : key, ...mods });
        for (const state of STATES) {
          count++;
          const [was, now] = [legacy(event, state), current(event, state)];
          if (was !== now) diffs.push(`${JSON.stringify(event)} ${JSON.stringify(state)}: 옛 ${was} · 새 ${now}`);
        }
      }
    }
    expect(count).toBe(KEYS.length * 12 * 8); // 39 키 × 수식키 12 조합 × 상태 8 = 3,744
    expect(diffs).toEqual([]);
  });
});

describe("입력 정규화(받기·찾기·겹침이 같이 쓴다)", () => {
  it("글자는 물리 키(code), 이름 있는 키는 key — code 가 Home 이어도 key 가 다르면 그 키가 아니다", () => {
    expect(keySlot(ev({ key: "ㅑ", code: "KeyI" }))).toBe("KeyI"); // 한글 상태도 같은 자리
    expect(keySlot(ev({ key: "ㅗ", code: "Home" }))).toBeNull();
    expect(keySlot(ev({ key: "ArrowLeft", code: "Numpad4" }))).toBe("ArrowLeft"); // NumLock 꺼진 숫자패드
    expect(keySlot(ev({ key: " ", code: "Space", shiftKey: true }))).toBe("shift+Space");
    expect(keySlot(ev({ key: "Control", code: "ControlLeft", ctrlKey: true }))).toBeNull();
    expect(keySlot(ev({ key: "z", code: "KeyZ", metaKey: true, shiftKey: true }))).toBe("mod+shift+KeyZ");
  });
  it("숫자패드 +·- 는 Shift 를 뗀다 — Ctrl+Shift+숫자패드 - = 축소, 일반 자판 Ctrl+Shift+-(_) 는 넘김", () => {
    expect(keySlot(ev({ key: "-", code: "NumpadSubtract", ctrlKey: true, shiftKey: true }))).toBe("mod+Minus");
    expect(findKeyAction("mod+Minus")).toBe("zoomOut");
    // Ctrl/⌘ 와 함께인 물리 Minus·Equal 자리는 실제 글자가 '='·'+'·'-' 일 때만 그 키다 — '_'·'ß' 는 칸이 아니다(옛 onKey 처럼 넘김)
    expect(keySlot(ev({ key: "_", code: "Minus", ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(keySlot(ev({ key: "ß", code: "Minus", ctrlKey: true }))).toBeNull();
    expect(keySlot(ev({ key: "=", code: "Digit0", ctrlKey: true, shiftKey: true }))).toBe("mod+Equal"); // '=' 가 Shift+0 인 자판
    expect(findKeyAction("mod+shift+Minus")).toBeNull();
    expect(keySlot(ev({ key: "+", code: "NumpadAdd", ctrlKey: true }))).toBe("mod+Equal");
  });
  it("예약 — 앱이 고정(Esc·Tab·Enter·Ctrl/⌘+Alt)과 브라우저가 가져감을 나눈다 · Ctrl+R 은 허용", () => {
    expect(["Escape", "shift+Escape", "Tab", "shift+Tab", "Enter", "mod+alt+KeyA"].map(reservedOf)).toEqual(["app", "app", "app", "app", "app", "app"]);
    expect(["mod+shift+KeyR", "mod+KeyW", "mod+Tab", "mod+Digit3", "alt+ArrowLeft", "F5", "shift+F12"].map(reservedOf))
      .toEqual(["browser", "browser", "browser", "browser", "browser", "browser", "browser"]);
    expect(reservedOf("mod+KeyR")).toBeNull();
  });
});

describe("바꾸기 — 칸 하나만 · 다시 읽고 · 겹치면 거절", () => {
  it("한 칸만 바꾸고 다른 칸은 그대로 · 기본값과 같아지면 저장값에서 빠진다", () => {
    expect(setSlot("zoomIn", 1, "alt+KeyQ")).toEqual({ ok: true });
    expect(slotsOf("zoomIn")).toEqual(["mod+Equal", "alt+KeyQ"]);
    expect(findKeyAction("alt+KeyQ")).toBe("zoomIn");
    expect(findWheelAction(wheel({ altKey: true, deltaY: -1 }))).toBeNull(); // Alt+휠↑ 는 이제 아무것도 아니다
    expect(setSlot("zoomIn", 1, "alt+wheelup")).toEqual({ ok: true });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({});
  });
  it("다른 탭이 바꾼 다른 동작·칸을 덮지 않는다", () => {
    localStorage.setItem(KEY, JSON.stringify({ end: ["KeyE", null] })); // 다른 탭이 쓴 것(이 탭은 아직 모른다)
    expect(setSlot("home", 1, "KeyH")).toEqual({ ok: true });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ end: ["KeyE", null], home: ["Home", "KeyH"] });
  });
  it("겹침·예약·입력 종류·같은 칸은 쓰지 않는다", () => {
    expect(setSlot("markIn", 0, "KeyO")).toEqual({ ok: false, reason: "conflict", clash: "markOut" });
    expect(setSlot("markIn", 0, "mod+shift+KeyR")).toMatchObject({ ok: false, reason: "reserved", reserved: "browser" });
    expect(setSlot("markIn", 0, "Enter")).toMatchObject({ ok: false, reason: "reserved", reserved: "app" });
    expect(setSlot("scrollX", 1, "KeyP")).toMatchObject({ ok: false, reason: "input" }); // 좌우 넘기기는 휠 칸만
    expect(setSlot("play", 1, "alt+wheelup")).toMatchObject({ ok: false, reason: "input" }); // 재생은 휠을 받지 않는다
    expect(setSlot("remove", 1, "Delete")).toMatchObject({ ok: false, reason: "same" });
    expect(setSlot("zoomIn", 1, "ctrl+wheelup")).toMatchObject({ ok: false, reason: "conflict", clash: "scrollX" }); // 방향 없는 Ctrl+휠과 겹친다
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(setSlot("laneUp", 1, "KeyP")).toEqual({ ok: true }); // 트랙 높이는 키도 받는다
  });
  it("↺ 는 그 동작의 기본값이 다른 동작에 쓰이고 있으면 거절한다 · 전체 복원은 비운다", () => {
    expect(setSlot("shuttleFwd", 0, "KeyP")).toEqual({ ok: true });
    expect(setSlot("stop", 1, "KeyL")).toEqual({ ok: true });
    expect(resetAction("shuttleFwd")).toEqual({ ok: false, reason: "conflict", clash: "stop" });
    resetAllEditShortcuts();
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({});
    expect(findKeyAction("KeyL")).toBe("shuttleFwd");
  });
  it("Shift same 동작의 빈 Shift 를 다른 동작이 쓰면 그쪽이 먼저 받는다(겹침이 아니라 우선순위)", () => {
    expect(setSlot("goOut", 1, "shift+KeyM")).toEqual({ ok: true });
    expect(findKeyAction("shift+KeyM")).toBe("goOut");
    expect(findKeyAction("KeyM")).toBe("bookmark");
    expect(shiftShadows()).toEqual([{ slot: "shift+KeyM", winner: "goOut", shadowed: "bookmark" }]);
  });
});

describe("읽을 때 고치기", () => {
  it("모르는 동작은 버리고, 형식·예약·입력 종류·안 중복이 틀린 동작은 기본값으로 — 사유를 남긴다", () => {
    reload({
      nope: ["KeyQ", null], play: "Space", stop: ["KeyK", "Bogus"], home: ["mod+shift+KeyR", null], scrollX: ["KeyP", null],
      end: ["KeyE", "KeyE"], fit: ["shift+KeyF", null],
    });
    expect(droppedOnLoad().map((item) => [item.id, item.reason])).toEqual([
      ["play", "format"], ["stop", "format"], ["home", "reserved"], ["scrollX", "input"], ["end", "format"],
    ]);
    expect(slotsOf("play")).toEqual(["Space", null]);
    expect(slotsOf("fit")).toEqual(["shift+KeyF", null]);
  });
  it("글자가 섞인 저장값(끝의 줄바꿈·순서가 틀린 수식키)은 형식 틀림 — 그 동작은 기본값으로 돌아가 키를 잃지 않는다", () => {
    reload({ play: ["Space\n", null], stop: ["shift+mod+KeyK", null], home: [" Home", null] });
    expect(droppedOnLoad().map((item) => [item.id, item.reason])).toEqual([["play", "format"], ["stop", "format"], ["home", "format"]]);
    expect([findKeyAction("Space"), findKeyAction("KeyK"), findKeyAction("Home")]).toEqual(["play", "stop", "home"]);
  });
  it("저장에 실패하면 이 창에도 적용하지 않는다(다음 변경이 앞의 임시 변경을 지우지 않게)", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
    try {
      expect(setSlot("end", 0, "KeyE")).toEqual({ ok: false, reason: "storage" });
      expect(slotsOf("end")).toEqual(["End", null]);
      expect(findKeyAction("KeyE")).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
  it("겹침은 칸 단위 '기본 먼저', 사용자 칸끼리는 표 순서가 앞인 동작이 남는다 — 겹침이 없을 때까지", () => {
    // markIn 이 L(shuttleFwd 의 기본 칸)을 쓰고, markOut·bookmark 가 같은 Q 를 쓴다
    reload({ markIn: ["KeyL", null], markOut: ["KeyQ", null], bookmark: ["KeyQ", null] });
    expect(droppedOnLoad()).toEqual([{ id: "markIn", reason: "conflict", clash: "shuttleFwd" }, { id: "bookmark", reason: "conflict", clash: "markOut" }]);
    expect([findKeyAction("KeyL"), findKeyAction("KeyQ"), findKeyAction("KeyI"), findKeyAction("KeyM")]).toEqual(["shuttleFwd", "markOut", "markIn", "bookmark"]);
  });
});

describe("보이는 글자 — 기본값이면 지금 툴팁과 같다", () => {
  it("툴팁 꼴·창 꼴", () => {
    expect(["zoomIn", "zoomOut", "fit", "clearBoth", "rangeLoop", "play", "shuttleBack", "stop", "home", "end", "retime", "undo", "bookmarkRemove", "toggleOff", "markIn"]
      .map((id) => hintOf(id as Parameters<typeof hintOf>[0])))
      .toEqual(["Ctrl+=", "Ctrl+-", "Shift+Z", "Alt+X", "Alt+/", "Space", "J", "K", "Home", "End", "Ctrl+R", "Ctrl+Z", "Alt+M", "D", "I"]);
    expect(pairHint("markerPrev", "markerNext")).toBe("Shift+↑↓");
    expect(hintOf("laneUp")).toBe("Shift+휠↑");
    expect(slotText("mod+shift+KeyZ", true)).toBe("Ctrl/⌘ + Shift + Z");
    expect(slotText("ctrl+wheel", true)).toBe("Ctrl + 휠");
  });
  it("{key} 자리 채우기 — 키가 없으면 괄호째 빼고, 괄호 앞 공백은 그대로", () => {
    expect(fillKeys("마크 인 ({key})", { key: "I" })).toBe("마크 인 (I)");
    expect(fillKeys("마크 인 ({key})", { key: "" })).toBe("마크 인");
    expect(fillKeys("되돌리기({key}) 한 번", { key: "Ctrl+Z" })).toBe("되돌리기(Ctrl+Z) 한 번");
    expect(fillKeys("재생·{jkl}·프레임", { jkl: "J/K/L" })).toBe("재생·J/K/L·프레임");
    expect(setSlot("markIn", 0, null)).toEqual({ ok: true });
    expect(hintOf("markIn")).toBe("");
  });
});
