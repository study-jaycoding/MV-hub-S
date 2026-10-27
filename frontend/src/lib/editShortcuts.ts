// 편집 탭 단축키 — 동작 목록(기본 동작 표) + 개인 지정(localStorage 'ch.editShortcuts') + 키·휠 → 동작 찾기.
// 규칙의 정본은 docs/status/편집탭_단축키설정_설계_2026-10-23.md(Codex 4차 승인). 공용 lib/shortcuts.ts(라이브러리·보드)와 따로다 —
//  편집 키는 물리 키(code)·한 동작에 칸 둘·휠·키마다 다른 Shift 뜻이라 규칙이 다르다(Codex 1차).
import { useSyncExternalStore } from "react";
import { APP_EVENTS, dispatchAppEvent } from "./appEvents";
import { flashMsg } from "./flash";
import { t } from "./i18n";
import { loadJSON, trySaveJSON } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";

export type EditGroup = "play" | "edit" | "mark" | "view";
export const EDIT_GROUPS: Record<EditGroup, string> = { play: "재생", edit: "편집", mark: "마크·북마크", view: "보기" };

export type EditActionId =
  | "play" | "shuttleFwd" | "stop" | "shuttleBack" | "frameNext" | "framePrev" | "secNext" | "secPrev" | "editNext" | "editPrev"
  | "home" | "end" | "rangeLoop" | "linked"
  | "undo" | "redo" | "selectAll" | "remove" | "toggleOff" | "clipsUp" | "clipsDown" | "retime"
  | "markIn" | "markOut" | "clearIn" | "clearOut" | "clearBoth" | "goIn" | "goOut" | "bookmark" | "bookmarkRemove" | "markerPrev" | "markerNext"
  | "zoomIn" | "zoomOut" | "fit" | "laneUp" | "laneDown" | "scrollX";

// 칸 = 키 하나("mod+shift+KeyZ") 또는 휠 하나("alt+wheelup") 또는 빈 칸(null). 한 동작에 늘 두 칸이다(칸 번호가 흔들리지 않게).
export type Slot = string | null;
export type Slots = readonly [Slot, Slot];
export interface EditActionDef {
  id: EditActionId;
  group: EditGroup;
  label: string;
  def: Slots;
  shift: "same" | "exact"; // same = Shift 가 붙어도 같은 동작(정확한 칸이 없을 때만)
  once?: true; // 길게 눌러 반복된 keydown 은 실행하지 않는다(키는 먹는다)
  input: "key" | "wheel" | "both";
}

const key = (id: EditActionId, group: EditGroup, label: string, a: Slot, shift: "same" | "exact", once?: true, b: Slot = null): EditActionDef =>
  ({ id, group, label, def: [a, b], shift, once, input: "key" });

