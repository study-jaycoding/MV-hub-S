// 사용자 지정 단축키 레지스트리.
// 기본값 + localStorage('ch.shortcuts') 오버라이드를 한곳에서 관리한다. 키 핸들러는 matchShortcut()
// 로 조회하므로 리스너를 다시 바인딩하지 않아도 변경이 즉시 반영된다. 설정창에서 현재 키를 보여주고
// '변경'(다음 키 캡처)으로 재지정한다. 방향키·Enter·Space·Esc 같은 네비/편집 기본키는 비대상(고정).

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
  | "boardArrange";

export interface ShortcutDef {
  id: ShortcutId;
  label: string;
  group: string;
  def: string; // 기본 바인딩(정규화 문자열)
}

export const SHORTCUTS: ShortcutDef[] = [
  { id: "focusPrompt", label: "프롬프트 입력바 표시/숨김", group: "라이브러리", def: "mod+k" },
  { id: "colorRed", label: "컬러 — 빨강", group: "라이브러리", def: "r" },
  { id: "colorGreen", label: "컬러 — 초록", group: "라이브러리", def: "g" },
  { id: "colorBlue", label: "컬러 — 파랑", group: "라이브러리", def: "b" },
  { id: "tag", label: "태그 입력", group: "라이브러리", def: "#" },
  { id: "comment", label: "코멘트 열기", group: "라이브러리", def: "c" },
  { id: "showHistory", label: "히스토리(가계) 보기", group: "라이브러리", def: "h" },
  { id: "selectAll", label: "전체 선택", group: "라이브러리", def: "mod+a" },
  { id: "boardDisable", label: "노드 비활성화(회색) 토글", group: "구성 보드", def: "d" },
  { id: "boardArrange", label: "자동 정렬", group: "구성 보드", def: "l" },
];

const LS_KEY = "ch.shortcuts";
const DEFAULTS = SHORTCUTS.reduce(
  (m, s) => {
    m[s.id] = s.def;
    return m;
  },
  {} as Record<ShortcutId, string>,
);

function load(): Partial<Record<ShortcutId, string>> {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}") || {};
  } catch {
    return {};
  }
}
let overrides = load();

function persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(overrides));
  } catch {
    /* ignore */
  }
  // 다른 컴포넌트(설정창 등)가 즉시 갱신되도록 알림(핸들러는 조회식이라 별도 갱신 불필요).
  window.dispatchEvent(new CustomEvent("ch:shortcuts-changed"));
}

export function getBinding(id: ShortcutId): string {
  return overrides[id] ?? DEFAULTS[id];
}
export function defaultBinding(id: ShortcutId): string {
  return DEFAULTS[id];
}
export function setBinding(id: ShortcutId, binding: string) {
  if (binding === DEFAULTS[id]) delete overrides[id];
  else overrides[id] = binding;
  persist();
}
export function resetBinding(id: ShortcutId) {
  delete overrides[id];
  persist();
}
export function resetAll() {
  overrides = {};
  persist();
}
// 이 바인딩을 이미 쓰는 다른 단축키 id(충돌). 없으면 null.
export function conflictOf(binding: string, except: ShortcutId): ShortcutId | null {
  for (const s of SHORTCUTS) {
    if (s.id !== except && getBinding(s.id) === binding) return s.id;
  }
  return null;
}

// 키 이벤트가 갖춰야 할 최소 형태 — DOM KeyboardEvent·React.KeyboardEvent 둘 다 구조적으로 만족.
type KeyLike = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean };

const MOD_ONLY = new Set(["control", "meta", "shift", "alt", "altgraph", "os"]);

// 키 이벤트 → 정규화 바인딩 문자열. ctrl/meta=mod, alt 포함. shift 는 무시(문자는 e.key 그대로 사용).
// 수식키 단독(Ctrl 만 등)은 null(아직 키 안 눌림).
export function eventToBinding(e: KeyLike): string | null {
  let key = e.key;
  if (MOD_ONLY.has(key.toLowerCase())) return null;
  if (key === " " || key.toLowerCase() === "spacebar") key = "space";
  key = key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey ? "mod+" : "";
  const alt = e.altKey ? "alt+" : "";
  return mod + alt + key;
}

export function matchShortcut(e: KeyLike, id: ShortcutId): boolean {
  const b = eventToBinding(e);
  return b != null && b === getBinding(id);
}

// 표시용: "mod+k" → "Ctrl/⌘ + K", "#" → "#", "escape" → "Escape"
export function prettyBinding(b: string): string {
  if (!b) return "—";
  return b
    .split("+")
    .map((p) =>
      p === "mod"
        ? "Ctrl/⌘"
        : p === "alt"
          ? "Alt"
          : p === "space"
            ? "Space"
            : p.length === 1
              ? p.toUpperCase()
              : p[0].toUpperCase() + p.slice(1),
    )
    .join(" + ");
}
