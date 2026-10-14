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

it("저장 공간이 꽉 차 저장하지 못하면 알린다 — 말없이 두면 새로 고침 뒤 옛 키로 돌아간다(47회차)", () => {
  const seen: string[] = [];
  const listener = (event: Event) => seen.push(String((event as CustomEvent).detail));
  window.addEventListener("ch:flash", listener);
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  try {
    shortcuts.setBinding("tag", "mod+alt+t");
    setItem.mockRestore();
    expect(seen).toEqual([expect.stringContaining("단축키를 저장하지 못했습니다")]);
    shortcuts.setBinding("tag", "mod+alt+t"); // 저장되면 알리지 않는다
    expect(seen).toHaveLength(1);
    expect(stored()).toEqual({ tag: "mod+alt+t" });
  } finally {
    setItem.mockRestore();
    window.removeEventListener("ch:flash", listener);
  }
});

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

// ── 7회차(Codex 4차 코드 리뷰의 기록분) ──
const reload = async (value: unknown) => {
  localStorage.setItem("ch.shortcuts", JSON.stringify(value));
  vi.resetModules();
  return import("../src/lib/shortcuts");
};
// 기본값과 다른 것만 — 읽은 뒤 실제로 듣는 지정
const custom = (s: Shortcuts) => Object.fromEntries(s.SHORTCUTS.filter((d) => s.getBinding(d.id) !== d.def).map((d) => [d.id, s.getBinding(d.id)]));
// 한 키에 두 동작이 걸린 항목(같이 켜지는 화면끼리)
const clashing = (s: Shortcuts) => s.SHORTCUTS.filter((d) => s.conflictOf(s.getBinding(d.id), d.id)).map((d) => d.id);

it("수식키가 붙은 입력기 키도 지정할 수 없다 — Ctrl+Process 는 글자가 아니라 입력기가 켜져 있다는 뜻이다", async () => {
  const { isReservedBinding, eventToBinding } = shortcuts;
  expect(eventToBinding(key("Process", { ctrlKey: true }))).toBe("mod+process");
  for (const ime of ["mod+process", "alt+process", "mod+shift+process", "mod+alt+shift+process", "mod+dead", "alt+shift+dead", "mod+unidentified", "process", "dead", "unidentified"]) {
    expect(isReservedBinding(ime), ime).toBe(true);
  }
  for (const free of ["mod+p", "alt+d", "mod+shift+u"]) expect(isReservedBinding(free), free).toBe(false);
  // 저장돼 있던 것도 읽을 때 걸러진다
  const fresh = await reload({ colorRed: "mod+process", colorGreen: "alt+dead", colorBlue: "1" });
  expect(custom(fresh)).toEqual({ colorBlue: "1" });
});

it("걸러져 기본값으로 돌아간 항목과 겹치는 지정은 같이 기본값으로 돌아간다 — 한 키에 두 동작이 걸리지 않게", async () => {
  // 고정 키를 막기 전: 코멘트를 Enter 로 옮기고, 비게 된 c 를 히스토리에 줬다. 지금 읽으면 코멘트가 c 로 돌아와 둘이 겹친다.
  const fresh = await reload({ comment: "enter", showHistory: "c", colorBlue: "1" });
  expect(fresh.getBinding("comment")).toBe("c");
  expect(fresh.getBinding("showHistory")).toBe("h");
  expect(clashing(fresh)).toEqual([]);
  expect(custom(fresh)).toEqual({ colorBlue: "1" }); // 안 겹치는 지정은 그대로
  expect(fresh.droppedOnLoad()).toEqual([{ id: "showHistory", binding: "c", clash: "comment" }]); // 단축키 창이 알릴 것
  // 읽는 것만으로는 저장소를 고쳐 쓰지 않는다 — 쓰는 때는 전처럼 사용자가 바꿀 때뿐이고, 그때 정리된 것이 함께 쓰인다
  expect(stored()).toEqual({ comment: "enter", showHistory: "c", colorBlue: "1" });
  fresh.setBinding("colorGreen", "2");
  expect(stored()).toEqual({ colorBlue: "1", colorGreen: "2" });
  expect(fresh.droppedOnLoad()).toEqual([]);
});

