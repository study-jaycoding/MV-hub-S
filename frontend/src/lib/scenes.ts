// Canvas 씬(빈 캔버스) 데이터 레이어 — 카드·연결·카메라를 프로젝트별로 보관.
// 생성 결과물 자체는 실제 generation(서버)이고, 여기 저장하는 건 "캔버스 편집물"(개인 로컬)뿐이다.
// ★저장 자리는 IndexedDB(sceneStore)다. 옛 localStorage 는 출처당 약 5MB 라 큰 씬 9개면 찼다.
//  '마지막 연 씬'(scenesActive)처럼 작은 값은 그대로 localStorage 에 남는다.
import { loadJSON, saveJSON } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";
import { getAccountNamespace } from "./accountScope";
import { sceneBodySum } from "./sceneAbsorb";
import {
  applySceneOp,
  captureSceneOps,
  hasConfirmedBucket,
  hasWorkingBucket,
  readConfirmedBucket,
  readWorkingBucket,
  sceneStoreConflicts,
  setSceneFlushListener,
  settleConflictsAsCopies,
  workingBucketLength,
  type SceneOpMerge,
} from "./sceneStore";

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
  // 파일 내용 지문·크기(2026-09-28) — 원본이 옮겨져도 **내용으로 다시 찾기** 위한 표식.
  // 없어도 동작한다(옛 씬). 씬 파일로 함께 나가고 들어온다. 에셋 대장 번호가 붙은 뒤에는 '넣을 때 판'이다.
  content_sha?: string;
  bytes?: number;
  // 에셋 대장 번호(2026-09-30, docs/ASSET_REGISTRY.md) — NAS 파일의 논리 번호. 이름을 바꾸거나 옮겨도 같은 번호라
  // 레퍼런스 찾기가 새 자리로 따라간다(고쳐 저장한 새 판이어도). 서버 답(open_ids·fixed)으로만 붙는다.
  registry_asset_id?: string;
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
export type SceneEdgeRole = "model" | "ref" | "text" | "set" | "lineage" | "list";
// 다입력 카드(생성·comfy) 입력 포트의 물리 레인 — 위=모델, 중앙=레퍼런스(계보 포함), 아래=텍스트, 맨아래=세트(Set 노드 전용).
export type ScenePortLane = "model" | "ref" | "text" | "set";

export interface SceneEdge {
  id: string;
  from: string; // 출력 카드 id
  to: string; // 입력 카드 id
  role?: SceneEdgeRole; // 명시 역할(있으면 우선). 생성카드 입력 레인·색 결정에 사용.
  order?: number; // list·render 수집 순서(리스트 안에서 순서를 바꿀 때 기록). 없으면 '연결한 순서'(엣지 배열 순서).
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
  // 이 캔버스가 속한 팀 워크스페이스(탭 우클릭으로 지정, 없으면 '지정 없음' = 어디서나 정상 표시).
  // 판정·표시 규칙은 sceneWorkspace.ts. **생성 크레딧이 빠지는 공간**이다 — 이 브라우저에서 사람이 고른 것만 담는다.
  workspace?: { id: string; name: string | null };
  // 씬 파일로 받은 '보낸 사람 캔버스의 공간'(2026-09-29) — 그림을 그 공간 폴더부터 찾으라는 **힌트일 뿐**이다.
  // workspace 에 넣으면 남의 씬을 여는 것만으로 과금 공간이 바뀌거나 생성이 막혔다. 찾기 열쇠는 sceneRefWorkspaceId.
  refWorkspaceHint?: { id: string; name: string | null };
  // 옛 판 창과 엇갈려 따로 살려 둔 사본이라는 표식(recoverSceneConflicts) — id = 원래 씬, sum = 만들 때의 내용 지문.
  // 같은 씬이 또 엇갈렸을 때 '손대지 않은 사본'이면 새 탭을 늘리지 않고 이 탭을 갈아 끼우려고 둔다.
  recoveredFrom?: { id: string; sum: string };
  created_at: number;
}

// 계정×프로젝트 버킷 → 그 버킷의 씬 목록. 저장소 계층(sceneStore·sceneAbsorb)이 같은 모양을 쓴다.
export type ScenesByProject = Record<string, Scene[]>;

// 씬 저장 버킷 키. ★계정별 네임스페이스 — 팀 서버에서 한 브라우저를 여러 계정이 써도 안 섞이게,
//  계정 전환 시 서로 지워지지 않게. 인증 계정을 탭별 sessionStorage 에 고정해 다른 탭의 로그인으로
//  activeAccount 가 바뀌어도 이미 열린 탭의 저장 대상은 바뀌지 않는다.
//  AUTH off 로컬(로그인 없음)은 'local' 네임스페이스. legacyKeyOf = 네임스페이스 도입 전 옛 키(1회 이관용).
const keyOf = (projectId: string | null | undefined) => `${getAccountNamespace()}::${projectId || "_none"}`;
const legacyKeyOf = (projectId: string | null | undefined) => projectId || "_none";

