// 허브 공책 저장과 맞추기. 임대 획득·화면 흐름은 호출자가 맡는다.
import {
  notebookKey as key, sceneNotebookTransaction,
  holdNotebookWrites, newSceneIntentId,
  type SceneBase, type SceneIntent, type SceneOrderBase, type SceneOrderState,
} from "./sceneStore";
import type { Scene, ScenesByProject } from "./scenes";
import type { SceneAbsorbConflict } from "./sceneAbsorb";
import { jsonFetch } from "./http";
import { getAccountNamespace } from "./accountScope";
import { hubHasFeature, EXPECT_ACCOUNT_HEADER } from "./hubFeatures";
import { sha256Hex } from "./editShare";

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
export function readSceneNotebook(account: string, guard?: () => boolean) {
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
  }, guard);
}

async function change(keys: string[], decide: (all: ScenesByProject, meta: Meta) => boolean, guard?: () => boolean): Promise<boolean> {
  const result = await sceneNotebookTransaction(keys, (all, meta) => {
    const applied = decide(all, meta);
    return { value: applied, changed: applied };
  }, guard);
  return result.ok && result.value;
}

/** 없는 행만 추가. 지움/되살림 의도가 남으면 조회로 덮지 않고 다음 맞추기로 돌린다. */
export function addNotebookSceneIfAbsent(bucket: string, scene: Scene, base: SceneBase, expected: NotebookSceneState = { text: null, base: null, deletion: null, revival: null }, guard?: () => boolean): Promise<boolean> {
  const incoming = structuredClone(scene);
  const version = structuredClone(base);
  const before = structuredClone(expected);
  return change([], (all, meta) => {
    const current = stateOf(all, meta, bucket, incoming.id);
    if (!sameState(current, before) || current.text !== null || current.deletion || current.revival) return false;
    all[bucket] = [...(all[bucket] ?? []), incoming];
    meta[key("b", bucket, incoming.id)] = version;
    return true;
  }, guard);
}

/** 조회/업로드 응답은 기대 글자·판·의도가 그대로일 때만 반영. 동일 id 실행 표식은 원문대로 둔다. */
export function replaceNotebookSceneIfUnchanged(bucket: string, expected: NotebookSceneState, scene: Scene, base: SceneBase, guard?: () => boolean): Promise<boolean> {
  const input = structuredClone({ expected, scene, base });
  return change([], (all, meta) => {
    if (!sameState(stateOf(all, meta, bucket, input.scene.id), input.expected)) return false;
    if (input.expected.text === null || input.expected.deletion || input.expected.revival) return false;
    all[bucket] = all[bucket].map((item) => item.id === input.scene.id ? input.scene : item);
    meta[key("b", bucket, input.scene.id)] = input.base;
    return true;
  }, guard);
}

/** 허브의 지움/행 소실 반영. 변경·되살리기 의도가 생겼으면 지우지 않는다. */
export function removeNotebookSceneIfUnchanged(bucket: string, id: string, expected: NotebookSceneState, base: SceneBase | null, guard?: () => boolean): Promise<boolean> {
  const input = structuredClone({ expected, base });
  return change([], (all, meta) => {
    if (!sameState(stateOf(all, meta, bucket, id), input.expected) || input.expected.deletion || input.expected.revival) return false;
    if (input.expected.text === null) return false;
    all[bucket] = all[bucket].filter((item) => item.id !== id);
    if (input.base) meta[key("b", bucket, id)] = input.base;
    else delete meta[key("b", bucket, id)];
    return true;
  }, guard);
}

/** 늦은 확인은 새 의도를 거둘 수 없다. 허브가 '남김'을 답하면 d만 거두고 다음 조회가 행을 더한다. */
export function acknowledgeNotebookIntent(bucket: string, id: string, kind: "delete" | "revive", expected: NotebookSceneState, base: SceneBase | null, guard?: () => boolean): Promise<boolean> {
  const input = structuredClone({ expected, base });
  return change([], (all, meta) => {
    const current = stateOf(all, meta, bucket, id);
    const intent = kind === "delete" ? current.deletion : current.revival;
    if (!intent || !sameState(current, input.expected)) return false;
    if ((kind === "delete") !== (current.text === null)) return false;
    delete meta[key(kind === "delete" ? "d" : "r", bucket, id)];
    meta[key("b", bucket, id)] = input.base;
    return true;
  }, guard);
}

