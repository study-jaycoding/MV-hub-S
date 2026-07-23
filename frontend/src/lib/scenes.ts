// Canvas 씬(빈 캔버스) 데이터 레이어 — 카드·연결·카메라를 localStorage 에 프로젝트별로 보관.
// 생성 결과물 자체는 실제 generation(서버)이고, 여기 저장하는 건 "캔버스 편집물"(개인 로컬)뿐이다.
import { loadJSON, saveJSON } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";

export type SceneCardKind =
  | "reference"
  | "generation"
  | "text"
  | "model"
  | "list"
  | "view"
  | "output"
  | "input"
  | "head"
  | "render";

// 모델 노드 설정 — 하단 프롬프트(SpotlightOptionsBar)에서 고른 값의 스냅샷(표시·조직화용).
export interface SceneModelCfg {
  type?: string; // 'image' | 'video' 등
  model?: string; // 모델 id
  modelName?: string; // 표시용 이름
  params?: Record<string, string | number | boolean>; // 주요 파라미터(표시·복원용)
}

// 카드가 담는 레퍼런스 — 하단 프롬프트의 레퍼런스와 호환되는 최소 필드.
export interface SceneRef {
  file_path: string; // 'asset:{project}|{path}' 토큰 또는 원격 URL
  type: string; // 'image' | 'video'
  name?: string;
  thumb?: string | null;
  source_gen_id?: string | null;
  // 이 참조가 '연결된 레퍼런스 카드/리스트'에서 온 것인지 표시(gatherTarget 이 붙임). true 면 소스 연결이
  // 바뀌면 함께 사라져야 한다 — @·드래그로 직접 넣은 생성물 참조(source_gen_id, from_card 없음)만 보존.
  from_card?: boolean;
}

export interface SceneCard {
  id: string;
  kind: SceneCardKind;
  x: number;
  y: number;
  w?: number; // 생성 카드: 사용자가 조절한 너비(없으면 기본 CARD_W). 레퍼런스는 미사용(고정폭·자동높이).
  h?: number; // 생성 카드: 사용자가 조절한 높이(없으면 기본 CARD_H).
  refs?: SceneRef[]; // 레퍼런스 카드: 담긴 레퍼런스(순서)
  genId?: string | null; // 생성 카드: 현재 표시 중인 generation id(다중이면 그중 하나)
  genIds?: string[]; // 생성 카드: 이 카드에서 만들어진 모든 결과(누적, 오래된→최신). 배지·팝업용.
  prompt?: string; // 생성 카드: 작성 중인 프롬프트 초안(직렬화 텍스트). 카드 전환 시 이 카드로 복원.
  status?: "empty" | "pending" | "running" | "done" | "failed";
  text?: string; // text 노드: 입력한 텍스트 내용. / output 노드: 채널 이름. / head 노드: 제목 글씨.
  modelCfg?: SceneModelCfg; // model 노드: 고른 모델 설정 스냅샷.
  channel?: string; // input 노드: 참조할 output 카드 id(이름 아님 — 이름은 바뀌므로 id 로 고정).
  color?: string; // head 노드: 글씨 색(HEX).
  unchecked?: string[]; // render 노드: 체크 해제된(렌더 제외) 생성카드 id들. 없으면 전부 체크(=렌더 대상).
}

// 연결의 의미(입력 레인·색). 없으면 소스/타깃 kind 로 추론(resolveEdgeRole) — 기존 저장분 하위호환.
export type SceneEdgeRole = "model" | "ref" | "text" | "lineage" | "list";

export interface SceneEdge {
  id: string;
  from: string; // 출력 카드 id
  to: string; // 입력 카드 id
  role?: SceneEdgeRole; // 명시 역할(있으면 우선). 생성카드 입력 레인·색 결정에 사용.
  order?: number; // list 노드 수집 순서(없으면 소스 y 로 폴백).
}