// 네임스페이스 도입 전 옛 버킷을 현재 계정 버킷으로 1회 이관(작업 유실 방지). 이관 후 옛 키는 제거해
//  같은 브라우저의 다른 계정이 다시 가져가지 않게 한다. map 을 제자리에서 바꾸고 이관 여부를 반환.
// ★대상 키를 **인자로 받는다**. 안에서 다시 계산하면 저장 큐에서 기다리는 사이에 계정이 바뀌었을 때
//  그 계정 버킷으로 옛 씬이 귀속된다(Codex 재현) — 키는 접수 시점에 고정해 넘긴다.
function migrateLegacyBucket<T>(
  map: Record<string, T>,
  projectId: string | null | undefined,
  targetKey?: string,
): boolean {
  const k = targetKey ?? keyOf(projectId);
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


// ── 저장소 접점 ─────────────────────────────────────────────────────────────────
// 읽기·쓰기 모두 **동기**다. 저장 자리는 IndexedDB 지만, sceneStore 가 '동기 얼굴'을 준다 —
// 쓰기는 그 틱에 화면이 읽는 값(working)에 반영되고, 저장소 확정은 뒤따른다. 앱 계층이 전부
// "저장은 그 틱에 끝난다"를 전제로 짜여 있어서(밀린 입력 확정 → 곧바로 읽기 → 패치), 그 전제를
// 지키는 쪽이 앱 곳곳을 기다리게 고치는 것보다 안전했다(2026-10-07, Codex 합의).
//  · 동기 반환의 '성공'은 **화면 값에 반영됐다**는 뜻이다. 저장소에 확정됐는지는
//    confirmSceneWrite 가 주는 Promise 로만 안다 — 내구성이 필요한 흐름(생성 제출 전 표식·백업
//    복구 보고·판정 기억)만 그것을 기다린다.
//  · 확정이 실패하면 화면은 그대로 두고 알린다(subscribeSceneSaveState). 저장소는 간격을 늘려 다시
//    시도한다. 종전(1단계)의 '되돌림'은 버렸다 — 작업을 화면에서 빼앗으면 파일로 건질 수도 없다.

// 접수 때 입력을 복사해 고정한다 — 연산은 나중에 저장소 내용 위에서 다시 실행되므로(재생), 호출부가
// 넘긴 배열·객체를 그 뒤에 고치면 화면과 저장본이 갈린다. JSON 왕복이 아니라 structuredClone 인 까닭:
// 값이 undefined 인 키를 지켜야 한다(`{ workspace: undefined }` = 그 필드를 지운다).
function frozen<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T; // 복제 못 하는 값이 섞였다 — 종전 저장(JSON)과 같게 떨군다
  }
}

// DB 미러 훅 — 씬이 저장소에 **확정된 뒤** 호출된다. sceneBackup.ts(씬 전체)와
// sceneCardLinks.ts(카드 소속)가 각각 등록한다(순환 import 회피). 둘은 저장 대상이 달라
// 서로 대체하지 않으므로 구독 목록으로 둔다 — 단일 슬롯이면 나중에 등록한 쪽이 앞을 지운다.
// ★미러는 확정본(listPersistedScenes)만 읽는다. 화면 값에는 아직 확정 안 된 편집이 섞여 있어,
//  그것을 올리면 저장되지도 않은 삭제가 서버 백업에 반영된다(Codex).
const scenesPersistedSubs = new Set<() => void>();
export function subscribeScenesPersisted(fn: () => void): () => void {
  scenesPersistedSubs.add(fn);
  return () => scenesPersistedSubs.delete(fn);
}

// 저장 실패/복귀 훅 — 화면이 사용자에게 알리기 위한 것. ★호출부마다 붙이지 않고 관문 하나에서 내보낸다:
// 저장 경로는 여럿인데(편집·이름·삭제·정렬·복구·이관) 어느 하나라도 알림을 빠뜨리면 사용자는 편집이
// 사라지는 것만 보고 '버그'로 읽는다(2026-10-07 실제 신고). 상태가 바뀔 때만 부른다 — 연속 실패에
// 매번 띄우면 알림이 폭주한다.
const saveStateSubs = new Set<(failed: boolean) => void>();
let saveFailing = false;
let lastNotifiedAt = 0;
// 이미 실패 중인데 늦게 구독한 화면에도 한 번은 알린다 — 부팅 직후의 저장이 실패하면 구독보다
// 먼저라, 안 알리면 그 세션 내내 조용하다(적대 리뷰 P1, 코덱스 재현).
export function subscribeSceneSaveState(fn: (failed: boolean) => void): () => void {
  saveStateSubs.add(fn);
  if (saveFailing) {
    lastNotifiedAt = Date.now();
    fn(true);
  }
  return () => saveStateSubs.delete(fn);
}
/** 지금 저장소 확정이 실패하고 있는가 — 화면의 상시 '저장 안 됨' 표시용. */
export const isSceneSaveFailing = (): boolean => saveFailing;
// 실패가 계속되는 동안에도 가끔은 다시 알린다 — 화면 알림이 한 칸뿐이라 뒤에 온 다른 알림
// ("생성 시작" 등)이 경고를 덮으면, 상태가 안 바뀌었다는 이유로 영영 다시 안 뜬다(적대 리뷰 P2).
const RENOTIFY_MS = 30_000;
function reportSaveState(failed: boolean): void {
  const changed = failed !== saveFailing;
  saveFailing = failed;
  if (!changed && !(failed && Date.now() - lastNotifiedAt >= RENOTIFY_MS)) return;
  lastNotifiedAt = Date.now();
  saveStateSubs.forEach((fn) => fn(failed));
}