/** 순서 ABA도 dirty 의도 id로 구별. 로컬 전용 탭을 포함해 현재 id들을 한 번씩 남긴다. */
export function applyNotebookOrder(bucket: string, expectedIds: string[], expected: SceneOrderState, ids: string[], base: SceneOrderBase, guard?: () => boolean): Promise<boolean> {
  const input = structuredClone({ expectedIds, expected, ids, base });
  return change([], (all, meta) => {
    const scenes = all[bucket] ?? [];
    if (!equal(scenes.map((s) => s.id), input.expectedIds) || !equal(meta[key("ob", bucket)] ?? emptyOrder(), input.expected)) return false;
    const byId = new Map(scenes.map((scene) => [scene.id, scene]));
    const order = [...new Set([...input.ids, ...scenes.map((s) => s.id)])].filter((id) => byId.has(id));
    all[bucket] = order.map((id) => byId.get(id)!);
    meta[key("ob", bucket)] = { base: input.base, dirty: null } satisfies SceneOrderState;
    return true;
  }, guard);
}

/** 합류 표시는 계정당 한 번이다. 공책/history가 바뀌어도 이 연산을 다시 쓰지 않는다.
 * 호출자는 합류 동안 편집을 잠근다(3단계). 저장 큐 앞의 pending도 보관본에 포함된다. */
export function joinSceneNotebook(account: string, notebookId: string, history: string, buckets: Record<string, NotebookHubBucket>, guard?: () => boolean): Promise<boolean> {
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
  }, guard);
}

export function readNotebookArchive(account: string, notebookId: string) {
  const name = key("na", account, notebookId);
  return sceneNotebookTransaction([name], (_all, meta) => ({ changed: false, value: (meta[name] as NotebookArchive | undefined) ?? null }));
}

/** 시작/요청 영수증 대기 상태. 요청 A의 늦은 정리가 새 요청 B를 없애지 않게 전체 기대값을 확인한다. */
export function writeNotebookProgress(account: string, kind: "start" | "write", expected: NotebookProgress | null, next: NotebookProgress | null, guard?: () => boolean): Promise<boolean> {
  const name = key(kind === "start" ? "ns" : "nw", account);
  const input = structuredClone({ expected, next });
  return change([name], (_all, meta) => {
    if (!equal(meta[name] ?? null, input.expected)) return false;
    if (input.next) meta[name] = input.next;
    else delete meta[name];
    return true;
  }, guard);
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
export function preserveUnuploadableNotebookScene(bucket: string, id: string, expected: NotebookSceneState, copyId: string, incoming: Scene | null, base: SceneBase | null, guard?: () => boolean): Promise<boolean> {
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
  }, guard);
}

