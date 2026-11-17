// 허브 공책 저장과 맞추기. 임대 획득·화면 흐름은 호출자가 맡는다.
import {
  notebookKey as key, sceneNotebookTransaction, readSceneStoreMeta,
  holdNotebookWrites, newSceneIntentId,
  readSceneStoreForClose, readConfirmedTexts, readConfirmedNotebookJoin, sceneStoreHasPending,
  type SceneBase, type SceneIntent, type SceneOrderBase, type SceneOrderState,
} from "./sceneStore";
import { makeLocalNotebookCopy, readStoredScene, type Scene, type ScenesByProject } from "./scenes";
import { flashMsg } from "./flash";
import type { SceneAbsorbConflict } from "./sceneAbsorb";
import { jsonFetch } from "./http";
import { getAccountNamespace } from "./accountScope";
import { hubHasFeature, EXPECT_ACCOUNT_HEADER } from "./hubFeatures";
import { sha256Hex, sha256Js } from "./editShare";

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
export interface NotebookJoin { notebookId: string; history: string; restoreGeneration?: string; beforeStart?: true; awaitingStart?: true; receivedFingerprint?: string }
export interface NotebookProgress { id: string; [field: string]: unknown }
export interface NotebookSnapshot {
  buckets: Record<string, NotebookBucket>;
  joined: NotebookJoin | null;
  starting: NotebookProgress | null;
  writing: NotebookProgress | null;
}
export interface NotebookArchive { notebookId: string; scenes: ScenesByProject; conflicts?: SceneAbsorbConflict[] }
export interface RestoreArchive extends NotebookArchive { id: string; createdAt: string; fromGeneration: string | null; toGeneration: string; controls: Record<string, unknown> }
export function hasRestoreArchiveContent(archive: Pick<RestoreArchive, "scenes" | "conflicts" | "controls">): boolean {
  // 형태를 확인할 수 없는 보관본은 빈 것으로 숨기지 않는다.
  if (!archive || typeof archive !== "object" || Array.isArray(archive)) return true;
  if (!archive.scenes || typeof archive.scenes !== "object" || Array.isArray(archive.scenes) ||
    !archive.controls || typeof archive.controls !== "object" || Array.isArray(archive.controls)) return true;
  if (archive.conflicts !== undefined && !Array.isArray(archive.conflicts)) return true;
  return Object.values(archive.scenes).some((scenes) => !Array.isArray(scenes) || scenes.length > 0) || !!archive.conflicts?.length ||
    Object.values(archive.controls).some((value) => value !== undefined);
}
export const validRestoreGeneration = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;
// 미러 세대 지도의 지문 기억 — 씬마다 [글자, 지문] 하나. 미러 동기화 한 번에 두 번·카드 연결 읽기마다 모든 씬을 다시 해싱하던 것을
//  같은 글자면 다시 쓴다(같은 글자 = 같은 지문). 지금 확정본에 없는·바뀐 글자는 부를 때마다 버린다. sceneBackup 의 provenanceHash 와
//  같은 까닭이지만 sceneBackup 이 이 모듈을 가져오므로(순환 금지) 따로 둔다(docs/status/배포후보_공책기본끔_2026-11-15.md).
const generationHashes = new Map<string, [string, string]>();
let generationHashesAccount = "";
export function mirrorSceneGenerations(): Map<string, string> {
  try {
    const account = getAccountNamespace();
    // 다른 계정의 글자를 쥐고 있지 않는다 — 계정이 바뀌거나 기록이 없으면 먼저 비운다(독립 리뷰 01a1de12).
    if (account !== generationHashesAccount) { generationHashes.clear(); generationHashesAccount = account; }
    const value = JSON.parse(localStorage.getItem(`mvhub.mirrorRecovery:${account}`) ?? "null") as { generation?: unknown; blockedIds?: unknown; raws?: Record<string, string | null> } | null;
    const result = new Map<string, string>();
    if (!value || !validRestoreGeneration(value.generation) || !Array.isArray(value.blockedIds)) { generationHashes.clear(); return result; }
    const blocked = new Set(value.blockedIds), texts = new Map(readConfirmedTexts(`${account}::_none`).map((scene) => [scene.id, scene.text]));
    for (const [id, [text]] of generationHashes) if (texts.get(id) !== text) generationHashes.delete(id);
    const hashOf = (id: string, text: string): string => {
      const kept = generationHashes.get(id);
      if (kept && kept[0] === text) return kept[1];
      const hash = sha256Js(new TextEncoder().encode(text));
      generationHashes.set(id, [text, hash]);
      return hash;
    };
    for (const [id, hash] of Object.entries(value.raws ?? {})) {
      const text = texts.get(id);
      if (!blocked.has(id) && hash === (text === undefined ? null : hashOf(id, text))) result.set(id, value.generation);
    }
    return result;
  } catch { generationHashes.clear(); return new Map(); }
}
export function notebookRestoreGeneration(account: string): string | null {
  if (account !== getAccountNamespace()) return null;
  const joined = readConfirmedNotebookJoin(account);
  return joined?.restoreGeneration ?? null;
}
export async function readRestoreArchives(account: string): Promise<{ ok: true; value: RestoreArchive[]; fresh: boolean } | { ok: false; stale?: true }> {
  const result = await readSceneStoreMeta(key("nr", account), () => account === getAccountNamespace());
  return result.ok ? { ok: true, value: (result.value as RestoreArchive[] | undefined) ?? [], fresh: result.fresh } : result;
}

