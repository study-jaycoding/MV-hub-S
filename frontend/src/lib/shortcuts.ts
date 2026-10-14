// 사용자 지정 단축키 레지스트리.
// 기본값 + localStorage('ch.shortcuts') 오버라이드를 한곳에서 관리한다. 키 핸들러는 matchShortcut()
// 로 조회하므로 리스너를 다시 바인딩하지 않아도 변경이 즉시 반영된다. 설정창에서 현재 키를 보여주고
// '변경'(다음 키 캡처)으로 재지정한다. 방향키·Enter·Space·Esc 같은 네비/편집 기본키는 비대상(고정).

import { APP_EVENTS, dispatchAppEvent } from "./appEvents";
import { flashMsg } from "./flash";
import { loadJSON, trySaveJSON } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";

export type ShortcutId =
  | "focusPrompt"
  | "colorRed"
  | "colorGreen"
  | "colorBlue"
  | "tag"
  | "comment"
  | "showHistory"
  | "selectAll"
  | "boardDisable"
  | "boardArrange"
  | "boardConnect";

export interface ShortcutDef {
  id: ShortcutId;
  label: string;
  group: string;
  def: string; // 기본 바인딩(정규화 문자열)
  // 이 단축키가 듣는 화면 — 같이 켜지는 것끼리만 충돌이다. library = 라이브러리 격자(목록·폴더 창·결과 창), board = 캔버스·계보 보드,
  //  없으면 어디서나. 라이브러리 격자가 키를 받는 동안 보드의 키는 쉬므로 둘은 같은 키를 써도 된다(기본값 c 가 그렇다).
  scope?: "library" | "board";
}

export const SHORTCUTS: ShortcutDef[] = [
  { id: "focusPrompt", label: "프롬프트 입력바 표시/숨김", group: "라이브러리", def: "mod+k" },
  { id: "colorRed", label: "컬러 — 빨강", group: "라이브러리", def: "r" },
  { id: "colorGreen", label: "컬러 — 초록", group: "라이브러리", def: "g" },
  { id: "colorBlue", label: "컬러 — 파랑", group: "라이브러리", def: "b" },
  { id: "tag", label: "태그 입력", group: "라이브러리", def: "#" },
  { id: "comment", label: "코멘트 열기", group: "라이브러리", def: "c", scope: "library" },
  { id: "showHistory", label: "히스토리 (어떻게 만들었나 노드로)", group: "라이브러리", def: "h", scope: "library" },
  { id: "selectAll", label: "전체 선택", group: "라이브러리", def: "mod+a" },
  { id: "boardDisable", label: "노드 비활성화(회색) 토글", group: "구성 보드", def: "d" },
  { id: "boardArrange", label: "선택 노드 자동 정렬", group: "구성 보드", def: "a", scope: "board" },
  { id: "boardConnect", label: "선택 노드 연결(왼→오른쪽)", group: "구성 보드", def: "c", scope: "board" },
];

const LS_KEY = STORAGE_KEYS.shortcuts;
const DEFAULTS = SHORTCUTS.reduce(
  (m, s) => {
    m[s.id] = s.def;
    return m;
  },
  {} as Record<ShortcutId, string>,
);