// 저장소가 확정에 성공/실패할 때마다 — 실패는 알림으로, 성공은 DB 미러로.
// ★실패했으면 미러 구독자를 부르지 않는다 — 저장소 내용이 그대로라 올릴 것도 없다.
setSceneFlushListener((ok) => {
  reportSaveState(!ok);
  if (ok) scenesPersistedSubs.forEach((fn) => fn());
});

// 씬 쓰기의 단일 관문. mutate 는 화면 값에 한 번, 저장소 내용 위에서 다시(재생) 실행된다 —
// **순수**해야 한다: id·시각·계정 키·입력은 밖에서 고정해 넣고, 버킷은 새 배열로 갈아 끼운다.
function commit<T, P = never>(
  mutate: (all: ScenesByProject) => { write: boolean; value: T },
  options?: { confirmedOnly?: boolean; merge?: SceneOpMerge<P> },
): { ok: boolean; value: T } {
  return applySceneOp(mutate, options);
}

/**
 * `write` 안에서 한 쓰기가 **저장소에 확정됐는지**를 함께 돌려준다.
 * 내구성이 필요한 흐름만 쓴다 — 예: 생성 요청을 보내기 전에 '어느 카드 것인지' 표식이 남았는지.
 * false = 이번 시도에 확정되지 못했다(그 쓰기는 화면에 남아 있고 저장소가 다시 시도한다).
 */
export const confirmSceneWrite = captureSceneOps;

// 이 계정의 씬 버킷 '키'가 존재하는가(화면 값 기준). legacy 키가 남아 있으면 이관 대상이므로 존재로 취급.
export function hasSceneBucket(projectId: string | null): boolean {
  return hasWorkingBucket(keyOf(projectId)) || hasWorkingBucket(legacyKeyOf(projectId));
}
// 같은 질문을 **확정본**에 — DB 복구 허용 판정용(코덱스 P1: 빈 배열 버킷은 정상 삭제의 결과라 복구 금지,
// 키 자체가 없을 때만 복구). ★화면 값으로 판정하면, 아직 확정 안 된 버킷 때문에 복구를 건너뛴 뒤
//  빈 확정본을 기준으로 서버 백업을 지우는 길이 열린다(Codex).
export function hasPersistedSceneBucket(projectId: string | null): boolean {
  return hasConfirmedBucket(keyOf(projectId)) || hasConfirmedBucket(legacyKeyOf(projectId));
}

// 네임스페이스 도입 전 옛 버킷을 이 계정으로 귀속시킨다. ★**확정된 뒤에만 보인다**(confirmedOnly) —
// 먼저 화면에 보여 주면, 다른 계정 창이 그사이 먼저 귀속을 확정했을 때 이 창은 남의 것이 된 씬을
// 보고 고치게 된다(Codex). 부팅 때는 bootSceneStore 가 확정까지 기다리므로 첫 화면부터 보이고,
// 세션 중 계정이 바뀐 경우에는 확정 직후 목록이 갱신된다(subscribeSceneStoreExternal).
const adoptionInFlight = new Set<string>();
export function adoptLegacyBucket(projectId: string | null): Promise<boolean> {
  const key = keyOf(projectId); // ★접수 시점의 계정으로 고정
  const legacy = legacyKeyOf(projectId);
  if (key === legacy || !hasWorkingBucket(legacy) || adoptionInFlight.has(key)) return Promise.resolve(true);
  adoptionInFlight.add(key);
  const { confirmed } = confirmSceneWrite(() =>
    commit((all) => ({ write: migrateLegacyBucket(all, projectId, key), value: undefined }), {
      confirmedOnly: true,
    }),
  );
  return confirmed.finally(() => adoptionInFlight.delete(key));
}

export function listScenes(projectId: string | null): Scene[] {
  void adoptLegacyBucket(projectId); // 옛 버킷이 남아 있을 때만 일한다(평소엔 키 하나 확인하고 끝)
  return readWorkingBucket(keyOf(projectId));
}

/** 저장소에 확정된 목록만 — DB 미러가 올릴 내용. 화면에는 listScenes 를 쓴다. */
export function listPersistedScenes(projectId: string | null): Scene[] {
  return readConfirmedBucket(keyOf(projectId));
}

// 버킷 목록을 통째로 놓는다. 반환 = 화면 값에 반영됐나.
// ★통째로 놓는 연산이라 다른 창이 그 버킷에 한 동시 변경과는 '나중 것이 이긴다'. 지금 목록에서
//  계산해야 하는 변경은 updateScenesWith 를 쓴다(저장소 내용 위에서 다시 계산된다).
export function saveScenes(projectId: string | null, scenes: Scene[]): boolean {
  const key = keyOf(projectId); // ★접수 시점의 계정으로 고정
  const list = frozen(scenes);
  return commit((all) => {
    all[key] = list;
    return { write: true, value: undefined };
  }).ok;
}