// 기본 동작 표 — 지금(2026-10-23) EditTab.onKey · EditTimeline 휠을 그대로 옮긴 것. 순서 = 창의 순서이자 읽을 때 겹침을 고치는 우선순위.
export const EDIT_ACTIONS: readonly EditActionDef[] = [
  key("play", "play", "재생 / 정지", "Space", "same", true),
  key("shuttleFwd", "play", "앞으로 재생(누를수록 빠르게)", "KeyL", "same", true),
  key("stop", "play", "정지", "KeyK", "same"),
  key("shuttleBack", "play", "뒤로 재생", "KeyJ", "same", true),
  key("frameNext", "play", "한 프레임 앞", "ArrowRight", "exact"),
  key("framePrev", "play", "한 프레임 뒤", "ArrowLeft", "exact"),
  key("secNext", "play", "1초 앞", "shift+ArrowRight", "exact"),
  key("secPrev", "play", "1초 뒤", "shift+ArrowLeft", "exact"),
  key("editNext", "play", "다음 편집점", "ArrowDown", "exact"),
  key("editPrev", "play", "앞 편집점", "ArrowUp", "exact"),
  key("home", "play", "처음", "Home", "same"),
  key("end", "play", "끝", "End", "same"),
  key("rangeLoop", "play", "구간 반복 켜기/끄기", "alt+Slash", "same", true),
  key("linked", "play", "다이나믹 재생 모드", "KeyW", "same", true),
  key("undo", "edit", "되돌리기", "mod+KeyZ", "exact"),
  key("redo", "edit", "다시 하기", "mod+shift+KeyZ", "exact"),
  key("selectAll", "edit", "클립 모두 고르기", "mod+KeyA", "same"),
  key("remove", "edit", "고른 클립 빼기", "Delete", "same", undefined, "Backspace"),
  key("toggleOff", "edit", "클립·컷 켜기/끄기", "KeyD", "same", true),
  key("clipsUp", "edit", "고른 클립 위 트랙으로", "alt+ArrowUp", "same"),
  key("clipsDown", "edit", "고른 클립 아래 트랙으로", "alt+ArrowDown", "same"),
  key("retime", "edit", "속도 막대", "mod+KeyR", "exact", true),
  key("markIn", "mark", "마크 인", "KeyI", "exact", true),
  key("markOut", "mark", "마크 아웃", "KeyO", "exact", true),
  key("clearIn", "mark", "인 지우기", "alt+KeyI", "same"),
  key("clearOut", "mark", "아웃 지우기", "alt+KeyO", "same"),
  key("clearBoth", "mark", "인·아웃 둘 다 지우기", "alt+KeyX", "same"),
  key("goIn", "mark", "인 자리로", "shift+KeyI", "exact"),
  key("goOut", "mark", "아웃 자리로", "shift+KeyO", "exact"),
  key("bookmark", "mark", "북마크", "KeyM", "same", true),
  key("bookmarkRemove", "mark", "북마크 지우기", "alt+KeyM", "same", true),
  key("markerPrev", "mark", "앞 북마크로", "shift+ArrowUp", "exact"),
  key("markerNext", "mark", "뒤 북마크로", "shift+ArrowDown", "exact"),
  { ...key("zoomIn", "view", "확대", "mod+Equal", "same", undefined, "alt+wheelup"), input: "both" },
  { ...key("zoomOut", "view", "축소", "mod+Minus", "exact", undefined, "alt+wheeldown"), input: "both" },
  key("fit", "view", "Fit", "shift+KeyZ", "exact"), // 타임라인을 창 폭에 맞춘다(Jay 2026-10-23 — '전체 보기'에서 이름만)
  { ...key("laneUp", "view", "트랙 높이 키우기", "shift+wheelup", "exact"), input: "both" },
  { ...key("laneDown", "view", "트랙 높이 줄이기", "shift+wheeldown", "exact"), input: "both" },
  { ...key("scrollX", "view", "좌우로 넘기기", "ctrl+wheel", "exact"), input: "wheel" }, // 방향·크기를 휠이 준다 — 키는 받지 않는다
];
const BY_ID = new Map(EDIT_ACTIONS.map((def) => [def.id, def]));
export const actionDef = (id: EditActionId): EditActionDef => BY_ID.get(id)!;

// ── 칸의 글자 ─────────────────────────────────────────────────────────────────────────────────────
// 키 = (mod+)(alt+)(shift+)이름. 이름 = 글자·숫자·기호·Space 는 물리 키(code — 한/영 상태와 무관, 지금 onKey 와 같다), 이름 있는 키는 key.
//  예외 하나: Ctrl/⌘ 와 함께인 '='·'+'·'-' 는 key 로 본다(Equal·Minus, Shift 를 뗀다) — 옛 onKey 가 key 로 확대·축소를 봐서 자판 배열(독일식 '+' 등)·
//  숫자패드와 무관했다(Codex 독립 리뷰 1차).
const NAMED = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Delete", "Backspace", "PageUp", "PageDown", "Insert", "Enter", "Escape", "Tab"]);
const CODE_NAME = /^(Key[A-Z]|Digit\d|Numpad(\d|Multiply|Divide|Decimal)|Space|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote|IntlBackslash|IntlRo|IntlYen)$/;
const MODIFIER_KEYS = new Set(["Control", "Meta", "Shift", "Alt", "AltGraph", "OS", "CapsLock", "Fn", "Hyper", "Super"]);
const KEY_SLOT = /^(mod\+)?(alt\+)?(shift\+)?(.+)$/;
const WHEEL_SLOT = /^(alt|shift|ctrl)\+(wheelup|wheeldown|wheel)$/;
export const isWheelSlot = (slot: string) => WHEEL_SLOT.test(slot);
const keyName = (slot: string) => KEY_SLOT.exec(slot)?.[4] ?? "";
const validName = (name: string) => NAMED.has(name) || CODE_NAME.test(name) || /^F\d{1,2}$/.test(name);
export const validSlot = (slot: string) => isWheelSlot(slot) || validName(keyName(slot));

