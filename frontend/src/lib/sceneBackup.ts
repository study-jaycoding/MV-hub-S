import { restoreCanvasDocuments } from "../features/canvas/api";
// 캔버스 씬 DB 백업 — 브라우저 IndexedDB 확정본의 미러(로컬→DB) + 원본 소실 시 복구.
//
// 계약(코덱스 합의 설계 + P1 반영):
//  · subscribeScenesPersisted의 로컬 저장 확정 통지 후 디바운스(2s) → 변경 씬만 벌크 PUT.
//    실패는 30s 백오프·online 이벤트·다음 변경에서 재시도.
//  · ★삭제 미러는 '이 세션에서 로컬에 있던 씬이 사라진 것'만 지운다(lastPushed 가 tombstone 역할).
//    '서버에만 있는 id 전부'를 지우던 종전 계약은, 앱 전용 브라우저 프로필 도입(2026-09-01)으로
//    한 PC 에 프로필이 여럿 생기자 프로필을 번갈아 열 때마다 서로의 백업을 지웠다.
//  · 복구는 '로컬 버킷 키 자체가 없을 때'만(hasSceneBucket) — 빈 배열 버킷(마지막 씬 정상 삭제)은
//    복구하지 않는다. 응답 전 행 검증(하나라도 손상 → 이번 복구 전체 포기 — 부분 복구가 남으면
//    다음 진입의 재복구가 막힌다) + 적용은 합집합(조회 중 생긴 씬 보존, 같은 id 는 로컬 우선).
//  · 자동 복구가 닿지 못하는 자리(이 브라우저에 씬이 있는데 다른 프로필 백업이 DB 에 있음)는
//    사용자가 여는 문(countBackupOnlyScenes/importFromBackup)으로만 연다 — 자동으로 합치지 않는다.
//  · ★순서 불변식: 어떤 sync(특히 삭제 정합)도 그 계정 scope 의 복구 판정이 끝나기 전엔 돌지
//    않는다(ensureInit await). 안 지키면 새 브라우저에서 로컬=[] 를 기준으로 서버 백업 전체를
//    지우는 사고가 난다.
//  · 계정 전환 레이스: 모든 await 뒤·적용 직전에 scope(ns)를 재검사 — 다른 계정 응답을 현재
//    계정에 적용하지 않는다. scope 가 바뀌면 메타·lastPushed·초기화 상태를 폐기하고 새로 시작.
//  · owner 는 서버가 actor_id 로 결정 — 계정은 확인용(X-MVHub-Expect-Account, 다르면 409)으로만 싣는다.
//  · 변경 대조: 서버 data_hash(sha256) vs 로컬 sha256(crypto.subtle). http LAN 등 insecure
//    context 로 subtle 이 없으면 첫 동기화 때 전 씬을 한 번 올린다(누락보다 중복이 안전) —
//    이후는 세션 내 lastPushed 문자열 비교로 변경분만.
//  · ★판(Jay 결정 1A, 10-15): 씬마다 '이 프로필이 서버와 맞춘 마지막 지문'(b)을 씬별 localStorage 키에 둔다. 탭은 범위에 들어갈 때 한 번
//    읽고 그 뒤로는 자기가 본 것(같음 확인·올리기·복구·가져오기)과, 다른 탭이 맞춘 값이 **이 탭이 받은 내용과 같을 때만** 승계한다.
//    바뀐 것 없는 옛 창(지문 == b, 서버 ≠ b)은 올리지 않는다. 그 밖엔 base_hash 를 실어 올리고, 서버가 그사이 바뀌었으면 허브가 덮지 않고
//    사본 행으로 받는다(갈래 — 그 뒤 이 씬의 편집은 그 사본 행으로 미러). 설계: docs/status/결정일곱_설계_2026-10-15.md 1A.
import { jsonFetch } from "./http";
import { sha256Js } from "./editShare";
import { getAccountNamespace } from "./accountScope";
import { hubHasFeature, hubFeaturesKnown, waitForHubFeatures, EXPECT_ACCOUNT_HEADER } from "./hubFeatures";
import {
  confirmSceneWrite,
  hasPersistedSceneBucket,
  listPersistedSceneTexts,
  listScenes,
  subscribeScenesPersisted,
  type Scene,
} from "./scenes";
import { subscribeSceneStoreExternal } from "./sceneStore";
import { subscribeNotebookSyncResult, syncSceneNotebook, SCENE_WRITER_FEATURE, validRestoreGeneration, mirrorSceneGenerations, type NotebookSyncResult } from "./sceneNotebook";
import { withoutComfyRuns } from "./comfyRunState";

const API = "/api/scenes/backup";
const DEBOUNCE_MS = 2000;
const RETRY_MS = 30_000; // 실패 백오프 — 다음 변경이 없어도 이 간격으로 재시도(성공 시 해제)
const MAX_UPSERTS = 200; // 서버 상한과 동일
const MAX_UPSERT_BYTES = 8 * 1024 * 1024; // 청크당 대략 바이트 상한(서버 총량 20MB 의 여유 하한)
const MAX_DELETES = 500; // 서버 상한과 동일
const MAX_FORK_AVOID = 2000; // 서버 상한과 동일(routers/scenes.SceneSyncIn.fork_avoid)
// 씬 1개의 서버 상한(UTF-8 바이트) — backend/app/repo/scenes_backup.py 의 MAX_SCENE_BYTES 와 같아야 한다.
// 서버는 이를 넘는 씬이 하나라도 있으면 **그 요청 전체**를 거절한다. 그대로 보내면 같은 청크를 영영 다시
// 보내고, 같은 청크·뒤 청크의 멀쩡한 씬도 백업되지 않는다(Codex 설계 검토 P1) — 넘는 씬만 빼고 보낸다.
export const MAX_SCENE_BYTES = 5 * 1024 * 1024;
const utf8 = new TextEncoder();
// 글자 수만으로 상한 안쪽임이 확실하면(글자당 최대 3바이트) 바이트를 세지 않는다 — 큰 씬에서만 센다.
const exceedsSceneLimit = (data: string): boolean =>
  data.length > MAX_SCENE_BYTES || (data.length * 3 > MAX_SCENE_BYTES && utf8.encode(data).byteLength > MAX_SCENE_BYTES);

