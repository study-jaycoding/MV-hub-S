// 작업탭 값(프로젝트/에피소드/시퀀스/생성자)별 색 라벨링 — 노션식 10색.
// 지정값은 localStorage 에 { "field::value": colorKey } 로 저장(브라우저별 기억, 창 간 storage 동기).
import { loadJSON, saveJSON } from "../../lib/storage";
import { STORAGE_KEYS } from "../../lib/storageKeys";

export type ColorMap = Record<string, string>; // "field::value" -> colorKey

// 이미지의 10색(기본=색 없음). hex 는 어두운 배경에서 읽히는 중간 밝기.
export const COLOR_OPTIONS: { key: string; label: string; hex: string | null }[] = [
  { key: "default", label: "기본", hex: null },
  { key: "gray", label: "회색", hex: "#9aa0a6" },
  { key: "brown", label: "갈색", hex: "#a9744f" },
  { key: "orange", label: "주황색", hex: "#d9730d" },
  { key: "yellow", label: "노란색", hex: "#d6a81e" },
  { key: "green", label: "초록색", hex: "#3f9d6b" },
  { key: "blue", label: "파란색", hex: "#3b7bd4" },
  { key: "purple", label: "보라색", hex: "#8a63d2" },
  { key: "pink", label: "분홍색", hex: "#c2557a" },
  { key: "red", label: "빨간색", hex: "#d4534d" },
];
const HEX: Record<string, string> = Object.fromEntries(
  COLOR_OPTIONS.filter((o) => o.hex).map((o) => [o.key, o.hex as string]),
);

export function colorHex(key?: string | null): string | undefined {
  return key ? HEX[key] : undefined;
}
export function colorKeyOf(field: string, value: string): string {
  return `${field}::${value}`;
}
export function loadColorMap(): ColorMap {
  const m = loadJSON<ColorMap>(STORAGE_KEYS.manageColorTags);
  return m && typeof m === "object" ? m : {};
}
export function saveColorMap(m: ColorMap): void {
  saveJSON(STORAGE_KEYS.manageColorTags, m);
}