type KeyLike = { key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean };
// 실제 키 입력 → 칸 글자. 받기·찾기·겹침이 모두 이 함수 하나를 쓴다. 수식키만 누른 것은 null.
//  숫자패드 +·- 는 Shift 로 글자가 안 바뀐다 — 지금 코드(key 비교)처럼 Equal·Minus 로 보고 Shift 를 뗀다(Ctrl+Shift+숫자패드 - = 축소).
export function keySlot(e: KeyLike): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  let name: string;
  let shift = e.shiftKey;
  const mod = e.ctrlKey || e.metaKey;
  if (NAMED.has(e.key) || /^F\d{1,2}$/.test(e.key)) name = e.key;
  else if (mod && (e.key === "=" || e.key === "+" || e.key === "-")) { name = e.key === "-" ? "Minus" : "Equal"; shift = false; }
  else if (mod && (e.code === "Equal" || e.code === "Minus")) return null; // 그 자리에서 다른 글자가 나는 자판(독일식 'ß' 등) — 옛 onKey 도 넘겼다
  else if (e.code === "NumpadAdd") { name = "Equal"; shift = false; }
  else if (e.code === "NumpadSubtract") { name = "Minus"; shift = false; }
  else if (CODE_NAME.test(e.code)) name = e.code; // 이름 있는 키는 key 로만 — code 가 Home 이어도 key 가 다르면(입력기 글자 등) 그 키가 아니다
  else return null;
  return (mod ? "mod+" : "") + (e.altKey ? "alt+" : "") + (shift ? "shift+" : "") + name;
}

type WheelLike = { altKey: boolean; shiftKey: boolean; ctrlKey: boolean; deltaX: number; deltaY: number };
// 휠 → [방향 있는 칸, 방향 없는 칸]. 수식키는 지금 우선순위 Alt → Shift → Ctrl 중 눌린 가장 높은 하나(Ctrl 은 ctrlKey 만 — ⌘ 아님). 0 이면 null.
export function wheelSlots(e: WheelLike): [string, string] | null {
  const delta = e.deltaY || e.deltaX;
  const mod = e.altKey ? "alt" : e.shiftKey ? "shift" : e.ctrlKey ? "ctrl" : null;
  if (!delta || !mod) return null;
  return [`${mod}+wheel${delta < 0 ? "up" : "down"}`, `${mod}+wheel`];
}

// 지정할 수 없는 입력 — app = 앱이 고정한 키, browser = 브라우저·OS 가 가져가는 키. 찾기 전에 넘긴다(Shift same 대체로도 닿지 않게).
//  Ctrl+R(Shift 없음)은 허용 — 속도 막대 기본값이고 기본 동작을 막는다.
const BROWSER = new Set([
  "mod+KeyW", "mod+KeyT", "mod+KeyN", "mod+KeyL", "mod+shift+KeyT", "mod+shift+KeyN", "mod+shift+KeyR", "mod+Tab", "mod+shift+Tab",
  "alt+ArrowLeft", "alt+ArrowRight", ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `mod+Digit${n}`),
]);
export function reservedOf(slot: string): "app" | "browser" | null {
  if (isWheelSlot(slot)) return null;
  const name = keyName(slot);
  if (name === "Escape" || name === "Enter") return "app";
  if (name === "Tab") return slot.startsWith("mod+") ? "browser" : "app";
  if (/^F\d{1,2}$/.test(name)) return "browser";
  if (slot.startsWith("mod+alt+")) return "app"; // Ctrl/⌘+Alt 동시(AltGr 자판)
  return BROWSER.has(slot) ? "browser" : null;
}

