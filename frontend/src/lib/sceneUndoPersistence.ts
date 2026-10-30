// 되돌리기 기록을 새로 고쳐도 남게 — 씬 DB 와 따로인 작은 IndexedDB(mvhub-undo — 씬 DB 버전을 올리면 옛 판 창의 씬 저장에 영향이 가서 따로 둔다).
// 계약: docs/status/캔버스_한계_B_되돌리기보존_2026-10-30.md (설계 §9.5·§9.9).
//  · 페이지 로드마다 새 writerId → (writerId, account, sceneId) 자기 슬롯을 그 로드 동안 덮어쓴다. 복원 포인터가 가리키는 남의 슬롯에는 쓰지 않는다
//    (편집마다 전체 기록을 새 레코드로 쌓으면 30MB 에 금방 닿아 보존이 멈췄다 — Codex 5차).
//  · 슬롯마다 진행 하나(고정)·최신 대기 하나. 그 편집의 씬 저장이 확정되고 지문이 저장본과 같을 때만 쓴다.
//  · 성공 커밋 뒤 탭별 포인터(sessionStorage)를 자기 슬롯으로. 보존은 마지막 저장부터 7일, 용량은 교체 후 크기로 같은 트랜잭션에서 본다.
//  · 무엇이 실패해도(열기·차단·시간 초과·용량) 기록 없이 진행한다 — 부팅·편집을 막지 않는다.
import { getAccountNamespace } from "./accountScope";
import { listPersistedScenes, settleComfyRunning } from "./scenes";
import { isComfyRunning } from "./sceneComfyRunningStore";
import { freezeLegacyCollectorOrder } from "./sceneEdges";
import { onSceneHistoryEvent, snapFingerprint, type SceneHistory } from "./sceneUndoStore";

export const UNDO_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const UNDO_BUDGET = 30 * 1024 * 1024; // 논리 추정치의 상한(실제 디스크 사용량이 아니다 — 아래 logicalSize)
const OPEN_TIMEOUT_MS = 1500;
const POINTER_KEY = "mvhub.undoPointers"; // sessionStorage — 탭마다 따로, 새로 고쳐도·복제해도 남는다
const writerId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; // 페이지 로드마다 새로(메모리 값)

export interface UndoSlot {
  key: string;
  writerId: string;
  account: string;
  sceneId: string;
  deleteGeneration: number;
  historyRevision: number;
  snapFp: string;
  history: SceneHistory;
  savedAt: number;
  size: number;
}
/** 그 편집을 담은 씬 저장의 영수증 — features/canvas 의 CanvasWriteReceipt 와 같은 모양(경계 규칙상 여기서 import 하지 않는다). */
export interface SceneWriteReceipt {
  readonly confirmed: Promise<boolean>;
}
export type UndoPutResult = "ok" | "deleted" | "full" | "failed";
/** 저장 칸. 한 호출이 한 트랜잭션이다 — put 은 삭제 세대 확인·용량 검사(합계 − 기존 + 새)·슬롯과 합계 갱신을 한 번에. */
export interface UndoBackend {
  put(slot: UndoSlot, budget: number): Promise<UndoPutResult>;
  get(key: string): Promise<UndoSlot | null>;
  generation(account: string, sceneId: string): Promise<number>;
  forget(account: string, sceneId: string, generation: number): Promise<void>;
  prune(savedBefore: number): Promise<void>;
}

/** put 한 번의 판정 — 삭제 세대가 다르면 deleted, 교체 후 합계(합계 − 기존 + 새)가 상한을 넘고 커지는 쓰기면 full(같거나 작은 갱신은 받는다). */
export function planUndoPut(
  stored: { generation: number; total: number; previousSize: number },
  slot: Pick<UndoSlot, "deleteGeneration" | "size">,
  budget: number,
): { result: "ok" | "deleted" | "full"; total: number } {
  const total = stored.total - stored.previousSize + slot.size;
  if (stored.generation !== slot.deleteGeneration) return { result: "deleted", total: stored.total };
  if (total > budget && slot.size > stored.previousSize) return { result: "full", total: stored.total };
  return { result: "ok", total };
}

const sceneKey = (account: string, sceneId: string) => JSON.stringify([account, sceneId]);
const slotKey = (account: string, sceneId: string) => JSON.stringify([writerId, account, sceneId]);