const restoreArchivedSubs = new Set<() => void>();
/** 합류가 보관 묶음(nr)을 새로 적었을 때 — 캔버스 복구 알림이 씬 저장마다 보관함을 읽지 않게(docs/status/공책첫전환복구동선_2026-11-15.md). */
export function subscribeRestoreArchived(fn: () => void): () => void {
  restoreArchivedSubs.add(fn);
  return () => { restoreArchivedSubs.delete(fn); };
}
function replacedJoinBases(joined: NotebookJoin | null | undefined, book: HubBook, bases: Record<string, SceneBase | null>): boolean {
  if (joined?.notebookId !== "" || !book.notebook_id) return false;
  if (joined.beforeStart) return true;
  const rows = new Map(book.items.map((row) => [row.id, row])); // tombstone도 실제로 있는 행이다.
  const skipped = new Set(book.skipped);
  return Object.entries(bases).some(([id, base]) => {
    if (!base || skipped.has(id)) return false;
    const row = rows.get(id);
    return !row || (base.history === book.history_id && (row.base.rev < base.rev ||
      (row.base.rev === base.rev && row.base.hash !== base.hash)));
  });
}
async function adoptRestoredNotebook(account: string, book: HubBook, guard: () => boolean, pendingAtStart: boolean, leaseGeneration: string, approval?: NotebookStartApproval, rejoinRequired = false) {
  const hadPending = pendingAtStart || sceneStoreHasPending();
  const release = holdNotebookWrites(account);
  let archived = false;
  try {
    const archiveKey = key("nr", account);
    const result = await sceneNotebookTransaction<boolean | (NotebookStartOffer & { approved?: true })>([archiveKey, key("ns", account), key("nw", account)], (all, meta) => {
      archived = false; // 다시 도는 거래면 앞 시도의 표시를 지운다
      const joined = meta[key("nj", account)] as NotebookJoin | undefined;
      const staleProgress = [meta[key("ns", account)], meta[key("nw", account)]].some((value) => value && (value as NotebookProgress).restoreGeneration !== book.restore_generation);
      const bases = Object.fromEntries(Object.entries(meta).flatMap(([name, value]) => {
        if (!value || !name.startsWith('["b",')) return [];
        const [, scope, id] = JSON.parse(name) as string[];
        return scope === `${account}::_none` ? [[id, value as SceneBase]] : [];
      }));
      if (!rejoinRequired && joined?.restoreGeneration === book.restore_generation && !staleProgress && !joined.awaitingStart && !replacedJoinBases(joined, book, bases)) return { changed: false, value: false };
      const before = shownScenes(all, account);
      const scenes = Object.fromEntries(Object.entries(all).filter(([bucket]) => belongs(bucket, account)));
      const conflicts = ((meta.conflicts as SceneAbsorbConflict[] | undefined) ?? []).filter((item) => belongs(item.bucket, account));
      const bucket = `${account}::_none`, incoming = hubBucket(book);
      const hasIntent = Object.entries(meta).some(([name, value]) => {
        if (!/^\["(?:d|r|ob)",/.test(name)) return false;
        const [kind, scope] = JSON.parse(name) as string[];
        return belongs(scope, account) && !!value && (kind !== "ob" || !!(value as SceneOrderState).dirty);
      });
      const localScenes = scenes[bucket] ?? [];
      const unordered = book.notebook_id === null || book.order.rev === 0;
      const incomingById = new Map(incoming.scenes.map((scene) => [scene.id, scene]));
      const sameContents = localScenes.length === incoming.scenes.length && new Set(localScenes.map((scene) => scene.id)).size === localScenes.length &&
        localScenes.every((scene) => equal(scene, incomingById.get(scene.id)));
      const sameScenes = unordered ? sameContents : equal(localScenes, incoming.scenes);
      const restored = knownMirrorRestore(account, book.restore_generation, scenes);
      const cleanUpgrade = !rejoinRequired && !restored && !joined?.restoreGeneration && !hadPending && !sceneStoreHasPending() && !hasIntent && !conflicts.length && !book.skipped?.length &&
        !meta[key("ns", account)] && !meta[key("nw", account)] &&
        Object.entries(scenes).every(([name, items]) => name === bucket || !items.length) && sameScenes;
      if (cleanUpgrade) {
        for (const row of book.items) meta[key("b", bucket, row.id)] = fromBase(row.base);
        meta[key("ob", bucket)] = { base: incoming.order, dirty: unordered ? newSceneIntentId() : null } satisfies SceneOrderState;
        meta[key("nj", account)] = { notebookId: book.notebook_id ?? "", history: book.history_id, restoreGeneration: book.restore_generation,
          ...(!book.notebook_id ? { beforeStart: true } : {}) } satisfies NotebookJoin;
        return { changed: true, value: false };
      }
      if (!book.notebook_id && !staleProgress &&
          (joined?.restoreGeneration === book.restore_generation || (!joined?.restoreGeneration && !restored))) {
        const offer: NotebookStartOffer = { kind: "confirm", id: newSceneIntentId(), account, count: localScenes.length, hubCount: incoming.scenes.length,
          ...(joined?.restoreGeneration && book.hasLiveRows ? { afterRestore: true } : {}),
          provenanceFingerprint: startFingerprint(all, meta, account, true),
          localFingerprint: startFingerprint(all, meta, account), bookFingerprint: bookFingerprint(book) };
        const progress = meta[key("ns", account)] as PendingStart | undefined;
        const confirmed = approval?.account === account && approval.bookFingerprint === offer.bookFingerprint &&
          approval.localFingerprint === offer.localFingerprint && approval.id === startNotice?.id;
        const resuming = progress?.generation === leaseGeneration && progress.firstStart?.localFingerprint === offer.localFingerprint &&
          progress.firstStart.bookFingerprint === offer.bookFingerprint;
        if (confirmed || resuming) {
          return { changed: false, value: { ...offer, approved: true } };
        }
        return { changed: false, value: offer };
      }
      const receivedOnly = joined?.awaitingStart && book.notebook_id && joined.restoreGeneration === book.restore_generation &&
        joined.history === book.history_id && !conflicts.length && joined.receivedFingerprint === receivedFingerprint(all, account);
      const progress = meta[key("ns", account)] as PendingStart | undefined;
      const completedEmptyStart = receivedOnly && sameContents && progress?.restoreGeneration === book.restore_generation &&
        progress.history === book.history_id && progress.generation === leaseGeneration && Array.isArray(progress.scenes) && progress.scenes.length === 0;
      const pendingControl = hasIntent || (!!progress && !completedEmptyStart) || !!meta[key("nw", account)];
      const archiveScenes = receivedOnly ? {} : scenes;
      const controls: Meta = {};
      for (const [name, value] of Object.entries(meta)) {
        if (value === undefined) continue; // 없는 ns/nw도 조회 결과에는 키가 있다. 보관·삭제할 자료가 아니다.
        if (!/^\["(?:b|d|r|ob|ns|nw|nj)",/.test(name)) continue;
        const [, scope] = JSON.parse(name) as string[];
        if (scope === account || belongs(scope, account)) { controls[name] = value; delete meta[name]; }
      }
      if ((!receivedOnly || pendingControl) && hasRestoreArchiveContent({ scenes: archiveScenes, conflicts, controls })) {
        const archive: RestoreArchive = { id: newSceneIntentId(), createdAt: new Date().toISOString(), notebookId: joined?.notebookId ?? "",
          fromGeneration: joined?.restoreGeneration ?? null, toGeneration: book.restore_generation, scenes: archiveScenes, conflicts, controls };
        meta[archiveKey] = [...((meta[archiveKey] as RestoreArchive[] | undefined) ?? []), archive];
        archived = true;
      }
      meta.conflicts = ((meta.conflicts as SceneAbsorbConflict[] | undefined) ?? []).filter((item) => !belongs(item.bucket, account));
      for (const bucket of Object.keys(scenes)) delete all[bucket];
      all[bucket] = incoming.scenes;
      for (const row of book.items) meta[key("b", bucket, row.id)] = fromBase(row.base);
      meta[key("ob", bucket)] = { base: incoming.order, dirty: null } satisfies SceneOrderState;
      meta[key("nj", account)] = { notebookId: book.notebook_id ?? "", history: book.history_id, restoreGeneration: book.restore_generation,
        ...(!book.notebook_id ? { beforeStart: true, awaitingStart: true, receivedFingerprint: receivedFingerprint(all, account) } : {}) } satisfies NotebookJoin;
      return { changed: true, value: before !== shownScenes(all, account), notify: conflicts.length > 0 };
    }, guard);
    if (result.ok && archived) for (const fn of [...restoreArchivedSubs]) fn();
    return result;
  } finally { release(); }
}
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
  // 정본 글자가 지금 글자와 같으면(방금 올린 그 씬) 객체를 바꾸지 않고 기준만 잇는다 — 새 객체가 저장소에서 씬 쓰기가 되어
  //  화면이 같은 씬을 다시 받아 그렸다(2026-11-10). 위 조건 검사·기준 갱신은 그대로다.
  if (expected.text !== JSON.stringify(scene)) all[bucket] = all[bucket].map((item) => item.id === scene.id ? scene : item);
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
export async function joinSceneNotebook(account: string, notebookId: string, history: string, buckets: Record<string, NotebookHubBucket>, guard?: () => boolean, restoreGeneration?: string): Promise<boolean> {
  return (await joinSceneNotebookDetailed(account, notebookId, history, buckets, guard, restoreGeneration)).joined;
}
/** 이 계정의 보이는 씬 목록(빈 버킷 제외, 버킷 이름순) — 합류 전후 비교용 */
function shownScenes(all: ScenesByProject, account: string): string {
  return JSON.stringify(Object.entries(all).filter(([bucket, scenes]) => belongs(bucket, account) && scenes.length).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
function receivedFingerprint(all: ScenesByProject, account: string): string {
  // 대기 중 카메라 이동은 받은 판의 새 원문으로 보관하지 않는다.
  const scenes = Object.fromEntries(Object.entries(all).filter(([bucket]) => belongs(bucket, account))
    .map(([bucket, items]) => [bucket, items.map(({ camera: _camera, ...scene }) => scene)]));
  return sha256Js(new TextEncoder().encode(shownScenes(scenes, account)));
}
/** 합류 + 그 트랜잭션 안에서 본 화면 변화(합류 성공이 곧 화면 변화는 아니다 — 같은 내용이면 false) */
async function joinSceneNotebookDetailed(account: string, notebookId: string, history: string, buckets: Record<string, NotebookHubBucket>, guard?: () => boolean, restoreGeneration?: string, firstStart = false): Promise<{ joined: boolean; visible: boolean }> {
  const input = structuredClone(buckets);
  const none = { joined: false, visible: false };
  // 서버 응답 해석은 3단계. 경계를 잘못 넘긴 입력은 부분 적용하지 않는다.
  for (const [bucket, value] of Object.entries(input)) {
    if (!belongs(bucket, account) || new Set(value.scenes.map((s) => s.id)).size !== value.scenes.length ||
      value.order.history !== history || value.scenes.some((scene) => own(value.bases, scene.id)?.history !== history)) return none;
  }
  const archiveKey = key("na", account, notebookId);
  const result = await sceneNotebookTransaction([archiveKey], (all, meta) => {
    const joined = meta[key("nj", account)] as NotebookJoin | undefined;
    if (joined && (!firstStart || joined.restoreGeneration)) return { value: none, changed: false };
    const shownBefore = shownScenes(all, account);
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
    meta[key("nj", account)] = { notebookId, history, ...(restoreGeneration ? { restoreGeneration } : {}) } satisfies NotebookJoin;
    const conflictsChanged = (meta.conflicts as SceneAbsorbConflict[]).length !== conflicts.length;
    // 씬 차이 없이 충돌 목록만 바뀌어도 화면(충돌 탭)이 알아야 한다 — 저장소의 바깥 알림은 씬 차이가 있을 때만 돈다
    return { value: { joined: true, visible: shownScenes(all, account) !== shownBefore }, changed: true, notify: conflictsChanged };
  }, guard);
  return result.ok ? result.value : none;
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
export const SCENE_WRITER_FEATURE = "scene_writer_confirm_v1";
export const NOTEBOOK_PROTOCOL_HEADERS = { "X-MVHub-Canvas-Protocol": "confirm-v1" };
const SCENE_LIMIT = 5 * 1024 * 1024;
export interface NotebookToken { account: string; token: string; generation: string }
export interface NotebookSyncResult {
  status: "disabled" | "waiting_token" | "ready" | "local_only" | "retry";
  changed: boolean;
  /** 이 동기화의 공책 연산이 사용자가 볼 씬·순서를 바꿨는가(진행 기록·기준만 바뀐 것은 아님) — 복구 알림·목록 다시 받기의 열쇠 */
  visibleChanged: boolean;
  reason?: string;
  sceneIds?: string[];
}
export interface NotebookStartOffer {
  kind: "confirm"; id: string; account: string; count: number; hubCount: number; provenanceFingerprint: string; localFingerprint: string; bookFingerprint: string;
  changed?: boolean;
  afterRestore?: true;
}
export type NotebookStartApproval = NotebookStartOffer;
type NotebookStartNotice = NotebookStartOffer | { kind: "started"; id: string; account: string };
let startNotice: NotebookStartNotice | null = null;
const startSubs = new Set<() => void>();
export const getNotebookStartNotice = () => startNotice;
export function subscribeNotebookStartNotice(fn: () => void): () => void { startSubs.add(fn); return () => { startSubs.delete(fn); }; }
function setStartNotice(next: NotebookStartNotice | null) {
  if (equal(startNotice, next)) return;
  startNotice = next;
  for (const fn of [...startSubs]) fn();
}
export function dismissNotebookStarted(id: string): void { if (startNotice?.id === id && startNotice.kind === "started") setStartNotice(null); }
export function invalidateNotebookStart(): void { setStartNotice(null); }
function knownMirrorRestore(account: string, generation: string, scenes: ScenesByProject): boolean {
  for (const scene of Object.values(scenes).flat()) {
    const ledger = localStorage.getItem(`mvhub.sceneBackupBase:${account}:${scene.id}`);
    if (ledger) {
      try { if (JSON.parse(ledger).fork) return true; }
      catch { return true; }
    }
  }
  const raw = localStorage.getItem(`mvhub.mirrorRecovery:${account}`);
  if (!raw) return false;
  try {
    const value = JSON.parse(raw);
    return (validRestoreGeneration(value.generation) && value.generation !== generation) ||
      (Array.isArray(value.blockedIds) && value.blockedIds.length > 0) ||
      (Array.isArray(value.uncopied) && value.uncopied.length > 0);
  } catch { return true; } // 출처 기록을 읽을 수 없으면 기존 보관·복구 경로로 간다.
}
function startFingerprint(all: ScenesByProject, meta: Meta, account: string, provenanceOnly = false): string {
  // ns는 이 고정본의 재시도 영수증이므로 그 자체를 원문 변경으로 세지 않는다.
  const controls = Object.entries(meta).filter(([name, value]) => {
    if (value === undefined || !/^\["(?:b|d|r|ob|nw|nj)",/.test(name)) return false;
    const [, scope] = JSON.parse(name) as string[];
    return scope === account || belongs(scope, account);
  });
  const scenes = Object.entries(all).filter(([bucket]) => belongs(bucket, account)).sort(([a], [b]) => a.localeCompare(b));
  const mirrorRaw = localStorage.getItem(`mvhub.mirrorRecovery:${account}`);
  let mirror: unknown = mirrorRaw;
  if (provenanceOnly && mirrorRaw) {
    try { const { raws: _raws, ...source } = JSON.parse(mirrorRaw); mirror = source; }
    catch { /* 읽을 수 없는 출처는 원문 그대로 대조한다. */ }
  }
  return sha256Js(new TextEncoder().encode(JSON.stringify([
    provenanceOnly ? null : scenes,
    controls.sort(([a], [b]) => a.localeCompare(b)),
    ((meta.conflicts as SceneAbsorbConflict[] | undefined) ?? []).filter((item) => belongs(item.bucket, account)),
    mirror,
    scenes.flatMap(([, items]) => items.map((scene) => [scene.id, localStorage.getItem(`mvhub.sceneBackupBase:${account}:${scene.id}`)]))
      .filter(([, ledger]) => !provenanceOnly || ledger !== null).sort(([a], [b]) => a!.localeCompare(b!)),
  ])));
}
const bookFingerprint = (book: HubBook) => sha256Js(new TextEncoder().encode(JSON.stringify(book)));
/** 확인을 누른 시점의 자료를 대조한 뒤 입력을 확정한다. 허브 판은 임대를 다시 얻은 뒤 또 대조한다. */
export async function prepareNotebookStart(id: string, settle: () => Promise<boolean>): Promise<NotebookStartApproval | null> {
  const offer = startNotice;
  const account = getAccountNamespace(), epoch = providerEpoch;
  if (offer?.kind !== "confirm" || offer.id !== id || offer.account !== account) return null;
  const guard = () => startNotice === offer && account === getAccountNamespace() && epoch === providerEpoch && hubHasFeature(SCENE_WRITER_FEATURE);
  const before = await sceneNotebookTransaction([key("ns", account), key("nw", account)], (all, meta) =>
    ({ changed: false, value: startFingerprint(all, meta, account, true) }), guard);
  if (!before.ok || before.value !== offer.provenanceFingerprint || !guard() || !(await settle()) || !guard()) return null;
  const after = await sceneNotebookTransaction([key("ns", account), key("nw", account)], (all, meta) =>
    ({ changed: false, value: { source: startFingerprint(all, meta, account, true), raw: startFingerprint(all, meta, account) } }), guard);
  return after.ok && guard() && after.value.source === offer.provenanceFingerprint ? { ...offer, localFingerprint: after.value.raw } : null;
}
let tokenProvider: () => NotebookToken | null = () => null;
let providerEpoch = 0;
let inFlight: Promise<NotebookSyncResult> | null = null;
let freshAfter: { after: Promise<NotebookSyncResult>; promise: Promise<NotebookSyncResult> } | null = null;
// account = 그 동기화를 시작한 계정 — 받는 쪽이 다른 계정의 결과로 재시도·재집계하지 않게(sceneBackup, Codex 6차)
const resultListeners = new Set<(result: NotebookSyncResult, account: string) => void>();
export function subscribeNotebookSyncResult(fn: (result: NotebookSyncResult, account: string) => void): () => void {
  resultListeners.add(fn);
  return () => { resultListeners.delete(fn); };
}
/** 4단계가 공급한다. 토큰 자체는 IndexedDB/로컬 저장소에 기록하지 않는다. */
export function setSceneNotebookTokenProvider(provider: () => NotebookToken | null): void {
  tokenProvider = provider;
  providerEpoch++;
  setStartNotice(null);
  mcpCompletions.clear(); // 미완료 작업은 서버 pending 조회가 새 세대에서 다시 접수한다.
  resetHashMemo(getAccountNamespace()); // 계정·쓰기 세대가 바뀌면 지문 기억도 놓는다(다른 계정의 큰 글자를 쥐지 않게)
}
type WireBase = { history_id: string; rev: number; hash: string };
type HubRow = { id: string; data: string; deleted_at: string | null; base: WireBase };
type HubBook = { restore_generation: string; notebook_id: string | null; history_id: string; items: HubRow[]; order: { ids: string[]; rev: number; history_id: string }; skipped?: string[]; hasLiveRows?: boolean };
type Upload = { id: string; name: string; data: string; base: WireBase | null; revive?: boolean; intent_id?: string };
type Delete = { id: string; intent_id: string; base: WireBase | null };
type Payload = { restore_generation?: string; request_id: string; project_id: string; upserts: Upload[]; deletes: Delete[]; order?: HubBook["order"]; mcp_complete?: string[] };
type Receipt = { restore_generation: string; history_id: string; order: HubBook["order"]; results: { id: string; status: "saved" | "same" | "copied" | "too_big"; target_id: string | null; base?: WireBase }[]; deletes: { id: string; status: "deleted" | "kept"; base: WireBase | null; intent_id: string }[]; mcp_done?: string[] };
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
  restoreGeneration: string; history: string; notebookId: string; frozen: NotebookBucket; requests: Payload[]; tooBig: string[]; orderCanAdvance: boolean;
}
interface PendingStart extends NotebookProgress { restoreGeneration: string; history: string; generation: string; scenes: Scene[]; firstStart?: { localFingerprint: string; bookFingerprint: string } }
const emptyBucket = (): NotebookBucket => ({ scenes: [], states: {}, order: emptyOrder() });
const fromBase = (base: WireBase): SceneBase => ({ history: base.history_id, rev: base.rev, hash: base.hash });
const toBase = (base: SceneBase | null): WireBase | null => base && ({ history_id: base.history, rev: base.rev, hash: base.hash });
const bytes = (text: string): number => new TextEncoder().encode(text).byteLength;

/** pagehide에서는 await하지 않는다. 로컬 판/의도를 지우지 않고 마지막 동기 편집만 보낸다.
 * 진행 중 PUT은 같은 요청 id로 먼저 확인해, 닫기 요청이 그 영수증 판을 이어받게 한다. */
export function buildSceneNotebookClose(lease: NotebookToken): string | null {
  if (!hubHasFeature(SCENE_WRITER_FEATURE) || lease.account !== getAccountNamespace()) return null;
  const current = tokenProvider();
  if (current?.token !== lease.token || current.generation !== lease.generation || current.account !== lease.account) return null;
  const snapshot = readSceneStoreForClose();
  if (!snapshot || !snapshot.meta[key("nj", lease.account)]) return null;
  const restoreGeneration = (snapshot.meta[key("nj", lease.account)] as NotebookJoin).restoreGeneration;
  if (!validRestoreGeneration(restoreGeneration)) return null;
  const bucket = `${lease.account}::_none`, scenes = snapshot.scenes[bucket] ?? [];
  const order = (snapshot.meta[key("ob", bucket)] as SceneOrderState | undefined) ?? emptyOrder();
  if (!order.base) return null;
  const pending = snapshot.meta[key("nw", lease.account)] as PendingWrite | undefined;
  if (pending && (pending.history !== order.base.history || pending.restoreGeneration !== restoreGeneration || pending.requests.some((r) => r.restore_generation !== restoreGeneration))) return null;
  const pendingIds = new Set(pending?.requests.flatMap((r) => [...r.upserts, ...r.deletes].map((item) => item.id)) ?? []);
  const payload: Payload = { restore_generation: restoreGeneration, request_id: newSceneIntentId(), project_id: "", upserts: [], deletes: [] };
  for (const scene of scenes) {
    if (scene.localNotebookCopy === "upload_failed") continue;
    const state = stateOf(snapshot.scenes, snapshot.meta, bucket, scene.id), text = state.text!;
    const hash = sha256Js(new TextEncoder().encode(text));
    if (hash === state.base?.hash && !state.revival && !pendingIds.has(scene.id) && !needsMcpConfirmation(lease.account, scene)) continue;
    payload.upserts.push({ id: scene.id, name: scene.name, data: text, base: toBase(state.base),
      ...(state.revival ? { revive: true, intent_id: state.revival.intentId } : {}) });
  }
  for (const [name, value] of Object.entries(snapshot.meta)) {
    if (!name.startsWith('["d",')) continue;
    const [, scope, id] = JSON.parse(name) as string[];
    if (scope !== bucket) continue;
    const intent = value as SceneIntent;
    payload.deletes.push({ id, base: toBase(intent.base), intent_id: intent.intentId });
  }
  if (order.dirty) payload.order = { ids: scenes.filter((s) => s.localNotebookCopy !== "upload_failed").map((s) => s.id),
    history_id: order.base.history, rev: order.base.rev };
  payload.mcp_complete = [...new Set(payload.upserts.flatMap((up) => (JSON.parse(up.data) as Scene).mcpAttachmentReceipts ?? []))];
  if (!payload.upserts.length && !payload.deletes.length && !payload.order && !pending?.requests.length) return null;
  if (payload.upserts.length > 200 || payload.deletes.length > 500 || payload.mcp_complete.length > 500 || (pending?.requests.length ?? 0) > 200) return null;
  const pendingOrderBase = pending?.orderCanAdvance && equal(order.base, pending.frozen.order.base)
    ? { history_id: order.base.history, rev: order.base.rev } : null;
  const body = JSON.stringify({ ...payload, token: lease.token, pending_requests: pending?.requests ?? [], pending_order_base: pendingOrderBase });
  // keepalive의 전체 본문 한도. 일부 씬만 보내고 정상 인계로 오해시키지 않는다.
  return bytes(body) <= 64 * 1024 ? body : null;
}
// 지문 기억 — 같은 전체 글자면 직접 계산해 둔 sha256 을 다시 쓴다. 동기화마다 허브 행 전부(받을 때 두 번)·로컬 씬 전부를
//  다시 해싱해, 화면만 옮겨도 큰 씬이면 멈춘 직후 긴 작업이 됐다(2026-11-10 실측). 서버가 보낸 hash 는 넣지 않는다(행 대조는 그대로).
//  shortcut: 상한은 추정(보유 글자 1,600만 자 ≈ 32MB·항목 1,000·한 글자 400만 자 초과는 기억 안 함) — 큰 공책이 늘면 실측 뒤 조정.
const HASH_MEMO_MAX_ITEMS = 1000;
const HASH_MEMO_MAX_CHARS = 16 * 1024 * 1024; // UTF-16 글자 수로 센다 — 상한을 세려고 다시 인코딩하지 않는다
const HASH_MEMO_MAX_ONE = 4 * 1024 * 1024;
const hashMemo = new Map<string, string>();
let hashMemoChars = 0;
let hashMemoAccount = "";
let hashMemoGen = 0; // 비울 때마다 +1 — 비우기 전에 시작한 계산이 끝나 새 기억을 다시 채우지 않게(Codex 리뷰 P2)
function resetHashMemo(account: string): void {
  hashMemo.clear();
  hashMemoChars = 0;
  hashMemoAccount = account;
  hashMemoGen++;
}
async function fingerprint(text: string): Promise<string> {
  const account = getAccountNamespace();
  if (account !== hashMemoAccount) resetHashMemo(account); // 다른 계정의 큰 글자를 쥐고 있지 않는다
  const gen = hashMemoGen;
  const kept = hashMemo.get(text);
  if (kept !== undefined) {
    hashMemo.delete(text); // 최근 것으로 옮긴다(오래된 것부터 버린다)
    hashMemo.set(text, kept);
    return kept;
  }
  const hash = await sha256Hex(text); // HTTP 문맥도 기존의 검증된 JS SHA-256 대체 경로를 쓴다.
  if (text.length <= HASH_MEMO_MAX_ONE && gen === hashMemoGen && getAccountNamespace() === hashMemoAccount && !hashMemo.has(text)) {
    hashMemo.set(text, hash);
    hashMemoChars += text.length;
    while (hashMemo.size > HASH_MEMO_MAX_ITEMS || hashMemoChars > HASH_MEMO_MAX_CHARS) {
      const oldest = hashMemo.keys().next().value as string;
      hashMemo.delete(oldest);
      hashMemoChars -= oldest.length;
    }
  }
  return hash;
}
/** 시험용 */
export function notebookHashMemoForTest(): { size: number; chars: number } {
  return { size: hashMemo.size, chars: hashMemoChars };
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
  if (!value || !validRestoreGeneration(value.restore_generation) || typeof value.history_id !== "string" || !(value.notebook_id === null || typeof value.notebook_id === "string") ||
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
  if (skipped.length) flashMsg(`읽을 수 없는 캔버스 씬 ${skipped.length}개를 건너뛰었습니다 — 원본은 이 PC 에 남아 있습니다`);
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
export function syncSceneNotebook(options: { fresh?: boolean; startApproval?: NotebookStartApproval } = {}): Promise<NotebookSyncResult> {
  if (!hubHasFeature(SCENE_WRITER_FEATURE)) return Promise.resolve({ status: "disabled", changed: false, visibleChanged: false });
  if (options.fresh && inFlight) {
    if (freshAfter?.after === inFlight) return freshAfter.promise;
    const after = inFlight;
    const promise = after.then(() => syncSceneNotebook({ startApproval: options.startApproval })).finally(() => {
      if (freshAfter?.promise === promise) freshAfter = null;
    });
    freshAfter = { after, promise };
    return promise;
  }
  if (inFlight) return inFlight;
  const account = getAccountNamespace(); // runNotebookSync 가 같은 틱에 잡는 계정과 같다
  inFlight = runNotebookSync(options.startApproval).then((result) => {
    resultListeners.forEach((fn) => fn(result, account));
    return result;
  }).finally(() => { inFlight = null; });
  return inFlight;
}
async function runNotebookSync(approval?: NotebookStartApproval): Promise<NotebookSyncResult> {
  const provided = tokenProvider();
  const lease = provided ? { ...provided } : null;
  const account = getAccountNamespace(), epoch = providerEpoch;
  for (const [id, pending] of mcpCompletions) if (pending.account !== account) mcpCompletions.delete(id);
  if (!lease || lease.account !== account) return { status: "waiting_token", changed: false, visibleChanged: false };
  const guard = () => {
    const now = tokenProvider();
    return hubHasFeature(SCENE_WRITER_FEATURE) && providerEpoch === epoch && getAccountNamespace() === account &&
      now?.account === account && now.token === lease.token && now.generation === lease.generation;
  };
  const check = () => { if (!guard()) throw new Error("writer_changed"); };
  let changed = false;
  // 공책 연산이 사용자가 볼 씬·순서를 바꿨는가 — 각 트랜잭션 안에서 판정해 성공한 것만 모은다(앞뒤 목록 비교는 그 사이의
  //  사용자 편집까지 복구로 센다). 실패로 끝나도 이미 확정한 화면 변화는 지우지 않는다.
  let visibleChanged = false;
  const bucket = `${account}::_none`;
  async function request<T>(path: string, payload?: unknown, method = "POST"): Promise<T> {
    check();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const result = await jsonFetch<T>(`/api/scenes/${path}`, {
        method: payload === undefined ? "GET" : method,
        headers: { ...NOTEBOOK_PROTOCOL_HEADERS, [EXPECT_ACCOUNT_HEADER]: account, "Content-Type": "application/json" },
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
  const startUnchanged = async (expected: string) => {
    const result = await sceneNotebookTransaction([key("nw", account)], (all, meta) =>
      ({ changed: false, value: startFingerprint(all, meta, account) === expected }), guard);
    if (!result.ok) throw new Error("local_store_failed");
    check(); return result.value;
  };
  const pendingAtStart = sceneStoreHasPending();
  let rejoinRequired = false;
  try {
    for (let round = 0; round < 3 || rejoinRequired; round++) {
      try {
        let local = await snapshot();
        let book = await getBook();
        let firstStart: PendingStart["firstStart"];
        let resumedStart = false;
        const starting = local.starting as PendingStart | null;
        if (!rejoinRequired && book.notebook_id && local.joined?.beforeStart && starting?.restoreGeneration === book.restore_generation &&
            starting.history === book.history_id && Array.isArray(starting.scenes)) {
          try {
            // 이미 시작된 공책에는 새 시도가 들어가지 않는다. 같은 시도의 확정 영수증만 재조회한다.
            const receipt = await request<{ status: string; notebook_id: string; history_id: string; restore_generation: string }>("notebook/start", {
              restore_generation: starting.restoreGeneration, token: lease.token, attempt_id: starting.id, project_id: "",
              expected_count: starting.scenes.length, order: starting.scenes.map((s) => s.id), upserts: [], commit: true,
            });
            if (receipt.status !== "committed" || receipt.notebook_id !== book.notebook_id || receipt.history_id !== book.history_id ||
                receipt.restore_generation !== book.restore_generation) throw new Error("invalid_start_receipt");
            resumedStart = true;
          } catch (error) { if (errorCode(error) !== "notebook_already_started") throw error; }
        }
        const replacedBases = !resumedStart && replacedJoinBases(local.joined, book,
          Object.fromEntries(Object.entries(local.buckets[bucket]?.states ?? {}).map(([id, state]) => [id, state.base])));
        // 미시작을 직접 본 옛 기록도 표시한다. 이미 시작된 1011 기록의 합류 해석은 유지한다.
        if (local.joined?.notebookId === "" && (book.notebook_id || !local.joined.beforeStart) && !replacedBases &&
            !local.joined.awaitingStart && !local.starting && local.joined.restoreGeneration === book.restore_generation) {
          const expected = local.joined;
          if (!(await change([], (_all, meta) => {
            if (!equal(meta[key("nj", account)], expected)) return false;
            meta[key("nj", account)] = { ...expected,
              ...(book.notebook_id ? { notebookId: book.notebook_id } : { beforeStart: true }) } satisfies NotebookJoin;
            return true;
          }, guard))) { check(); continue; }
          changed = true;
          local = await snapshot();
        }
        if (rejoinRequired || local.joined?.restoreGeneration !== book.restore_generation || (local.joined?.awaitingStart && !resumedStart) || replacedBases ||
            [local.starting, local.writing].some((value) => value && value.restoreGeneration !== book.restore_generation)) {
          const adopted = await adoptRestoredNotebook(account, book, guard, pendingAtStart, lease.generation, approval, rejoinRequired);
          if (!adopted.ok) throw new Error("local_store_failed");
          rejoinRequired = false;
          if (typeof adopted.value === "boolean") {
            if (startNotice?.account === account) setStartNotice(null);
            mcpCompletions.clear();
            if (!book.notebook_id && (await snapshot()).joined?.awaitingStart) {
              changed = true;
              visibleChanged ||= adopted.value;
              continue;
            }
            return { status: "ready", changed: true, visibleChanged: adopted.value };
          }
          if (!book.hasLiveRows && adopted.value.count === 0) {
            setStartNotice(null);
            return { status: "local_only", reason: "empty_notebook", changed, visibleChanged };
          }
          if (!adopted.value.approved) {
            const previous = startNotice;
            const same = !approval && previous?.kind === "confirm" && previous.account === account &&
              previous.provenanceFingerprint === adopted.value.provenanceFingerprint && previous.bookFingerprint === adopted.value.bookFingerprint &&
              previous.count === adopted.value.count;
            setStartNotice(same ? previous : { ...adopted.value, changed: previous?.kind === "confirm" && previous.account === account });
            return { status: "local_only", reason: "start_confirmation", changed, visibleChanged };
          }
          firstStart = { localFingerprint: adopted.value.localFingerprint, bookFingerprint: adopted.value.bookFingerprint };
        }
        const reduced = (local.buckets[bucket]?.scenes ?? []).filter((s) => s.localNotebookCopy === "upload_failed" && bytes(JSON.stringify(s)) <= SCENE_LIMIT);
        if (reduced.length) {
          const cleared = await sceneNotebookTransaction([], (all) => {
            let modified = false;
            all[bucket] = (all[bucket] ?? []).map((s) => {
              if (!reduced.some((before) => before.id === s.id && equal(before, s))) return s;
              const copy = { ...s }; delete copy.localNotebookCopy; modified = true; return copy;
            });
            return { value: modified, changed: modified };
          }, guard);
          if (cleared.ok && cleared.value) visibleChanged = true; // 사본 표식을 거뒀다(뒤에 네트워크가 실패해도 이미 확정)
          local = await snapshot();
        }
        if (!local.joined || !book.notebook_id || local.starting) {
          let releaseHold: (() => void) | undefined;
          let startedHere = resumedStart;
          try {
            local = await snapshot();
            if (!book.notebook_id) {
              if (firstStart && !(await startUnchanged(firstStart.localFingerprint))) continue;
              const scenes = local.joined?.restoreGeneration && book.hasLiveRows ? [] : local.buckets[bucket]?.scenes ?? [];
              // 현재 캔버스는 전역 버킷이다. 옛 프로젝트 버킷은 합류 전 사본에 남긴다.
              const oversizedIds = scenes.filter((s) => bytes(JSON.stringify(s)) > SCENE_LIMIT).map((s) => s.id);
              if (oversizedIds.length) {
                try { await request("writer", { action: "release", token: lease.token }); } catch { check(); }
                if (local.starting) await writeNotebookProgress(account, "start", local.starting, null, guard);
                return { status: "local_only", changed, visibleChanged, reason: "start_too_big", sceneIds: oversizedIds };
              }
              let progress = local.starting as PendingStart | null;
              if (!progress || progress.restoreGeneration !== book.restore_generation || progress.history !== book.history_id || progress.generation !== lease.generation || !equal(progress.scenes, scenes)) {
                const next: PendingStart = { restoreGeneration: book.restore_generation, id: newSceneIntentId(), history: book.history_id, generation: lease.generation, scenes, ...(firstStart ? { firstStart } : {}) };
                if (!(await writeNotebookProgress(account, "start", progress, next, guard))) throw new Error("local_store_failed");
                progress = next;
              }
              const start = { restore_generation: book.restore_generation, token: lease.token, attempt_id: progress.id, project_id: "", expected_count: scenes.length, order: scenes.map((s) => s.id) };
              try {
                for (const upserts of batches(scenes.map((s) => ({ id: s.id, name: s.name, data: JSON.stringify(s) })))) {
                  await request("notebook/start", { ...start, upserts, commit: false });
                }
                // 시작 칸은 아직 공책이 아니다. 올리는 동안 편집을 허용하고 확정 직전에만
                // 입력을 거둔다. flush가 만든 마지막 편집도 같아야 이 시작본을 확정한다.
                releaseHold = holdNotebookWrites(account);
                local = await snapshot();
                const currentScenes = local.joined?.restoreGeneration && book.hasLiveRows ? [] : local.buckets[bucket]?.scenes ?? [];
                if (!equal(currentScenes, scenes) || (firstStart && !(await startUnchanged(firstStart.localFingerprint)))) {
                  await writeNotebookProgress(account, "start", progress, null, guard);
                  continue;
                }
                await request("notebook/start", { ...start, upserts: [], commit: true });
                startedHere = true;
              } catch (error) {
                const code = errorCode(error);
                if (["empty_notebook", "start_too_big", "start_attempt_changed", "start_snapshot_changed"].includes(code)) {
                  await writeNotebookProgress(account, "start", progress, null, guard);
                  if (code === "empty_notebook" || code === "start_too_big") {
                    const ids = errorInfo(error)?.scene_ids;
                    return { status: "local_only", reason: code, changed, visibleChanged,
                      sceneIds: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [],
                    };
                  }
                  continue;
                }
                if (code !== "notebook_already_started") throw error;
              }
              const confirmed = await getBook();
              if (confirmed.restore_generation !== book.restore_generation) continue;
              book = confirmed;
            }
            if (!book.notebook_id) throw new Error("notebook_not_started");
            if (!local.joined?.restoreGeneration) {
              releaseHold ??= holdNotebookWrites(account);
              const joined = await joinSceneNotebookDetailed(account, book.notebook_id, book.history_id, { [bucket]: hubBucket(book) }, guard, book.restore_generation, true);
              if (!joined.joined) throw new Error("join_failed");
              changed = true;
              visibleChanged ||= joined.visible; // 같은 내용으로 합류하면 화면 변화 아님
              const progress = (await snapshot()).starting;
              if (progress) await writeNotebookProgress(account, "start", progress, null, guard);
              setStartNotice(startedHere ? { kind: "started", id: newSceneIntentId(), account } : null);
              return { status: "ready", changed, visibleChanged };
            }
            const progress = (await snapshot()).starting;
            // Zero-item start establishes the first order; retain the clean browser order even after a lost start reply.
            if (local.joined.notebookId === "" && progress?.history === book.history_id && (progress.generation === lease.generation || resumedStart) &&
                Array.isArray(progress.scenes)) {
              const emptyStart = progress.scenes.length === 0;
              const advanced = await sceneNotebookTransaction([key("ns", account)], (_all, meta) => {
                const order = meta[key("ob", bucket)] as SceneOrderState | undefined;
                const joined = meta[key("nj", account)] as NotebookJoin | undefined;
                if (joined?.restoreGeneration !== book.restore_generation || !equal(meta[key("ns", account)], progress)) return { changed: false, value: null };
                const next = { ...joined, notebookId: book.notebook_id! };
                delete next.beforeStart; delete next.awaitingStart; delete next.receivedFingerprint;
                meta[key("nj", account)] = next;
                if (emptyStart && order?.dirty && order.base?.history === book.history_id && order.base.rev + 1 === book.order.rev) {
                  meta[key("ob", bucket)] = { ...order, base: { history: book.history_id, rev: book.order.rev } } satisfies SceneOrderState;
                }
                return { changed: true, value: null };
              }, guard);
              if (!advanced.ok) throw new Error("local_store_failed");
            }
            if (progress) await writeNotebookProgress(account, "start", progress, null, guard);
            local = await snapshot(); // 합류했던 프로필은 보관/합류를 다시 하지 않고 기존 판으로 맞춘다.
            if (startedHere) setStartNotice({ kind: "started", id: newSceneIntentId(), account });
          } finally { releaseHold?.(); }
        }
        if (!book.notebook_id) throw new Error("notebook_missing");
        let pending = local.writing as PendingWrite | null;
        if (pending && (pending.restoreGeneration !== book.restore_generation || pending.history !== book.history_id || pending.notebookId !== book.notebook_id)) {
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
            if (equal((await snapshot()).buckets[bucket] ?? emptyBucket(), frozen)) return { status: "ready", changed, visibleChanged };
            continue;
          }
          requests.forEach((r) => { r.restore_generation = book.restore_generation; });
          pending = { restoreGeneration: book.restore_generation, id: newSceneIntentId(), history: book.history_id, notebookId: book.notebook_id, frozen, requests, tooBig,
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
          if (receipt.restore_generation !== pending.restoreGeneration || receipt.history_id !== pending.history || !receipt.order || receipt.order.history_id !== receipt.history_id || !Number.isInteger(receipt.order.rev) || !Array.isArray(receipt.results) || !Array.isArray(receipt.deletes) ||
              receipt.results.length !== payload.upserts.length || receipt.deletes.length !== payload.deletes.length ||
              receipt.results.some((r, i) => r.id !== payload.upserts[i].id || !["saved", "same", "copied", "too_big"].includes(r.status) ||
                (r.status !== "too_big" && (!r.target_id || !validBase(r.base, receipt.history_id)))) ||
              receipt.deletes.some((r, i) => r.id !== payload.deletes[i].id || r.intent_id !== payload.deletes[i].intent_id || !["deleted", "kept"].includes(r.status) || (r.base && !validBase(r.base, receipt.history_id)))) throw new Error("invalid_receipt");
          receipts.push(receipt);
          if (receipt.mcp_done && (!Array.isArray(receipt.mcp_done) || receipt.mcp_done.some((id) => !payload.mcp_complete?.includes(id) || !payload.upserts.some((up) =>
            (JSON.parse(up.data) as Scene).mcpAttachmentReceipts?.includes(id) && receipt.results.some((r) => r.id === up.id && r.target_id === up.id && ["saved", "same"].includes(r.status)))))) throw new Error("invalid_mcp_receipt");

        }
        const received = await getBook();
        if (received.restore_generation !== pending.restoreGeneration) continue;
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
        // 값 = 결과 + 이 트랜잭션이 사용자가 볼 씬·순서를 바꿨는가(콜백 밖 변수를 고치면 중단된 트랜잭션을 성공처럼 셀 수 있다)
        type Applied = { state: "retry" | "changed" | "ready"; visible: boolean };
        const retry: Applied = { state: "retry", visible: false };
        const applied = await sceneNotebookTransaction([key("nw", account)], (all, meta) => {
          if ((meta[key("nj", account)] as NotebookJoin | undefined)?.restoreGeneration !== work.restoreGeneration || !equal(meta[key("nw", account)], work)) return { value: retry, changed: false };
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
            delete meta[key("nw", account)]; return { value: retry, changed: true }; // 기준·의도·순서 메타만 — 화면 변화 아님
          }
          const rows = new Map(received.items.map((row) => [row.id, row]));
          for (const r of results.values()) if (r.status === "copied" && (!rows.get(r.target_id!) || rows.get(r.target_id!)!.deleted_at !== null)) {
            delete meta[key("nw", account)]; return { value: retry, changed: true };
          }
          const extra: Scene[] = [];
          for (const scene of work.frozen.scenes) {
            if (scene.localNotebookCopy === "upload_failed" || received.skipped?.includes(scene.id)) extra.push(scene);
            else if (tooBig.has(scene.id)) extra.push(makeLocalNotebookCopy(scene, newSceneIntentId(), "upload_failed"));
          }
          const incoming = hubBucket(received);
          if (extra.some((s) => incoming.scenes.some((r) => r.id === s.id))) return { value: retry, changed: false };
          const next = [...incoming.scenes, ...extra];
          const visible = !equal(all[bucket] ?? [], next); // 받기·추가·삭제·충돌 사본·실패 사본·순서 — 아래 메타 변경은 섞지 않는다
          let modified = visible;
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
          return { value: { state: modified ? "changed" : "ready", visible } satisfies Applied, changed: true };
        }, guard);
        if (!applied.ok) throw new Error("local_store_failed");
        for (const receipt of receipts) for (const id of receipt.mcp_done ?? []) {
          const name = JSON.stringify([account, id]), completion = mcpCompletions.get(name);
          if (completion) { completion.confirmed = true; mcpCompletions.delete(name); }
        }
        if (applied.value.state === "retry") continue;
        changed ||= applied.value.state === "changed";
        visibleChanged ||= applied.value.visible;
        return { status: "ready", changed, visibleChanged };
      } catch (error) {
        if (errorCode(error) === "notebook_rejoin_required" && !rejoinRequired) { rejoinRequired = true; continue; }
        if (error instanceof NotebookTransportError && round < 2) continue;
        throw error;
      }
    }
    return { status: "retry", changed, visibleChanged, reason: "reconcile_limit" };
  } catch (error) {
    const reason = errorCode(error);
    return { status: ["writer_changed", "writer_required", "writer_expired"].includes(reason) ? "waiting_token" : "retry", changed, visibleChanged, reason };
  }
}
