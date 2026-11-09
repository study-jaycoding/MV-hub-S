// 허브 공책 저장과 맞추기. 임대 획득·화면 흐름은 호출자가 맡는다.
import {
  notebookKey as key, sceneNotebookTransaction,
  holdNotebookWrites, newSceneIntentId,
  type SceneBase, type SceneIntent, type SceneOrderBase, type SceneOrderState,
} from "./sceneStore";
import { makeLocalNotebookCopy, readStoredScene, type Scene, type ScenesByProject } from "./scenes";
import { flashMsg } from "./flash";
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
  return change([], (all, meta) => replaceNotebookSceneIfUnchangedInTransaction(all, meta, bucket, input.expected, input.scene, input.base), guard);
}
function replaceNotebookSceneIfUnchangedInTransaction(all: ScenesByProject, meta: Meta, bucket: string, expected: NotebookSceneState, scene: Scene, base: SceneBase): boolean {
  if (!sameState(stateOf(all, meta, bucket, scene.id), expected) || expected.text === null || expected.deletion || expected.revival) return false;
  all[bucket] = all[bucket].map((item) => item.id === scene.id ? scene : item);
  meta[key("b", bucket, scene.id)] = base;
  return true;
}

/** 허브의 지움/행 소실 반영. 변경·되살리기 의도가 생겼으면 지우지 않는다. */
export function removeNotebookSceneIfUnchanged(bucket: string, id: string, expected: NotebookSceneState, base: SceneBase | null, guard?: () => boolean): Promise<boolean> {
  const input = structuredClone({ expected, base });
  return change([], (all, meta) => removeNotebookSceneIfUnchangedInTransaction(all, meta, bucket, id, input.expected, input.base), guard);
}
function removeNotebookSceneIfUnchangedInTransaction(all: ScenesByProject, meta: Meta, bucket: string, id: string, expected: NotebookSceneState, base: SceneBase | null): boolean {
  if (!sameState(stateOf(all, meta, bucket, id), expected) || expected.deletion || expected.revival || expected.text === null) return false;
  all[bucket] = all[bucket].filter((item) => item.id !== id);
  if (base) meta[key("b", bucket, id)] = base;
  else delete meta[key("b", bucket, id)];
  return true;
}