// 카드 묶음(그룹).
//  · name: 헤더에 표시(더블클릭 편집)  · collapsed: 접으면 제목 막대로 축소(멤버 숨김·연결은 막대로 브릿지)
//  · rect: 수동 지정한 테두리 위치·크기. 없으면 멤버 바운딩박스로 자동(하위호환).
//  · color: 테두리·헤더 색.  멤버십(cardIds)은 카드를 그룹 안/밖으로 드롭할 때만 바뀐다.
export interface SceneGroup {
  id: string;
  name: string;
  cardIds: string[];
  collapsed?: boolean;
  rect?: { x: number; y: number; w: number; h: number };
  color?: string;
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

// ─────────────────────────────────────────────────────────────────────────
// 씬 저장/불러오기 (ComfyUI 워크플로우식 가벼운 텍스트) — 미디어 바이트는 안 넣고 참조(URL/토큰/genId)만.
//   같은 서버/팀이면 백엔드가 실제 미디어를 그려주므로 화면이 그대로 재현된다.
// ─────────────────────────────────────────────────────────────────────────
export const SCENE_EXPORT_FORMAT = "mv-scene";
export const SCENE_EXPORT_VERSION = 1;
export const SCENE_IMPORT_MAX_BYTES = 5 * 1024 * 1024; // 5MB — 텍스트라 충분히 큰 상한

const SCENE_CARD_KINDS: SceneCardKind[] = [
  "reference", "generation", "text", "model", "list", "view", "output", "input", "head", "render",
];

// 불러오기로 새 씬을 만들 때 쓰는 스냅샷(= Scene 에서 id/created_at 만 뺀 것).
export interface SceneSnapshot {
  name: string;
  cards: SceneCard[];
  edges: SceneEdge[];
  groups?: SceneGroup[];
  camera?: { z: number; x: number; y: number };
}

// 저장용 정규화 — 임시 상태만 정리하고 '내용'(refs 순서·프롬프트·텍스트)은 그대로 둔다.
//  · 생성 카드: 결과(genId/genIds)가 있으면 status 는 저장 안 함(실제 상태는 서버가 결정), 없으면 empty.
//  · refs 썸네일이 data:/blob: 이면 제거(무겁고 이식성 없음 — 실제 복원 기준은 file_path/genId).
function normalizeCardForExport(card: SceneCard): SceneCard {
  const c: SceneCard = { ...card };
  if (c.refs) {
    c.refs = c.refs.map((r) =>
      r.thumb && (r.thumb.startsWith("data:") || r.thumb.startsWith("blob:")) ? { ...r, thumb: null } : r,
    );
  }
  if (c.kind === "generation") {
    if ((c.genIds && c.genIds.length > 0) || c.genId) delete c.status;
    else c.status = "empty";
  }
  return c;
}

// 활성 씬 → 저장 텍스트(JSON). 다운로드해서 파일로 보관.
export function exportSceneText(scene: Scene): string {
  const snapshot: SceneSnapshot = {
    name: scene.name,
    cards: scene.cards.map(normalizeCardForExport),
    edges: scene.edges,
    groups: scene.groups,
    camera: scene.camera,
  };
  return JSON.stringify(
    { format: SCENE_EXPORT_FORMAT, version: SCENE_EXPORT_VERSION, savedAt: Date.now(), name: scene.name, scene: snapshot },
    null,
    2,
  );
}

// 저장 텍스트 → 검증된 스냅샷. 형식·버전·구조·알 수 없는 카드 종류를 막고, 실패 시 사용자 메시지로 throw.
export function parseSceneImport(text: string): SceneSnapshot {
  if (text.length > SCENE_IMPORT_MAX_BYTES) throw new Error("파일이 너무 큽니다(최대 5MB).");
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error("씬 파일을 읽을 수 없습니다(JSON 형식이 아님).");
  }
  const o = obj as Record<string, unknown>;
  if (!o || o.format !== SCENE_EXPORT_FORMAT) throw new Error("MV 씬 파일이 아닙니다.");
  if (o.version !== SCENE_EXPORT_VERSION) throw new Error(`지원하지 않는 씬 파일 버전입니다(v${String(o.version)}).`);
  const s = o.scene as Record<string, unknown> | undefined;
  if (!s || !Array.isArray(s.cards) || !Array.isArray(s.edges)) throw new Error("씬 데이터가 손상됐습니다.");
  for (const c of s.cards as SceneCard[]) {
    if (!c || typeof c.id !== "string" || !SCENE_CARD_KINDS.includes(c.kind)) {
      throw new Error("알 수 없는 카드가 있어 불러올 수 없습니다(버전이 다를 수 있음).");
    }
  }
  const name =
    typeof s.name === "string" && s.name
      ? s.name
      : typeof o.name === "string" && o.name
        ? (o.name as string)
        : "불러온 씬";
  // 엣지·그룹은 '손상 항목만 버리고' 나머지는 살린다(전체 거부보다 관대). 특히 group.cardIds 가 배열이
  // 아니면 렌더(memberBounds)에서 순회하다 크래시하므로 여기서 반드시 정제한다. 존재하지 않는 카드
  // id 참조는 렌더가 이미 건너뛰므로(cardById=null) 남겨도 안전.
  const cardIds = new Set((s.cards as SceneCard[]).map((c) => c.id));
  const edges = (s.edges as unknown[]).filter(
    (e): e is SceneEdge =>
      !!e &&
      typeof (e as SceneEdge).id === "string" &&
      typeof (e as SceneEdge).from === "string" &&
      typeof (e as SceneEdge).to === "string",
  );
  const rawGroups = Array.isArray(s.groups) ? (s.groups as unknown[]) : [];
  const groups = rawGroups
    .filter(
      (g): g is SceneGroup =>
        !!g && typeof (g as SceneGroup).id === "string" && Array.isArray((g as SceneGroup).cardIds),
    )
    .map((g) => ({
      ...g,
      name: typeof g.name === "string" ? g.name : "",
      cardIds: g.cardIds.filter((id) => typeof id === "string" && cardIds.has(id)), // 문자열 + 실제 존재 카드만
    }));
  return {
    name,
    cards: s.cards as SceneCard[],
    edges,
    groups: groups.length ? groups : undefined,
    camera: s.camera && typeof s.camera === "object" ? (s.camera as SceneSnapshot["camera"]) : undefined,
  };
}

// 스냅샷을 '새 씬'으로 저장(새 id/created_at). 이름은 그대로(탭에서 구분).
export function importScene(projectId: string | null, snap: SceneSnapshot): Scene {
  const scenes = listScenes(projectId);
  const scene: Scene = {
    id: uid(),
    name: snap.name || `씬 ${scenes.length + 1}`,
    cards: snap.cards,
    edges: snap.edges,
    groups: snap.groups,
    camera: snap.camera,
    created_at: Date.now(),
  };
  saveScenes(projectId, [...scenes, scene]);
  // 저장이 실제로 persist 됐는지 확인 — localStorage 가 꽉 차면 saveJSON 이 조용히 실패한다. 이때 그냥
  // 반환하면 활성씬 id 만 새로 잡히고 목록엔 없어 '빈 화면'이 된다. 실패면 throw 해서 호출부가 알린다.
  if (!listScenes(projectId).some((s) => s.id === scene.id)) {
    throw new Error("저장 공간이 부족해 씬을 불러오지 못했습니다.");
  }
  return scene;
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