/**
 * 지금 목록을 받아 새 목록을 만드는 변경(탭 순서·카드 소속 합치기·자산 재연결).
 *
 * fn 은 화면 값에 한 번, 저장소 내용 위에서 다시 실행된다 — 그래서 다른 창이 그사이 더한 씬 위에
 * 얹힌다. **순수**해야 한다: 바깥 변수에 결과를 적거나 바깥 상태를 읽지 않는다.
 * @param fn null 을 돌려주면 저장하지 않는다(바꿀 것이 없을 때).
 */
export function updateScenesWith(
  projectId: string | null,
  fn: (current: Scene[]) => Scene[] | null,
): boolean {
  const key = keyOf(projectId); // ★접수 시점의 계정으로 고정
  return commit((all) => {
    const next = fn(all[key] || []);
    if (!next) return { write: false, value: undefined };
    all[key] = next;
    return { write: true, value: undefined };
  }).ok;
}

/**
 * DB 백업에서 받은 씬을 합친다 — **같은 id 는 로컬이 이긴다**(로컬이 정답).
 * 합치기가 연산 안에 있어서, 서버 응답을 기다리는 사이에 만들어진 씬을 덮지 않는다.
 * @returns added = 실제로 더해진 씬(이미 로컬에 있던 것은 뺀다)
 */
export function mergeScenesFromBackup(
  projectId: string | null,
  incoming: Scene[],
): { ok: boolean; added: Scene[] } {
  const key = keyOf(projectId); // ★접수 시점의 계정으로 고정
  const list = frozen(incoming);
  const out = commit((all) => {
    const local = all[key] || [];
    const localIds = new Set(local.map((s) => s.id));
    const added = list.filter((s) => !localIds.has(s.id));
    if (!added.length) return { write: false, value: added };
    all[key] = local.concat(added);
    return { write: true, value: added };
  });
  return { ok: out.ok, added: out.value };
}

// ★화면 값에 반영하지 못하면 null — 종전에는 저장 못 한 씬을 그대로 돌려줘, 호출부가 목록에 없는
//  씬을 활성 탭으로 골라 빈 화면에 갇혔다(적대 리뷰 r3).
export function createScene(projectId: string | null, name?: string): Scene | null {
  const key = keyOf(projectId); // ★접수 시점의 계정으로 고정
  // id·시각·이름은 여기서 정한다 — 연산 안에서 만들면 재생 때마다 다른 씬이 된다.
  const scene: Scene = {
    id: uid(),
    name: name || `씬 ${workingBucketLength(key) + 1}`,
    cards: [],
    edges: [],
    created_at: Date.now(),
  };
  const out = commit((all) => {
    migrateLegacyBucket(all, projectId, key);
    all[key] = [...(all[key] || []), scene];
    return { write: true, value: undefined };
  });
  // 돌려주는 것은 사본이다 — 저장소가 든 객체를 내주면 받은 쪽의 수정이 저장소 값을 바꾼다.
  return out.ok ? frozen(scene) : null;
}

// 씬 쓰기 결과. ★'화면 값에 반영 못 함'과 '요청한 대상이 없음'은 다른 실패다(적대 리뷰 r3) —
//  · storage: 저장소가 받지 않았다(아직 안 열림, 또는 오래 막혀 밀린 연산이 상한에 닿음). 편집이 남지 않았다.
//  · missing: 대상 씬이 없어 바뀐 것이 없다(다른 창이 먼저 지움).
//  종전에는 둘 다 '성공'으로 보여, 없는 씬에 쓴 편집이 저장된 것처럼 보였다.
//  (저장소 **확정** 실패는 여기로 오지 않는다 — 뒤따르는 일이라 subscribeSceneSaveState 가 알린다.)
export type SceneWriteFailure = "storage" | "missing";
export type SceneWriteResult =
  | { ok: true; scenes: Scene[] }
  | { ok: false; reason: SceneWriteFailure };