/** 늦은 확인은 새 의도를 거둘 수 없다. 허브가 '남김'을 답하면 d만 거두고 다음 조회가 행을 더한다. */
export function acknowledgeNotebookIntent(bucket: string, id: string, kind: "delete" | "revive", expected: NotebookSceneState, base: SceneBase | null, guard?: () => boolean): Promise<boolean> {
  const input = structuredClone({ expected, base });
  return change([], (all, meta) => acknowledgeNotebookIntentInTransaction(all, meta, bucket, id, kind, input.expected, input.base), guard);
}
function acknowledgeNotebookIntentInTransaction(all: ScenesByProject, meta: Meta, bucket: string, id: string, kind: "delete" | "revive", expected: NotebookSceneState, base: SceneBase | null): boolean {
  const current = stateOf(all, meta, bucket, id);
  const intent = kind === "delete" ? current.deletion : current.revival;
  if (!intent || !sameState(current, expected) || ((kind === "delete") !== (current.text === null))) return false;
  delete meta[key(kind === "delete" ? "d" : "r", bucket, id)];
  meta[key("b", bucket, id)] = base;
  return true;
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
let freshAfter: { after: Promise<NotebookSyncResult>; promise: Promise<NotebookSyncResult> } | null = null;
const resultListeners = new Set<(result: NotebookSyncResult) => void>();
export function subscribeNotebookSyncResult(fn: (result: NotebookSyncResult) => void): () => void {
  resultListeners.add(fn);
  return () => { resultListeners.delete(fn); };
}
/** 4단계가 공급한다. 토큰 자체는 IndexedDB/로컬 저장소에 기록하지 않는다. */
export function setSceneNotebookTokenProvider(provider: () => NotebookToken | null): void {
  tokenProvider = provider;
  providerEpoch++;
  mcpCompletions.clear(); // 미완료 작업은 서버 pending 조회가 새 세대에서 다시 접수한다.
}
type WireBase = { history_id: string; rev: number; hash: string };
type HubRow = { id: string; data: string; deleted_at: string | null; base: WireBase };
type HubBook = { notebook_id: string | null; history_id: string; items: HubRow[]; order: { ids: string[]; rev: number; history_id: string }; skipped?: string[]; hasLiveRows?: boolean };
type Upload = { id: string; name: string; data: string; base: WireBase | null; revive?: boolean; intent_id?: string };
type Delete = { id: string; intent_id: string; base: WireBase | null };
type Payload = { request_id: string; project_id: string; upserts: Upload[]; deletes: Delete[]; order?: HubBook["order"]; mcp_complete?: string[] };
type Receipt = { history_id: string; order: HubBook["order"]; results: { id: string; status: "saved" | "same" | "copied" | "too_big"; target_id: string | null; base?: WireBase }[]; deletes: { id: string; status: "deleted" | "kept"; base: WireBase | null; intent_id: string }[]; mcp_done?: string[] };
// 서버의 pending 작업이 재전달의 원장이다. 이 큐는 이미 저장된 씬에도 same 확인을 요청한다.
const mcpCompletions = new Map<string, { account: string; sceneId: string; confirmed: boolean }>();
export async function completeNotebookMcpTask(account: string, sceneId: string, taskId: string): Promise<boolean> {
  if (!hubHasFeature(SCENE_WRITER_FEATURE) || account !== getAccountNamespace()) return false;
  const id = JSON.stringify([account, taskId]);
  const pending = mcpCompletions.get(id) ?? { account, sceneId, confirmed: false };
  mcpCompletions.set(id, pending);
  await syncSceneNotebook();
  return account === getAccountNamespace() && pending.confirmed;
}
function needsMcpConfirmation(account: string, scene: Scene): boolean {
  return [...mcpCompletions.entries()].some(([id, item]) => item.account === account && item.sceneId === scene.id && scene.mcpAttachmentReceipts?.includes((JSON.parse(id) as string[])[1]));
}
function uploadRequests(upserts: Upload[]): Payload[] {
  return batches(upserts).flatMap((chunk) => {
    const ids = [...new Set(chunk.flatMap((s) => (JSON.parse(s.data) as Scene).mcpAttachmentReceipts ?? []))];
    const requests: Payload[] = [];
    // API는 한 번에 완료 500개. 옛 영수증이 많아도 새 작업을 잘라 버리지 않는다.
    for (let i = 0; i < Math.max(1, ids.length); i += 500) requests.push({ request_id: newSceneIntentId(), project_id: "", upserts: chunk, deletes: [], mcp_complete: ids.slice(i, i + 500) });
    return requests;
  });
}
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
  const skipped: string[] = [];
  const valid: HubRow[] = [];
  for (const row of value.items) {
    if (typeof row.id !== "string" || ids.has(row.id) || !validBase(row.base, value.history_id) || typeof row.data !== "string") throw new Error("invalid_notebook");
    ids.add(row.id);
    try {
      const raw = JSON.parse(row.data);
      const scene = readStoredScene({ ...raw, edges: raw?.edges ?? [] });
      if (scene.id !== row.id) throw new Error("scene id mismatch");
      valid.push(row);
    } catch { skipped.push(row.id); }
    if (row.deleted_at !== null && typeof row.deleted_at !== "string") throw new Error("invalid_notebook");
  }
  const live = new Set(value.items.filter((r) => r.deleted_at === null).map((r) => r.id));
  if (new Set(value.order.ids).size !== value.order.ids.length || value.order.ids.some((id) => !live.has(id)) || live.size !== value.order.ids.length) throw new Error("invalid_order");
  if (skipped.length) flashMsg(`읽을 수 없는 허브 씬 ${skipped.length}개를 건너뛰었습니다 — 원본은 허브에 남아 있습니다`);
  return { ...value, items: valid, order: { ...value.order, ids: value.order.ids.filter((id) => !skipped.includes(id)) }, skipped, hasLiveRows: live.size > 0 };
}
function rowScene(row: HubRow): Scene {
  const raw = JSON.parse(row.data) as Scene;
  // 파일 가져오기 관문은 실행 표식을 제거한다. 같은 id 받기에서는 원문 표식을 그대로 보존한다.
  return { ...raw, ...(typeof raw.name !== "string" || !raw.name ? { name: readStoredScene({ ...raw, edges: raw.edges ?? [] }).name } : {}), ...(!Array.isArray(raw.edges) ? { edges: [] } : {}) };
}
function hubBucket(book: HubBook): NotebookHubBucket {
  const rows = new Map(book.items.map((row) => [row.id, row]));
  return {
    scenes: book.order.ids.map((id) => rowScene(rows.get(id)!)),
    bases: Object.fromEntries(book.items.map((row) => [row.id, fromBase(row.base)])),
    order: { history: book.history_id, rev: book.order.rev },
  };
}