it("겹침 정리는 결정적이다 — 기본값이 지정을 이기고, 지정끼리는 목록의 위가 이기고, 같이 켜지지 않는 화면끼리는 겹침이 아니다", async () => {
  expect(clashing(shortcuts)).toEqual([]); // 전제: 기본값끼리는 안 겹친다
  // 같이 켜지지 않는 화면(보드의 a ↔ 라이브러리의 a)은 그대로 둔다
  expect(custom(await reload({ boardArrange: "enter", comment: "a" }))).toEqual({ comment: "a" });
  // 같은 화면(보드)끼리, 어디서나 듣는 키(빨강 r)와는 겹침이다
  expect(custom(await reload({ boardArrange: "enter", boardConnect: "a" }))).toEqual({});
  expect(custom(await reload({ colorRed: "enter", comment: "r" }))).toEqual({});
  // 걷힌 항목의 기본값이 또 다른 지정과 겹친다(빨강 → 초록 → 파랑) — 겹침이 없을 때까지
  const chain = await reload({ colorRed: "enter", colorGreen: "r", colorBlue: "g" });
  expect(custom(chain)).toEqual({});
  expect(clashing(chain)).toEqual([]);
  // 지정끼리 겹치면 목록에서 위의 것이 남는다
  const twins = await reload({ colorGreen: "1", colorRed: "1" });
  expect(custom(twins)).toEqual({ colorRed: "1" });
  expect(twins.droppedOnLoad()).toEqual([{ id: "colorGreen", binding: "1", clash: "colorRed" }]);
  // 다른 탭이 겹치는 값을 써도(storage 이벤트) 같은 정리를 탄다
  localStorage.setItem("ch.shortcuts", JSON.stringify({ comment: "enter", showHistory: "c" }));
  window.dispatchEvent(new StorageEvent("storage", { key: "ch.shortcuts" }));
  expect(custom(twins)).toEqual({});
  expect(twins.droppedOnLoad()).toEqual([{ id: "showHistory", binding: "c", clash: "comment" }]); // 알릴 것은 마지막으로 읽은 것만
});

it("본 키가 + 인 지정도 읽고 보이고 듣는다 — + 로 쪼개다 예외가 나 단축키 창이 무너졌다", async () => {
  const { prettyBinding, isReservedBinding, isImeBinding } = shortcuts;
  expect(prettyBinding("+")).toBe("+");
  expect(prettyBinding("mod++")).toBe("Ctrl/⌘ + +");
  expect(prettyBinding("mod+alt++")).toBe("Ctrl/⌘ + Alt + +");
  expect(prettyBinding("mod+shift+k")).toBe("Ctrl/⌘ + Shift + K"); // 수식키 접두는 전처럼
  expect(prettyBinding("mod+")).toBe("—"); // 본 키가 없는 깨진 값에도 던지지 않는다
  for (const plus of ["+", "mod++", "alt++"]) {
    expect(isReservedBinding(plus), plus).toBe(false);
    expect(isImeBinding(plus), plus).toBe(false);
  }
  // 이미 저장돼 있는 값: 그대로 읽히고 실제 키와 맞는다. 본 키가 없는 것("mod+")은 깨진 값이라 기본값으로 돌아간다
  const fresh = await reload({ colorRed: "+", colorGreen: "mod++", colorBlue: "mod+" });
  expect(custom(fresh)).toEqual({ colorRed: "+", colorGreen: "mod++" });
  expect(fresh.matchShortcut(key("+", { shiftKey: true }), "colorRed")).toBe(true); // Shift+=
  expect(fresh.matchShortcut(key("+"), "colorRed")).toBe(true); // 숫자패드 +
  expect(fresh.matchShortcut(key("+", { ctrlKey: true }), "colorGreen")).toBe(true);
  expect(fresh.matchShortcut(key("+", { ctrlKey: true }), "colorRed")).toBe(false);
  expect(fresh.conflictOf("+", "colorBlue")).toBe("colorRed");
  expect(fresh.conflictOf("mod++", "colorBlue")).toBe("colorGreen");
});