// 두 칸이 같은 실제 입력에 걸리는가 — 같은 글자, 또는 같은 수식키의 방향 없는 휠과 방향 휠.
function sameInput(a: string, b: string): boolean {
  if (a === b) return true;
  const wa = WHEEL_SLOT.exec(a);
  const wb = WHEEL_SLOT.exec(b);
  return !!wa && !!wb && wa[1] === wb[1] && (wa[2] === "wheel" || wb[2] === "wheel");
}
// 이 동작이 이 칸을 받을 수 있는가(입력 종류)
const fitsInput = (def: EditActionDef, slot: string) => (isWheelSlot(slot) ? def.input !== "key" : def.input !== "wheel");

// ── 저장 ─────────────────────────────────────────────────────────────────────────────────────────
type Stored = Partial<Record<EditActionId, Slots>>;
export type DropReason = "format" | "reserved" | "input" | "conflict";
export interface DroppedSlots { id: EditActionId; reason: DropReason; clash?: EditActionId }
const LS_KEY = STORAGE_KEYS.editShortcuts;
let dropped: DroppedSlots[] = [];
export const droppedOnLoad = (): readonly DroppedSlots[] => dropped;

function slotProblem(def: EditActionDef, slot: Slot): DropReason | null {
  if (slot === null) return null;
  if (typeof slot !== "string" || !validSlot(slot)) return "format";
  if (reservedOf(slot)) return "reserved";
  return fitsInput(def, slot) ? null : "input";
}
const effective = (map: Stored, id: EditActionId): Slots => map[id] ?? actionDef(id).def;

// 읽을 때 고치기 — 틀린 동작은 그 동작 전체를 기본값으로. 겹침은 칸 단위로 '기본 칸(그 동작의 기본값과 같은 칸)'이 먼저, 사용자 칸끼리는
//  표 순서가 앞인 동작이 남는다. 진 동작의 지정을 지우고(→ 기본값) 겹침이 없을 때까지 다시 본다(매번 지정이 하나 줄어 끝난다).
function load(): Stored {
  const raw = loadJSON<unknown>(LS_KEY);
  const kept: Stored = {};
  dropped = [];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      const def = BY_ID.get(id as EditActionId);
      if (!def) continue; // 모르는 동작(옛·새 판의 칸) — 버린다
      const pair = Array.isArray(value) && value.length === 2 ? (value as Slot[]) : null;
      const reason = !pair ? "format" : (slotProblem(def, pair[0]) ?? slotProblem(def, pair[1])
        ?? (pair[0] !== null && pair[1] !== null && sameInput(pair[0], pair[1]) ? "format" : null));
      if (reason) dropped.push({ id: def.id, reason });
      else kept[def.id] = [pair![0], pair![1]];
    }
  }
  for (let again = true; again; ) {
    again = false;
    const loser = firstConflict(kept);
    if (loser) {
      delete kept[loser.id];
      dropped.push({ id: loser.id, reason: "conflict", clash: loser.clash });
      again = true;
    }
  }
  return kept;
}
// 겹치는 두 칸 중 지는 쪽 — 기본 칸이 이기고, 둘 다 사용자 칸이면 표 순서가 뒤인 동작이 진다. 기본 칸끼리는 겹치지 않는다.
function firstConflict(map: Stored): { id: EditActionId; clash: EditActionId } | null {
  const slots = EDIT_ACTIONS.flatMap((def, order) =>
    effective(map, def.id).flatMap((slot) => (slot === null ? [] : [{ id: def.id, order, slot, user: !def.def.includes(slot) }])));
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i];
      const b = slots[j];
      if (a.id === b.id || !sameInput(a.slot, b.slot)) continue;
      const lose = a.user !== b.user ? (a.user ? a : b) : a.order > b.order ? a : b;
      return { id: lose.id, clash: lose === a ? b.id : a.id };
    }
  }
  return null;
}

