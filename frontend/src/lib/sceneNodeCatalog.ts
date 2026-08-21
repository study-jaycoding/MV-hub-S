import type { SceneCardKind } from "./scenes";

/** 사용자가 Tab 피커·단축키로 '새로 만들 수 있는' 노드의 단일 카탈로그.
 *
 * 종전엔 피커 메뉴(11종)·키보드 매핑(11종)·피커 높이(9행 하드코딩)가 세 곳에 따로 선언돼
 * 어긋났고, 화면 하단에서 메뉴가 약 2행만큼 넘쳤다. 종류를 추가할 땐 이 목록 하나만 고친다.
 * ★reference(가져오기 전용 kind)는 여기 넣지 않는다 — '새로 만들 수 있는' 목록과 의미가 다르다.
 */
export interface SceneNodeEntry {
  label: string;
  key: string; // 단축키(대문자 표기, 매핑은 소문자)
  kind: SceneCardKind;
}

export const SCENE_NODE_CATALOG: readonly SceneNodeEntry[] = [
  // 역할별 묶음: 생성(New·Model·Text) → 모음/흐름(Set·List·Render·View) → 무선(Input·Output) → 주석(Head)
  { label: "New", key: "N", kind: "generation" },
  { label: "Model", key: "M", kind: "model" },
  { label: "Text", key: "T", kind: "text" },
  { label: "Set", key: "S", kind: "set" },
  { label: "List", key: "L", kind: "list" },
  { label: "Render", key: "R", kind: "render" },
  { label: "View", key: "V", kind: "view" },
  { label: "Input", key: "I", kind: "input" },
  { label: "Output", key: "O", kind: "output" },
  { label: "Head", key: "H", kind: "head" },
  { label: "Comfy", key: "C", kind: "comfy" },
];

/** 키보드 단축키 → kind (소문자 키). 카탈로그에서 파생 — 별도 선언 금지. */
export const SCENE_NODE_KEYS: Record<string, SceneCardKind> = Object.fromEntries(
  SCENE_NODE_CATALOG.map((entry) => [entry.key.toLowerCase(), entry.kind]),
);