/** 동시 호출은 합치되, 넘기기는 settle 뒤의 새 고정본으로 한 번 더 맞춘다. */
export function syncSceneNotebook(options: { fresh?: boolean } = {}): Promise<NotebookSyncResult> {
  if (!hubHasFeature(SCENE_WRITER_FEATURE)) return Promise.resolve({ status: "disabled", changed: false });
  if (options.fresh && inFlight) {
    if (freshAfter?.after === inFlight) return freshAfter.promise;
    const after = inFlight;
    const promise = after.then(() => syncSceneNotebook()).finally(() => {
      if (freshAfter?.promise === promise) freshAfter = null;
    });
    freshAfter = { after, promise };
    return promise;
  }
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
  for (const [id, pending] of mcpCompletions) if (pending.account !== account) mcpCompletions.delete(id);
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
        const reduced = (local.buckets[bucket]?.scenes ?? []).filter((s) => s.localNotebookCopy === "upload_failed" && bytes(JSON.stringify(s)) <= SCENE_LIMIT);
        if (reduced.length) {
          await sceneNotebookTransaction([], (all) => {
            let modified = false;
            all[bucket] = (all[bucket] ?? []).map((s) => {
              if (!reduced.some((before) => before.id === s.id && equal(before, s))) return s;
              const copy = { ...s }; delete copy.localNotebookCopy; modified = true; return copy;
            });
            return { value: modified, changed: modified };
          }, guard);
          local = await snapshot();
        }
        let book = await getBook();
        if (!local.joined || !book.notebook_id) {
          let releaseHold: (() => void) | undefined;
          try {
            local = await snapshot();
            if (!book.notebook_id) {
              const scenes = local.joined && book.hasLiveRows ? [] : local.buckets[bucket]?.scenes ?? [];
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
                // 시작 칸은 아직 공책이 아니다. 올리는 동안 편집을 허용하고 확정 직전에만
                // 입력을 거둔다. flush가 만든 마지막 편집도 같아야 이 시작본을 확정한다.
                releaseHold = holdNotebookWrites(account);
                local = await snapshot();
                const currentScenes = local.joined && book.hasLiveRows ? [] : local.buckets[bucket]?.scenes ?? [];
                if (!equal(currentScenes, scenes)) {
                  await writeNotebookProgress(account, "start", progress, null, guard);
                  continue;
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
            if (!local.joined) {
              releaseHold ??= holdNotebookWrites(account);
              if (!(await joinSceneNotebook(account, book.notebook_id, book.history_id, { [bucket]: hubBucket(book) }, guard))) throw new Error("join_failed");
              changed = true;
              const progress = (await snapshot()).starting;
              if (progress) await writeNotebookProgress(account, "start", progress, null, guard);
              return { status: "ready", changed };
            }
            const progress = (await snapshot()).starting;
            if (progress) await writeNotebookProgress(account, "start", progress, null, guard);
            local = await snapshot(); // 합류했던 프로필은 보관/합류를 다시 하지 않고 기존 판으로 맞춘다.
          } finally { releaseHold?.(); }
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
            if (book.skipped?.includes(id)) continue;
            if (state.deletion) {
              deletes.push({ id, intent_id: state.deletion.intentId, base: toBase(state.deletion.base) });
            } else if (state.text !== null) {
              const scene = JSON.parse(state.text) as Scene;
              if (scene.localNotebookCopy === "upload_failed") continue;
              const hash = await fingerprint(state.text); check();
              const row = rows.get(id);
              if (!state.revival && row && state.base?.history !== book.history_id && hash === state.base?.hash) continue;
              const unknown = !state.base || state.base.history !== book.history_id || !row || row.base.rev < state.base.rev ||
                (row.base.rev === state.base.rev && row.base.hash !== state.base.hash);
              if (!state.revival && !unknown && hash === state.base?.hash && !needsMcpConfirmation(account, scene)) continue;
              if (bytes(state.text) > SCENE_LIMIT) { tooBig.push(id); continue; }
              upserts.push({ id, name: scene.name, data: state.text,
                base: state.revival && row?.deleted_at ? row.base : toBase(state.base),
                ...(state.revival ? { revive: true, intent_id: state.revival.intentId } : {}),
              });
            }
          }
          const requests: Payload[] = uploadRequests(upserts);
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
          if (receipt.mcp_done && (!Array.isArray(receipt.mcp_done) || receipt.mcp_done.some((id) => !payload.mcp_complete?.includes(id) || !payload.upserts.some((up) =>
            (JSON.parse(up.data) as Scene).mcpAttachmentReceipts?.includes(id) && receipt.results.some((r) => r.id === up.id && r.target_id === up.id && ["saved", "same"].includes(r.status)))))) throw new Error("invalid_mcp_receipt");
          for (const id of receipt.mcp_done ?? []) {
            const name = JSON.stringify([account, id]), completion = mcpCompletions.get(name);
            if (completion) { completion.confirmed = true; mcpCompletions.delete(name); }
          }
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
          !received.skipped?.includes(id) && !results.has(id) && !pending.tooBig.includes(id) &&
          (JSON.parse(state.text) as Scene).localNotebookCopy !== "upload_failed" && state.base?.history === received.history_id &&
          regressed(receivedRows.get(id), toBase(state.base)!));
        if (receiptRegressed || localRegressed) {
          if (!(await writeNotebookProgress(account, "write", pending, null, guard))) throw new Error("local_store_failed");
          continue;
        }
        const tooBig = new Set([...pending.tooBig, ...[...results.values()].filter((r) => r.status === "too_big").map((r) => r.id)]);
        // All replacements and acknowledgements use the original frozen states, including intent IDs.
        // A concurrent edit skips text replacement but inherits the receipt for our own preceding write.
        const work = pending;
        const applied = await sceneNotebookTransaction([key("nw", account)], (all, meta) => {
          if (!equal(meta[key("nw", account)], work)) return { value: "retry" as const, changed: false };
          const ids = new Set([...Object.keys(work.frozen.states), ...(all[bucket] ?? []).map((s) => s.id)]);
          const stable = equal((all[bucket] ?? []).map((s) => s.id), work.frozen.scenes.map((s) => s.id)) &&
            equal(meta[key("ob", bucket)] ?? emptyOrder(), work.frozen.order) && [...ids].every((id) =>
              sameState(stateOf(all, meta, bucket, id), work.frozen.states[id] ?? { text: null, base: null, deletion: null, revival: null }));
          if (!stable) {
            // 서버가 확인한 내 쓰기의 판은 최신 글자와 별개로 잇는다. 그렇지 않으면 다음 편집마다
            // 옛 판으로 재전송되어 내 직전 편집과 충돌하고 사본이 계속 늘어난다(새 씬도 동일).
            for (const r of results.values()) {
              const before = work.frozen.states[r.id];
              const now = stateOf(all, meta, bucket, r.id);
              if (!before || !r.base || !["saved", "same"].includes(r.status) || r.target_id !== r.id || !equal(now.base, before.base)) continue;
              meta[key("b", bucket, r.id)] = fromBase(r.base);
              if (before.revival && now.revival?.intentId === before.revival.intentId) delete meta[key("r", bucket, r.id)];
              // 올리는 동안 새로 한 삭제는 남기되, 내가 저장한 글자의 판으로 삭제하게 한다.
              if (now.deletion && equal(now.deletion.base, before.base)) meta[key("d", bucket, r.id)] = { ...now.deletion, base: fromBase(r.base) };
            }
            for (const r of receipts.flatMap((receipt) => receipt.deletes)) {
              const before = work.frozen.states[r.id], now = stateOf(all, meta, bucket, r.id);
              if (!before || !equal(now.base, before.base)) continue;
              meta[key("b", bucket, r.id)] = r.base ? fromBase(r.base) : null;
              if (now.deletion?.intentId === r.intent_id) delete meta[key("d", bucket, r.id)];
            }
            const last = receipts[receipts.length - 1];
            const order = (meta[key("ob", bucket)] as SceneOrderState | undefined) ?? emptyOrder();
            if (last && work.orderCanAdvance && equal(order.base, work.frozen.order.base)) meta[key("ob", bucket)] = {
              base: { history: last.order.history_id, rev: last.order.rev }, dirty: order.dirty === work.frozen.order.dirty ? null : order.dirty,
            };
            delete meta[key("nw", account)]; return { value: "retry" as const, changed: true };
          }
          const rows = new Map(received.items.map((row) => [row.id, row]));
          for (const r of results.values()) if (r.status === "copied" && (!rows.get(r.target_id!) || rows.get(r.target_id!)!.deleted_at !== null)) {
            delete meta[key("nw", account)]; return { value: "retry" as const, changed: true };
          }
          const extra: Scene[] = [];
          for (const scene of work.frozen.scenes) {
            if (scene.localNotebookCopy === "upload_failed" || received.skipped?.includes(scene.id)) extra.push(scene);
            else if (tooBig.has(scene.id)) extra.push(makeLocalNotebookCopy(scene, newSceneIntentId(), "upload_failed"));
          }
          const incoming = hubBucket(received);
          if (extra.some((s) => incoming.scenes.some((r) => r.id === s.id))) return { value: "retry" as const, changed: false };
          const next = [...incoming.scenes, ...extra];
          let modified = !equal(all[bucket] ?? [], next);
          for (const receipt of receipts) {
            for (const r of receipt.deletes) acknowledgeNotebookIntentInTransaction(all, meta, bucket, r.id, "delete", stateOf(all, meta, bucket, r.id), r.base ? fromBase(r.base) : null);
            for (const r of receipt.results) if (r.base && ["saved", "same"].includes(r.status)) acknowledgeNotebookIntentInTransaction(all, meta, bucket, r.id, "revive", stateOf(all, meta, bucket, r.id), fromBase(r.base));
          }
          // The whole frozen state is still current and conflicting/oversized contents have a copy.
          // Resolve remaining intents before applying the same conditional store primitives.
          for (const id of ids) if (!received.skipped?.includes(id)) { delete meta[key("d", bucket, id)]; delete meta[key("r", bucket, id)]; }
          for (const scene of all[bucket] ?? []) if (!next.some((s) => s.id === scene.id)) removeNotebookSceneIfUnchangedInTransaction(all, meta, bucket, scene.id, stateOf(all, meta, bucket, scene.id), null);
          for (const scene of incoming.scenes) {
            const expected = stateOf(all, meta, bucket, scene.id);
            if (expected.text === null) all[bucket] = [...(all[bucket] ?? []), scene];
            else replaceNotebookSceneIfUnchangedInTransaction(all, meta, bucket, expected, scene, incoming.bases[scene.id]);
          }
          const appliedScenes = new Map((all[bucket] ?? []).map((s) => [s.id, s]));
          extra.forEach((s) => appliedScenes.set(s.id, s));
          all[bucket] = next.map((s) => appliedScenes.get(s.id)!);
          for (const name of Object.keys(meta)) if (/^\["[bdr]",/.test(name) && (JSON.parse(name) as string[])[1] === bucket) {
            if (received.skipped?.includes((JSON.parse(name) as string[])[2])) continue;
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