// 한 레코드 전체 객체 그래프의 크기 추정 — 같은 객체는 한 번만 센다(IDB 구조적 복제도 한 레코드 안의 공유 객체를 한 번만 저장한다).
export function logicalSize(value: unknown, seen = new Set<object>()): number {
  if (value === null || typeof value !== "object") return typeof value === "string" ? value.length + 2 : 8;
  if (seen.has(value)) return 0;
  seen.add(value);
  let size = 2;
  if (Array.isArray(value)) for (const item of value) size += logicalSize(item, seen) + 1;
  else for (const [key, item] of Object.entries(value)) size += key.length + 3 + logicalSize(item, seen);
  return size;
}

// ── 탭별 포인터 ────────────────────────────────────────────────────────────────
function readPointers(): Record<string, string> {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(POINTER_KEY) || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}
function writePointer(scene: string, key: string | null): boolean {
  try {
    const pointers = readPointers();
    if (key) pointers[scene] = key;
    else delete pointers[scene];
    sessionStorage.setItem(POINTER_KEY, JSON.stringify(pointers));
    return true;
  } catch {
    return false; // 이전 포인터가 남는다 — 다음 성공 저장 때 다시 게시한다
  }
}

// ── IndexedDB 칸 ──────────────────────────────────────────────────────────────
const DB_NAME = "mvhub-undo";
const SLOTS = "slots";
const META = "meta"; // "total" → 논리 크기 합계, ["gen", account, sceneId] → 삭제 세대
const TOTAL = "total";
const genKey = (account: string, sceneId: string) => JSON.stringify(["gen", account, sceneId]);

function openUndoDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    const timer = setTimeout(() => resolve(null), OPEN_TIMEOUT_MS);
    const done = (db: IDBDatabase | null) => {
      clearTimeout(timer);
      resolve(db);
    };
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SLOTS)) db.createObjectStore(SLOTS, { keyPath: "key" });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        done(db);
      };
      req.onerror = () => done(null);
      req.onblocked = () => done(null);
    } catch {
      done(null);
    }
  });
}

const request = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const finished = (tx: IDBTransaction) => new Promise<boolean>((resolve) => {
  tx.oncomplete = () => resolve(true);
  tx.onabort = () => resolve(false);
  tx.onerror = () => resolve(false);
});

function indexedDbBackend(): UndoBackend {
  let opening: Promise<IDBDatabase | null> | null = null;
  const db = () => (opening ??= openUndoDb().then((opened) => {
    if (!opened) opening = null; // 다음 기회에 다시 연다
    else opened.onclose = () => { opening = null; };
    return opened;
  }));
  return {
    async put(slot, budget) {
      const conn = await db();
      if (!conn) return "failed";
      try {
        const tx = conn.transaction([SLOTS, META], "readwrite");
        const slots = tx.objectStore(SLOTS);
        const meta = tx.objectStore(META);
        const [generation, total, previous] = await Promise.all([
          request(meta.get(genKey(slot.account, slot.sceneId))),
          request(meta.get(TOTAL)),
          request(slots.get(slot.key)),
        ]) as [number | undefined, number | undefined, UndoSlot | undefined];
        const plan = planUndoPut({ generation: generation ?? 0, total: total ?? 0, previousSize: previous?.size ?? 0 }, slot, budget);
        if (plan.result === "ok") {
          slots.put(slot);
          meta.put(plan.total, TOTAL);
        }
        return (await finished(tx)) ? plan.result : "failed"; // 실제 용량 오류(QuotaExceeded)도 여기서 실패 — 기존 레코드·합계는 그대로
      } catch {
        return "failed";
      }
    },
    async get(key) {
      const conn = await db();
      if (!conn) return null;
      try {
        return ((await request(conn.transaction(SLOTS).objectStore(SLOTS).get(key))) as UndoSlot | undefined) ?? null;
      } catch {
        return null;
      }
    },
    async generation(account, sceneId) {
      const conn = await db();
      if (!conn) return 0;
      try {
        return ((await request(conn.transaction(META).objectStore(META).get(genKey(account, sceneId)))) as number | undefined) ?? 0;
      } catch {
        return 0;
      }
    },
    async forget(account, sceneId, generation) {
      const conn = await db();
      if (!conn) return;
      try {
        const tx = conn.transaction([SLOTS, META], "readwrite");
        const meta = tx.objectStore(META);
        const stored = ((await request(meta.get(genKey(account, sceneId)))) as number | undefined) ?? 0;
        meta.put(Math.max(stored, generation), genKey(account, sceneId));
        let freed = 0;
        const all = (await request(tx.objectStore(SLOTS).getAll())) as UndoSlot[];
        for (const slot of all) {
          if (slot.account !== account || slot.sceneId !== sceneId) continue;
          freed += slot.size;
          tx.objectStore(SLOTS).delete(slot.key);
        }
        const total = ((await request(meta.get(TOTAL))) as number | undefined) ?? 0;
        meta.put(Math.max(0, total - freed), TOTAL);
        await finished(tx);
      } catch {
        /* 못 지운 슬롯은 세대가 달라 쓰이지 않고, 7일 뒤 정리된다 */
      }
    },
    async prune(savedBefore) {
      const conn = await db();
      if (!conn) return;
      try {
        const tx = conn.transaction([SLOTS, META], "readwrite");
        const all = (await request(tx.objectStore(SLOTS).getAll())) as UndoSlot[];
        let total = 0;
        for (const slot of all) {
          if (slot.savedAt < savedBefore) tx.objectStore(SLOTS).delete(slot.key);
          else total += slot.size;
        }
        tx.objectStore(META).put(total, TOTAL); // 합계도 실제 남은 슬롯으로 다시 맞춘다
        await finished(tx);
      } catch {
        /* 다음 부팅에 다시 */
      }
    },
  };
}