let stored = load();
let byInput = buildIndex(stored);
let version = 0;
function buildIndex(map: Stored): Map<string, EditActionId> {
  const index = new Map<string, EditActionId>();
  for (const def of EDIT_ACTIONS) for (const slot of effective(map, def.id)) if (slot !== null) index.set(slot, def.id);
  return index;
}
function refresh(map: Stored) {
  stored = map;
  byInput = buildIndex(map);
  version += 1;
  dispatchAppEvent(APP_EVENTS.editShortcutsChanged);
}
// 저장에 실패하면 이 창에도 적용하지 않는다 — 다음 변경이 저장소를 다시 읽어 앞의 임시 변경을 말없이 지웠다(Codex 독립 리뷰 1차).
function persist(map: Stored): boolean {
  if (!trySaveJSON(LS_KEY, map)) {
    flashMsg("단축키를 저장하지 못했습니다(브라우저 저장 공간) — 바꾸지 않았습니다");
    return false;
  }
  dropped = [];
  refresh(map);
  return true;
}
// 다른 탭·창에서 바꾸면 이 탭도 바로 따른다(storage 이벤트는 바꾼 탭이 아닌 탭에만 온다)
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== LS_KEY) return;
    refresh(load());
  });
}

export const slotsOf = (id: EditActionId): Slots => effective(stored, id);
export const isCustom = (id: EditActionId) => stored[id] !== undefined;

// ── 찾기 ─────────────────────────────────────────────────────────────────────────────────────────
// 정확한 칸 → 없고 Shift 가 있으면 Shift 를 뺀 칸 중 shift same 동작 → 없음. 예약 입력은 부르는 쪽이 먼저 거른다(reservedOf).
export function findKeyAction(slot: string): EditActionId | null {
  const exact = byInput.get(slot);
  if (exact) return exact;
  if (!slot.includes("shift+")) return null;
  const id = byInput.get(slot.replace("shift+", ""));
  return id && actionDef(id).shift === "same" ? id : null;
}
export function findWheelAction(e: WheelLike): EditActionId | null {
  const slots = wheelSlots(e);
  return slots ? (byInput.get(slots[0]) ?? byInput.get(slots[1]) ?? null) : null;
}

// ── 바꾸기 ───────────────────────────────────────────────────────────────────────────────────────
export type SetResult = { ok: true } | { ok: false; reason: DropReason | "same" | "storage"; clash?: EditActionId; reserved?: "app" | "browser" };
// 그 동작의 칸 하나만 바꾼다 — 저장값을 다시 읽어(다른 탭이 바꾼 다른 칸·동작을 덮지 않게) 같은 검사로 확인하고, 겹치면 쓰지 않는다.
export function setSlot(id: EditActionId, index: 0 | 1, slot: Slot): SetResult {
  const latest = load();
  const [first, second] = effective(latest, id);
  return write(latest, id, index === 0 ? [slot, second] : [first, slot]);
}
export function resetAction(id: EditActionId): SetResult {
  const [first, second] = actionDef(id).def;
  return write(load(), id, [first, second]);
}
export function resetAllEditShortcuts(): boolean {
  return persist({});
}
function write(latest: Stored, id: EditActionId, next: [Slot, Slot]): SetResult {
  const def = actionDef(id);
  for (const slot of next) {
    const reason = slotProblem(def, slot);
    if (reason) return { ok: false, reason, reserved: reason === "reserved" && slot ? reservedOf(slot) ?? undefined : undefined };
  }
  if (next[0] !== null && next[1] !== null && sameInput(next[0], next[1])) return { ok: false, reason: "same" };
  for (const other of EDIT_ACTIONS) {
    if (other.id === id) continue;
    const hit = effective(latest, other.id).some((theirs) => theirs !== null && next.some((mine) => mine !== null && sameInput(mine, theirs)));
    if (hit) return { ok: false, reason: "conflict", clash: other.id };
  }
  const map: Stored = { ...latest };
  if (next[0] === def.def[0] && next[1] === def.def[1]) delete map[id];
  else map[id] = next;
  return persist(map) ? { ok: true } : { ok: false, reason: "storage" };
}

// Shift same 동작의 '빈 Shift' 를 다른 동작이 정확히 쓰는 곳 — 그 입력은 정확한 쪽이 먼저 받는다(겹침이 아니라 우선순위, 창에 한 줄).
export function shiftShadows(): { slot: string; winner: EditActionId; shadowed: EditActionId }[] {
  return [...byInput].flatMap(([slot, winner]) => {
    if (isWheelSlot(slot) || !slot.includes("shift+")) return [];
    const shadowed = byInput.get(slot.replace("shift+", ""));
    return shadowed && shadowed !== winner && actionDef(shadowed).shift === "same" ? [{ slot, winner, shadowed }] : [];
  });
}