// ── 3단계: 네트워크는 저장 트랜잭션 밖에서, 응답은 고정본과 조건부로 맞춘다. ──
export const SCENE_WRITER_FEATURE = "scene_writer_v1";
const SCENE_LIMIT = 5 * 1024 * 1024;
export interface NotebookToken { account: string; token: string; generation: string }
export interface NotebookSyncResult {
  status: "disabled" | "waiting_token" | "ready" | "local_only" | "retry";
  changed: boolean;
  reason?: string;
  sceneIds?: string[];
}
let tokenProvider: () => NotebookToken | null = () => null;
let providerEpoch = 0;
let inFlight: Promise<NotebookSyncResult> | null = null;
const resultListeners = new Set<(result: NotebookSyncResult) => void>();
export function subscribeNotebookSyncResult(fn: (result: NotebookSyncResult) => void): () => void {
  resultListeners.add(fn);
  return () => { resultListeners.delete(fn); };
}
/** 4단계가 공급한다. 토큰 자체는 IndexedDB/로컬 저장소에 기록하지 않는다. */
export function setSceneNotebookTokenProvider(provider: () => NotebookToken | null): void {
  tokenProvider = provider;
  providerEpoch++;
}
type WireBase = { history_id: string; rev: number; hash: string };
type HubRow = { id: string; data: string; deleted_at: string | null; base: WireBase };
type HubBook = { notebook_id: string | null; history_id: string; items: HubRow[]; order: { ids: string[]; rev: number; history_id: string } };
type Upload = { id: string; name: string; data: string; base: WireBase | null; revive?: boolean; intent_id?: string };
type Delete = { id: string; intent_id: string; base: WireBase | null };
type Payload = { request_id: string; project_id: string; upserts: Upload[]; deletes: Delete[]; order?: HubBook["order"] };
type Receipt = { history_id: string; order: HubBook["order"]; results: { id: string; status: "saved" | "same" | "copied" | "too_big"; target_id: string | null; base?: WireBase }[]; deletes: { id: string; status: "deleted" | "kept"; base: WireBase | null; intent_id: string }[] };
interface PendingWrite extends NotebookProgress {
  history: string; notebookId: string; frozen: NotebookBucket; requests: Payload[]; tooBig: string[]; orderCanAdvance: boolean;
}
interface PendingStart extends NotebookProgress { history: string; generation: string; scenes: Scene[] }
const emptyBucket = (): NotebookBucket => ({ scenes: [], states: {}, order: emptyOrder() });
const fromBase = (base: WireBase): SceneBase => ({ history: base.history_id, rev: base.rev, hash: base.hash });
const toBase = (base: SceneBase | null): WireBase | null => base && ({ history_id: base.history, rev: base.rev, hash: base.hash });
const bytes = (text: string): number => new TextEncoder().encode(text).byteLength;
async function fingerprint(text: string): Promise<string> {
  return sha256Hex(text); // HTTP 문맥도 기존의 검증된 JS SHA-256 대체 경로를 쓴다.
}
function batches<T extends { data: string }>(items: T[]): T[][] {
  const result: T[][] = [];
  let batch: T[] = [], size = 0;
  for (const item of items) {
    const n = bytes(item.data);
    if (batch.length >= 200 || (batch.length > 0 && size + n > 8 * 1024 * 1024)) {
      result.push(batch); batch = []; size = 0;
    }
    batch.push(item); size += n;
  }
  if (batch.length) result.push(batch);
  return result;
}
function errorInfo(error: unknown): Record<string, unknown> | undefined {
  const e = error as { info?: Record<string, unknown>; detail?: string };
  if (e?.info) return e.info;
  if (e?.detail?.startsWith("{")) {
    try { return JSON.parse(e.detail) as Record<string, unknown>; } catch { /* 일반 오류 글자 */ }
  }
}
function errorCode(error: unknown): string {
  const e = error as { info?: { code?: string }; detail?: string; message?: string };
  // 기존 http.ts는 message 없는 JSON detail을 글자로 보존한다(시작 413 포함).
  const info = errorInfo(error);
  if (typeof info?.code === "string") return info.code;
  return e?.info?.code || e?.detail || e?.message || "network_failed";
}
class NotebookTransportError extends Error {}
function validBase(base: WireBase | undefined, history: string): base is WireBase {
  return !!base && base.history_id === history && Number.isInteger(base.rev) && base.rev >= 0 && typeof base.hash === "string";
}
function parseBook(value: HubBook): HubBook {
  if (!value || typeof value.history_id !== "string" || !(value.notebook_id === null || typeof value.notebook_id === "string") ||
      !Array.isArray(value.items) || !value.order || !Array.isArray(value.order.ids) ||
      value.order.history_id !== value.history_id || !Number.isInteger(value.order.rev)) throw new Error("invalid_notebook");
  const ids = new Set<string>();
  for (const row of value.items) {
    if (typeof row.id !== "string" || ids.has(row.id) || !validBase(row.base, value.history_id) || typeof row.data !== "string") throw new Error("invalid_notebook");
    ids.add(row.id);
    const scene = JSON.parse(row.data) as Scene;
    if (!scene || scene.id !== row.id || typeof scene.name !== "string" || !Array.isArray(scene.cards) || !Array.isArray(scene.edges)) throw new Error("invalid_notebook");
    if (row.deleted_at !== null && typeof row.deleted_at !== "string") throw new Error("invalid_notebook");
  }
  const live = new Set(value.items.filter((r) => r.deleted_at === null).map((r) => r.id));
  if (new Set(value.order.ids).size !== value.order.ids.length || value.order.ids.some((id) => !live.has(id)) || live.size !== value.order.ids.length) throw new Error("invalid_order");
  return value;
}
function hubBucket(book: HubBook): NotebookHubBucket {
  const rows = new Map(book.items.map((row) => [row.id, row]));
  return {
    scenes: book.order.ids.map((id) => JSON.parse(rows.get(id)!.data) as Scene),
    bases: Object.fromEntries(book.items.map((row) => [row.id, fromBase(row.base)])),
    order: { history: book.history_id, rev: book.order.rev },
  };
}