let backend: UndoBackend | null = null;
const currentBackend = () => (backend ??= indexedDbBackend());
/** 시험용 — 가짜 칸으로 바꾼다(jsdom 에는 IndexedDB 가 없다). null 이면 다음 호출에 실제 IndexedDB 로. */
export function setUndoBackend(next: UndoBackend | null): void {
  backend = next;
}

// ── 저장본 지문 ────────────────────────────────────────────────────────────────
// 보드가 씬을 받을 때와 같은 모양으로(SceneBoard 첫 스냅샷·useCanvasSession 수신: 실행 중 정리·옛 수집 순서 고정) 만든 뒤 지문을 낸다.
export function savedSceneFingerprint(sceneId: string): string | null {
  const scene = listPersistedScenes(null).find((item) => item.id === sceneId);
  if (!scene) return null;
  const cards = settleComfyRunning(scene.cards, isComfyRunning);
  return snapFingerprint({ cards, edges: freezeLegacyCollectorOrder(cards, scene.edges), groups: scene.groups || [] });
}

// ── 예약·쓰기 ─────────────────────────────────────────────────────────────────
interface Reservation {
  account: string;
  sceneId: string;
  deleteGeneration: number;
  historyRevision: number;
  snapFp: string;
  history: SceneHistory;
  receipt: SceneWriteReceipt;
}
const generations = new Map<string, number>(); // 이 창이 아는 삭제 세대 — 예약 때 고정하고, 쓰기 직전(트랜잭션 안)·포인터 게시 직전에 다시 본다
const lanes = new Map<string, { next: Reservation | null }>(); // 슬롯마다 진행 하나(이 맵에 있음)·최신 대기 하나(next)

/** 편집·Undo·Redo·파생 저장 뒤에 부른다. 기록은 지금 모습으로 복제해 둔다(스택은 그 자리에서 바뀐다). */
export function scheduleUndoCheckpoint(sceneId: string, history: SceneHistory, historyRevision: number, receipt: SceneWriteReceipt): void {
  // 빈 기록은 쓰지 않는다 — 부팅 직후의 파생 저장이 빈 기록으로 포인터를 옮기면, 아직 들이지 못한 지난 기록을 잃는다(Codex 5차)
  if (!history.undo.length && !history.redo.length) return;
  const account = getAccountNamespace();
  const key = sceneKey(account, sceneId);
  const reservation: Reservation = {
    account, sceneId, historyRevision, receipt,
    deleteGeneration: generations.get(key) ?? 0,
    snapFp: snapFingerprint(history.lastCommit),
    history: { undo: [...history.undo], redo: [...history.redo], lastCommit: history.lastCommit },
  };
  const lane = lanes.get(key);
  if (lane) lane.next = reservation; // 진행 중이면 대기만 최신으로 바꾼다
  else {
    lanes.set(key, { next: null });
    void drain(key, reservation);
  }
}