// 재지정할 수 없는 키 — 격자·캔버스·브라우저가 이미 쓰는 고정 키(같은 키에 두 동작이 걸리거나 아무 일도 안 일어난다),
//  그리고 글자가 아닌 입력기 키(아래 isImeBinding). 전엔 Enter·방향키도 받아, 프롬프트의 Enter 에 도크가 숨거나 방향키에 색이 칠해졌다.
const RESERVED = new Set([
  "escape", "enter", "tab", "space", "backspace", "delete", "insert", "home", "end", "pageup", "pagedown",
  "arrowup", "arrowdown", "arrowleft", "arrowright", "contextmenu", "capslock",
  "f", "y", "s", // 캔버스: 화면 맞춤·가위 / Assets: 소스
  "mod+z", "mod+shift+z", "mod+c", "mod+v", "mod+x", "mod+g", // 캔버스: 실행 취소·복사·붙여넣기·그룹
  "mod+shift+c", "mod+shift+v", "mod+shift+x", "mod+shift+g", // 캔버스의 복사·붙여넣기·그룹은 Shift 를 가리지 않는다
  "mod+w", "mod+t", "mod+n", "mod+r", "mod+l", "mod+shift+t", "mod+shift+n", // 브라우저
]);
// 수식키를 뺀 본 키가 입력기 키인가 — 입력기가 켜져 있으면 무슨 키를 눌러도 이 이름으로 온다(어느 키인지 알 수 없다).
//  수식키가 붙어도 같다: 전엔 수식키 없는 것만 막아 "Ctrl + Process" 가 지정됐고, 한글 상태의 Ctrl+아무 키에나 발동했다.
export function isImeBinding(binding: string): boolean {
  return /^(process|dead|unidentified)$/.test(splitBinding(binding).key);
}
export function isReservedBinding(binding: string): boolean {
  return RESERVED.has(binding) || isImeBinding(binding) || /^f\d{1,2}$/.test(splitBinding(binding).key);
}

// 바인딩 문자열 = 수식키 접두("mod+"·"alt+"·"shift+") + 본 키. 나눠 읽는 곳은 전부 이 함수를 쓴다 — "+" 로 쪼개면 본 키가 "+" 인 값
//  ("+", "mod++")에서 빈 조각이 나온다(표시가 그 빈 조각에서 예외를 던져, + 를 지정하면 단축키 창이 통째로 사라졌고 저장된 뒤라
//  열 때마다 되풀이됐다). 접두만 떼고 나머지는 통째로 본 키다.
function splitBinding(binding: string): { mods: string; key: string } {
  const key = binding.replace(/^(mod\+|alt\+|shift\+)*/, "");
  return { mods: binding.slice(0, binding.length - key.length), key };
}
// Shift 가 이미 글자에 담겨 오는 키인가 — 기호다("!" 는 "1" 과 다른 키로 온다). 글자(대소문자를 접어 적으니 Shift 가 안 남는다)·숫자·
//  이름 있는 키(Enter·F5)는 아니다. Shift 를 따로 세는 것은 그런 키에서만이다(eventToBinding·normalizeBinding 이 같은 판정을 쓴다).
//  판정: 대소문자가 없고 숫자가 아니다 — 이름 있는 키는 전부 영문 이름이라 대소문자가 있다.
function shiftInKey(key: string): boolean {
  return key.toLowerCase() === key.toUpperCase() && !/\d/.test(key);
}
// 저장값을 지금의 꼴로 읽는다 — 기호에 붙은 shift+ 는 뗀다("mod+shift+!" → "mod+!"). 한동안 기호에도 Shift 를 적어 저장했고, 그 전에는
//  Shift 를 늘 버려 "mod+!" 로 저장했다: 둘 다 같은 꼴이 되어 같은 키(Ctrl+Shift+1)에 듣는다. 본 키가 없으면 깨진 값(null).
function normalizeBinding(binding: string): string | null {
  const { mods, key } = splitBinding(binding);
  if (!key) return null;
  return (shiftInKey(key) ? mods.replace("shift+", "") : mods) + key;
}

type Overrides = Partial<Record<ShortcutId, string>>;
// 읽을 때 겹쳐서 걷어 낸 지정(저장소에는 아직 남아 있다) — 단축키 창이 열릴 때 알린다. 정리된 것이 저장소에 쓰이면 비워진다.
export interface DroppedBinding {
  id: ShortcutId;
  binding: string;
  clash: ShortcutId; // 이 항목과 겹쳤다
}
let dropped: DroppedBinding[] = [];
export function droppedOnLoad(): readonly DroppedBinding[] {
  return dropped;
}