it("기호 키에서는 Shift 를 따로 세지 않는다 — 글자가 이미 Shift 를 담고 있다(1 과 ! 는 다른 키). 옛 저장값 mod+! 가 그대로 듣는다", async () => {
  const { eventToBinding, isReservedBinding, prettyBinding } = shortcuts;
  expect(eventToBinding(key("!", { ctrlKey: true, shiftKey: true }))).toBe("mod+!"); // Ctrl+Shift+1
  expect(eventToBinding(key("@", { altKey: true, shiftKey: true }))).toBe("alt+@");
  expect(eventToBinding(key("?", { ctrlKey: true, altKey: true, shiftKey: true }))).toBe("mod+alt+?");
  expect(eventToBinding(key("1", { ctrlKey: true }))).toBe("mod+1"); // Ctrl+1 과는 여전히 다른 지정
  // 숫자패드 +(Shift 없음)와 Shift+= 는 같은 글자 — 한 지정으로 합쳐진다(Shift 를 버리던 옛 동작과 같다)
  expect(eventToBinding(key("+", { ctrlKey: true }))).toBe("mod++");
  expect(eventToBinding(key("+", { ctrlKey: true, shiftKey: true }))).toBe("mod++");
  // Shift 가 글자를 바꾸지 않는 키는 전처럼 Shift 를 센다: 글자(대소문자를 접는다)·숫자·이름 있는 키
  expect(eventToBinding(key("J", { ctrlKey: true, shiftKey: true }))).toBe("mod+shift+j");
  expect(eventToBinding(key("É", { ctrlKey: true, shiftKey: true }))).toBe("mod+shift+é");
  expect(eventToBinding(key("1", { ctrlKey: true, shiftKey: true }))).toBe("mod+shift+1");
  expect(eventToBinding(key("Enter", { ctrlKey: true, shiftKey: true }))).toBe("mod+shift+enter");
  expect(eventToBinding(key("F5", { altKey: true, shiftKey: true }))).toBe("alt+shift+f5");
  expect(eventToBinding(key(" ", { ctrlKey: true, shiftKey: true }))).toBe("mod+shift+space");
  // 고정 키 목록(글자)은 이 정규화와 어긋나지 않는다
  expect(isReservedBinding(eventToBinding(key("C", { ctrlKey: true, shiftKey: true }))!)).toBe(true);
  expect(prettyBinding("mod+!")).toBe("Ctrl/⌘ + !");

  // 옛 코드(Shift 를 버리고 저장)의 값과 그 사이 dev 가 저장한 값(…shift+기호) 둘 다 같은 꼴로 읽혀 같은 키에 듣는다. 글자 키는 손대지 않는다
  const fresh = await reload({ colorRed: "mod+!", colorGreen: "alt+shift+@", colorBlue: "mod+j", comment: "mod+shift+j" });
  expect(custom(fresh)).toEqual({ colorRed: "mod+!", colorGreen: "alt+@", colorBlue: "mod+j", comment: "mod+shift+j" });
  expect(fresh.matchShortcut(key("!", { ctrlKey: true, shiftKey: true }), "colorRed")).toBe(true);
  expect(fresh.matchShortcut(key("@", { altKey: true, shiftKey: true }), "colorGreen")).toBe(true);
  expect(fresh.matchShortcut(key("j", { ctrlKey: true }), "colorBlue")).toBe(true);
  expect(fresh.matchShortcut(key("J", { ctrlKey: true, shiftKey: true }), "colorBlue")).toBe(false);
  expect(fresh.matchShortcut(key("J", { ctrlKey: true, shiftKey: true }), "comment")).toBe(true);
  // 저장소는 읽는 것만으로는 안 바뀌고, 다음 저장 때 지금의 꼴로 쓰인다
  expect(stored().colorGreen).toBe("alt+shift+@");
  fresh.setBinding("tag", "2");
  expect(stored()).toEqual({ colorRed: "mod+!", colorGreen: "alt+@", colorBlue: "mod+j", comment: "mod+shift+j", tag: "2" });
  // 두 꼴이 서로 다른 항목에 남아 있으면 같은 키다 — 겹침 정리를 탄다
  const both = await reload({ colorRed: "mod+!", colorGreen: "mod+shift+!" });
  expect(custom(both)).toEqual({ colorRed: "mod+!" });
  expect(both.droppedOnLoad()).toEqual([{ id: "colorGreen", binding: "mod+!", clash: "colorRed" }]);
});