async function drain(key: string, first: Reservation): Promise<void> {
  let reservation: Reservation | null = first;
  while (reservation) {
    await write(reservation);
    const lane = lanes.get(key);
    reservation = lane?.next ?? null;
    if (lane) lane.next = null;
  }
  lanes.delete(key);
}

async function write(reservation: Reservation): Promise<void> {
  const { account, sceneId, deleteGeneration } = reservation;
  const key = sceneKey(account, sceneId);
  const live = () => account === getAccountNamespace() && (generations.get(key) ?? 0) === deleteGeneration;
  try {
    if (!(await reservation.receipt.confirmed) || !live()) return;
    if (savedSceneFingerprint(sceneId) !== reservation.snapFp) return; // 그 뒤 편집이 또 저장됐다 — 대기 중인 더 새 예약이 쓴다
    const slot: UndoSlot = {
      key: slotKey(account, sceneId), writerId, account, sceneId, deleteGeneration,
      historyRevision: reservation.historyRevision, snapFp: reservation.snapFp, history: reservation.history,
      savedAt: Date.now(), size: 0,
    };
    slot.size = logicalSize(slot);
    const result = await currentBackend().put(slot, UNDO_BUDGET);
    if (result === "deleted") {
      // 다른 창이 이 씬을 지웠다(되살렸으면 그 뒤 예약부터 새 세대로 쓴다)
      const stored = await currentBackend().generation(account, sceneId);
      generations.set(key, Math.max(generations.get(key) ?? 0, stored));
      return;
    }
    if (result === "ok" && live() && readPointers()[key] !== slot.key) writePointer(key, slot.key);
  } catch {
    /* 기록 없이 진행 */
  }
}

/** 씬을 지웠다 — 세대를 올려 대기 쓰기와 그 완료의 포인터 게시를 모두 무효로 하고, 그 씬의 슬롯을 지운다. */
export function forgetSceneUndo(sceneId: string): void {
  const account = getAccountNamespace();
  const key = sceneKey(account, sceneId);
  const generation = (generations.get(key) ?? 0) + 1;
  generations.set(key, generation);
  writePointer(key, null);
  void currentBackend().forget(account, sceneId, generation);
}

// 저장소(sceneUndoStore)의 사건 — 씬 기록 지움 = 씬 삭제, 창 인계로 받은 기록 = 이 창의 슬롯에 남긴다(돌려받은 뒤 새로 고쳐도 이어지게).
//  인계 기록은 이미 저장된 씬의 것이라 영수증 대신 지문 대조만으로 쓴다.
onSceneHistoryEvent((event) => {
  if (event.type === "cleared") forgetSceneUndo(event.sceneId);
  else scheduleUndoCheckpoint(event.sceneId, event.history, 0, { confirmed: Promise.resolve(true) });
});

// ── 부팅 읽기 ─────────────────────────────────────────────────────────────────
/** 이 탭의 포인터가 가리키는 슬롯(지금 계정 것, 7일 안, 지운 씬 아님). 남의 슬롯일 수 있다 — 읽기만 한다. 무엇이 실패해도 빈 목록. */
export async function readUndoSlots(): Promise<UndoSlot[]> {
  const account = getAccountNamespace();
  const now = Date.now();
  const out: UndoSlot[] = [];
  try {
    for (const [scene, key] of Object.entries(readPointers())) {
      const slot = await currentBackend().get(key);
      if (!slot || sceneKey(slot.account, slot.sceneId) !== scene || slot.account !== account || now - slot.savedAt > UNDO_KEEP_MS) continue;
      const generation = await currentBackend().generation(account, slot.sceneId);
      generations.set(scene, Math.max(generations.get(scene) ?? 0, generation));
      if (slot.deleteGeneration === generation) out.push(slot);
    }
    void currentBackend().prune(now - UNDO_KEEP_MS);
  } catch {
    /* 기록 없이 시작 */
  }
  return out;
}