// 저장된 값도 거른다 — 고정 키를 막기 전에 저장해 둔 것(Enter·방향키 등)이 계속 듣지 않게. 걸러진 항목은 기본값으로 돌아간다.
function load(): Overrides {
  const stored = loadJSON<Overrides>(LS_KEY) || {};
  const kept: Overrides = {};
  for (const [id, raw] of Object.entries(stored)) {
    const binding = typeof raw === "string" ? normalizeBinding(raw) : null;
    if (binding && !isReservedBinding(binding)) kept[id as ShortcutId] = binding;
  }
  // 걸러진 항목이 돌아간 기본값을 그사이 다른 항목이 지정해 쓰고 있을 수 있다(코멘트를 Enter 로 옮기고 빈 c 를 히스토리에 준 경우 —
  //  읽고 나면 둘 다 c 다). 그래서 거른 뒤의 실효 키(지정 ?? 기본값) 전체를 다시 본다: 다른 항목과 겹치는 '지정'을 걷어 그 항목도
  //  기본값으로 돌린다. 기본값이 지정을 이기고(기본값끼리는 안 겹치니 끝에는 겹침이 없다), 지정끼리 겹치면 목록에서 위의 것이 남는다
  //  (아래에서부터 걷는다). 걷힌 항목의 기본값이 또 다른 지정과 겹칠 수 있어 겹침이 없을 때까지 돈다.
  //  여기서는 저장소에 쓰지 않는다 — 쓰는 때는 전처럼 사용자가 바꿀 때뿐이고(persist), 그때 정리된 것이 함께 쓰인다.
  // ponytail: 지정끼리 겹친 저장값(창으로는 못 만든다 — 손댄 저장소·두 탭의 경합)은 걷는 순서 탓에 꼭 필요한 것보다 하나 더 걷힐 수 있다
  //  (위의 것도 기본값과 겹쳐 걷히는 경우). 겹침은 남지 않는다. 문제가 되면 '기본값과 겹치는 지정'부터 걷게 두 단계로 나눈다.
  dropped = [];
  for (let again = true; again; ) {
    again = false;
    for (let i = SHORTCUTS.length - 1; i >= 0; i--) {
      const id = SHORTCUTS[i].id;
      const binding = kept[id];
      if (binding === undefined) continue;
      const clash = conflictOf(binding, id, kept);
      if (!clash) continue;
      delete kept[id];
      dropped.push({ id, binding, clash });
      again = true;
    }
  }
  return kept;
}
let overrides = load();

function persist() {
  // 저장 공간이 꽉 찼거나 막혔으면 알린다 — 말없이 두면 새로 고침 뒤(또는 다음 변경 때) 옛 키로 돌아간다(47회차).
  if (!trySaveJSON(LS_KEY, overrides)) flashMsg("단축키를 저장하지 못했습니다(브라우저 저장 공간) — 이 창에서만 바뀌고 새로 고침하면 돌아갑니다");
  dropped = []; // 정리된 것이 저장소에 쓰였다 — 더 알릴 것이 없다
  // 다른 컴포넌트(설정창 등)가 즉시 갱신되도록 알림(핸들러는 조회식이라 별도 갱신 불필요).
  dispatchAppEvent(APP_EVENTS.shortcutsChanged);
}

