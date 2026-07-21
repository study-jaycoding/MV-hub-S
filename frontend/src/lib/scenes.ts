// Canvas 씬(빈 캔버스) 데이터 레이어 — 카드·연결·카메라를 localStorage 에 프로젝트별로 보관.
// 생성 결과물 자체는 실제 generation(서버)이고, 여기 저장하는 건 "캔버스 편집물"(개인 로컬)뿐이다.
import { loadJSON, saveJSON } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";

export type SceneCardKind = "reference" | "generation";

// 카드가 담는 레퍼런스 — 하단 프롬프트의 레퍼런스와 호환되는 최소 필드.
export interface SceneRef {
  file_path: string; // 'asset:{project}|{path}' 토큰 또는 원격 URL
  type: string; // 'image' | 'video'
  name?: string;
  thumb?: string | null;
  source_gen_id?: string | null;
}

export interface SceneCard {
  id: string;
  kind: SceneCardKind;
  x: number;
  y: number;
  refs?: SceneRef[]; // 레퍼런스 카드: 담긴 레퍼런스(순서)
  genId?: string | null; // 생성 카드: 현재 표시 중인 generation id(다중이면 그중 하나)
  genIds?: string[]; // 생성 카드: 이 카드에서 만들어진 모든 결과(누적, 오래된→최신). 배지·팝업용.
  prompt?: string; // 생성 카드: 작성 중인 프롬프트 초안(직렬화 텍스트). 카드 전환 시 이 카드로 복원.
  status?: "empty" | "pending" | "running" | "done" | "failed";
}

export interface SceneEdge {
  id: string;
  from: string; // 출력 카드 id
  to: string; // 입력 카드 id
}

// 카드 묶음(그룹) — 테두리는 멤버 카드들의 바운딩박스로 자동 계산(별도 좌표 저장 안 함).
//  · name: 헤더에 표시(더블클릭 편집)  · collapsed: 접으면 제목 막대로 축소(멤버 숨김·연결은 막대로 브릿지)
export interface SceneGroup {
  id: string;
  name: string;
  cardIds: string[];
  collapsed?: boolean;
}

export interface Scene {
  id: string;
  name: string;
  cards: SceneCard[];
  edges: SceneEdge[];
  groups?: SceneGroup[]; // 카드 그룹(선택 후 Ctrl+G) — 없으면 그룹 없음
  camera?: { z: number; x: number; y: number };
  created_at: number;
}

type ScenesByProject = Record<string, Scene[]>;

const keyOf = (projectId: string | null | undefined) => projectId || "_none";

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 생성 카드의 변형(결과) id 목록 — genIds(누적) + legacy genId 를 합쳐 중복 제거, 순서 보존.
export function variantIds(card: Pick<SceneCard, "genIds" | "genId">): string[] {
  const out: string[] = [];
  for (const id of card.genIds || []) if (id && !out.includes(id)) out.push(id);
  if (card.genId && !out.includes(card.genId)) out.push(card.genId);
  return out;
}

// 레퍼런스 목록의 "내용 지문" — 순서·값이 같으면 같은 문자열. uid/role 같은 표시용 필드는 제외.
// 씬 카드 ↔ 하단 프롬프트 트레이 동기화에서 '내 편집의 에코'를 걸러내 무한 갱신을 막는 데 쓴다.
export function sceneRefFingerprint(
  refs: Pick<SceneRef, "file_path" | "type" | "name" | "thumb" | "source_gen_id">[],
): string {
  return JSON.stringify(
    refs.map((r) => [r.file_path, r.type, r.name ?? "", r.thumb ?? "", r.source_gen_id ?? ""]),
  );
}


function loadAll(): ScenesByProject {
  return loadJSON<ScenesByProject>(STORAGE_KEYS.scenes) || {};
}
function saveAll(all: ScenesByProject) {
  saveJSON(STORAGE_KEYS.scenes, all);
}

export function listScenes(projectId: string | null): Scene[] {
  return loadAll()[keyOf(projectId)] || [];
}

export function saveScenes(projectId: string | null, scenes: Scene[]) {
  const all = loadAll();
  all[keyOf(projectId)] = scenes;
  saveAll(all);
}

export function createScene(projectId: string | null, name?: string): Scene {
  const scenes = listScenes(projectId);
  const scene: Scene = {
    id: uid(),
    name: name || `씬 ${scenes.length + 1}`,
    cards: [],
    edges: [],
    created_at: Date.now(),
  };
  saveScenes(projectId, [...scenes, scene]);
  return scene;
}

export function updateScene(projectId: string | null, sceneId: string, patch: Partial<Scene>) {
  saveScenes(
    projectId,
    listScenes(projectId).map((s) => (s.id === sceneId ? { ...s, ...patch } : s)),
  );
}

export function deleteScene(projectId: string | null, sceneId: string) {
  saveScenes(
    projectId,
    listScenes(projectId).filter((s) => s.id !== sceneId),
  );
}

export function getActiveSceneId(projectId: string | null): string | null {
  const map = loadJSON<Record<string, string>>(STORAGE_KEYS.scenesActive) || {};
  return map[keyOf(projectId)] || null;
}

export function setActiveSceneId(projectId: string | null, sceneId: string | null) {
  const map = loadJSON<Record<string, string>>(STORAGE_KEYS.scenesActive) || {};
  if (sceneId) map[keyOf(projectId)] = sceneId;
  else delete map[keyOf(projectId)];
  saveJSON(STORAGE_KEYS.scenesActive, map);
}
