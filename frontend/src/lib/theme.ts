// 강조색(테마) — CSS 변수 --accent 계열을 런타임에 교체. localStorage 영속.
// 프리셋 hex 하나로 --accent / --accent-ink / --grad / --grad-soft / --glow 를 파생 생성한다.

export interface AccentPreset {
  key: string;
  name: string;
  hex: string;
}

// 첫 번째(라임)가 기본 — styles.css :root 와 동일 값. (그 외는 커스텀 컬러로)
export const ACCENT_PRESETS: AccentPreset[] = [
  { key: "lime", name: "라임", hex: "#c4e84a" },
  { key: "purple", name: "퍼플", hex: "#b14bf4" },
  { key: "pink", name: "핑크", hex: "#ff5e8a" },
  { key: "blue", name: "블루", hex: "#4a9eff" },
  { key: "orange", name: "오렌지", hex: "#ff8a3d" },
];

const ACCENT_KEY = "ch_accent";
export const DEFAULT_ACCENT = ACCENT_PRESETS[0].hex;

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16),
  };
}

// 배경 휘도로 그 위 텍스트(잉크) 색 결정 — 밝은 강조색 위엔 검정, 어두운 강조색 위엔 흰색.
// [[lime-bg-dark-ink]] 원칙의 일반화: 라임처럼 밝으면 검정.
function inkFor(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  return lum > 150 ? "#131806" : "#ffffff";
}

/** CSS 변수를 강조색 hex 기준으로 일괄 갱신. */
export function applyAccent(hex: string): void {
  const { r, g, b } = hexToRgb(hex);
  const s = document.documentElement.style;
  s.setProperty("--accent", hex);
  s.setProperty("--accent-ink", inkFor(hex));
  // grad: 거의 단색의 미세 그라데이션(라임 기본과 동일한 느낌)
  s.setProperty("--grad", `linear-gradient(120deg, ${hex}, ${hex})`);
  s.setProperty(
    "--grad-soft",
    `linear-gradient(120deg, rgba(${r},${g},${b},0.15), rgba(${r},${g},${b},0.15))`,
  );
  s.setProperty(
    "--glow",
    `0 0 0 1px rgba(${r},${g},${b},0.5), 0 8px 30px rgba(${r},${g},${b},0.22)`,
  );
}

export function loadAccent(): string {
  try {
    return localStorage.getItem(ACCENT_KEY) || DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

export function saveAccent(hex: string): void {
  try {
    localStorage.setItem(ACCENT_KEY, hex);
  } catch {
    /* 저장 실패해도 적용은 진행 */
  }
  applyAccent(hex);
}

// ── 언어(i18n 토대) ────────────────────────────────────────────────────
// 전체 UI 영어화는 단계적 — 우선 선택값을 영속하고 <html lang>을 갱신한다.
export type Lang = "ko" | "en";
const LANG_KEY = "ch_lang";

export function loadLang(): Lang {
  try {
    return (localStorage.getItem(LANG_KEY) as Lang) || "ko";
  } catch {
    return "ko";
  }
}

export function saveLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    /* noop */
  }
  document.documentElement.setAttribute("lang", lang);
}

// ── 모션 끄기(애니메이션 감소) ──────────────────────────────────────────
// 앱 자체 설정. 켜면 <html class="reduce-motion"> → 골드 셔이머 등 장식 애니메이션 정지.
const MOTION_KEY = "ch_reduce_motion";

export function loadReduceMotion(): boolean {
  try {
    return localStorage.getItem(MOTION_KEY) === "1";
  } catch {
    return false;
  }
}

export function applyReduceMotion(on: boolean): void {
  document.documentElement.classList.toggle("reduce-motion", on);
}

export function saveReduceMotion(on: boolean): void {
  try {
    localStorage.setItem(MOTION_KEY, on ? "1" : "0");
  } catch {
    /* noop */
  }
  applyReduceMotion(on);
}