const ns = getAccountNamespace;
export interface MirrorRecovery {
  generation: string;
  blockedIds: string[];
  raws: Record<string, string | null>; // SHA-256 출처 지문. 원문은 보류된 씬만 originals에 보존한다.
  originals: { generation: string | null; scenes: { id: string; text: string }[]; ledger: [string, LedgerEntry][] }[];
}
const mirrorRecoveryKey = (scope: string) => `mvhub.mirrorRecovery:${scope}`;
const mirrorRecoverySubs = new Set<() => void>();
export function subscribeMirrorRecovery(fn: () => void): () => void {
  mirrorRecoverySubs.add(fn);
  return () => mirrorRecoverySubs.delete(fn);
}
function notifyMirrorRecovery() {
  mirrorRecoverySubs.forEach((fn) => {
    try { fn(); } catch { /* 화면 알림 실패가 이미 확인된 저장을 실패로 바꾸지 않는다. */ }
  });
}
function sortRecoveryKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortRecoveryKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sortRecoveryKeys(item)]));
  }
  return value;
}
function mirrorRecoveryView(text: string | null): string | null {
  if (text === null) return null;
  try {
    const { generation, blockedIds, originals } = JSON.parse(text);
    return JSON.stringify(sortRecoveryKeys({ generation, blockedIds, originals }));
  } catch { return text; }
}
function saveMirrorRecovery(scope: string, value: MirrorRecovery, notify = true) {
  const text = JSON.stringify(value), key = mirrorRecoveryKey(scope);
  notify = notify && mirrorRecoverySubs.size > 0;
  let previous: string | null | undefined;
  if (notify) {
    try { previous = localStorage.getItem(key); } catch { /* 알림 비교 실패가 저장을 막지 않게, 변경 여부는 모름으로 둔다. */ }
  }
  localStorage.setItem(key, text);
  let saved: string | null;
  try { saved = localStorage.getItem(key); }
  catch (error) { if (notify) notifyMirrorRecovery(); throw error; }
  if (notify && (previous === undefined || (previous !== saved && mirrorRecoveryView(previous) !== mirrorRecoveryView(saved)))) notifyMirrorRecovery();
  if (saved !== text) throw new Error("mirror_recovery_write_failed");
}
export function readMirrorRecovery(scope = ns()): MirrorRecovery | null {
  if (scope !== ns()) return null;
  const raw = localStorage.getItem(mirrorRecoveryKey(scope));
  if (!raw) return null;
  const value = JSON.parse(raw) as MirrorRecovery;
  if (!validRestoreGeneration(value.generation) || !Array.isArray(value.blockedIds) || !Array.isArray(value.originals) || !value.raws || typeof value.raws !== "object") throw new Error("invalid_mirror_recovery");
  return value;
}
async function checkMirrorGeneration(scope: string): Promise<string> {
  const response = await jsonFetch<{ restore_generation: string; items: BackupRow[] }>(`${API}?project_id=&include_data=1`, asAccount(scope));
  if (scope !== ns() || !validRestoreGeneration(response.restore_generation) || !Array.isArray(response.items)) throw new Error("invalid_mirror_generation");
  const prior = readMirrorRecovery(scope);
  const scenes = listPersistedSceneTexts(null).map(({ id, text }) => ({ id, text }));
  const hashes = new Map(scenes.map((scene) => [scene.id, sha256Js(new TextEncoder().encode(scene.text))]));
  if (prior?.generation === response.restore_generation) {
    const blocked = new Set(prior.blockedIds);
    const unproven = new Set([...new Set([...Object.keys(prior.raws), ...hashes.keys()])].filter((id) => !blocked.has(id) && (prior.raws[id] ?? null) !== (hashes.get(id) ?? null)));
    if (unproven.size) {
      prior.originals.push({ generation: prior.generation, scenes: scenes.filter((scene) => unproven.has(scene.id)), ledger: [...loadLedger(scope, true)].filter(([id]) => unproven.has(id)) });
      prior.blockedIds.push(...unproven);
      saveMirrorRecovery(scope, prior);
    }
    return prior.generation;
  }
  const oldLedger = loadLedger(scope, true), rows = new Map(response.items.map((row) => [row.id, row]));
  const blocked = new Set(scenes.filter((scene) => prior || oldLedger.get(scene.id)?.fork || rows.get(scene.id)?.data !== scene.text).map((scene) => scene.id));
  for (const id of oldLedger.keys()) if (!hashes.has(id)) blocked.add(id);
  const originals = [...(prior?.originals ?? [])];
  if (blocked.size || oldLedger.size) originals.push({ generation: prior?.generation ?? null, scenes: scenes.filter((scene) => blocked.has(scene.id)), ledger: [...oldLedger] });
  const record: MirrorRecovery = { generation: response.restore_generation, blockedIds: [...new Set([...blocked, ...oldLedger.keys()])], originals, raws: Object.fromEntries(hashes) };
  // 옛 장부 보관이 확인된 다음에만 제거하고, 깨끗한 씬의 현재 기준판을 새로 적는다.
  const notify = mirrorRecoverySubs.size > 0;
  let previousRecovery: string | null | undefined;
  if (notify) {
    try { previousRecovery = localStorage.getItem(mirrorRecoveryKey(scope)); } catch { /* 비교 불가여도 보호 기록 저장을 계속한다. */ }
  }
  try {
    saveMirrorRecovery(scope, record, false);
    for (const id of oldLedger.keys()) {
      localStorage.removeItem(ledgerKey(scope, id));
      if (localStorage.getItem(ledgerKey(scope, id)) !== null) throw new Error("mirror_ledger_clear_failed");
      if (curScope === scope) ledger.delete(id);
    }
    for (const scene of scenes) if (!blocked.has(scene.id)) {
      const entry = { b: rows.get(scene.id)?.data_hash || hashes.get(scene.id)! };
      const encoded = JSON.stringify(entry);
      localStorage.setItem(ledgerKey(scope, scene.id), encoded);
      if (localStorage.getItem(ledgerKey(scope, scene.id)) !== encoded) throw new Error("mirror_ledger_write_failed");
      if (curScope === scope) ledger.set(scene.id, entry);
    }
    record.blockedIds = [...blocked];
    saveMirrorRecovery(scope, record, false);
  } finally {
    // 확인 읽기가 실패해도 원래 오류는 유지하고, 남았을 수 있는 보호 기록을 알린다.
    if (notify) {
      let changed = true;
      try {
        if (previousRecovery !== undefined) {
          const saved = localStorage.getItem(mirrorRecoveryKey(scope));
          changed = saved !== previousRecovery && mirrorRecoveryView(saved) !== mirrorRecoveryView(previousRecovery);
        }
      } catch { /* 확인 불가면 보수적으로 알린다. */ }
      if (changed) notifyMirrorRecovery();
    }
  }
  serverHash = null; lastPushed.clear();
  for (const scene of scenes) if (!blocked.has(scene.id)) lastPushed.set(scene.id, scene.text);
  return response.restore_generation;
}
// 작업을 시작할 때 잡은 이 탭의 계정을 싣는다 — 허브가 고정한 계정과 다르면(다른 브라우저 프로필에서 계정을 바꿈) 409 로 아무것도
//  읽고 쓰지 않는다(81회차 F-A-02). 409 는 다른 실패처럼 재시도로 넘어가 로컬 씬·미전송 변경은 그대로다.
const asAccount = (scope: string) => ({ headers: { [EXPECT_ACCOUNT_HEADER]: scope } });