// 대상 씬을 갱신하고 '갱신된 목록'을 반환한다(호출부가 다시 읽지 않게).
// ★반환 목록의 고친 씬에는 **호출부가 넘긴 patch 를 그대로** 얹는다(복사본이 아니라). 캔버스는
//  자기가 넘긴 cards 배열을 그대로 되받아야 '바뀐 게 없다'로 보고 다시 그리지 않는다(종전과 같은 참조).
export function updateScene(
  projectId: string | null,
  sceneId: string,
  patch: Partial<Scene>,
): SceneWriteResult {
  const key = keyOf(projectId); // ★접수 시점의 계정으로 고정
  const stored = frozen(patch);
  const apply = (all: ScenesByProject, fields: Partial<Scene>) => {
    const migrated = migrateLegacyBucket(all, projectId, key); // 옛 씬을 현재 계정으로 1회 이관
    const current = all[key] || [];
    const found = current.some((s) => s.id === sceneId);
    // ★대상도 없고 이관할 것도 없으면 쓰지 않는다 — 쓰면 없던 계정 버킷이 '빈 배열'로 생기고,
    //  DB 자동복구는 '버킷 키 자체가 없을 때'만 돌므로 복구 경로가 막힌다(코덱스 리뷰).
    if (!found && !migrated) return { write: false, value: found };
    all[key] = current.map((s) => (s.id === sceneId ? { ...s, ...fields } : s));
    return { write: true, value: found };
  };
  // 같은 씬을 잇달아 고치는 연산은 하나로 합친다(뒤 입력이 같은 필드를 덮는다 — 차례로 재생한 것과 같다).
  // 캔버스 편집의 거의 전부가 이것이라, 저장소가 막혀 있어도 밀린 연산이 쌓이지 않는다.
  const out = commit((all) => apply(all, stored), {
    merge: {
      slot: `update\u0000${key}\u0000${sceneId}`,
      patch: stored,
      join: (previous, next) => ({ ...previous, ...next }),
      replay: (all, fields) => {
        apply(all, fields);
      },
    },
  });
  if (!out.value) return { ok: false, reason: "missing" };
  if (!out.ok) return { ok: false, reason: "storage" };
  return {
    ok: true,
    scenes: readWorkingBucket(key).map((s) => (s.id === sceneId ? { ...s, ...patch } : s)),
  };
}

// ── 옛 판 창과 엇갈린 씬 ─────────────────────────────────────────────────────────
// 옛 판으로 떠 있는 창과 이 창이 같은 씬을 각자 고치면 자동으로 합칠 수 없다(sceneAbsorb). 저장소는
// 덮지 않고 양쪽을 보관해 둔다. 사람이 고르는 화면을 따로 두지 않고, **옛 창 쪽 내용을 새 탭으로 살려
// 둔다** — 둘 다 남으므로 잃는 것이 없고, 필요 없는 쪽은 사용자가 지우면 된다.
// ★표식은 이름 **앞**에 붙인다 — 탭은 이름을 12자에서 자르므로(shortSceneName) 뒤에 붙이면 잘려서
//  원래 탭과 똑같이 보인다(화면 시험에서 드러남).
const CONFLICT_COPY_PREFIX = "[옛 창] ";

/** 이 계정에 정리할 충돌이 있는가. */
export function hasSceneConflicts(): boolean {
  const key = keyOf(null);
  return sceneStoreConflicts().some((conflict) => conflict.bucket === key);
}

/**
 * 이 계정의 충돌을 정리한다 — 옛 창 쪽 내용을 새 탭으로 더하고 충돌 목록에서 뺀다.
 * @returns copied = 새 탭으로 살린 수, refreshed = 있던 사본 탭을 최신으로 갈아 끼운 수,
 *          keptMine = 옛 창이 지웠지만 이 창 것을 그대로 둔 수. 실패면 null(충돌은 남아 다음에 다시 한다).
 */
export function recoverSceneConflicts(): Promise<{ copied: number; refreshed: number; keptMine: number } | null> {
  return settleConflictsAsCopies(keyOf(null), (scenes, theirs) => {
    const copy: Scene = {
      ...theirs,
      id: uid(),
      name: `${CONFLICT_COPY_PREFIX}${theirs.name}`,
      recoveredFrom: { id: theirs.id, sum: sceneBodySum(theirs) },
    };
    // 같은 씬의 사본이 이미 있고 **만든 뒤 손대지 않았으면** 그 탭을 최신으로 갈아 끼운다 — 옛 창이 그 씬을
    // 계속 고치는 동안 탭(과 저장소)이 끝없이 늘지 않게. 손댄 사본은 건드리지 않고 새로 더한다(잃는 것이 없게).
    const at = scenes.findIndex(
      (s) => s.recoveredFrom?.id === theirs.id && sceneBodySum(s) === s.recoveredFrom.sum,
    );
    if (at < 0) return [...scenes, copy];
    return scenes.map((s, i) => (i === at ? { ...copy, id: s.id, name: s.name } : s)); // 탭 id·이름은 그대로
  });
}

// 반환 = 화면 값에 반영됐나.
export function deleteScene(projectId: string | null, sceneId: string): boolean {
  const key = keyOf(projectId); // ★접수 시점의 계정으로 고정
  return commit((all) => {
    all[key] = (all[key] || []).filter((s) => s.id !== sceneId);
    return { write: true, value: undefined };
  }).ok;
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
  // 이 캔버스가 속한 팀 워크스페이스 — 남이 열었을 때 **그 공간에 등록된 프로젝트 폴더**에서
  // 그림을 찾게 하려고 담는다(Jay 2026-09-28). 예전에는 공간 id 가 파일로 도는 것을 꺼려 뺐지만,
  // 그 정보가 없으면 받는 쪽이 어느 폴더를 뒤져야 할지 몰라 빈칸이 된다.
  // ★받는 쪽은 Scene.refWorkspaceHint 로만 쓴다(과금 지정 아님, 2026-09-29).
  workspace?: { id: string; name: string | null };
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
    // 받아 온 씬을 다시 보낼 때도 힌트가 이어진다(다음 사람도 같은 공간 폴더부터 찾게).
    workspace: scene.workspace ?? scene.refWorkspaceHint,
  };
  return JSON.stringify(
    { format: SCENE_EXPORT_FORMAT, version: SCENE_EXPORT_VERSION, savedAt: Date.now(), name: scene.name, scene: snapshot },
    null,
    2,
  );
}

