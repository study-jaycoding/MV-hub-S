// Canvas 씬(빈 캔버스) 데이터 레이어 — 카드·연결·카메라를 localStorage 에 프로젝트별로 보관.
// 생성 결과물 자체는 실제 generation(서버)이고, 여기 저장하는 건 "캔버스 편집물"(개인 로컬)뿐이다.
import { loadJSON, saveJSON } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";
import { getAccountNamespace } from "./accountScope";

export type SceneCardKind =
  | "reference"
  | "generation"
  | "text"
  | "set"
  | "model"
  | "list"
  | "view"
  | "output"
  | "input"
  | "head"
  | "render"
  | "comfy";

// 모델 노드 설정 — 하단 프롬프트(SpotlightOptionsBar)에서 고른 값의 스냅샷(표시·조직화용).
export interface SceneModelCfg {
  type?: string; // 'image' | 'video' 등
  model?: string; // 모델 id
  modelName?: string; // 표시용 이름
  params?: Record<string, string | number | boolean>; // 주요 파라미터(표시·복원용)
}

export interface SceneSetFolder {
  projectId: string;
  projectName?: string;
  path: string;
}

export interface SceneSetCfg {
  folder?: SceneSetFolder;
  tagsText?: string;
}

// Comfy 노드 설정 — ComfyUI API 워크플로우 + 노출·조절 파라미터 스냅샷(씬에 저장).
export interface SceneComfyCfg {
  name?: string; // 워크플로우 표시 이름(파일명 등)
  content?: string; // API 포맷 워크플로우 JSON 원문
  nodeCount?: number; // 파싱된 노드 수(표시용)
  paramExposed?: string[]; // 노출 선택한 "node|field" 목록
  paramValues?: Record<string, string | number | boolean>; // {"node|field": value} 현재 조절값
  // 노출 파라미터 메타 스냅샷(카드 인라인 컨트롤 렌더용) — 노출 순서 유지.
  params?: { key: string; label: string; type: "bool" | "number" | "text"; choices?: (string | number)[] | null }[];
  output?: { url: string; kind: "image" | "video" } | null; // (구) 단일 결과 — 하위호환용
  // 실행 결과(복수·혼합). saved_generation_id = '내 작업'에 저장한 gen id(표시용 캐시 — "저장됨" 배지).
  outputs?: { kind: "image" | "video" | "text"; url?: string; text?: string; saved_generation_id?: string }[];
  status?: "idle" | "running" | "done" | "failed"; // 실행 상태
  error?: string | null; // 실패 메시지
  // 현재 실행 소유자. 늦게 끝난 이전 실행이 새 실행의 상태를 덮어쓰지 않게 하는 메모리용 식별자.
  runId?: number;
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
  // 출처 — 'asset'(우리 에셋 패널에서 가져옴) vs 'upload'(임포트/캡쳐). 레퍼런스 카드 테두리 색 구분용.
  //  (없으면 upload 취급 = 파란색. 지문·제출에는 영향 없음.)
  origin?: "asset" | "upload";
}

