// 허브 공책의 로컬 저장 부분. 네트워크·임대 획득·화면 흐름은 이 모듈에 없다.
import {
  notebookKey as key, sceneNotebookTransaction,
  type SceneBase, type SceneIntent, type SceneOrderBase, type SceneOrderState,
} from "./sceneStore";
import type { Scene, ScenesByProject } from "./scenes";
import type { SceneAbsorbConflict } from "./sceneAbsorb";

export type { SceneBase, SceneIntent, SceneOrderBase, SceneOrderState } from "./sceneStore";
export interface NotebookSceneState {
  text: string | null;
  base: SceneBase | null;
  deletion: SceneIntent | null;
  revival: SceneIntent | null;
}
export interface NotebookBucket {
  scenes: Scene[];
  states: Record<string, NotebookSceneState>;
  order: SceneOrderState;
}
export interface NotebookJoin { notebookId: string; history: string }
export interface NotebookProgress { id: string; [field: string]: unknown }
export interface NotebookSnapshot {
  buckets: Record<string, NotebookBucket>;
  joined: NotebookJoin | null;
  starting: NotebookProgress | null;
  writing: NotebookProgress | null;
}
export interface NotebookArchive { notebookId: string; scenes: ScenesByProject; conflicts?: SceneAbsorbConflict[] }
export interface NotebookHubBucket {
  scenes: Scene[];
  bases: Record<string, SceneBase>;
  order: SceneOrderBase;
}
type Meta = Record<string, unknown>;
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const belongs = (bucket: string, account: string): boolean => bucket.startsWith(`${account}::`);
const own = <T>(map: Record<string, T>, id: string): T | undefined => Object.prototype.hasOwnProperty.call(map, id) ? map[id] : undefined;

function stateOf(all: ScenesByProject, meta: Meta, bucket: string, id: string): NotebookSceneState {
  const scene = all[bucket]?.find((item) => item.id === id);
  return {
    text: scene ? JSON.stringify(scene) : null,
    base: (meta[key("b", bucket, id)] as SceneBase | undefined) ?? null,
    deletion: (meta[key("d", bucket, id)] as SceneIntent | undefined) ?? null,
    revival: (meta[key("r", bucket, id)] as SceneIntent | undefined) ?? null,
  };
}
function sameState(a: NotebookSceneState, b: NotebookSceneState): boolean {
  return a.text === b.text && equal(a.base, b.base) && equal(a.deletion, b.deletion) && equal(a.revival, b.revival);
}
const emptyOrder = (): SceneOrderState => ({ base: null, dirty: null });

