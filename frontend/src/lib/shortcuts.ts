// 사용자 지정 단축키 레지스트리.
// 기본값 + localStorage('ch.shortcuts') 오버라이드를 한곳에서 관리한다. 키 핸들러는 matchShortcut()
// 로 조회하므로 리스너를 다시 바인딩하지 않아도 변경이 즉시 반영된다. 설정창에서 현재 키를 보여주고
// '변경'(다음 키 캡처)으로 재지정한다. 방향키·Enter·Space·Esc 같은 네비/편집 기본키는 비대상(고정).

import { APP_EVENTS, dispatchAppEvent } from "./appEvents";
import { loadJSON, saveJSON } from "./storage";
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
//  그리고 글자가 아닌 입력기 키. 전엔 Enter·방향키도 받아, 프롬프트의 Enter 에 도크가 숨거나 방향키에 색이 칠해졌다.
const RESERVED = new Set([
  "escape", "enter", "tab", "space", "backspace", "delete", "insert", "home", "end", "pageup", "pagedown",
  "arrowup", "arrowdown", "arrowleft", "arrowright", "contextmenu", "capslock", "process", "unidentified", "dead",
  "f", "y", "s", // 캔버스: 화면 맞춤·가위 / Assets: 소스
  "mod+z", "mod+shift+z", "mod+c", "mod+v", "mod+x", "mod+g", // 캔버스: 실행 취소·복사·붙여넣기·그룹
  "mod+shift+c", "mod+shift+v", "mod+shift+x", "mod+shift+g", // 캔버스의 복사·붙여넣기·그룹은 Shift 를 가리지 않는다
  "mod+w", "mod+t", "mod+n", "mod+r", "mod+l", "mod+shift+t", "mod+shift+n", // 브라우저
]);
export function isReservedBinding(binding: string): boolean {
  return RESERVED.has(binding) || /^(mod\+|alt\+|shift\+)*f\d{1,2}$/.test(binding);
}

// 저장된 값도 거른다 — 고정 키를 막기 전에 저장해 둔 것(Enter·방향키 등)이 계속 듣지 않게. 걸러진 항목은 기본값으로 돌아간다.
function load(): Partial<Record<ShortcutId, string>> {
  const stored = loadJSON<Partial<Record<ShortcutId, string>>>(LS_KEY) || {};
  const kept: Partial<Record<ShortcutId, string>> = {};
  for (const [id, binding] of Object.entries(stored)) {
    if (typeof binding === "string" && binding && !isReservedBinding(binding)) kept[id as ShortcutId] = binding;
  }
  return kept;
}
let overrides = load();

function persist() {
  saveJSON(LS_KEY, overrides);
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
export function conflictOf(binding: string, except: ShortcutId): ShortcutId | null {
  const mine = SHORTCUTS.find((s) => s.id === except)?.scope;
  for (const s of SHORTCUTS) {
    if (s.id === except || getBinding(s.id) !== binding) continue;
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
// 수식키 단독(Ctrl 만 등)은 null(아직 키 안 눌림).
export function eventToBinding(e: KeyLike): string | null {
  let key = e.key;
  if (MOD_ONLY.has(key.toLowerCase())) return null;
  if (key === " " || key.toLowerCase() === "spacebar") key = "space";
  key = key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey ? "mod+" : "";
  const alt = e.altKey ? "alt+" : "";
  const shift = e.shiftKey && (mod || alt) ? "shift+" : "";
  return mod + alt + shift + key;
}

export function matchShortcut(e: KeyLike, id: ShortcutId): boolean {
  const b = eventToBinding(e);
  return b != null && b === getBinding(id);
}

const ARROWS: Record<string, string> = { arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓" };
// 표시용: "mod+k" → "Ctrl/⌘ + K", "#" → "#", "escape" → "Escape", "arrowright" → "→"
export function prettyBinding(b: string): string {
  if (!b) return "—";
  return b
    .split("+")
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