const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** 씬 파일의 워크스페이스는 남이 만든 값이다 — 모양이 맞을 때만 받는다. */
function readImportedWorkspace(raw: unknown): { id: string; name: string | null } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const w = raw as { id?: unknown; name?: unknown };
  if (typeof w.id !== "string" || !w.id) return undefined;
  return { id: w.id, name: typeof w.name === "string" ? w.name : null };
}

// ── 밖에서 온 씬의 모양 강제 ─────────────────────────────────────────────────────
// 씬 파일·전체 파일은 남이 만든(또는 손상된) 값이다. 화면은 타입을 믿고 쓰므로(`card.text.trim()`,
// `refs.map(r => r.file_path…)`), 모양이 다른 값이 저장소에 들어가면 그 씬을 여는 순간 죽고 — 저장돼 있으니
// 다시 켜도 죽는다(Codex 코드 리뷰 P1). 그래서 **필드마다, 배열은 원소까지** 본다.
// 규칙: 모양이 다른 필드는 지운다(없는 것으로 친다), 모양이 다른 배열 원소는 뺀다. 카드 자체가 못 읽을
// 모양이면(id·종류) 파일을 거절한다(readSceneBody).
type Shape = (value: unknown) => boolean;
const isStr: Shape = (v) => typeof v === "string";
const isBool: Shape = (v) => typeof v === "boolean";
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isPrimitive: Shape = (v) => isStr(v) || isBool(v) || isFiniteNum(v);
const oneOf = (...allowed: unknown[]): Shape => (v) => allowed.includes(v);
const orNull = (shape: Shape): Shape => (v) => v === null || shape(v);
// id 로 쓰이는 글자 — "toString"·"constructor"·"__proto__" 처럼 Object.prototype 에 있는 이름은 받지 않는다.
// 화면은 id 로 사전을 조회하는데(`ownEntry` 로 막아 두었지만) 이런 id 가 저장소에 들어올 이유 자체가 없다.
const isSafeId: Shape = (v) => typeof v === "string" && v !== "" && !(v in Object.prototype);

/** 있는데 모양이 다른 필드를 지운다. */
function keepShaped(target: Record<string, unknown>, shapes: Record<string, Shape>): void {
  for (const [field, shape] of Object.entries(shapes)) {
    if (target[field] !== undefined && !shape(target[field])) delete target[field];
  }
}
/** 배열의 원소를 하나씩 다듬는다 — null 을 준 원소는 뺀다. */
function cleanList<T>(raw: unknown[], clean: (item: unknown) => T | null): T[] {
  return raw.flatMap((item) => {
    const cleaned = clean(item);
    return cleaned === null ? [] : [cleaned];
  });
}
const strings = (raw: unknown[]): string[] => raw.filter((item): item is string => typeof item === "string");
const safeIds = (raw: unknown[]): string[] => raw.filter((item): item is string => isSafeId(item));
const primitives = (raw: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(raw).filter(([, value]) => isPrimitive(value))) as Record<string, string | number | boolean>;

function cleanRef(raw: unknown): SceneRef | null {
  if (!isPlain(raw) || !isStr(raw.file_path) || !isStr(raw.type)) return null;
  const ref = { ...raw };
  keepShaped(ref, {
    name: isStr,
    thumb: orNull(isStr),
    source_gen_id: orNull(isSafeId),
    from_card: isBool,
    origin: oneOf("asset", "upload"),
    content_sha: isStr,
    bytes: isFiniteNum,
    registry_asset_id: isStr,
  });
  return ref as unknown as SceneRef;
}

function cleanSetCfg(raw: SceneSetCfg): SceneSetCfg {
  const folder = isPlain(raw.folder) ? raw.folder : undefined;
  const folderProjectId = typeof folder?.projectId === "string" ? folder.projectId.trim() : "";
  const folderProjectName = typeof folder?.projectName === "string" ? folder.projectName.trim() : "";
  const folderPath =
    typeof folder?.path === "string" ? folder.path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") : "";
  const folderSegments = folderPath.split("/").filter(Boolean);
  const validFolder =
    !!folderProjectId &&
    folderSegments.length > 0 &&
    !folderSegments.some((segment) => segment === "." || segment === "..");
  return {
    ...(validFolder
      ? {
          folder: {
            projectId: folderProjectId,
            ...(folderProjectName ? { projectName: folderProjectName } : {}),
            path: folderSegments.join("/"),
          },
        }
      : {}),
    ...(typeof raw.tagsText === "string" ? { tagsText: raw.tagsText } : {}),
  };
}