// 캔버스가 생성 요청보다 먼저 저장하는 복구 표식. 브라우저가 요청 직후 종료돼도 generation id와
// 목적 카드가 로컬 씬에 남아, 다음 실행에서 서버 요청 기록과 다시 맞출 수 있다.
export interface CanvasGenerationAttempt {
  attemptId: string;
  generationId: string;
  createdAt: number;
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
  pendingGenerationAttempts?: CanvasGenerationAttempt[]; // 응답 전 종료 대비 생성 연결 복구 표식.
  prompt?: string; // 생성 카드: 작성 중인 프롬프트 초안(직렬화 텍스트). 카드 전환 시 이 카드로 복원.
  status?: "empty" | "pending" | "running" | "done" | "failed";
  text?: string; // text 노드: 입력한 텍스트 내용. / output 노드: 채널 이름. / head 노드: 제목 글씨.
  modelCfg?: SceneModelCfg; // model 노드: 고른 모델 설정 스냅샷.
  channel?: string; // input 노드: 참조할 output 카드 id(이름 아님 — 이름은 바뀌므로 id 로 고정).
  color?: string; // head 노드: 글씨 색(HEX).
  fontSize?: number; // head 노드: 글씨 크기(px). 박스는 글씨에 맞춰 자동 크기.
  unchecked?: string[]; // render 노드: 체크 해제된(렌더 제외) 생성카드 id들. 없으면 전부 체크(=렌더 대상).
  listOrder?: string[]; // list 노드: 중첩/무선으로 펼쳐진 레퍼런스 카드 id의 이 리스트 전용 순서.
  batchCount?: number; // 이 노드에서 한 번에 생성할 장수(배치). 노드마다 각자 관리(없으면 1). 실제 사용은 cardBatch().
  comfyCfg?: SceneComfyCfg; // comfy 노드: ComfyUI 워크플로우·파라미터·실행결과 스냅샷.
  setCfg?: SceneSetCfg; // set 노드: 생성 목적 폴더 + 생성물에 적용할 일반 등록 태그.
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

// 씬 저장 버킷 키. ★계정별 네임스페이스 — 팀 서버에서 한 브라우저를 여러 계정이 써도 안 섞이게,
//  계정 전환 시 서로 지워지지 않게. 인증 계정을 탭별 sessionStorage 에 고정해 다른 탭의 로그인으로
//  activeAccount 가 바뀌어도 이미 열린 탭의 저장 대상은 바뀌지 않는다.
//  AUTH off 로컬(로그인 없음)은 'local' 네임스페이스. legacyKeyOf = 네임스페이스 도입 전 옛 키(1회 이관용).
const keyOf = (projectId: string | null | undefined) => `${getAccountNamespace()}::${projectId || "_none"}`;
const legacyKeyOf = (projectId: string | null | undefined) => projectId || "_none";

// 네임스페이스 도입 전 옛 버킷을 현재 계정 버킷으로 1회 이관(작업 유실 방지). 이관 후 옛 키는 제거해
//  같은 브라우저의 다른 계정이 다시 가져가지 않게 한다. map 을 제자리에서 바꾸고 이관 여부를 반환.
function migrateLegacyBucket<T>(map: Record<string, T>, projectId: string | null | undefined): boolean {
  const k = keyOf(projectId);
  const legacy = legacyKeyOf(projectId);
  // 현재 계정 버킷에 '내용'이 있으면 이관 안 함. ★빈 버킷([])만 있어도 이관받아야 한다 —
  //  안 그러면 legacy 가 남아 다른 계정이 나중에 가져가(재귀속) 버린다.
  const existing = map[k] as unknown;
  const nsHasContent = Array.isArray(existing) ? existing.length > 0 : existing !== undefined;
  if (k === legacy || nsHasContent) return false;
  const val = map[legacy] as unknown;
  if (val === undefined || (Array.isArray(val) && val.length === 0)) return false; // 이관할 옛 내용 없음
  map[k] = map[legacy];
  delete map[legacy];
  return true;
}

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 카드의 배치수(한 번에 생성할 장수) — 표시·실행 공용. 임포트/저장값이 범위를 벗어나거나 숫자가 아니어도
// 1~4 정수로 안전화한다(예: 손상된 씬에 batchCount:99 나 NaN 이 들어와도 폭주/실패하지 않게).
export function cardBatch(card?: { batchCount?: number } | null): number {
  const n = Math.trunc(Number(card?.batchCount));
  return Number.isFinite(n) ? Math.max(1, Math.min(4, n)) : 1;
}

// 생성 카드의 변형(결과) id 목록 — genIds(누적) + legacy genId 를 합쳐 중복 제거, 순서 보존.
export function variantIds(card: Pick<SceneCard, "genIds" | "genId">): string[] {
  const out: string[] = [];
  for (const id of card.genIds || []) if (id && !out.includes(id)) out.push(id);
  if (card.genId && !out.includes(card.genId)) out.push(card.genId);
  return out;
}

// undo/redo 복원 시 '사용자가 고른 현재 대표(genId)'는 유지 — 대표 선택은 되돌리기 대상에서 제외(사용자 요구).
//  현재 카드(currentCards)의 대표를 복원 대상(targetCards)에 병합한다. 대표가 target 변형목록에 없으면(그 시점엔
//  없던 새 변형) 목록에 포함시켜 깨진 참조를 막는다. 현재 대표가 없는 카드(빈 카드 등)는 스냅샷 그대로 둔다.
//  삭제로 대표가 바뀐 경우는 현재 대표(cur.genId)가 이미 새 값이라 그대로 유지되어 정상이다.
export function preserveRepresentatives(targetCards: SceneCard[], currentCards: SceneCard[]): SceneCard[] {
  const curById = new Map(currentCards.map((c) => [c.id, c] as const));
  return targetCards.map((tc) => {
    const cur = curById.get(tc.id);
    const rep = cur?.genId;
    if (!rep || rep === tc.genId) return tc;
    // comfy 는 워크플로(content)가 같을 때만 대표 보존 — 워크플로 교체 후엔 옛 워크플로 결과를 새 워크플로에
    //  붙이지 않는다(#3 propagate 가드와 동일). content 가 다르면 스냅샷 그대로 두어 옛 genId 를 주입하지 않는다.
    if (tc.kind === "comfy" && tc.comfyCfg?.content !== cur?.comfyCfg?.content) return tc;
    if (variantIds(tc).includes(rep)) return { ...tc, genId: rep };
    return { ...tc, genId: rep, genIds: [...(tc.genIds || []), rep] };
  });
}

// comfy '실행중(running)' 상태는 메모리 전용(웨이브·모듈 store 가 표시 담당) — 저장/로드 스냅샷에서는
//  완료형으로 정규화한다. 안 하면 실행 중 씬 전환·새로고침·크래시 때 status:"running" 이 디스크에 박제돼
//  카드가 '영원히 생성중'으로 보인다(사용자 보고). keep(id)=true 인 카드(지금 실제 실행 중)는 그대로 둔다.
//  running → 결과가 있으면 done(이전 결과 표시 유지), 없으면 idle. 변경 없으면 원본 배열 그대로(참조 보존).
export function settleComfyRunning(cards: SceneCard[], keep?: (id: string) => boolean): SceneCard[] {
  let changed = false;
  const out = cards.map((c) => {
    if (c.kind !== "comfy" || c.comfyCfg?.status !== "running") return c;
    if (keep?.(c.id)) return c;
    changed = true;
    // 결과 판정은 신형 outputs + 하위호환 단일 output.url 둘 다 — 레거시 카드가 결과를 보여주면서 idle 로 남지 않게.
    const hasResult = !!c.comfyCfg.outputs?.length || !!c.comfyCfg.output?.url;
    return { ...c, comfyCfg: { ...c.comfyCfg, status: hasResult ? ("done" as const) : ("idle" as const) } };
  });
  return changed ? out : cards;
}

// 레퍼런스 목록의 "내용 지문" — 순서·값이 같으면 같은 문자열. uid/role 같은 표시용 필드는 제외.
// 씬 카드 ↔ 하단 프롬프트 트레이 동기화에서 '내 편집의 에코'를 걸러내 무한 갱신을 막는 데 쓴다.
//  ★from_card 포함: 소스 연결로 같은 참조의 출처만 바뀌어도(직접@→연결) 트레이가 최신화돼야 유령 참조를
//   막는다. undefined 를 그대로 넣으면 JSON 이 null 로 직렬화돼 false 와 달라지므로 ?? false 로 정규화.
export function sceneRefFingerprint(
  refs: Pick<SceneRef, "file_path" | "type" | "name" | "thumb" | "source_gen_id" | "from_card">[],
): string {
  return JSON.stringify(
    refs.map((r) => [r.file_path, r.type, r.name ?? "", r.thumb ?? "", r.source_gen_id ?? "", r.from_card ?? false]),
  );
}


function loadAll(): ScenesByProject {
  return loadJSON<ScenesByProject>(STORAGE_KEYS.scenes) || {};
}

// DB 미러 훅 — saveAll(단일 쓰기 관문) 뒤 호출된다. sceneBackup.ts(씬 전체)와
// sceneCardLinks.ts(카드 소속)가 각각 등록한다(순환 import 회피). 둘은 저장 대상이 달라
// 서로 대체하지 않으므로 구독 목록으로 둔다 — 단일 슬롯이면 나중에 등록한 쪽이 앞을 지운다.
const scenesPersistedSubs = new Set<() => void>();
export function subscribeScenesPersisted(fn: () => void): () => void {
  scenesPersistedSubs.add(fn);
  return () => scenesPersistedSubs.delete(fn);
}

function saveAll(all: ScenesByProject) {
  saveJSON(STORAGE_KEYS.scenes, all);
  scenesPersistedSubs.forEach((fn) => fn());
}

// 이 계정의 씬 버킷 '키'가 존재하는가 — DB 복구 허용 판정(코덱스 P1: 빈 배열 버킷은 정상 삭제의
// 결과라 복구 금지, 키 자체가 없을 때만 복구). legacy 키가 남아 있으면 이관 대상이므로 존재로 취급.
export function hasSceneBucket(projectId: string | null): boolean {
  const all = loadAll();
  return keyOf(projectId) in all || legacyKeyOf(projectId) in all;
}

export function listScenes(projectId: string | null): Scene[] {
  const all = loadAll();
  if (migrateLegacyBucket(all, projectId)) saveAll(all); // 옛 씬을 현재 계정으로 1회 이관
  return all[keyOf(projectId)] || [];
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
  "reference", "generation", "text", "set", "model", "list", "view", "output", "input", "head", "render",
  "comfy",
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

const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// 불러온 카드의 소비처 크래시를 막는 최소 정규화: 좌표는 유한수로, 배열/객체여야 하는 필드는 형태를 강제한다.
//  (손상/악성 씬 파일이 refs.map·genIds 순회·comfyCfg.outputs.filter·arrangeNodes 좌표계산에서 터지는 것 방지.)
function sanitizeImportedCard(c: SceneCard): SceneCard {
  const out: SceneCard = { ...c, x: isFiniteNum(c.x) ? c.x : 0, y: isFiniteNum(c.y) ? c.y : 0 };
  if (c.w !== undefined && !isFiniteNum(c.w)) delete out.w;
  if (c.h !== undefined && !isFiniteNum(c.h)) delete out.h;
  if (c.refs !== undefined && !Array.isArray(c.refs)) delete out.refs;
  if (c.genIds !== undefined && !Array.isArray(c.genIds)) delete out.genIds;
  if (c.listOrder !== undefined) {
    if (!Array.isArray(c.listOrder)) delete out.listOrder;
    else out.listOrder = c.listOrder.filter((id): id is string => typeof id === "string");
  }
  if (c.setCfg !== undefined) {
    if (!c.setCfg || typeof c.setCfg !== "object" || Array.isArray(c.setCfg)) delete out.setCfg;
    else {
      const folder = c.setCfg.folder;
      const folderProjectId = typeof folder?.projectId === "string" ? folder.projectId.trim() : "";
      const folderProjectName =
        typeof folder?.projectName === "string" ? folder.projectName.trim() : "";
      const folderPath =
        typeof folder?.path === "string"
          ? folder.path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
          : "";
      const folderSegments = folderPath.split("/").filter(Boolean);
      const validFolder =
        !!folderProjectId &&
        folderSegments.length > 0 &&
        !folderSegments.some((segment) => segment === "." || segment === "..");
      out.setCfg = {
        ...(validFolder
          ? {
              folder: {
                projectId: folderProjectId,
                ...(folderProjectName ? { projectName: folderProjectName } : {}),
                path: folderSegments.join("/"),
              },
            }
          : {}),
        ...(typeof c.setCfg.tagsText === "string" ? { tagsText: c.setCfg.tagsText } : {}),
      };
    }
  }
  const cfg = c.comfyCfg;
  if (cfg !== undefined) {
    if (!cfg || typeof cfg !== "object") delete out.comfyCfg;
    else {
      const nc: SceneComfyCfg = { ...cfg };
      if (nc.outputs !== undefined && !Array.isArray(nc.outputs)) delete nc.outputs;
      if (nc.params !== undefined && !Array.isArray(nc.params)) delete nc.params;
      if (nc.paramExposed !== undefined && !Array.isArray(nc.paramExposed)) delete nc.paramExposed;
      if (nc.paramValues !== undefined &&
          (!nc.paramValues || typeof nc.paramValues !== "object" || Array.isArray(nc.paramValues))) {
        delete nc.paramValues;
      }
      out.comfyCfg = nc;
    }
  }
  return out;
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
  const seenCardIds = new Set<string>();
  const cards: SceneCard[] = [];
  for (const c of s.cards as SceneCard[]) {
    if (!c || typeof c.id !== "string" || !SCENE_CARD_KINDS.includes(c.kind)) {
      throw new Error("알 수 없는 카드가 있어 불러올 수 없습니다(버전이 다를 수 있음).");
    }
    if (seenCardIds.has(c.id)) continue; // 중복 id 제거(첫 것 유지) — 렌더/매핑 혼란 방지
    seenCardIds.add(c.id);
    cards.push(sanitizeImportedCard(c)); // 좌표·배열·comfyCfg 형태 강제
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
  const cardIds = new Set(cards.map((c) => c.id));
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
  // 카메라도 유한수 3값일 때만 채택(NaN/문자열이면 기본 뷰로 — 렌더 좌표 계산 보호).
  const cam = s.camera as { x?: unknown; y?: unknown; z?: unknown } | null | undefined;
  const camera =
    cam && typeof cam === "object" && isFiniteNum(cam.x) && isFiniteNum(cam.y) && isFiniteNum(cam.z)
      ? { x: cam.x, y: cam.y, z: cam.z }
      : undefined;
  return {
    name,
    cards,
    edges,
    groups: groups.length ? groups : undefined,
    camera,
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
  if (migrateLegacyBucket(map, projectId)) saveJSON(STORAGE_KEYS.scenesActive, map); // '마지막 연 씬'도 계정별
  return map[keyOf(projectId)] || null;
}

export function setActiveSceneId(projectId: string | null, sceneId: string | null) {
  const map = loadJSON<Record<string, string>>(STORAGE_KEYS.scenesActive) || {};
  if (sceneId) map[keyOf(projectId)] = sceneId;
  else delete map[keyOf(projectId)];
  saveJSON(STORAGE_KEYS.scenesActive, map);
}