/** 동시 호출은 하나로 합친다. 실패 뒤 다음 호출도 저장된 request_id로 재전송한다. */
export function syncSceneNotebook(): Promise<NotebookSyncResult> {
  if (!hubHasFeature(SCENE_WRITER_FEATURE)) return Promise.resolve({ status: "disabled", changed: false });
  if (inFlight) return inFlight;
  inFlight = runNotebookSync().then((result) => {
    resultListeners.forEach((fn) => fn(result));
    return result;
  }).finally(() => { inFlight = null; });
  return inFlight;
}
async function runNotebookSync(): Promise<NotebookSyncResult> {
  const provided = tokenProvider();
  const lease = provided ? { ...provided } : null;
  const account = getAccountNamespace(), epoch = providerEpoch;
  if (!lease || lease.account !== account) return { status: "waiting_token", changed: false };
  const guard = () => {
    const now = tokenProvider();
    return hubHasFeature(SCENE_WRITER_FEATURE) && providerEpoch === epoch && getAccountNamespace() === account &&
      now?.account === account && now.token === lease.token && now.generation === lease.generation;
  };
  const check = () => { if (!guard()) throw new Error("writer_changed"); };
  let changed = false;
  const bucket = `${account}::_none`;
  async function request<T>(path: string, payload?: unknown, method = "POST"): Promise<T> {
    check();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const result = await jsonFetch<T>(`/api/scenes/${path}`, {
        method: payload === undefined ? "GET" : method,
        headers: { [EXPECT_ACCOUNT_HEADER]: account, "Content-Type": "application/json" },
        signal: controller.signal, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      check(); return result;
    } catch (error) {
      check();
      const status = (error as { status?: number })?.status;
      if (!status || status >= 500) throw new NotebookTransportError(errorCode(error));
      throw error;
    } finally { clearTimeout(timeout); }
  }
  const getBook = async () => {
    const book = parseBook(await request<HubBook>("notebook?project_id="));
    for (const row of book.items) if (await fingerprint(row.data) !== row.base.hash) throw new Error("invalid_notebook_hash");
    check(); return book;
  };
  const snapshot = async () => {
    const result = await readSceneNotebook(account, guard);
    if (!result.ok) throw new Error("local_store_failed");
    check(); return result.value;
  };
  try {
    for (let round = 0; round < 3; round++) {
      try {
        let local = await snapshot();
        let book = await getBook();
        if (!local.joined) {
          const releaseHold = holdNotebookWrites(account);
          try {
            local = await snapshot();
            if (!book.notebook_id) {
              const scenes = local.buckets[bucket]?.scenes ?? [];
              // 현재 캔버스는 전역 버킷이다. 옛 프로젝트 버킷은 합류 전 사본에 남긴다.
              const oversizedIds = scenes.filter((s) => bytes(JSON.stringify(s)) > SCENE_LIMIT).map((s) => s.id);
              if (oversizedIds.length) {
                try { await request("writer", { action: "release", token: lease.token }); } catch { check(); }
                if (local.starting) await writeNotebookProgress(account, "start", local.starting, null, guard);
                return { status: "local_only", changed, reason: "start_too_big", sceneIds: oversizedIds };
              }
              let progress = local.starting as PendingStart | null;
              if (!progress || progress.history !== book.history_id || progress.generation !== lease.generation || !equal(progress.scenes, scenes)) {
                const next: PendingStart = { id: newSceneIntentId(), history: book.history_id, generation: lease.generation, scenes };
                if (!(await writeNotebookProgress(account, "start", progress, next, guard))) throw new Error("local_store_failed");
                progress = next;
              }
              const start = { token: lease.token, attempt_id: progress.id, project_id: "", expected_count: scenes.length, order: scenes.map((s) => s.id) };
              try {
                for (const upserts of batches(scenes.map((s) => ({ id: s.id, name: s.name, data: JSON.stringify(s) })))) {
                  await request("notebook/start", { ...start, upserts, commit: false });
                }
                await request("notebook/start", { ...start, upserts: [], commit: true });
              } catch (error) {
                const code = errorCode(error);
                if (["empty_notebook", "start_too_big", "start_attempt_changed", "start_snapshot_changed"].includes(code)) {
                  await writeNotebookProgress(account, "start", progress, null, guard);
                  if (code === "empty_notebook" || code === "start_too_big") {
                    const ids = errorInfo(error)?.scene_ids;
                    return { status: "local_only", reason: code, changed,
                      sceneIds: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [],
                    };
                  }
                  continue;
                }
                if (code !== "notebook_already_started") throw error;
              }
              book = await getBook();
            }
            if (!book.notebook_id) throw new Error("notebook_not_started");
            if (!(await joinSceneNotebook(account, book.notebook_id, book.history_id, { [bucket]: hubBucket(book) }, guard))) throw new Error("join_failed");
            changed = true;
            const progress = (await snapshot()).starting;
            if (progress) await writeNotebookProgress(account, "start", progress, null, guard);
            return { status: "ready", changed };
          } finally { releaseHold(); }
        }
        if (!book.notebook_id) throw new Error("notebook_missing");
        let pending = local.writing as PendingWrite | null;
        if (pending && (pending.history !== book.history_id || pending.notebookId !== book.notebook_id)) {
          if (!(await writeNotebookProgress(account, "write", pending, null, guard))) throw new Error("local_store_failed");
          pending = null;
        }
        if (!pending) {
          const frozen = local.buckets[bucket] ?? emptyBucket();
          const rows = new Map(book.items.map((row) => [row.id, row]));
          const upserts: Upload[] = [], deletes: Delete[] = [], tooBig: string[] = [];
          for (const [id, state] of Object.entries(frozen.states)) {
            if (state.deletion) {
              deletes.push({ id, intent_id: state.deletion.intentId, base: toBase(state.deletion.base) });
            } else if (state.text !== null) {
              const scene = JSON.parse(state.text) as Scene;
              if (scene.localNotebookCopy === "upload_failed") continue;
              const hash = await fingerprint(state.text); check();
              const row = rows.get(id);
              const unknown = !state.base || state.base.history !== book.history_id || !row || row.base.rev < state.base.rev ||
                (row.base.rev === state.base.rev && row.base.hash !== state.base.hash);
              if (!state.revival && !unknown && hash === state.base?.hash) continue;
              if (bytes(state.text) > SCENE_LIMIT) { tooBig.push(id); continue; }
              upserts.push({ id, name: scene.name, data: state.text,
                base: state.revival && row?.deleted_at ? row.base : toBase(state.base),
                ...(state.revival ? { revive: true, intent_id: state.revival.intentId } : {}),
              });
            }
          }
          const requests: Payload[] = batches(upserts).map((chunk) => ({ request_id: newSceneIntentId(), project_id: "", upserts: chunk, deletes: [] }));
          for (let i = 0; i < deletes.length; i += 500) requests.push({ request_id: newSceneIntentId(), project_id: "", upserts: [], deletes: deletes.slice(i, i + 500) });
          if (frozen.order.dirty || !frozen.order.base || frozen.order.base.history !== book.history_id) {
            requests.push({ request_id: newSceneIntentId(), project_id: "", upserts: [], deletes: [], order: {
              ids: frozen.scenes.filter((s) => s.localNotebookCopy !== "upload_failed" && !tooBig.includes(s.id)).map((s) => s.id),
              rev: frozen.order.base?.rev ?? 0, history_id: frozen.order.base?.history ?? book.history_id,
            } });
          }
          const canonical = hubBucket(book);
          const localCopies = frozen.scenes.filter((s) => s.localNotebookCopy === "upload_failed");
          if (!requests.length && !tooBig.length && equal(frozen.scenes, [...canonical.scenes, ...localCopies]) &&
              equal(frozen.order, { base: canonical.order, dirty: null }) &&
              book.items.every((r) => equal(frozen.states[r.id]?.base, fromBase(r.base))) &&
              Object.values(frozen.states).every((s) => !s.deletion && !s.revival)) {
            if (equal((await snapshot()).buckets[bucket] ?? emptyBucket(), frozen)) return { status: "ready", changed };
            continue;
          }
          pending = { id: newSceneIntentId(), history: book.history_id, notebookId: book.notebook_id, frozen, requests, tooBig,
            orderCanAdvance: equal(frozen.order.base, { history: book.history_id, rev: book.order.rev }),
          };
          if (!(await writeNotebookProgress(account, "write", null, pending, guard))) throw new Error("local_store_failed");
        }
        const receipts: Receipt[] = [];
        for (let index = 0; index < pending.requests.length; index++) {
          let payload = pending.requests[index];
          // 앞 묶음이 더한/지운 행 때문에 바뀐 순서 판은 그 요청의 영수증에서만 승계한다.
          // 이미 엇갈린 순서 판을 새 조회 판으로 바꾸면 사용자의 순서 충돌 의도를 잃는다.
          const prior = receipts[receipts.length - 1];
          if (payload.order && pending.orderCanAdvance && prior && payload.order.rev !== prior.order.rev) {
            payload = { ...payload, order: { ...payload.order, rev: prior.order.rev } };
            const next: PendingWrite = { ...pending, requests: pending.requests.map((r, i) => i === index ? payload : r) };
            if (!(await writeNotebookProgress(account, "write", pending, next, guard))) throw new Error("local_store_failed");
            pending = next;
          }
          const receipt = await request<Receipt>("backup", { ...payload, token: lease.token }, "PUT");
          if (receipt.history_id !== pending.history || !receipt.order || receipt.order.history_id !== receipt.history_id || !Number.isInteger(receipt.order.rev) || !Array.isArray(receipt.results) || !Array.isArray(receipt.deletes) ||
              receipt.results.length !== payload.upserts.length || receipt.deletes.length !== payload.deletes.length ||
              receipt.results.some((r, i) => r.id !== payload.upserts[i].id || !["saved", "same", "copied", "too_big"].includes(r.status) ||
                (r.status !== "too_big" && (!r.target_id || !validBase(r.base, receipt.history_id)))) ||
              receipt.deletes.some((r, i) => r.id !== payload.deletes[i].id || r.intent_id !== payload.deletes[i].intent_id || !["deleted", "kept"].includes(r.status) || (r.base && !validBase(r.base, receipt.history_id)))) throw new Error("invalid_receipt");
          receipts.push(receipt);
        }
        const received = await getBook();
        if (received.history_id !== pending.history || received.notebook_id !== pending.notebookId) continue;
        const results = new Map(receipts.flatMap((r) => r.results).map((r) => [r.id, r]));
        const receivedRows = new Map(received.items.map((row) => [row.id, row]));
        const regressed = (row: HubRow | undefined, base: WireBase) => !row || row.base.rev < base.rev ||
          (row.base.rev === base.rev && row.base.hash !== base.hash);
        // DB 파일의 외부 교체도 방어한다. 업로드 영수증보다 과거인 조회를 성공으로 받아들이면
        // 방금 올린 편집을 로컬에서도 없애게 된다. 옛 영수증은 버리고 현 로컬 글자로 다시 판정받는다.
        const receiptRegressed = [...results.values()].some((r) => r.base && r.target_id && regressed(receivedRows.get(r.target_id), r.base));
        const localRegressed = Object.entries(pending.frozen.states).some(([id, state]) => state.text !== null &&
          !results.has(id) && !pending.tooBig.includes(id) &&
          (JSON.parse(state.text) as Scene).localNotebookCopy !== "upload_failed" && state.base?.history === received.history_id &&
          regressed(receivedRows.get(id), toBase(state.base)!));
        if (receiptRegressed || localRegressed) {
          if (!(await writeNotebookProgress(account, "write", pending, null, guard))) throw new Error("local_store_failed");
          continue;
        }
        const tooBig = new Set([...pending.tooBig, ...[...results.values()].filter((r) => r.status === "too_big").map((r) => r.id)]);
        // All replacements and acknowledgements use the original frozen states, including intent IDs.
        // A concurrent local edit rejects this whole receive; no newer edit is stamped with an older base.
        const work = pending;
        const applied = await sceneNotebookTransaction([key("nw", account)], (all, meta) => {
          if (!equal(meta[key("nw", account)], work)) return { value: "retry" as const, changed: false };
          const ids = new Set([...Object.keys(work.frozen.states), ...(all[bucket] ?? []).map((s) => s.id)]);
          const stable = equal((all[bucket] ?? []).map((s) => s.id), work.frozen.scenes.map((s) => s.id)) &&
            equal(meta[key("ob", bucket)] ?? emptyOrder(), work.frozen.order) && [...ids].every((id) =>
              sameState(stateOf(all, meta, bucket, id), work.frozen.states[id] ?? { text: null, base: null, deletion: null, revival: null }));
          if (!stable) { delete meta[key("nw", account)]; return { value: "retry" as const, changed: true }; }
          const rows = new Map(received.items.map((row) => [row.id, row]));
          for (const r of results.values()) if (r.status === "copied" && (!rows.get(r.target_id!) || rows.get(r.target_id!)!.deleted_at !== null)) {
            delete meta[key("nw", account)]; return { value: "retry" as const, changed: true };
          }
          const extra: Scene[] = [];
          for (const scene of work.frozen.scenes) {
            if (scene.localNotebookCopy === "upload_failed") extra.push(scene);
            else if (tooBig.has(scene.id)) extra.push(makeLocalNotebookCopy(scene, newSceneIntentId(), "upload_failed"));
          }
          const incoming = hubBucket(received);
          if (extra.some((s) => incoming.scenes.some((r) => r.id === s.id))) throw new Error("local_copy_collision");
          const next = [...incoming.scenes, ...extra];
          let modified = !equal(all[bucket] ?? [], next);
          all[bucket] = next;
          for (const name of Object.keys(meta)) if (/^\["[bdr]",/.test(name) && (JSON.parse(name) as string[])[1] === bucket) {
            delete meta[name]; modified = true;
          }
          for (const row of received.items) meta[key("b", bucket, row.id)] = fromBase(row.base);
          const order = { base: incoming.order, dirty: null };
          modified ||= !equal(meta[key("ob", bucket)], order);
          meta[key("ob", bucket)] = order;
          delete meta[key("nw", account)];
          return { value: modified ? "changed" as const : "ready" as const, changed: true };
        }, guard);
        if (!applied.ok) throw new Error("local_store_failed");
        if (applied.value === "retry") continue;
        changed ||= applied.value === "changed";
        return { status: "ready", changed };
      } catch (error) {
        if (error instanceof NotebookTransportError && round < 2) continue;
        throw error;
      }
    }
    return { status: "retry", changed, reason: "reconcile_limit" };
  } catch (error) {
    const reason = errorCode(error);
    return { status: ["writer_changed", "writer_required", "writer_expired"].includes(reason) ? "waiting_token" : "retry", changed, reason };
  }
}