function cleanComfyCfg(raw: Record<string, unknown>): SceneComfyCfg {
  const cfg = { ...raw };
  keepShaped(cfg, {
    name: isStr,
    content: isStr,
    nodeCount: isFiniteNum,
    paramExposed: Array.isArray,
    paramValues: isPlain,
    params: Array.isArray,
    output: orNull((o) => isPlain(o) && isStr(o.url) && oneOf("image", "video")(o.kind)),
    outputs: Array.isArray,
    status: oneOf("idle", "running", "done", "failed"),
    error: orNull(isStr),
    runId: isFiniteNum,
  });
  if (Array.isArray(cfg.paramExposed)) cfg.paramExposed = strings(cfg.paramExposed);
  if (isPlain(cfg.paramValues)) cfg.paramValues = primitives(cfg.paramValues);
  if (Array.isArray(cfg.params)) {
    cfg.params = cleanList(cfg.params, (item) => {
      if (!isPlain(item) || !isStr(item.key) || !isStr(item.label) || !oneOf("bool", "number", "text")(item.type)) return null;
      const param = { ...item };
      if (Array.isArray(param.choices)) param.choices = param.choices.filter((choice) => isStr(choice) || isFiniteNum(choice));
      else if (param.choices !== null) delete param.choices;
      return param;
    });
  }
  if (Array.isArray(cfg.outputs)) {
    cfg.outputs = cleanList(cfg.outputs, (item) => {
      if (!isPlain(item) || !oneOf("image", "video", "text")(item.kind)) return null;
      const output = { ...item };
      keepShaped(output, { url: isStr, text: isStr, saved_generation_id: isSafeId });
      return output;
    });
  }
  return cfg as SceneComfyCfg;
}

// 불러온 카드를 화면이 믿는 모양으로 — 좌표는 유한수로, 나머지 필드는 위 규칙대로.
function sanitizeImportedCard(c: SceneCard): SceneCard {
  const out: Record<string, unknown> = { ...c, x: isFiniteNum(c.x) ? c.x : 0, y: isFiniteNum(c.y) ? c.y : 0 };
  keepShaped(out, {
    w: isFiniteNum,
    h: isFiniteNum,
    refs: Array.isArray,
    genId: orNull(isSafeId),
    genIds: Array.isArray,
    pendingGenerationAttempts: Array.isArray,
    prompt: isStr,
    status: oneOf("empty", "pending", "running", "done", "failed"),
    text: isStr,
    modelCfg: isPlain,
    channel: isSafeId,
    color: isStr,
    fontSize: isFiniteNum,
    unchecked: Array.isArray,
    listOrder: Array.isArray,
    batchCount: isFiniteNum,
    comfyCfg: isPlain,
    setCfg: isPlain,
  });
  if (Array.isArray(out.refs)) out.refs = cleanList(out.refs, cleanRef);
  if (Array.isArray(out.genIds)) out.genIds = safeIds(out.genIds);
  if (Array.isArray(out.unchecked)) out.unchecked = safeIds(out.unchecked);
  if (Array.isArray(out.listOrder)) out.listOrder = safeIds(out.listOrder);
  if (Array.isArray(out.pendingGenerationAttempts)) {
    out.pendingGenerationAttempts = cleanList(out.pendingGenerationAttempts, (item): CanvasGenerationAttempt | null =>
      isPlain(item) && isSafeId(item.attemptId) && isSafeId(item.generationId) && isFiniteNum(item.createdAt)
        ? { attemptId: item.attemptId as string, generationId: item.generationId as string, createdAt: item.createdAt }
        : null,
    );
  }
  if (isPlain(out.modelCfg)) {
    const model = { ...out.modelCfg };
    keepShaped(model, { type: isStr, model: isStr, modelName: isStr, params: isPlain });
    if (isPlain(model.params)) model.params = primitives(model.params);
    out.modelCfg = model;
  }
  if (isPlain(out.setCfg)) out.setCfg = cleanSetCfg(out.setCfg as SceneSetCfg);
  if (isPlain(out.comfyCfg)) out.comfyCfg = cleanComfyCfg(out.comfyCfg);
  return out as unknown as SceneCard;
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
  return readSceneBody(o.scene, typeof o.name === "string" && o.name ? o.name : "불러온 씬");
}