/** pending까지 앞에서 확정하고 같은 시점의 글자·판·의도·순서를 읽는다. 실패를 빈 공책으로 돌려주지 않는다. */
export function readSceneNotebook(account: string) {
  return sceneNotebookTransaction([key("ns", account), key("nw", account)], (all, meta) => {
    const buckets: Record<string, NotebookBucket> = {};
    const idsByBucket = new Map<string, Set<string>>();
    for (const [bucket, scenes] of Object.entries(all)) if (belongs(bucket, account)) idsByBucket.set(bucket, new Set(scenes.map((s) => s.id)));
    for (const name of Object.keys(meta)) if (/^\["[bdr]",/.test(name)) {
      const [, bucket, id] = JSON.parse(name) as string[];
      if (!belongs(bucket, account)) continue;
      if (!idsByBucket.has(bucket)) idsByBucket.set(bucket, new Set());
      idsByBucket.get(bucket)!.add(id);
    }
    for (const [bucket, ids] of idsByBucket) buckets[bucket] = {
      scenes: all[bucket] ?? [],
      states: Object.fromEntries([...ids].map((id) => [id, stateOf(all, meta, bucket, id)])),
      order: (meta[key("ob", bucket)] as SceneOrderState | undefined) ?? emptyOrder(),
    };
    return { changed: false, value: {
      buckets,
      joined: (meta[key("nj", account)] as NotebookJoin | undefined) ?? null,
      starting: (meta[key("ns", account)] as NotebookProgress | undefined) ?? null,
      writing: (meta[key("nw", account)] as NotebookProgress | undefined) ?? null,
    } satisfies NotebookSnapshot };
  });
}

async function change(keys: string[], decide: (all: ScenesByProject, meta: Meta) => boolean): Promise<boolean> {
  const result = await sceneNotebookTransaction(keys, (all, meta) => {
    const applied = decide(all, meta);
    return { value: applied, changed: applied };
  });
  return result.ok && result.value;
}

/** 없는 행만 추가. 지움/되살림 의도가 남으면 조회로 덮지 않고 다음 맞추기로 돌린다. */
export function addNotebookSceneIfAbsent(bucket: string, scene: Scene, base: SceneBase, expected: NotebookSceneState = { text: null, base: null, deletion: null, revival: null }): Promise<boolean> {
  const incoming = structuredClone(scene);
  const version = structuredClone(base);
  const before = structuredClone(expected);
  return change([], (all, meta) => {
    const current = stateOf(all, meta, bucket, incoming.id);
    if (!sameState(current, before) || current.text !== null || current.deletion || current.revival) return false;
    all[bucket] = [...(all[bucket] ?? []), incoming];
    meta[key("b", bucket, incoming.id)] = version;
    return true;
  });
}

/** 조회/업로드 응답은 기대 글자·판·의도가 그대로일 때만 반영. 동일 id 실행 표식은 원문대로 둔다. */
export function replaceNotebookSceneIfUnchanged(bucket: string, expected: NotebookSceneState, scene: Scene, base: SceneBase): Promise<boolean> {
  const input = structuredClone({ expected, scene, base });
  return change([], (all, meta) => {
    if (!sameState(stateOf(all, meta, bucket, input.scene.id), input.expected)) return false;
    if (input.expected.text === null || input.expected.deletion || input.expected.revival) return false;
    all[bucket] = all[bucket].map((item) => item.id === input.scene.id ? input.scene : item);
    meta[key("b", bucket, input.scene.id)] = input.base;
    return true;
  });
}

/** 허브의 지움/행 소실 반영. 변경·되살리기 의도가 생겼으면 지우지 않는다. */
export function removeNotebookSceneIfUnchanged(bucket: string, id: string, expected: NotebookSceneState, base: SceneBase | null): Promise<boolean> {
  const input = structuredClone({ expected, base });
  return change([], (all, meta) => {
    if (!sameState(stateOf(all, meta, bucket, id), input.expected) || input.expected.deletion || input.expected.revival) return false;
    if (input.expected.text === null) return false;
    all[bucket] = all[bucket].filter((item) => item.id !== id);
    if (input.base) meta[key("b", bucket, id)] = input.base;
    else delete meta[key("b", bucket, id)];
    return true;
  });
}

/** 늦은 확인은 새 의도를 거둘 수 없다. 허브가 '남김'을 답하면 d만 거두고 다음 조회가 행을 더한다. */
export function acknowledgeNotebookIntent(bucket: string, id: string, kind: "delete" | "revive", expected: NotebookSceneState, base: SceneBase): Promise<boolean> {
  const input = structuredClone({ expected, base });
  return change([], (all, meta) => {
    const current = stateOf(all, meta, bucket, id);
    const intent = kind === "delete" ? current.deletion : current.revival;
    if (!intent || !sameState(current, input.expected)) return false;
    if ((kind === "delete") !== (current.text === null)) return false;
    delete meta[key(kind === "delete" ? "d" : "r", bucket, id)];
    meta[key("b", bucket, id)] = input.base;
    return true;
  });
}

/** 순서 ABA도 dirty 의도 id로 구별. 로컬 전용 탭을 포함해 현재 id들을 한 번씩 남긴다. */
export function applyNotebookOrder(bucket: string, expectedIds: string[], expected: SceneOrderState, ids: string[], base: SceneOrderBase): Promise<boolean> {
  const input = structuredClone({ expectedIds, expected, ids, base });
  return change([], (all, meta) => {
    const scenes = all[bucket] ?? [];
    if (!equal(scenes.map((s) => s.id), input.expectedIds) || !equal(meta[key("ob", bucket)] ?? emptyOrder(), input.expected)) return false;
    const byId = new Map(scenes.map((scene) => [scene.id, scene]));
    const order = [...new Set([...input.ids, ...scenes.map((s) => s.id)])].filter((id) => byId.has(id));
    all[bucket] = order.map((id) => byId.get(id)!);
    meta[key("ob", bucket)] = { base: input.base, dirty: null } satisfies SceneOrderState;
    return true;
  });
}

/** 합류 표시는 계정당 한 번이다. 공책/history가 바뀌어도 이 연산을 다시 쓰지 않는다.
 * 호출자는 합류 동안 편집을 잠근다(3단계). 저장 큐 앞의 pending도 보관본에 포함된다. */
export function joinSceneNotebook(account: string, notebookId: string, history: string, buckets: Record<string, NotebookHubBucket>): Promise<boolean> {
  const input = structuredClone(buckets);
  // 서버 응답 해석은 3단계. 경계를 잘못 넘긴 입력은 부분 적용하지 않는다.
  for (const [bucket, value] of Object.entries(input)) {
    if (!belongs(bucket, account) || new Set(value.scenes.map((s) => s.id)).size !== value.scenes.length ||
      value.order.history !== history || value.scenes.some((scene) => own(value.bases, scene.id)?.history !== history)) return Promise.resolve(false);
  }
  const archiveKey = key("na", account, notebookId);
  return change([archiveKey], (all, meta) => {
    if (meta[key("nj", account)]) return false;
    const conflicts = (meta.conflicts as SceneAbsorbConflict[] | undefined) ?? [];
    if (!meta[archiveKey]) meta[archiveKey] = {
      notebookId, scenes: Object.fromEntries(Object.entries(all).filter(([bucket]) => belongs(bucket, account))),
      conflicts: conflicts.filter((item) => belongs(item.bucket, account)),
    } satisfies NotebookArchive;
    // 종전 미해결 충돌도 합류 이전 자료다. 새 공책에 자동 사본 탭으로 다시 들어오지 않게 함께 보관한다.
    meta.conflicts = conflicts.filter((item) => !belongs(item.bucket, account));
    for (const bucket of Object.keys(all)) if (belongs(bucket, account)) delete all[bucket];
    for (const name of Object.keys(meta)) if (/^\["(?:b|d|r|ob)",/.test(name)) {
      const [, bucket] = JSON.parse(name) as string[];
      if (belongs(bucket, account)) delete meta[name];
    }
    for (const [bucket, value] of Object.entries(input)) {
      all[bucket] = value.scenes;
      for (const scene of value.scenes) meta[key("b", bucket, scene.id)] = value.bases[scene.id];
      meta[key("ob", bucket)] = { base: value.order, dirty: null } satisfies SceneOrderState;
    }
    meta[key("nj", account)] = { notebookId, history } satisfies NotebookJoin;
    return true;
  });
}

export function readNotebookArchive(account: string, notebookId: string) {
  const name = key("na", account, notebookId);
  return sceneNotebookTransaction([name], (_all, meta) => ({ changed: false, value: (meta[name] as NotebookArchive | undefined) ?? null }));
}

/** 시작/요청 영수증 대기 상태. 요청 A의 늦은 정리가 새 요청 B를 없애지 않게 전체 기대값을 확인한다. */
export function writeNotebookProgress(account: string, kind: "start" | "write", expected: NotebookProgress | null, next: NotebookProgress | null): Promise<boolean> {
  const name = key(kind === "start" ? "ns" : "nw", account);
  const input = structuredClone({ expected, next });
  return change([name], (_all, meta) => {
    if (!equal(meta[name] ?? null, input.expected)) return false;
    if (input.next) meta[name] = input.next;
    else delete meta[name];
    return true;
  });
}

/** 새 id에는 능동 실행 연결을 옮기지 않는다. 수동 확인용 원래 표식은 backupForkOf 안에 보관한다. */
export function makeLocalNotebookCopy(scene: Scene, id: string, reason: "upload_failed" | "stale_handover"): Scene {
  const copy = structuredClone(scene);
  const attempts = Object.fromEntries(copy.cards.filter((card) => card.pendingGenerationAttempts?.length).map((card) => [card.id, card.pendingGenerationAttempts!]));
  const legacyRuns = Object.fromEntries(copy.cards.filter((card) => card.comfyCfg?.runId).map((card) => [card.id, card.comfyCfg!.runId!]));
  copy.backupForkOf = {
    id: scene.id, comfyRuns: copy.comfyRuns, comfyCardRuns: copy.comfyCardRuns,
    pendingGenerationAttempts: attempts, comfyLegacyRuns: legacyRuns, previous: copy.backupForkOf,
  };
  copy.id = id;
  copy.name = `[옛 창] ${scene.name}`;
  copy.localNotebookCopy = reason;
  delete copy.comfyRuns;
  delete copy.comfyCardRuns;
  delete copy.mcpAttachmentReceipts;
  for (const card of copy.cards) {
    delete card.pendingGenerationAttempts;
    if (card.comfyCfg) {
      delete card.comfyCfg.runId;
      delete card.comfyCfg.status;
      delete card.comfyCfg.error;
    }
  }
  return copy;
}

/** 못 올린 내용을 먼저 새 로컬 id로 보존하고 원래 id를 맞춘다. 둘 중 하나만 확정될 수 없다. */
export function preserveUnuploadableNotebookScene(bucket: string, id: string, expected: NotebookSceneState, copyId: string, incoming: Scene | null, base: SceneBase | null): Promise<boolean> {
  const input = structuredClone({ expected, incoming, base });
  if (copyId === id || (incoming && incoming.id !== id) || (incoming && !base)) return Promise.resolve(false);
  return change([], (all, meta) => {
    if (!sameState(stateOf(all, meta, bucket, id), input.expected) || input.expected.text === null || input.expected.deletion) return false;
    const target = stateOf(all, meta, bucket, copyId);
    if (target.text !== null || target.base || target.deletion || target.revival) return false;
    const original = all[bucket].find((s) => s.id === id)!;
    const copy = makeLocalNotebookCopy(original, copyId, "upload_failed");
    all[bucket] = all[bucket].flatMap((s) => s.id === id ? (input.incoming ? [input.incoming, copy] : [copy]) : [s]);
    if (input.base) meta[key("b", bucket, id)] = input.base;
    else delete meta[key("b", bucket, id)];
    delete meta[key("r", bucket, id)];
    return true;
  });
}