// ── 보이는 글자 ──────────────────────────────────────────────────────────────────────────────────
const ARROWS: Record<string, string> = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓" };
const SYMBOLS: Record<string, string> = {
  Equal: "=", Minus: "-", Slash: "/", Backslash: "\\", Comma: ",", Period: ".", Semicolon: ";", Quote: "'", Backquote: "`",
  BracketLeft: "[", BracketRight: "]", NumpadMultiply: "Num *", NumpadDivide: "Num /", NumpadDecimal: "Num .",
};
const WHEEL_TEXT: Record<string, string> = { wheelup: "휠↑", wheeldown: "휠↓", wheel: "휠" };
function nameText(name: string): string {
  if (ARROWS[name]) return ARROWS[name];
  if (SYMBOLS[name]) return SYMBOLS[name];
  if (/^Key[A-Z]$/.test(name)) return name.slice(3);
  if (/^Digit\d$/.test(name)) return name.slice(5);
  if (/^Numpad\d$/.test(name)) return `Num ${name.slice(6)}`;
  return name;
}
// 툴팁 꼴 — 지금 글과 같다("Ctrl+=", "Shift+Z", "Alt+X", "Space", "J", "Home"). spaced = 창 꼴("Ctrl/⌘ + =").
export function slotText(slot: string, spaced = false): string {
  const wheel = WHEEL_SLOT.exec(slot);
  const mods = wheel ? [wheel[1]] : (KEY_SLOT.exec(slot)?.slice(1, 4).filter(Boolean).map((part) => part!.slice(0, -1)) ?? []);
  const name = wheel ? t(WHEEL_TEXT[wheel[2]]) : nameText(keyName(slot)); // 영어 화면은 Wheel↑ (찾기도 같은 글로 — Codex 묶음 검토 R3)
  const modText = (mod: string) => (mod === "mod" ? (spaced ? "Ctrl/⌘" : "Ctrl") : mod === "ctrl" ? "Ctrl" : mod === "alt" ? "Alt" : "Shift");
  return [...mods.map(modText), name].join(spaced ? " + " : "+");
}
// 그 동작의 첫 키 칸(없으면 첫 칸) 글자 — 없으면 "". 툴팁의 '(키)' 자리에 쓴다.
export function hintOf(id: EditActionId): string {
  const slots = slotsOf(id).filter((slot): slot is string => slot !== null);
  const first = slots.find((slot) => !isWheelSlot(slot)) ?? slots[0];
  return first ? slotText(first) : "";
}
// 두 동작의 글자를 하나로 — 수식키가 같은 화살표면 "Shift+↑↓", 아니면 "a/b"(한쪽이 없으면 있는 쪽만).
export function pairHint(a: EditActionId, b: EditActionId): string {
  const ha = hintOf(a);
  const hb = hintOf(b);
  if (!ha || !hb) return ha || hb;
  const cut = (text: string) => text.slice(0, text.lastIndexOf("+") + 1);
  const arrow = (text: string) => /[←→↑↓]$/.test(text);
  return cut(ha) === cut(hb) && arrow(ha) && arrow(hb) ? cut(ha) + ha.slice(-1) + hb.slice(-1) : `${ha}/${hb}`;
}
// "마크 인 ({key})" 같은 글의 {이름} 자리를 채운다. 키가 없으면 " ({이름})" 째로 뺀다(빈 괄호를 남기지 않는다).
export function fillKeys(text: string, keys: Record<string, string>): string {
  return text.replace(/( ?)\(\{(\w+)\}\)|\{(\w+)\}/g, (_whole, space: string | undefined, wrapped: string | undefined, bare: string | undefined) => {
    const value = keys[(wrapped ?? bare)!] ?? "";
    return wrapped ? (value ? `${space}(${value})` : "") : value;
  });
}

// 그리는 쪽 — 지정이 바뀌면 다시 그린다(툴팁·창). 키 처리는 이벤트 때 findKeyAction 을 부르므로 이 훅이 없어도 바로 따른다.
const subscribe = (fn: () => void) => {
  window.addEventListener(APP_EVENTS.editShortcutsChanged, fn);
  return () => window.removeEventListener(APP_EVENTS.editShortcutsChanged, fn);
};
export function useEditShortcutsVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}