// 씬 본문(이름·카드·연결·그룹·카메라)을 검증·정규화한다 — 밖에서 온 씬이 화면에 닿기 전의 단일 관문.
// 씬 파일 가져오기와 전체 파일 가져오기(readStoredScene)가 같이 쓴다. 고칠 수 없는 손상이면 throw.
function readSceneBody(raw: unknown, fallbackName: string): SceneSnapshot {
  const s = raw as Record<string, unknown> | null | undefined;
  if (!s || typeof s !== "object" || !Array.isArray(s.cards) || !Array.isArray(s.edges)) {
    throw new Error("씬 데이터가 손상됐습니다.");
  }
  const seenCardIds = new Set<string>();
  const cards: SceneCard[] = [];
  for (const c of s.cards as SceneCard[]) {
    if (!isPlain(c) || !isSafeId(c.id) || !SCENE_CARD_KINDS.includes(c.kind)) {
      throw new Error("알 수 없는 카드가 있어 불러올 수 없습니다(버전이 다를 수 있음).");
    }
    if (seenCardIds.has(c.id)) continue; // 중복 id 제거(첫 것 유지) — 렌더/매핑 혼란 방지
    seenCardIds.add(c.id);
    cards.push(sanitizeImportedCard(c)); // 좌표·배열·comfyCfg 형태 강제
  }
  const name = typeof s.name === "string" && s.name ? s.name : fallbackName;
  // 엣지·그룹은 '손상 항목만 버리고' 나머지는 살린다(전체 거부보다 관대). 특히 group.cardIds 가 배열이
  // 아니면 렌더(memberBounds)에서 순회하다 크래시하므로 여기서 반드시 정제한다. 존재하지 않는 카드
  // id 참조는 렌더가 이미 건너뛰므로(cardById=null) 남겨도 안전.
  const cardIds = new Set(cards.map((c) => c.id));
  const edges = cleanList(s.edges as unknown[], (item): SceneEdge | null => {
    if (!isPlain(item) || !isSafeId(item.id) || !isSafeId(item.from) || !isSafeId(item.to)) return null;
    const edge = { ...item };
    keepShaped(edge, { role: oneOf("model", "ref", "text", "set", "lineage", "list"), order: isFiniteNum });
    return edge as unknown as SceneEdge;
  });
  const rawGroups = Array.isArray(s.groups) ? (s.groups as unknown[]) : [];
  const groups = rawGroups
    .filter(
      (g): g is SceneGroup =>
        !!g && isSafeId((g as SceneGroup).id) && Array.isArray((g as SceneGroup).cardIds),
    )
    .map((g) => {
      const group: Record<string, unknown> = {
        ...g,
        name: typeof g.name === "string" ? g.name : "",
        cardIds: g.cardIds.filter((id) => typeof id === "string" && cardIds.has(id)), // 문자열 + 실제 존재 카드만
      };
      keepShaped(group, {
        collapsed: isBool,
        color: isStr,
        rect: (r) => isPlain(r) && [r.x, r.y, r.w, r.h].every(isFiniteNum),
      });
      return group as unknown as SceneGroup;
    });
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
    workspace: readImportedWorkspace(s.workspace),
  };
}

/**
 * 밖에서 온 '저장된 씬' 한 개(전체 내보내기 파일)를 검증·정규화한다. id·만든 시각·공간은 그대로 두되,
 * 화면이 믿고 쓰는 모양(이름·카드·연결·그룹·카메라)은 씬 파일 가져오기와 같은 기준으로 강제한다 —
 * 이름 없는 씬·null 카드가 저장소에 들어가면 탭 줄이 그리다 죽고, 저장돼 있으니 다시 켜도 죽는다
 * (Codex 코드 리뷰 P1). 고칠 수 없는 손상이면 throw.
 */
export function readStoredScene(raw: unknown): Scene {
  const r = raw as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== "object" || Array.isArray(r) || !isSafeId(r.id)) {
    throw new Error("씬 데이터가 손상됐습니다.");
  }
  const body = readSceneBody(r, "이름 없는 씬");
  const hint = readImportedWorkspace(r.refWorkspaceHint);
  const from = r.recoveredFrom as { id?: unknown; sum?: unknown } | null | undefined;
  return {
    id: r.id as string,
    name: body.name,
    cards: body.cards,
    edges: body.edges,
    ...(body.groups ? { groups: body.groups } : {}),
    ...(body.camera ? { camera: body.camera } : {}),
    ...(body.workspace ? { workspace: body.workspace } : {}),
    ...(hint ? { refWorkspaceHint: hint } : {}),
    ...(from && typeof from.id === "string" && typeof from.sum === "string"
      ? { recoveredFrom: { id: from.id, sum: from.sum } }
      : {}),
    created_at: isFiniteNum(r.created_at) ? r.created_at : 0,
  };
}

// 스냅샷을 '새 씬'으로 저장(새 id/created_at). 이름은 그대로(탭에서 구분).
export function importScene(projectId: string | null, snap: SceneSnapshot): Scene {
  const key = keyOf(projectId); // ★접수 시점의 계정으로 고정
  // id·시각·이름은 여기서 정한다 — 연산 안에서 만들면 재생 때마다 다른 씬이 된다.
  const scene: Scene = frozen({
    id: uid(),
    name: snap.name || `씬 ${workingBucketLength(key) + 1}`,
    cards: snap.cards,
    edges: snap.edges,
    groups: snap.groups,
    camera: snap.camera,
    // 파일의 공간은 찾기 힌트로만 — 탭의 과금 공간(workspace)으로 넣지 않는다(2026-09-29).
    refWorkspaceHint: snap.workspace,
    created_at: Date.now(),
  });
  // 화면 값에 반영하지 못한 채 반환하면 활성씬 id 만 새로 잡히고 목록엔 없어 '빈 화면'이 된다.
  const out = commit((all) => {
    migrateLegacyBucket(all, projectId, key);
    all[key] = [...(all[key] || []), scene];
    return { write: true, value: undefined };
  });
  if (!out.ok) throw new Error("씬을 저장하지 못했습니다 — 저장소가 아직 열리지 않았습니다. 다시 시도하세요.");
  return frozen(scene); // 사본 — 위 createScene 과 같은 까닭
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