export function getBinding(id: ShortcutId): string {
  return overrides[id] ?? DEFAULTS[id];
}
export function defaultBinding(id: ShortcutId): string {
  return DEFAULTS[id];
}
// 저장 직전에 저장소를 다시 읽는다 — 다른 탭·창에서 바꾼 항목을 이 탭의 낡은 사본으로 덮지 않는다(그 항목만 바꾼다).
export function setBinding(id: ShortcutId, binding: string) {
  overrides = load();
  if (binding === DEFAULTS[id]) delete overrides[id];
  else overrides[id] = binding;
  persist();
}
export function resetBinding(id: ShortcutId) {
  overrides = load();
  delete overrides[id];
  persist();
}
export function resetAll() {
  overrides = {};
  persist();
}
// 다른 탭·창에서 바꾸면 이 탭도 바로 따른다(storage 이벤트는 바꾼 탭이 아닌 탭에만 온다).
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== LS_KEY) return;
    overrides = load();
    dispatchAppEvent(APP_EVENTS.shortcutsChanged);
  });
}
// 이 바인딩을 이미 쓰는 다른 단축키 id(충돌). 없으면 null. 같이 켜지지 않는 화면끼리(library ↔ board)는 충돌이 아니다.
//  map 은 읽는 중인 후보(load 가 같은 규칙으로 겹침을 본다) — 안 주면 지금 쓰는 지정.
export function conflictOf(binding: string, except: ShortcutId, map: Overrides = overrides): ShortcutId | null {
  const mine = SHORTCUTS.find((s) => s.id === except)?.scope;
  for (const s of SHORTCUTS) {
    if (s.id === except || (map[s.id] ?? s.def) !== binding) continue;
    if (mine && s.scope && mine !== s.scope) continue;
    return s.id;
  }
  return null;
}
// 키 이벤트가 갖춰야 할 최소 형태 — DOM KeyboardEvent·React.KeyboardEvent 둘 다 구조적으로 만족.
type KeyLike = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey?: boolean };

const MOD_ONLY = new Set(["control", "meta", "shift", "alt", "altgraph", "os"]);

// 키 이벤트 → 정규화 바인딩 문자열. ctrl/meta=mod, alt 포함. Shift 는 Ctrl·Alt 와 함께일 때만 센다 — 혼자일 때는 글자가 이미
// 달라져 있어(#, R) e.key 그대로 쓴다. 전엔 Shift 를 늘 버려, Ctrl+X 로 정한 것이 Ctrl+Shift+X 에도 발동했다.
// Ctrl·Alt 와 함께여도 기호에서는 세지 않는다(shiftInKey) — Ctrl+Shift+1 은 key 가 "!" 라 이미 Ctrl+1 과 다르다. 기호에도 세면
// Shift 를 버리던 때 저장한 "mod+!" 가 어느 키에도 안 맞는 죽은 지정이 되어 기본 키까지 가린다.
// 수식키 단독(Ctrl 만 등)은 null(아직 키 안 눌림).
export function eventToBinding(e: KeyLike): string | null {
  let key = e.key;
  if (MOD_ONLY.has(key.toLowerCase())) return null;
  if (key === " " || key.toLowerCase() === "spacebar") key = "space";
  key = key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey ? "mod+" : "";
  const alt = e.altKey ? "alt+" : "";
  const shift = e.shiftKey && (mod || alt) && !shiftInKey(key) ? "shift+" : "";
  return mod + alt + shift + key;
}

export function matchShortcut(e: KeyLike, id: ShortcutId): boolean {
  const b = eventToBinding(e);
  return b != null && b === getBinding(id);
}

const ARROWS: Record<string, string> = { arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓" };
// 표시용: "mod+k" → "Ctrl/⌘ + K", "#" → "#", "escape" → "Escape", "arrowright" → "→"
export function prettyBinding(b: string): string {
  const { mods, key } = splitBinding(b);
  if (!key) return "—";
  return [...mods.split("+").filter(Boolean), key] // 접두 안의 + 는 구분자뿐이다 — 본 키("+")는 쪼개지 않는다
    .map((p) =>
      p === "mod"
        ? "Ctrl/⌘"
        : p === "alt"
          ? "Alt"
          : p === "shift"
            ? "Shift"
          : p === "space"
            ? "Space"
            : p.length === 1
              ? p.toUpperCase()
              : ARROWS[p] ?? p[0].toUpperCase() + p.slice(1),
    )
    .join(" + ");
}