async function sha256hex(text: string): Promise<string | null> {
  try {
    if (!crypto?.subtle) return null; // insecure context(http LAN) — 해시 대조 불가
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

// 복구 판정 결과 — sync 진행 가능 여부를 가른다.
//  · restored: DB 에서 복원함 / clean: 복원 불필요(버킷 존재 or 서버 비어있음) → sync 진행 OK
//  · retry: 조회 실패(오프라인·미로그인 401·구백엔드) — 판정 미상. ★이 상태로 sync(특히 삭제
//    정합)를 진행하면 '로컬=[] 기준으로 서버 백업 전량 삭제' 사고가 난다 → sync 차단+백오프 재판정.
//  · blocked: 백업 손상(부분 복구 금지로 전체 포기) — 이 세션에선 sync 도 멈춘다(덮어쓰기 방지).
type InitResult = "restored" | "clean" | "retry" | "blocked";

// ── 상태 (모듈 스코프, 전부 '현재 scope' 소유 — scope 바뀌면 폐기) ────────
let curScope: string | null = null; // 이 상태가 어느 계정 것인지
let initPromise: Promise<InitResult> | null = null; // scope 의 복구 판정 — sync 는 이걸 기다린다
let serverHash: Map<string, string> | null = null; // 서버 메타 캐시 sceneId→data_hash
let lastPushed = new Map<string, string>(); // 마지막으로 밀어올린(또는 복구한) 씬 JSON — 정확 비교
let timer: ReturnType<typeof setTimeout> | null = null;
let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let syncing = false;
let rerun = false; // 동기화 중 새 변경 — 끝나고 한 번 더
// 진행 중인 sync 가 끝나는 시점 — 명시적 가져오기(importFromBackup)가 삭제 정합과 겹치지 않게 기다린다.
let syncIdle: Promise<void> = Promise.resolve();
let syncSettled: (() => void) | null = null;
// 가져오기가 도는 동안엔 sync 를 아예 들이지 않는다. 겹치면 sync 가 '가져오기 전' 로컬 목록을 들고
// 삭제를 계산해, 방금 가져온 씬을 서버에서 지운다(코덱스 P1). 가져오기가 끝나며 schedule() 로 이어준다.
let importing = false;

// ── 판 장부(1A) — 씬마다 키 하나: 전체를 읽고 다시 쓰지 않으니 다른 탭이 쓴 다른 씬 항목을 지우지 않는다(Codex D2) ──
type LedgerEntry = { b?: string; fork?: { id: string; b?: string } };
const LEDGER_PREFIX = "mvhub.sceneBackupBase:";
const ledgerKey = (scope: string, id: string) => `${LEDGER_PREFIX}${scope}:${id}`;
let ledger = new Map<string, LedgerEntry>(); // 이 탭이 믿는 판 — 범위에 들어갈 때 한 번 읽는다
let received = new Map<string, string>(); // 다른 탭에서 받은 확정본의 지문(씬마다 마지막 것) — 승계 조건
let holdNoticeShown = false; // 지문을 못 구해 보류한 안내는 범위마다 한 번
// 이 탭이 본 마지막 글자(범위에 들어갈 때·이 탭의 확정·다른 탭에서 받음) — 다른 탭 알림 때 '그 탭이 바꾼 씬'만 가려낸다.
//  처음 알림에 모든 씬을 받은 것으로 세면 보내던 정상 응답까지 버린다(Codex 1A 3차 P2).
let knownText = new Map<string, string>();
let externalSeq = new Map<string, number>(); // 씬마다 다른 탭에서 받은 횟수 — 보내는 사이 받았는지 응답 때 본다
// 확정본에 없는 씬(지운 것)은 뺀다 — 남기면 지운 큰 씬의 글자를 범위가 바뀔 때까지 쥐고 있다(Codex 63회차)
const noteSeenTexts = (): void => {
  knownText = new Map(listPersistedSceneTexts(null).map((s) => [s.id, s.text]));
};

function readLedgerEntry(scope: string, id: string, strict = false): LedgerEntry | null {
  try {
    const raw = localStorage.getItem(ledgerKey(scope, id));
    const value = raw ? (JSON.parse(raw) as LedgerEntry) : null;
    if (raw && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error("invalid_mirror_ledger");
    return value;
  } catch (error) {
    if (strict) throw error;
    return null;
  }
}

function loadLedger(scope: string, strict = false): Map<string, LedgerEntry> {
  const out = new Map<string, LedgerEntry>();
  try {
    const prefix = `${LEDGER_PREFIX}${scope}:`;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const entry = readLedgerEntry(scope, key.slice(prefix.length), strict);
      if (entry) out.set(key.slice(prefix.length), entry);
    }
  } catch (error) {
    if (strict) throw error;
    /* 못 읽으면 빈 장부 — '모름'(사본 쪽)으로 가지 덮어쓰기 쪽으로 새지 않는다 */
  }
  return out;
}

/** 전체 가져오기로 선택하고 로컬 확정을 확인한 씬만 현재 허브 기준으로 재개한다. */
export async function resumeImportedMirror(scope: string, generation: string, selected: Map<string, string>): Promise<void> {
  if (!hubFeaturesKnown()) throw new Error("허브 기능을 아직 확인하지 못했습니다 — 잠시 뒤 다시 시도하세요.");
  if (importing) throw new Error("다른 가져오기가 끝난 뒤 다시 시도해 주세요.");
  importing = true;
  try {
    await syncIdle;
    const response = await jsonFetch<{ restore_generation: string; items: BackupRow[] }>(`${API}?project_id=&include_data=1`, asAccount(scope));
    const record = readMirrorRecovery(scope);
    if (ns() !== scope || response.restore_generation !== generation || record?.generation !== generation) throw new Error("허브와 기록 시점이 달라 전송을 보류했습니다.");
    const current = new Map(listPersistedSceneTexts(null).map((scene) => [scene.id, scene.text]));
    for (const [id, text] of selected) {
      if (current.get(id) !== text) throw new Error("가져오는 동안 문서가 바뀌어 전송을 보류했습니다.");
      const base = response.items.find((row) => row.id === id)?.data_hash;
      const entry = base ? { b: base } : null;
      if (entry) localStorage.setItem(ledgerKey(scope, id), JSON.stringify(entry));
      else localStorage.removeItem(ledgerKey(scope, id));
      if (JSON.stringify(readLedgerEntry(scope, id, true)) !== JSON.stringify(entry)) throw new Error("가져온 자료의 기준판 저장에 실패했습니다.");
      if (curScope === scope) { if (entry) ledger.set(id, entry); else ledger.delete(id); lastPushed.delete(id); received.delete(id); }
      record.raws[id] = sha256Js(new TextEncoder().encode(text));
      record.blockedIds = record.blockedIds.filter((blocked) => blocked !== id);
    }
    saveMirrorRecovery(scope, record);
    serverHash = null;
  } finally { importing = false; schedule(); }
}

// 이 탭의 판을 바꾸고 그 씬 항목만 저장한다. 쓰기 실패(용량)는 삼킨다. 범위가 바뀌었으면 아무것도 안 한다.
// 판 장부 쓰기는 보관 알림을 보내지 않는다 — 보관 읽기는 미러 기록만 본다.
function setLedger(scope: string, id: string, entry: LedgerEntry | null): void {
  if (ns() !== scope) return;
  if (entry && (entry.b || entry.fork)) ledger.set(id, entry);
  else ledger.delete(id);
  try {
    if (entry && (entry.b || entry.fork)) localStorage.setItem(ledgerKey(scope, id), JSON.stringify(entry));
    else localStorage.removeItem(ledgerKey(scope, id));
  } catch {
    /* 용량 — 다음 탭은 '모름'으로 시작한다 */
  }
}

// 갈래 업로드용 글자 — 허브의 사본 변환과 같다(id·이름·표식, 진행 중 생성 표식 빼기 — Codex D4). 지문도 이 글자로 잰다.
function forkText(text: string, forkId: string, originalId: string, sum: string): string | null {
  try {
    const scene = JSON.parse(text) as Scene & { backupForkOf?: unknown };
    return JSON.stringify({
      ...withoutComfyRuns(scene),
      id: forkId,
      name: `${scene.name || "씬"} (옛 창 사본)`,
      backupForkOf: { id: originalId, sum },
      cards: (scene.cards || []).map((card) => {
        const { pendingGenerationAttempts: _pending, ...rest } = card as typeof card & { pendingGenerationAttempts?: unknown };
        return rest;
      }),
    });
  } catch {
    return null;
  }
}

// 사본 씬이 어느 행의 사본인가(backupForkOf.id — 허브·forkText 가 적는다). 모르면 null. 글자가 바뀔 때만 다시 읽는다(큰 씬을 동기화마다 파싱하지 않게).
const forkOriginCache = new Map<string, { text: string; of: string | null }>();
function forkOrigin(id: string, text: string): string | null {
  const hit = forkOriginCache.get(id);
  if (hit?.text === text) return hit.of;
  let of: string | null = null;
  try {
    const origin = (JSON.parse(text) as { backupForkOf?: { id?: unknown } }).backupForkOf?.id;
    of = typeof origin === "string" && origin ? origin : null;
  } catch {
    /* 못 읽으면 모름 — 늘 피할 목록에 넣는다 */
  }
  forkOriginCache.set(id, { text, of });
  return of;
}

// 다른 창에 더 새로 저장된 백업이 있어 덮지 않고 사본으로 남긴 씬(이름) — 화면이 한 번 알린다.
const forkSubs = new Set<(names: string[]) => void>();
export function subscribeSceneBackupForked(fn: (names: string[]) => void): () => void {
  forkSubs.add(fn);
  return () => forkSubs.delete(fn);
}

// 다른 탭이 저장한 확정본을 받았다 — 받은 글자의 지문을 기억하고, 그 씬의 장부를 **새로 읽어** 같은 지문이면 승계한다(Codex D1).
async function onExternalScenes(): Promise<void> {
  if (!hubFeaturesKnown() || hubHasFeature(SCENE_WRITER_FEATURE)) { schedule(); return; }
  const scope = ns();
  if (scope !== curScope) return;
  const changed: { id: string; text: string }[] = [];
  const persisted = listPersistedSceneTexts(null);
  const present = new Set(persisted.map((s) => s.id));
  for (const id of knownText.keys()) if (!present.has(id)) knownText.delete(id); // 다른 탭이 지운 씬(noteSeenTexts 와 같은 까닭)
  recountOverLimit(); // 다른 탭이 저장한 확정본도 크기를 다시 센다(7A·D11)
  for (const s of persisted) {
    // 이 탭이 본 마지막 글자(자기 확정 포함 — noteSeenTexts)와 같으면 다른 탭이 바꾼 씬이 아니다
    if (knownText.get(s.id) === s.text) continue;
    knownText.set(s.id, s.text);
    externalSeq.set(s.id, (externalSeq.get(s.id) ?? 0) + 1);
    // 다른 탭에서 바뀐 씬 — 서버도 그사이 바뀌었을 수 있다. 올린 기억을 무효로 하고(지움 표식으로는 남긴다) 메타를 새로 받는다 —
    //  안 그러면 사용자가 옛 글자로 되돌렸을 때 '올린 그대로'로 보고 건너뛰어 서버만 남의 글자로 남는다(Codex 1A 리뷰 #4·재검토).
    if (lastPushed.get(s.id)) {
      lastPushed.set(s.id, "");
      serverHash = null;
    }
    changed.push(s);
  }
  for (const s of changed) {
    const h = await sha256hex(s.text);
    if (ns() !== scope) return;
    if (!h) continue; // 지문을 못 구하면 이 씬의 판 승계만 건너뛴다 — 나머지 씬·예약은 그대로(재검토)
    received.set(s.id, h);
    const fresh = readLedgerEntry(scope, s.id);
    if (fresh?.b === h) ledger.set(s.id, { ...ledger.get(s.id), b: h });
  }
  schedule();
}

// 다른 탭이 장부를 고쳤다(뒤늦게 온 백업 확인) — 그 값이 이 탭이 받은 내용의 지문과 같을 때만 승계한다(Codex E1).
function onLedgerStorage(event: StorageEvent): void {
  if (!hubFeaturesKnown() || hubHasFeature(SCENE_WRITER_FEATURE)) return;
  const scope = curScope;
  if (!scope || !event.key?.startsWith(`${LEDGER_PREFIX}${scope}:`) || !event.newValue) return;
  const id = event.key.slice(`${LEDGER_PREFIX}${scope}:`.length);
  try {
    const value = JSON.parse(event.newValue) as LedgerEntry;
    if (value?.b && received.get(id) === value.b) ledger.set(id, { ...ledger.get(id), b: value.b });
  } catch {
    /* 손상 — 승계하지 않는다 */
  }
}

// 너무 커서 DB 백업에 올리지 못한 씬(id). 새로 생길 때만 알린다 — 작아져 다시 올라가면 빠진다.
let oversized = new Set<string>();
const oversizeSubs = new Set<(names: string[]) => void>();
/** 서버 상한을 넘어 DB 백업에서 빠진 씬이 **새로 생기면** 그 이름들을 알린다(씬은 이 브라우저에 그대로 있다). */
export function subscribeSceneBackupSkipped(fn: (names: string[]) => void): () => void {
  oversizeSubs.add(fn);
  return () => oversizeSubs.delete(fn);
}

// 씬 탭에 계속 보이는 '백업 안 됨'(Jay 결정 7A) — 까닭 둘을 따로 기억한다(설계 D11·E11):
//  overLimit  = 확정본 글자가 상한을 넘음 — 저장·다른 탭에서 받음·범위 전환 때마다 다시 센다(네트워크·동기화 성패와 무관).
//  copyTooBig = 사본(갈래)으로 바꾼 글자가 상한을 넘음 — 동기화가 안다. 그 씬이 다음에 올라가면·갈래가 끝나면·씬이 사라지면 지운다.
//  표시가 사라지는 것은 '크기 제한이 풀림'이지 '백업됨'이 아니다(C19).
let overLimit = new Set<string>();
let copyTooBig = new Set<string>();
let skippedIds: ReadonlySet<string> = new Set();
const overLimitCache = new Map<string, { text: string; over: boolean }>(); // 글자가 그대로면 큰 씬의 바이트를 다시 세지 않는다
const skippedIdSubs = new Set<() => void>();
/** 지금 DB 백업에서 빠진 씬 id — 바뀔 때만 새 집합이다(useSyncExternalStore 용). */
export const getSceneBackupSkippedIds = (): ReadonlySet<string> => skippedIds;
export function subscribeSceneBackupSkippedIds(fn: () => void): () => void {
  skippedIdSubs.add(fn);
  return () => skippedIdSubs.delete(fn);
}
function publishSkippedIds(): void {
  const next = new Set([...overLimit, ...copyTooBig]);
  if (next.size === skippedIds.size && [...next].every((id) => skippedIds.has(id))) return;
  skippedIds = next;
  skippedIdSubs.forEach((fn) => fn());
}
function recountOverLimit(): void {
  const persisted = listPersistedSceneTexts(null);
  const present = new Set(persisted.map((s) => s.id));
  overLimit = new Set();
  for (const s of persisted) {
    const hit = overLimitCache.get(s.id);
    const over = hit?.text === s.text ? hit.over : (exceedsSceneLimit(s.text) || (hubHasFeature(SCENE_WRITER_FEATURE) && JSON.parse(s.text).localNotebookCopy === "upload_failed"));
    overLimitCache.set(s.id, { text: s.text, over });
    if (over) overLimit.add(s.id);
  }
  for (const id of overLimitCache.keys()) if (!present.has(id)) overLimitCache.delete(id);
  for (const id of copyTooBig) if (!present.has(id)) copyTooBig.delete(id);
  publishSkippedIds();
}

// 복구 알림 — 백그라운드(백오프 재시도) 복구도 현재 탭 UI(씬 목록)에 반영되게 구독을 받는다.
//  같은 탭엔 storage 이벤트가 안 오므로 이 콜백이 유일한 통지 경로다(코덱스 P1).
const restoreSubs = new Set<() => void>();
export function subscribeSceneRestore(fn: () => void): () => void {
  restoreSubs.add(fn);
  return () => restoreSubs.delete(fn);
}

// upsert 청크 분할 — 개수 + ★UTF-8 바이트 기준(서버 총량 검증과 같은 단위. JS 문자열 length 로
//  자르면 한글 등 멀티바이트 씬이 서버 400 에 걸려 같은 청크를 영구 재시도한다 — 코덱스 P1).
export function chunkUpserts<T extends { data: string }>(
  ups: T[],
  maxCount = MAX_UPSERTS,
  maxBytes = MAX_UPSERT_BYTES,
): T[][] {
  const chunks: T[][] = [];
  const enc = new TextEncoder();
  let cur: T[] = [];
  let curBytes = 0;
  for (const u of ups) {
    const b = enc.encode(u.data).byteLength;
    if (cur.length >= maxCount || (cur.length && curBytes + b > maxBytes)) {
      chunks.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(u);
    curBytes += b;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// scope 확정·전환 — 바뀌었으면 이전 계정 상태를 전부 버리고 이 scope 로 다시 시작한다.
function enterScope(): string {
  const s = ns();
  if (curScope !== s) {
    curScope = s;
    initPromise = null;
    serverHash = null;
    lastPushed = new Map();
    oversized = new Set();
    copyTooBig = new Set();
    overLimitCache.clear();
    ledger = hubHasFeature(SCENE_WRITER_FEATURE) ? new Map() : loadLedger(s); // 이 범위의 판 — 여기서 한 번만 읽는다(Codex C1)
    received = new Map();
    knownText = new Map();
    noteSeenTexts();
    recountOverLimit();
    externalSeq = new Map();
    holdNoticeShown = false;
    rerun = false;
    rerunRetry = null;
    retryForNewChange = false;
    if (timer) clearTimeout(timer);
    timer = null;
    if (maxWaitTimer) clearTimeout(maxWaitTimer);
    maxWaitTimer = null;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }
  return s;
}

// 복구 판정(스코프당 1회): 버킷 키가 없으면 DB 전체를 받아 원자적으로 복원. sync 의 선행 조건.
// retry(조회 실패)만 캐시하지 않고 다음 기회에 재판정 — 로그인 후 자연 회복.
function ensureInit(scope: string): Promise<InitResult> {
  if (initPromise) return initPromise;
  const p: Promise<InitResult> = (async () => {
    let restoreGeneration: string;
    try { restoreGeneration = await checkMirrorGeneration(scope); } catch { return "retry"; }
    // ★확정본으로 판정한다 — 화면 값의 아직 확정 안 된 버킷 때문에 복구를 건너뛰면, 그 뒤 빈 확정본을
    //  기준으로 서버 백업을 지우는 길이 열린다(Codex).
    if (hasPersistedSceneBucket(null)) return "clean";
    let items: BackupRow[];
    try {
      const r = await jsonFetch<{ restore_generation: string; items: BackupRow[] }>(
        `${API}?project_id=&include_data=1`,
        asAccount(scope),
      );
      if (r.restore_generation !== restoreGeneration || ns() !== scope) return "retry";
      items = r.items || [];
    } catch {
      return "retry"; // 오프라인·미로그인(401)·구백엔드 — 판정 미상(sync 차단, 백오프 재판정)
    }
    if (ns() !== scope) return "retry"; // 계정 전환 중 응답 — 폐기
    if (!items.length) return "clean"; // 서버도 비어있음(새 사용자) — 복원할 것 없음
    // ★전 행 검증 — 하나라도 손상이면 이번 복구 전체 포기(부분 복구 금지, 코덱스 P1).
    //  이때 sync 도 막는다(blocked) — 진행하면 로컬 공백 기준 정합이 살아있는 백업까지 지운다.
    const scenes: Scene[] = [];
    for (const it of items) {
      try {
        const s = JSON.parse(it.data) as Scene;
        if (!s || typeof s !== "object" || s.id !== it.id || !Array.isArray(s.cards)) return "blocked";
        scenes.push(s);
      } catch {
        return "blocked";
      }
    }
    if (ns() !== scope) return "retry"; // 계정 전환 중 응답 — 폐기
    scenes.sort((a, b) => (a.created_at || 0) - (b.created_at || 0)); // 생성 순서대로 탭 복원
    // 조회하는 사이에 사용자가 씬을 만들었으면 그것을 버릴 수 없다 → 합집합으로 적용하고 같은 id 는
    // 로컬이 이긴다(로컬이 정답). ★종전엔 여기서 복구를 통째로 포기해, 빈 프로필에서 씬 하나만
    //  만들어도 DB 백업을 영영 못 가져왔다(코덱스 P0). 위쪽 '버킷 키 없을 때만' 게이트는 그대로다 —
    //  마지막 씬을 정상 삭제한 빈 배열 버킷은 여전히 복구 대상이 아니다.
    const { value: merged, confirmed } = confirmSceneWrite(() => restoreCanvasDocuments(scope, scenes));
    const added = merged.added;
    if (!added.length) return "clean"; // 가져올 게 없다
    if (!merged.ok) return "retry"; // 쓰기가 접수되지 않았다(떠 있는 동안·저장소 상한) — 복구했다고 알리지 않는다
    restoreSubs.forEach((f) => f()); // 화면 값에는 이미 들어갔다 — 열린 캔버스가 즉시 목록을 다시 읽게
    // ★저장소에 **확정된 뒤에만** 복구했다고 보고한다 — 확정 못 한 채 '복구됨'이면 다음 sync 가 빈
    //  확정본을 기준으로 서버 백업을 지운다(코덱스 P0).
    if (!(await confirmed)) return "retry";
    for (const s of added) lastPushed.set(s.id, JSON.stringify(s)); // 복구 에코 방지(서버가 이미 아는 것만)
    adoptReceivedRows(scope, items, new Set(added.map((s) => s.id)));
    return "restored";
  })();
  initPromise = p;
  void p.then((res) => {
    if (initPromise === p && res === "retry") initPromise = null; // 실패 판정은 캐시 안 함 — 재시도 가능
  });
  return p;
}

type BackupRow = { id: string; data: string; data_hash?: string };

// 복구·가져오기로 받은 씬 — 판은 서버가 준 지문이다(지문 계산을 못 하는 창도 판을 안다 — Codex 1A 리뷰 #2). 받은 씬은 그 서버 행
//  그대로라 옛 장부의 갈래를 통째로 버린다 — 저장소를 잃고 복구했는데 갈래가 남으면 원본을 지울 때 함께 복구된 사본 씬의 백업이
//  지워진다(#3). 가져오기는 갈래 사본 행을 받지 않는다(forkIds).
function adoptReceivedRows(scope: string, items: BackupRow[], added: Set<string>): void {
  for (const it of items) if (added.has(it.id)) setLedger(scope, it.id, it.data_hash ? { b: it.data_hash } : null);
}

/** 이 탭 장부의 갈래 사본 id — 가져오기·개수에서 뺀다(두 로컬 씬이 같은 행을 미러하지 않게, Codex C3). */
const forkIds = (): Set<string> => new Set([...ledger.values()].flatMap((entry) => (entry.fork ? [entry.fork.id] : [])));

async function ensureServerMeta(scope: string): Promise<Map<string, string> | null> {
  if (serverHash) return serverHash;
  try {
    const r = await jsonFetch<{ restore_generation: string; items: { id: string; data_hash: string }[] }>(
      `${API}?project_id=`,
      asAccount(scope),
    );
    if (ns() !== scope) return null; // 계정 전환 중 응답 — 다른 계정 메타를 캐시하지 않는다
    if (r.restore_generation !== readMirrorRecovery(scope)?.generation) return null;
    serverHash = new Map(r.items.map((it) => [it.id, it.data_hash]));
    return serverHash;
  } catch {
    return null; // 구백엔드(404)·오프라인 — 이번 회차 건너뜀(백오프가 재시도)
  }
}

/** 실패 재시도가 실어 오는 조건 — 재시도는 그것을 건 회차와 같은 계정·같은 길(공책 회차였으면 공책 기능이 켜져 있을 때)에서만 돈다. */
interface RetryGuard { scope: string; viaNotebook: boolean }
const retryStillValid = (guard: RetryGuard): boolean => ns() === guard.scope && (!guard.viaNotebook || hubHasFeature(SCENE_WRITER_FEATURE));
// 동기화 중에 온 '재시도' — 끝난 뒤 **실행 직전에** 조건을 다시 본다. 새 변경의 rerun(조건 없음)과 섞지 않는다: 섞으면 재시도가
//  조건을 잃고, 그사이 공책 기능이 꺼졌을 때 옛 백업 길을 시작한다(Codex 상의 2 — N1).
let rerunRetry: RetryGuard | null = null;
// 걸려 있는 재시도 타이머가 '실패한 회차 도중 들어온 새 변경'도 맡았다 — 그러면 그 재시도는 조건 없이(정상 동기화로) 돈다.
let retryForNewChange = false;
// 걸려 있는 재시도 타이머의 조건(타이머가 있을 때만 뜻이 있다) — 다른 조건의 회차가 실패했을 때 그 타이머가 이 실패도 맡게 할지 가린다.
let retryTimerGuard: RetryGuard | null = null;

async function syncNow(retry?: RetryGuard): Promise<void> {
  if (!hubFeaturesKnown()) await waitForHubFeatures();
  if (retry && !retryStillValid(retry)) return; // 타이머가 돌 때·밀렸다 실행될 때 모두 여기서 본다
  if (importing) return; // 가져오기가 끝나면 스스로 schedule() 한다 — 예약 타이머가 끼어들지 못하게
  if (syncing) {
    if (retry) rerunRetry = retry;
    else rerun = true;
    return;
  }
  syncing = true;
  syncIdle = new Promise<void>((resolve) => (syncSettled = resolve)); // 명시적 가져오기가 기다릴 지점
  let failed = false;
  const scope = enterScope();
  const viaNotebook = hubHasFeature(SCENE_WRITER_FEATURE); // 이 회차의 길 — 실패 재시도가 같은 계정·같은 길일 때만 돌게(아래 finally)
  try {
    // ★복구 판정이 끝나기 전 삭제 정합 금지 — 새 브라우저에서 로컬=[] 로 서버를 지우는 사고 방지.
    if (viaNotebook) {
      const result = await syncSceneNotebook();
      failed = result.status === "retry";
      if (ns() === scope) {
        recountOverLimit();
        // 사용자가 볼 씬·순서가 바뀐 동기화만 '복구' 다 — 진행 기록·기준만 바뀌어도(카메라만 옮긴 뒤) 복구 알림이 떴다(2026-11-10)
        if (result.visibleChanged) restoreSubs.forEach((fn) => fn());
      }
      return;
    }
    const restoreGeneration = await checkMirrorGeneration(scope);
    const init = await ensureInit(scope);
    if (init === "retry") {
      failed = true; // 판정 미상(미로그인 등) — 백오프로 재판정
      return;
    }
    if (init === "blocked") return; // 손상 백업 — 이 세션은 미러 중단(덮어쓰기·삭제 방지)
    if (ns() !== scope) return;
    const meta = await ensureServerMeta(scope);
    if (!meta) {
      failed = true;
      return;
    }
    if (ns() !== scope) return;
    // ★미러는 **확정본만** 올린다. 화면 값에는 아직 확정 안 된 편집이 섞여 있어, 그것을 올리면
    //  저장되지도 않은 삭제가 서버 백업에 반영된다(Codex).
    //  씬은 저장소가 기억해 둔 글자를 그대로 받는다 — 확정 때마다 전부를 다시 글자로 바꾸지 않는다.
    const local = listPersistedSceneTexts(null);
    const generations = mirrorSceneGenerations();
    // ★모든 씬의 글자와 판을 첫 await 전에 한 쌍으로 고정한다 — 앞 씬의 지문을 기다리는 사이 다른 탭에서 받은 뒤 씬의 새 판을
    //  옛 글자에 붙이면 서버의 새 내용을 덮는다(Codex E1 · 1A 리뷰 #1). 아래 지움 계산도 이 판을 쓴다.
    const frozen = new Map(ledger);
    // 올릴 것: id = 서버 행(갈래면 사본 id), localId = 이 브라우저의 씬, text = 로컬 글자(lastPushed 비교용).
    //  판(base_hash)은 늘 싣는다(""=모름) — 칸을 빼는 것은 옛 앱의 '그냥 덮기'라 새 앱은 쓰지 않는다(Codex 1A 리뷰 #2).
    type Up = { id: string; name: string; data: string; base_hash: string; localId: string; text: string };
    const upserts: Up[] = [];
    const tooBig = new Set<string>();
    const newlyTooBig: string[] = [];
    let heldNoHash = 0;
    const localIds = new Set(local.map((s) => s.id));
    for (const s of local) {
      if (generations.get(s.id) !== restoreGeneration) continue;
      const data = s.text;
      let entry = frozen.get(s.id);
      if (entry?.fork && localIds.has(entry.fork.id)) {
        // 갈래 사본 행이 이 브라우저의 씬으로 들어왔다(다른 탭이 가져옴) — 두 로컬 씬이 한 행을 미러하지 않게 갈래를 끊는다.
        //  이 씬은 제 행으로 돌아가 판으로 판정받는다(그사이 바뀌었으면 새 사본) — Codex 1A 4차 P1.
        entry = { b: entry.b };
        setLedger(scope, s.id, entry);
        copyTooBig.delete(s.id); // 갈래가 끝났다 — 사본 초과도 풀린다(E11)
        // 이 씬의 내용은 지금껏 그 사본 행에만 있었다 — 올린 기억을 무효로 해 제 판정(새 사본 행)을 다시 받게 한다.
        //  안 그러면 사본 씬만 지울 때 이 씬 내용의 유일한 백업이 지워진다(Codex 1A 5차). 새 사본 자리는 fork_avoid 로 그 행을 피한다.
        if (lastPushed.has(s.id)) lastPushed.set(s.id, "");
      }
      const target = entry?.fork?.id ?? s.id;
      // 이 세션에서 이미 올린(또는 복구한) 그대로 — 다만 서버 행이 사라졌으면 다시 넣는다(Codex C2)
      if (lastPushed.get(s.id) === data && meta.has(target)) continue;
      if (exceedsSceneLimit(data)) {
        // 전송에서 뺀다. ★올린 것으로 적지 않는다(lastPushed) — 작아지면 다시 대상이 된다. 서버에 남은 옛 사본도
        //  지우지 않는다(아래 삭제 계산은 '로컬에서 사라진 것'만 본다 — 이 씬은 로컬에 있다).
        tooBig.add(s.id);
        if (!oversized.has(s.id)) newlyTooBig.push(s.name);
        continue;
      }
      // 지문은 서버에 그 씬이 있을 때만 필요하다(같음·옛 창 판정) — 없으면 넣기만 한다
      const h = meta.has(s.id) ? await sha256hex(data) : null;
      if (ns() !== scope) return; // 지문을 기다리는 사이 범위가 바뀌었다 — 옛 범위의 씬을 새 범위의 표시·장부에 넣지 않는다(Codex 7A 리뷰)
      if (entry?.fork) {
        // 갈래 — 이 씬의 편집은 사본 행으로 간다. 로컬이 원본 서버 행과 같아졌으면 갈래를 끝낸다.
        if (h && h === meta.get(s.id)) {
          setLedger(scope, s.id, { b: h });
          lastPushed.set(s.id, data);
          copyTooBig.delete(s.id);
          continue;
        }
        const fork = forkText(data, entry.fork.id, s.id, h ?? "");
        if (!fork || exceedsSceneLimit(fork)) {
          tooBig.add(s.id);
          copyTooBig.add(s.id);
          continue;
        }
        copyTooBig.delete(s.id); // 지금 내용의 사본은 상한 안이다(E11 — 허브가 다시 넘는다고 하면 아래 응답이 다시 넣는다)
        upserts.push({ id: entry.fork.id, name: s.name, data: fork, base_hash: entry.fork.b ?? "", localId: s.id, text: data });
        continue;
      }
      if (!meta.has(s.id)) {
        upserts.push({ id: s.id, name: s.name, data, base_hash: entry?.b ?? "", localId: s.id, text: data });
        continue;
      }
      if (h === null) {
        // 지문을 못 구한다(insecure context·예외). 판을 알거나 이 세션이 올린 씬이면 판(모르면 "")을 실어 허브가 판정하게 한다(다르면 사본 —
        //  옛 허브는 판을 모르고 지금처럼 덮는다). 둘 다 아니면 서버에 이미 있는 씬은 덮지 않고 보류한다(Codex C5).
        if (entry?.b || lastPushed.has(s.id)) upserts.push({ id: s.id, name: s.name, data, base_hash: entry?.b ?? "", localId: s.id, text: data });
        else heldNoHash++;
        continue;
      }
      if (h === meta.get(s.id)) {
        setLedger(scope, s.id, { ...entry, b: h });
        lastPushed.set(s.id, data); // 서버와 동일 — 올릴 필요 없음
        copyTooBig.delete(s.id); // 이 내용은 백업에 있다(Codex 7A 리뷰)
        continue;
      }
      // 바뀐 것 없는 옛 창 — 서버가 더 새것이다(다른 창이 올렸다). 올리지 않고 lastPushed 에도 적지 않는다(지워도 남의 새것을 안 지움).
      if (entry?.b === h) continue;
      upserts.push({ id: s.id, name: s.name, data, base_hash: entry?.b ?? "", localId: s.id, text: data });
    }
    oversized = tooBig;
    publishSkippedIds();
    if (newlyTooBig.length) oversizeSubs.forEach((fn) => fn(newlyTooBig));
    if (heldNoHash && !holdNoticeShown) {
      holdNoticeShown = true;
      forkSubs.forEach((fn) => fn([])); // 빈 목록 = '지문을 못 구해 보류' 안내(화면이 글을 고른다)
    }
    // ★삭제 미러는 '이 세션에서 로컬에 있던 씬이 사라진 것'만 지운다(코덱스 P0).
    //  종전엔 '서버에만 있는 id' 를 전부 지웠다. 앱 전용 브라우저 프로필 도입(2026-09-01) 뒤로
    //  한 PC 에 프로필이 여럿 생기면서, 프로필을 번갈아 열 때마다 서로의 백업을 지웠다.
    //  · lastPushed = 이 세션에서 올렸거나 복구한 씬. 그게 지금 로컬에 없으면 사용자가 지운 것이다.
    //  · 버킷 키 자체가 없으면(읽기 실패·캐시 소실) 로컬을 '정답'으로 믿을 수 없으므로 삭제하지 않는다.
    //  · 갈래가 있으면 사본 행을 지우고, 지울 때의 판을 실어 그사이 다른 창이 올린 새 내용은 남긴다(1A).
    const localTrusted = hasPersistedSceneBucket(null);
    const deleteOf = new Map<string, string>(); // 서버 행 id → 로컬 씬 id
    const deleteBases: Record<string, string> = {}; // 지울 행마다 판("" = 모름 → 허브가 남긴다, Codex 1A 리뷰 #2)
    if (localTrusted) {
      for (const id of lastPushed.keys()) {
        if (localIds.has(id)) continue;
        const entry = frozen.get(id);
        const target = entry?.fork?.id ?? id;
        if (localIds.has(target)) {
          // 지운 씬의 갈래 사본 행이 살아 있는 다른 로컬 씬이다 — 그 백업은 지우지 않는다. 지운 씬의 제 행은 갈래였으니 남의 것이다(Codex 1A 4차 P1).
          lastPushed.delete(id);
          setLedger(scope, id, null);
          continue;
        }
        if (!meta.has(target)) continue;
        deleteOf.set(target, id);
        deleteBases[target] = (entry?.fork ? entry.fork.b : entry?.b) ?? "";
      }
    }
    // ★지문을 기다리는 사이 확정본이 바뀐 씬(다른 탭에서 받음·이 탭의 새 편집)은 이번에 보내지 않는다 — 옛 글자를 보내지 않게.
    //  끝나고 한 번 더 돌아 새 글자와 그때의 판으로 보낸다(Codex 1A 리뷰 #1).
    const nowText = new Map(listPersistedSceneTexts(null).map((s) => [s.id, s.text]));
    const fresh = upserts.filter((u) => nowText.get(u.localId) === u.text);
    if (fresh.length < upserts.length) rerun = true;
    upserts.splice(0, upserts.length, ...fresh);
    const currentGenerations = mirrorSceneGenerations();
    const allDeleted = [...deleteOf.keys()].filter((id) => !nowText.has(deleteOf.get(id)!) && currentGenerations.get(deleteOf.get(id)!) === restoreGeneration);
    // 이 브라우저의 사본 씬(bk_)과 그 원본 — 허브의 사본 자리는 올리는 행 id 에서만 나오므로 그 행의 사본만 피하라고 알린다(전부 보내면
    //  자동 복구로 사본이 2,000개를 넘을 때 상한에 걸려 백업이 멈췄다, Codex 63회차). 원본을 모르면 늘 보낸다.
    const forksOf = new Map<string, string[]>(); // 원본 행 id → 그 사본 씬들
    const unknownForks: string[] = [];
    for (const [id, text] of nowText) {
      if (!id.startsWith("bk_")) continue;
      const of = forkOrigin(id, text);
      if (of === null) unknownForks.push(id);
      else forksOf.set(of, [...(forksOf.get(of) ?? []), id]);
    }
    for (const id of forkOriginCache.keys()) if (!nowText.has(id)) forkOriginCache.delete(id);
    const forkAvoidOf = (chunk: Up[]) => [...unknownForks, ...chunk.flatMap((u) => forksOf.get(u.id) ?? [])];
    if (!upserts.length && !allDeleted.length) return;
    if (ns() !== scope) return; // 변경 적용(PUT) 직전 최종 확인
    // 청크 전송 — upsert 는 개수+UTF-8 바이트, delete 는 개수 기준(서버 상한과 동일). 피할 사본의 합계도 상한 안으로 다시 나눈다 —
    //  원본 여럿의 사본을 합치면 넘는다(Codex 63회차 재검토). 목록을 자르지는 않는다(자르면 사본이 남의 씬 행을 덮는다).
    //  shortcut: 원본을 모르는 사본 + 한 행의 사본만으로 2,000개를 넘으면 여전히 거절된다 — 그런 일이 생기면 서버 상한을 올린다.
    const upChunks = chunkUpserts(upserts).flatMap((chunk) => {
      const parts: Up[][] = [];
      let part: Up[] = [];
      let count = unknownForks.length;
      for (const u of chunk) {
        const more = forksOf.get(u.id)?.length ?? 0;
        if (part.length && count + more > MAX_FORK_AVOID) {
          parts.push(part);
          part = [];
          count = unknownForks.length;
        }
        part.push(u);
        count += more;
      }
      if (part.length) parts.push(part);
      return parts;
    });
    const delChunks: string[][] = [];
    for (let i = 0; i < allDeleted.length; i += MAX_DELETES) {
      delChunks.push(allDeleted.slice(i, i + MAX_DELETES));
    }
    const rounds = Math.max(upChunks.length, delChunks.length);
    const forked: string[] = [];
    for (let i = 0; i < rounds; i++) {
      if (ns() !== scope) return; // 각 청크 직전 재확인
      const chunk = upChunks[i] || [];
      const dels = delChunks[i] || [];
      const seqAtSend = new Map(chunk.map((u) => [u.localId, externalSeq.get(u.localId) ?? 0]));
      const res = await jsonFetch<{ restore_generation: string; results?: { id: string; status: string; target_id: string; hash: string | null }[]; kept?: string[] }>(`${API}`, {
        method: "PUT",
        ...asAccount(scope),
        body: JSON.stringify({
          restore_generation: restoreGeneration,
          project_id: "",
          upserts: chunk.map(({ id, name, data, base_hash }) => ({ id, name, data, base_hash })),
          deleted_ids: dels,
          delete_bases: Object.fromEntries(dels.map((id) => [id, deleteBases[id] ?? ""])),
          // 이 브라우저에서 이미 별도 씬이 된 사본 행 — 허브가 새 사본 자리로 쓰지 않게(옛 허브는 모르는 칸이라 무시)
          fork_avoid: forkAvoidOf(chunk),
        }),
      });
      if (ns() !== scope) return; // 응답 후 상태 반영도 같은 scope 일 때만
      const confirmedGeneration = await checkMirrorGeneration(scope);
      if (ns() !== scope || res.restore_generation !== restoreGeneration || confirmedGeneration !== restoreGeneration) return;
      const results = new Map((res?.results ?? []).map((r) => [r.id, r]));
      for (const u of chunk) {
        const r = results.get(u.id);
        if (r?.status === "too_big") {
          tooBig.add(u.localId); // 사본이 상한을 넘었다 — 올라가지 않았다(lastPushed 에 적지 않는다)
          copyTooBig.add(u.localId);
          continue;
        }
        copyTooBig.delete(u.localId); // 이번엔 올라갔다
        if ((externalSeq.get(u.localId) ?? 0) !== seqAtSend.get(u.localId)) {
          // 보내는 사이 다른 탭에서 이 씬을 받았다 — 늦은 응답으로 올린 기억·판·갈래를 되살리지 않는다(지금 글자는 받은 것이다).
          //  다음 동기화가 메타를 새로 받아 맞춘다. 사본으로 갔으면 그 행은 옛 내용의 사본으로 남는다(Codex 1A 재검토).
          lastPushed.set(u.localId, "");
          serverHash = null;
          continue;
        }
        lastPushed.set(u.localId, u.text);
        if (!r) {
          // 옛 허브(결과 칸 없음) — 지금처럼. 빈 글자는 존재 멤버십 sentinel 이며 변경 대조는 lastPushed 가 한다.
          serverHash?.set(u.id, "");
          continue;
        }
        serverHash?.set(r.target_id, r.hash ?? "");
        const entry = ledger.get(u.localId);
        if (r.status === "copied") {
          setLedger(scope, u.localId, { ...entry, fork: { id: r.target_id, b: r.hash ?? undefined } });
          forked.push(u.name);
        } else if (u.id !== u.localId) {
          setLedger(scope, u.localId, { ...entry, fork: { id: u.id, b: r.hash ?? undefined } });
        } else if (r.hash) {
          setLedger(scope, u.localId, { ...entry, b: r.hash });
        }
      }
      publishSkippedIds(); // 묶음마다 — 뒤 묶음이 실패해도 앞 묶음이 받은 too_big 이 탭에 보이게(Codex 7A 리뷰 P1)
      const kept = new Set(res?.kept ?? []);
      for (const id of dels) {
        const localId = deleteOf.get(id) ?? id;
        if (!kept.has(id)) serverHash?.delete(id);
        lastPushed.delete(localId);
        setLedger(scope, localId, null);
      }
    }
    oversized = tooBig;
    publishSkippedIds();
    if (forked.length) forkSubs.forEach((fn) => fn(forked));
  } catch {
    failed = true;
  } finally {
    syncing = false;
    syncSettled?.();
    syncSettled = null;
    if (ns() === scope && failed) {
      serverHash = null; // 실패 후엔 메타 재조회(부분 반영 가능성)
      // 이 회차 도중 들어온 새 변경(rerun)은 걸리는(또는 이미 걸린) 재시도가 맡는다 — 그 재시도는 조건 없이 돌아야 한다. 재시도의 조건에
      //  묶어 두면, 기한 전에 공책 기능이 꺼졌을 때 재시도와 함께 정상 변경의 동기화까지 사라진다(Codex 계약 검토).
      if (rerun) {
        rerun = false;
        retryForNewChange = true;
      }
      rerunRetry = null; // 밀려 있던 재시도는 이 재시도와 같은 일이다
      if (!retryTimer) {
        retryTimerGuard = { scope, viaNotebook };
        retryTimer = setTimeout(() => fireRetry({ scope, viaNotebook }), RETRY_MS);
      } else if (retryTimerGuard && (retryTimerGuard.scope !== scope || retryTimerGuard.viaNotebook !== viaNotebook)) {
        // 이미 걸린 재시도는 다른 조건(예: 공책 길)의 것이다 — 그 조건이 이제 맞지 않으면 그 재시도는 아무것도 하지 않아,
        //  방금 실패한 이 회차(다른 길의 정상 동기화)의 재시도가 사라진다. 그 재시도가 조건 없이 돌게 한다(독립 리뷰).
        retryForNewChange = true;
      }
    } else if (rerun) {
      rerun = false;
      rerunRetry = null; // 조건 없는 새 변경의 한 번 더가 재시도까지 맡는다
      void syncNow();
    } else if (rerunRetry) {
      const guard = rerunRetry;
      rerunRetry = null;
      void syncNow(guard);
    }
  }
}

// 이 백업이 시작하지 않은 공책 동기화(숨김·넘기기가 직접 부른 syncSceneNotebook)의 결과 — 카메라만 바뀐 확정은 동기화를 예약하지 않아(E4)
//  숨김 동기화가 실패하면 다음 계기까지 남는다. 실패면 기존 재시도 하나(있으면 그대로 — 기한을 미루지 않음), 성공이면 그 계정의 재시도를 풀고
//  크기 상한을 다시 센다(카메라만 확정은 다시 세지 않는다). 자기 syncNow 의 결과는 syncNow 가 처리한다(같은 진행 중 요청을 공유해도 타이머 하나).
function onNotebookSyncResult(result: NotebookSyncResult, account: string): void {
  if (!hubHasFeature(SCENE_WRITER_FEATURE) || account !== ns() || account !== curScope) return;
  if (result.status === "ready") {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    retryForNewChange = false; // 방금 성공한 공책 동기화가 그 새 변경까지 실어 갔다
    if (!syncing) recountOverLimit();
    return;
  }
  if (result.status !== "retry" || syncing || retryTimer) return;
  // 돌 때도 다시 본다 — 공책 기능이 꺼졌으면 syncNow 가 옛 백업 PUT 으로 들어가므로 이 재시도로는 아무것도 시작하지 않는다(Codex 6차)
  retryTimerGuard = { scope: account, viaNotebook: true };
  retryTimer = setTimeout(() => fireRetry({ scope: account, viaNotebook: true }), RETRY_MS);
}

/** 재시도 타이머가 돌 때 — 걸려 있는 동안 '새 변경'을 맡았으면 조건 없는 정상 동기화로, 아니면 건 회차의 조건(계정·길)이 그대로일 때만 돈다. */
function fireRetry(guard: RetryGuard): void {
  retryTimer = null;
  const forNewChange = retryForNewChange;
  retryForNewChange = false;
  void syncNow(forNewChange ? undefined : guard);
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  const run = () => {
    if (timer) clearTimeout(timer);
    if (maxWaitTimer) clearTimeout(maxWaitTimer);
    timer = maxWaitTimer = null;
    void syncNow();
  };
  timer = setTimeout(run, DEBOUNCE_MS);
  if (hubHasFeature(SCENE_WRITER_FEATURE) && !maxWaitTimer) maxWaitTimer = setTimeout(run, 10000);
}

// ── 명시적 가져오기 — 자동 복구가 닿지 못하는 자리를 사람이 직접 여는 문 ──────────────
// 자동 복구는 '로컬 버킷 키가 통째로 없을 때'만 돈다(로컬이 정답이라는 원칙). 그래서 이 브라우저에
// 씬이 하나라도 있으면, 다른 브라우저 프로필이 올려 둔 DB 백업은 영영 안 보인다. 앱 전용 프로필
// 도입(2026-09-01)으로 한 PC 에 프로필이 여럿 생기면서 이게 실제 문제가 됐다.
// 계약: 로컬을 덮지 않는다 — 같은 id 는 로컬을 유지하고, DB 에만 있는 씬만 더한다.

/** DB 백업에만 있고 이 브라우저엔 없는 씬 수. 0 이면 가져올 게 없다(UI 노출 판단용). */
export async function countBackupOnlyScenes(): Promise<number> {
  if (!hubFeaturesKnown() || hubHasFeature(SCENE_WRITER_FEATURE)) return 0;
  const scope = enterScope();
  try {
    const r = await jsonFetch<{ items: { id: string }[] }>(`${API}?project_id=`, asAccount(scope));
    if (ns() !== scope) return 0;
    const localIds = new Set(listScenes(null).map((s) => s.id));
    const mine = forkIds(); // 이 탭 씬의 갈래 사본은 자기 것 — 다시 가져오라고 하지 않는다
    return (r.items || []).filter((it) => !localIds.has(it.id) && !mine.has(it.id)).length;
  } catch {
    return 0; // 오프라인·구백엔드 — 조용히 숨긴다(없는 기능처럼 보이는 게 낫다)
  }
}

/** DB 백업에만 있는 씬을 이 브라우저로 가져온다. 반환 = 실제로 더한 개수. */
export async function importFromBackup(): Promise<number> {
  if (!hubFeaturesKnown() || hubHasFeature(SCENE_WRITER_FEATURE)) return 0;
  if (importing) return 0; // 연타 방지
  importing = true;
  try {
    return await runImport();
  } finally {
    importing = false;
    schedule(); // 가져온 결과를 서버와 다시 대조 + 그동안 밀린 변경을 이어서 올린다
  }
}

async function runImport(): Promise<number> {
  // 이미 시작된 sync 는 끝까지 기다린다. rerun 으로 곧바로 다음 sync 가 시작될 수 있어 반복 확인한다
  // (syncIdle 은 sync 마다 새로 만들어진다). importing=true 라 새 sync 는 더 들어오지 않는다.
  while (syncing) await syncIdle;
  if (!hubFeaturesKnown() || hubHasFeature(SCENE_WRITER_FEATURE)) return 0;
  const scope = enterScope();
  const r = await jsonFetch<{ restore_generation: string; items: BackupRow[] }>(
    `${API}?project_id=&include_data=1`,
    asAccount(scope),
  );
  if (ns() !== scope) return 0;
  if (!validRestoreGeneration(r.restore_generation) || (await checkMirrorGeneration(scope)) !== r.restore_generation || ns() !== scope) throw new Error("허브와 기록 시점이 달라 목록을 다시 읽어 주세요.");
  // 자동 복구와 같은 전 행 검증 — 하나라도 손상이면 부분 적용 없이 전체 포기.
  //  이 탭 씬의 갈래 사본 행은 가져오지 않는다 — 두 로컬 씬이 같은 행을 미러하게 된다(Codex C3).
  const mine = forkIds();
  const scenes: Scene[] = [];
  for (const it of (r.items || []).filter((item) => !mine.has(item.id))) {
    let s: Scene;
    try {
      s = JSON.parse(it.data) as Scene;
    } catch {
      throw new Error("백업이 손상돼 가져오지 못했습니다");
    }
    if (!s || typeof s !== "object" || s.id !== it.id || !Array.isArray(s.cards)) {
      throw new Error("백업이 손상돼 가져오지 못했습니다");
    }
    scenes.push(s);
  }
  // ★요청이 오가는 동안 생긴 씬을 잃지 않게, 합치기를 저장과 한 임계 구역에서 한다.
  const { value: merged, confirmed } = confirmSceneWrite(() =>
    restoreCanvasDocuments(
      scope,
      scenes.slice().sort((a, b) => (a.created_at || 0) - (b.created_at || 0)),
    ),
  );
  const added = merged.added;
  if (!added.length) return 0;
  if (!merged.ok || !(await confirmed)) {
    if (merged.ok) restoreSubs.forEach((f) => f()); // 화면 값에는 들어갔다 — 목록은 맞춰 준다
    throw new Error("가져온 씬을 저장소에 확정하지 못했습니다 — 잠시 뒤 자동으로 다시 시도합니다");
  }
  for (const s of added) lastPushed.set(s.id, JSON.stringify(s)); // 방금 가져온 것 = 서버에 이미 있음
  adoptReceivedRows(scope, r.items || [], new Set(added.map((s) => s.id)));
  serverHash = null; // 그사이 다른 프로필이 바꿨을 수 있다 — 메타를 새로 받아 대조
  restoreSubs.forEach((f) => f());
  return added.length;
}

function advanceMirrorProvenance(scope: string, before: Map<string, string>): void {
  try {
    const record = readMirrorRecovery(scope);
    if (record) {
      const after = new Map(listPersistedSceneTexts(null).map((scene) => [scene.id, scene.text]));
      const blocked = new Set(record.blockedIds);
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        const prev = before.get(id), next = after.get(id);
        if ((record.raws[id] ?? null) === (prev === undefined ? null : sha256Js(new TextEncoder().encode(prev))) && !blocked.has(id)) record.raws[id] = next === undefined ? null : sha256Js(new TextEncoder().encode(next));
      }
      saveMirrorRecovery(scope, record, false); // raws만 바뀌므로 화면용 비교·알림은 필요 없다.
    }
  } catch { /* 출처 저장 실패는 기존 확인값을 유지해 다음 전송을 보류한다. */ }
}

// 부팅 배선 + 복구 — useSceneCoordination 이 마운트마다 호출(내부는 scope 당 1회).
// 반환: 이번 호출로 복구가 일어났는지(호출부가 씬 목록 재읽기·알림).
let installed = false;
export async function initSceneBackup(): Promise<boolean> {
  if (!installed) {
    installed = true;
    // 이 탭의 확정 — 본 글자로 적는다(같은 확정에 다른 탭 변경이 섞였으면 그 알림이 먼저 온다 — sceneStore runStoreTx)
    subscribeScenesPersisted(({ notebookMetaOnly, cameraOnly }) => {
      // 공책이 자기 기준·진행 기록만 정리한 확정 — 씬은 그대로라 다시 예약·재집계하지 않는다(진행 기록 쓰기마다 2초 뒤 동기화가 또 돌았다)
      if (notebookMetaOnly) return;
      // 공책 허브에서 이 창의 카메라만 바꾼 확정 — 새로 예약·재집계하지 않는다(E4, Jay 2026-11-11 "바꿔도 됨"). 카메라는 다음 성공한
      //  공책 동기화(내용 저장·숨김·넘기기·기존 예약·재시도)가 씬 전체 비교로 함께 싣는다. 크기 상한 표시는 그 동기화·다음 내용 확정 때 다시 센다.
      if (cameraOnly && hubHasFeature(SCENE_WRITER_FEATURE)) return;
      if (ns() === curScope) {
        if (hubFeaturesKnown() && !hubHasFeature(SCENE_WRITER_FEATURE)) {
          advanceMirrorProvenance(ns(), knownText);
        }
        noteSeenTexts();
        recountOverLimit();
      }
      schedule();
    });
    subscribeSceneStoreExternal(() => void onExternalScenes()); // 다른 탭의 확정본 — 판 승계·미러 예약(1A)
    subscribeNotebookSyncResult(onNotebookSyncResult); // 숨김·넘기기가 시작한 공책 동기화의 실패·성공(E4)
    window.addEventListener("storage", onLedgerStorage); // 다른 탭이 장부를 고쳤다 — 받은 내용과 같으면 승계(1A)
    window.addEventListener("online", () => void syncNow());
  }
  const waiting = !hubFeaturesKnown()
    ? { scope: ns(), texts: new Map(listPersistedSceneTexts(null).map((scene) => [scene.id, scene.text])) }
    : null;
  if (waiting) await waitForHubFeatures();
  const scope = enterScope();
  if (hubHasFeature(SCENE_WRITER_FEATURE)) {
    const result = await syncSceneNotebook();
    schedule();
    return result.changed;
  }
  // 기능 대기 중 확정된 정상 편집도 대기 전 지문과 이어질 때만 승계한다.
  if (waiting?.scope === scope) advanceMirrorProvenance(scope, waiting.texts);
  const res = await ensureInit(scope);
  // 복구 여부와 무관하게 초기 reconcile 1회 — 배포 전부터 있던(수정 안 한) 씬도 미러되게(코덱스 P1).
  // 실패(미로그인 401 포함)는 30s 백오프가 이어받아 로그인 후 자연 회복된다.
  schedule();
  return res === "restored";
}
