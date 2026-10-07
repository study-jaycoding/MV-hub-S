// 씬 저장소 — IndexedDB. localStorage(출처당 약 5MB 고정)를 대신한다.
//
// 왜: 씬은 전부 localStorage 에 있었고, 큰 씬 9개면 5MB 가 찼다. 차면 저장이 실패하는데 화면은
// 조용히 저장본으로 되돌아가, 쓰는 사람에겐 "연결이 안 되는 버그"로 보였다(2026-10-07 신고).
// IndexedDB 는 같은 프로필 폴더 안이지만 한도가 디스크 여유 기준이라 그 벽이 없다.
//
// ── 구조: "동기 얼굴 + 연산 재생" (Codex 합의 2026-10-07) ─────────────────────────────
// 앱 계층(App·SceneBoard·useSceneCoordination)은 전부 **"저장은 그 틱에 끝난다"** 를 전제로 짜여 있다.
// 처음에는 쓰기를 Promise 로 바꿔 앱 계층이 기다리게 했는데, 그 전제를 앱 곳곳에서 깨다 보니 리뷰마다
// 새 경쟁이 나왔다(누적 26건: 방금 친 글이 낡은 카드 배열에 덮임·늦은 저장 응답이 새 편집을 되돌림…).
// 그래서 비동기를 **이 모듈 안에 가둔다**:
//
//   confirmed  IndexedDB 에 확정된 내용
//   pending    working 에는 적용됐지만 아직 확정 안 된 '연산'(mutator 함수) 목록
//   working    confirmed 에 pending 을 차례로 적용한 것 — **앱이 읽고 쓰는 값(동기)**
//
//  · 쓰기 = 연산을 working 에 **동기로** 적용하고(종전과 같은 틱), 같은 연산을 pending 에 넣는다.
//  · flush = 한 readwrite 트랜잭션에서 **저장소의 최신 내용을 읽어 pending 을 순서대로 재생**하고 쓴다.
//    다른 창의 변경 위에 얹히므로 서로 덮지 않는다. 끝나면 confirmed 를 갈고 working 을 다시 계산한다.
//  · 실패하면 pending 을 그대로 두고 알린 뒤 간격을 늘려 다시 시도한다. working(화면)은 건드리지 않는다.
//
// 지켜야 할 것:
//  · **동기 성공 = working 반영 성공**이다. 영속화 성공은 연산별 Promise(captureSceneOps)로만 안다.
//  · **연산은 순수**하다 — id·시각·계정·입력은 접수 때 고정해 넣는다. 재생은 두 번 이상 일어난다.
//  · **미러·복구 판정은 confirmed 만 본다.** 화면에 보인다는 이유로 바깥 상태를 확정하지 않는다.
//
// 그 밖(종전 합의 그대로):
//  · 옛 저장소(localStorage)는 지우지 않는다 — 앱 업데이트가 옛 창을 닫아 주지 않으므로(브라우저 창은
//    일부러 업데이트 대상 밖에서 돈다), 지우면 살아남은 옛 창이 깨진다. 대신 그 변경을 흡수한다(sceneAbsorb).
//  · 이관 표식을 바깥(옛 저장소·쿠키)에도 둔다 — IDB 안에만 두면 IDB 가 통째로 사라졌을 때 표식도
//    함께 사라져, 낡은 옛 저장소를 '처음 이관'으로 착각해 최신인 양 되살린다.
import { planAbsorption, type SceneAbsorbConflict, type SceneAbsorbPlan } from "./sceneAbsorb";
import type { Scene, ScenesByProject } from "./scenes";

const DB_NAME = "mvhub-scenes";
// 2 = 씬별 키 배치(아래 '씬별 키'). ★object store 는 그대로지만 버전을 올린다. 옛 배치(씬 전체가 한 키)를 쓰는
//  창이 같이 떠 있으면, 그 창은 지워진 옛 키를 다시 만들어 "확정됐다"고 알리고 새 창은 그 키를 읽지 않는다
//  (Codex 설계 검토). 버전을 올리면 둘이 동시에 열리지 못한다 — 옛 창이 닫힐 때까지 새 창의 열기가 막히고
//  (부팅 오류 화면이 "다른 창을 닫으라"고 안내한다), 올라간 뒤에는 옛 판이 낮은 버전으로 열지 못한다.
const DB_VERSION = 2;
const STORE = "kv";
const K_LEGACY_SCENES = "scenes"; // 옛 배치 — 씬 묶음 전체가 한 값. 열 때 씬별 키로 풀고 지운다
const K_LAYOUT = "layout"; // 2 = 씬별 키 배치로 초기화가 끝났다
const K_VERSION = "version"; // 씬이 바뀔 때마다 1씩 — 다른 창이 그사이 썼는지 값싸게 안다
const K_BASE = "absorbBase"; // 마지막으로 처리한 옛 저장소 내용(흡수 판정의 B)
const K_GENERATION = "generation"; // 이관 세대 — 바깥 표식과 짝을 이룬다
const K_CONFLICTS = "conflicts"; // 해결 전까지 남겨 두는 흡수 충돌
/** 옛 저장소에 두는 바깥 표식의 키. */
export const LEGACY_GENERATION_KEY = "ch.scenes.migration";

/** 바깥 이관 표식. pending=시작했지만 아직 확정 안 됨, committed=끝남. 둘을 구분하지 않으면
 *  "첫 이관이 끊긴 것"과 "이관 뒤 IDB 가 사라진 것"을 섞어, 빈 상태를 성공으로 열어 버린다. */
export interface LegacyMark {
  state: "pending" | "committed";
  generation: string;
}

type StoreValues = Record<string, unknown>;
type Entries = Array<[string, unknown]>;

let db: IDBDatabase | null = null;
// IndexedDB 가 아예 없는 런타임(브라우저가 아닌 곳 — 시험의 jsdom)용 대체 저장. ★브라우저에서는
// 시크릿 창·사이트 데이터 차단이어도 indexedDB 자체는 존재하고 open 이 실패하므로, 이 경로로
// 빠지지 않는다(그때는 'failed' 로 오류 화면). 즉 제품에서 조용히 메모리에 저장하는 일은 없다.
let memory: Map<string, unknown> | null = null;
let ready = false;

let confirmed: ScenesByProject = {};
let confirmedVersion = 0;
let working: ScenesByProject = {};
let conflictList: SceneAbsorbConflict[] = [];

interface PendingOp {
  mutate: (all: ScenesByProject) => void;
  /** true 면 working 에 미리 반영하지 않는다 — 확정된 뒤에만 보인다(계정 귀속처럼 '먼저 보이면 안 되는' 변경). */
  confirmedOnly: boolean;
  waiters: Array<(ok: boolean) => void>;
  poisoned?: boolean;
  /** 같은 slot 의 다음 연산을 여기에 합칠 수 있다(applySceneOp 의 merge). */
  slot?: string;
  absorb?: (patch: unknown) => void;
  /** 저장으로 떠났다 — 이 뒤로는 합치지 않는다(이미 계산해 쓴 뒤에 합치면 그 입력이 사라진다). */
  flying?: boolean;
}
let pending: PendingOp[] = [];

/** 부팅 게이트가 끝났는가. false 면 읽은 값을 믿을 수 없다(빈 데이터로 오해하면 안 된다). */
export const sceneStoreReady = (): boolean => ready;
/** 자동으로 정하지 못해 남겨 둔 흡수 충돌(확정본). */
export const sceneStoreConflicts = (): SceneAbsorbConflict[] => conflictList;
/** 아직 저장소에 확정되지 않은 변경이 있는가(화면의 '저장 안 됨' 표시용). */
export const sceneStoreHasPending = (): boolean => pending.length > 0;

// ── IndexedDB 얇은 어댑터 ────────────────────────────────────────────────────
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      // 배치 변환은 여기서 하지 않는다(부팅이 보통 트랜잭션에서 다시 확인하며 한다) — 저장 칸만 만든다.
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const opened = req.result;
      // 더 새 판이 이 DB 를 올리려 한다 — 비켜 준다(안 닫으면 그 창의 열기가 막힌다). 이 창의 저장은 그 뒤로
      // 실패하고, 기존 '저장 안 됨' 경로가 알린다(편집은 화면에 남고 파일로 내려받을 수 있다).
      const drop = () => {
        opened.close();
        if (db === opened) db = null;
      };
      opened.onversionchange = drop;
      opened.onclose = drop; // 브라우저가 연결을 끊었다(저장소 비우기 등) — 다음 저장 때 다시 연다
      resolve(opened);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("scene store blocked"));
  });
}

/** 저장소 연결이 있는가 — 끊겼으면 다시 연다. false = 지금은 쓸 수 없다. */
async function ensureDb(): Promise<boolean> {
  if (memory || db) return true;
  if (typeof indexedDB === "undefined") return false;
  try {
    db = await openDb();
    return true;
  } catch {
    return false;
  }
}

// ── 씬별 키 ─────────────────────────────────────────────────────────────────────
// 씬 하나가 한 키다. 종전에는 씬 묶음 전체가 한 값이라, 편집 한 번마다 전부를 읽고 전부를 다시 썼다(편집의
// 화면 멈춤이 전체 양에 비례 — 15MB 에서 30ms, 44MB 에서 80ms 실측). 이제 바뀐 씬만 쓴다.
//  · ["s", 버킷, 씬 id] → 씬
//  · ["o", 버킷]        → 그 버킷의 씬 id 순서(탭 순서). **이 키가 있으면 버킷이 있다**(빈 배열 = 빈 버킷).
// 키는 JSON 배열 글자라 계정 이름에 어떤 글자가 들어도 서로 겹치지 않고, 낱말로 된 메타 키와 범위가 갈린다.
const orderKey = (bucket: string): string => JSON.stringify(["o", bucket]);
const sceneKey = (bucket: string, id: string): string => JSON.stringify(["s", bucket, id]);
const SCENE_KEY_FROM = '["';
const SCENE_KEY_TO = '["' + String.fromCharCode(0xffff); // 범위의 끝 — 소스에 보이지 않는 글자를 넣지 않으려고 코드로 만든다
const isSceneKey = (key: string): boolean => key.startsWith(SCENE_KEY_FROM);

interface TxWrite {
  puts: Entries;
  deletes: string[];
}
const NO_WRITE: TxWrite = { puts: [], deletes: [] };

/** 씬별 키들을 버킷 맵으로 조립한다. 순서 키에 없는 씬은 싣지 않는다(순서·씬·버전은 늘 한 트랜잭션에서 쓴다). */
function assembleScenes(entries: Iterable<[string, unknown]>): ScenesByProject {
  const orders = new Map<string, string[]>();
  const scenes = new Map<string, Map<string, Scene>>();
  for (const [key, value] of entries) {
    const [kind, bucket, id] = JSON.parse(key) as [string, string, string | undefined];
    if (kind === "o") orders.set(bucket, value as string[]);
    else if (kind === "s" && id !== undefined) {
      let inBucket = scenes.get(bucket);
      if (!inBucket) scenes.set(bucket, (inBucket = new Map()));
      inBucket.set(id, value as Scene);
    }
  }
  const all: ScenesByProject = {};
  for (const [bucket, ids] of orders) {
    const inBucket = scenes.get(bucket);
    all[bucket] = ids.flatMap((id) => {
      const scene = inBucket?.get(id);
      return scene ? [scene] : [];
    });
  }
  freezeScenes(all);
  return all;
}

const sameIds = (a: Scene[], b: Scene[]): boolean => a.length === b.length && a.every((scene, i) => scene.id === b[i].id);

/**
 * 기준(base)에서 결과(live)로 가려면 무엇을 써야 하는가 — **객체가 같으면 안 바뀐 것**으로 본다.
 * 연산은 버킷을 새 배열로 갈아 끼우고 안 바뀐 씬은 같은 객체로 두므로(applySceneOp 의 계약), 바뀐 씬만 잡힌다.
 * 내용이 같은 새 객체는 한 번 더 쓰일 뿐 틀리지 않는다. 제자리에서 고친 것은 못 잡는다 — 그래서 개발·시험
 * 빌드에서는 저장소에 든 씬을 얼려 두어(freezeScenes) 그런 연산이 그 자리에서 던지게 한다.
 */
function diffScenes(base: ScenesByProject, live: ScenesByProject): TxWrite {
  const puts: Entries = [];
  const deletes: string[] = [];
  for (const [bucket, after] of Object.entries(live)) {
    const before = base[bucket];
    if (after === before) continue;
    const was = new Map((before || []).map((scene) => [scene.id, scene]));
    const now = new Set<string>();
    for (const scene of after) {
      now.add(scene.id);
      if (was.get(scene.id) !== scene) puts.push([sceneKey(bucket, scene.id), scene]);
    }
    for (const scene of before || []) if (!now.has(scene.id)) deletes.push(sceneKey(bucket, scene.id));
    if (!before || !sameIds(before, after)) puts.push([orderKey(bucket), after.map((scene) => scene.id)]);
  }
  for (const [bucket, before] of Object.entries(base)) {
    if (bucket in live) continue;
    deletes.push(orderKey(bucket));
    for (const scene of before) deletes.push(sceneKey(bucket, scene.id));
  }
  return { puts, deletes };
}

// 개발·시험 빌드에서만: 저장소가 든 씬(버킷 배열과 그 안)을 얼린다. 연산이 순수 계약을 어기고 제자리에서
// 고치면 그 자리에서 던진다 — 제품 빌드에서는 그런 편집이 조용히 저장에서 빠지므로(diffScenes) 시험에서 잡는다.
// 이미 언 것은 건너뛰어, 편집마다 전체를 다시 훑지 않는다.
const FREEZE = import.meta.env.DEV;
function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const inner of Object.values(value)) deepFreeze(inner);
}
function freezeScenes(all: ScenesByProject): void {
  if (!FREEZE) return;
  for (const list of Object.values(all)) deepFreeze(list);
}

// '확정'이 디스크 기록까지 뜻하게 요청한다(전원이 나가도 남게). 실제로 적용됐는지는 브라우저가 정한다 —
// 적용값을 읽어 두고, strict 가 아니면 그 보장을 말하지 않는다(sceneStoreDurability).
let appliedDurability = "unknown";
function openTx(active: IDBDatabase, mode: IDBTransactionMode): IDBTransaction {
  if (mode !== "readwrite") return active.transaction(STORE, mode);
  let tx: IDBTransaction;
  try {
    tx = active.transaction(STORE, mode, { durability: "strict" });
  } catch {
    tx = active.transaction(STORE, mode); // 이 선택지를 모르는 브라우저
  }
  appliedDurability = (tx as IDBTransaction & { durability?: string }).durability ?? "default";
  return tx;
}
/** 마지막 쓰기 트랜잭션에 실제로 적용된 내구성("strict" 면 디스크 기록까지 기다린다). 메모리 대체는 "unknown". */
export const sceneStoreDurability = (): string => appliedDurability;

/**
 * **한 트랜잭션 안에서** 읽고, 계산하고, 쓴다.
 *
 * 읽기는 두 박자다: 메타 키를 먼저 읽고, `wantScenes(meta)` 가 참일 때만 같은 트랜잭션에서 씬 전체를 읽는다
 * (다른 창이 그사이 썼을 때·부팅·전체 내보내기). 평소 저장은 버전 숫자만 읽고 끝난다.
 *
 * ★읽기와 쓰기를 따로 열면 그 사이에 다른 창이 끼어들어 서로를 덮는다. IndexedDB 는 한 트랜잭션
 *  안에서 get→put 을 허용하므로, 다른 창의 같은 작업은 이 트랜잭션이 끝날 때까지 기다린다.
 * ★`wantScenes`·`decide` 는 **동기**여야 한다. IDB 트랜잭션은 보류 중인 요청이 없는 채로 마이크로태스크를
 *  넘기면 저절로 닫힌다 — 안에서 IDB 가 아닌 Promise 를 기다리면 트랜잭션이 죽는다.
 * ★쓰기는 전부 되거나 전부 안 된다(씬·순서·버전·메타). 실패하면 던지고, 저장소는 그대로다.
 */
async function storeTx(
  metaKeys: string[],
  wantScenes: (meta: StoreValues) => boolean,
  decide: (meta: StoreValues, scenes: ScenesByProject | null) => TxWrite,
  mode: IDBTransactionMode = "readwrite",
): Promise<void> {
  const writing = mode === "readwrite";
  if (writing && delayWritesForTest) await new Promise((resolve) => setTimeout(resolve, delayWritesForTest));
  if (writing && failWritesForTest) throw new Error("scene store write blocked (test)");
  if (memory) {
    const active = memory;
    const meta: StoreValues = {};
    // 저장소가 돌려주는 값은 호출부 소유다(IDB 는 매번 새 객체를 준다) — 메모리 대체도 같게.
    for (const key of metaKeys) meta[key] = cloneStored(active.get(key));
    const write = decide(meta, wantScenes(meta) ? assembleScenes(sceneEntries(active)) : null);
    if (writing && abortWritesForTest) throw new Error("scene store aborted (test)");
    for (const [key, value] of write.puts) active.set(key, cloneStored(value));
    for (const key of write.deletes) active.delete(key);
    return;
  }
  if (!db) throw new Error("scene store not ready");
  const active = db;
  await new Promise<void>((resolve, reject) => {
    const tx = openTx(active, mode);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("scene store aborted"));
    const store = tx.objectStore(STORE);
    const meta: StoreValues = {};
    const giveUp = (error: unknown) => {
      try {
        tx.abort();
      } catch {
        // 이미 닫힌 트랜잭션이면 abort 가 던진다 — 원래 오류를 그대로 올린다.
      }
      reject(error);
    };
    const finish = (scenes: ScenesByProject | null) => {
      try {
        const write = decide(meta, scenes);
        for (const [key, value] of write.puts) store.put(value, key);
        for (const key of write.deletes) store.delete(key);
        if (writing && abortWritesForTest) return tx.abort(); // 쓰기를 낸 뒤 중단 — 하나도 남지 않아야 한다
        // 곧바로 확정을 보낸다 — 창이 닫히는 중이어도 이미 보낸 쓰기가 끝날 가능성을 높인다(보장은 아니다).
        (tx as IDBTransaction & { commit?: () => void }).commit?.();
      } catch (error) {
        giveUp(error);
      }
    };
    const afterMeta = () => {
      try {
        if (!wantScenes(meta)) return finish(null);
        const range = IDBKeyRange.bound(SCENE_KEY_FROM, SCENE_KEY_TO);
        const keys = store.getAllKeys(range);
        const values = store.getAll(range);
        // 한 트랜잭션의 요청은 낸 순서대로 끝난다 — 값이 왔으면 키도 와 있다. 둘은 같은 키 순서다.
        values.onsuccess = () => {
          const found = keys.result as string[];
          finish(assembleScenes(found.map((key, i): [string, unknown] => [key, values.result[i]])));
        };
        keys.onerror = values.onerror = () => reject(values.error || keys.error);
      } catch (error) {
        giveUp(error);
      }
    };
    let waiting = metaKeys.length;
    if (!waiting) return afterMeta();
    for (const key of metaKeys) {
      const got = store.get(key) as IDBRequest<unknown>;
      got.onsuccess = () => {
        meta[key] = got.result;
        if (--waiting === 0) afterMeta(); // 메타를 전부 읽은 뒤 같은 트랜잭션에서 이어 간다
      };
      got.onerror = () => reject(got.error);
    }
  });
}

/** 읽기만 — **한 시점**의 메타와 (원하면) 씬 전체. */
async function readStore(
  metaKeys: string[],
  wantScenes: (meta: StoreValues) => boolean,
): Promise<{ meta: StoreValues; scenes: ScenesByProject | null }> {
  let out: { meta: StoreValues; scenes: ScenesByProject | null } = { meta: {}, scenes: null };
  await storeTx(
    metaKeys,
    wantScenes,
    (meta, scenes) => {
      out = { meta, scenes };
      return NO_WRITE;
    },
    "readonly",
  );
  return out;
}

function* sceneEntries(store: Map<string, unknown>): Generator<[string, unknown]> {
  for (const [key, value] of store) if (isSceneKey(key)) yield [key, cloneStored(value)];
}

function cloneStored<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

// ── 저장소 트랜잭션은 전부 한 줄로 ───────────────────────────────────────────────
// flush·흡수·다른 창 재조회·충돌 정리·전체 가져오기가 서로 추월하지 않는다. 늦게 끝난 조회가
// confirmed 를 과거로 되감는 일도 없다(순서대로 적용되고, version 이 같으면 건드리지 않는다).
let txQueue: Promise<unknown> = Promise.resolve();
function enqueueTx<T>(run: () => Promise<T>): Promise<T> {
  const next = txQueue.then(run, run);
  txQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

interface TxStepResult {
  /** 씬 내용을 바꿨는가. */
  changed: boolean;
  /** 같은 트랜잭션에 함께 쓸 다른 키(기준·충돌 등). */
  entries: Entries;
  /** 씬은 그대로여도 화면에 알려야 하는가(충돌 목록만 바뀐 경우). */
  notify?: boolean;
}
type TxStep = (live: ScenesByProject, current: StoreValues) => TxStepResult;

/**
 * 저장소 트랜잭션 한 번: 최신을 읽고 → pending 을 재생하고 → (있으면) step 을 적용하고 → 쓴다.
 * step 은 트랜잭션 안에서 **한 번만** 실행된다(재생되지 않는다) — 흡수·충돌 정리·가져오기처럼
 * 저장소의 다른 키를 읽어야만 계산할 수 있는 일에 쓴다. step 앞에 pending 을 먼저 재생하므로,
 * 아직 확정 안 된 내 편집을 흡수가 추월하지 않는다.
 * @returns 트랜잭션이 끝났는가
 */
function runStoreTx(extraReads: string[] = [], step?: TxStep, after?: () => void): Promise<boolean> {
  return enqueueTx(async () => {
    if (!ready) return false;
    const batch = pending.slice(); // ★묶음 고정 — 끝난 뒤 이 묶음만 뺀다(도중에 들어온 연산은 남긴다)
    for (const op of batch) op.flying = true;
    // ★기준(base)과 작업본(live)을 나눈다. 재생은 live 에만 하고, confirmed 는 **트랜잭션이 끝난 뒤에만** 간다 —
    //  실패한 트랜잭션의 결과가 확정본으로 읽히면 미러·복구가 저장되지 않은 편집을 확정으로 믿는다(Codex 설계 검토).
    let live: ScenesByProject = {};
    let liveVersion = 0;
    let external = false;
    let wrote = false;
    let stepOut: TxStepResult = { changed: false, entries: [] };
    try {
      if (!(await ensureDb())) throw new Error("scene store not open");
      await storeTx(
        [K_VERSION, ...extraReads],
        // 버전이 내가 아는 것과 다르면 다른 창이 썼다 — 그때만 씬 전체를 읽는다. 같으면 메모리의 확정본이 곧
        // 저장소 내용이라 다시 읽을 필요가 없다(평소 저장이 전체 크기에 매이지 않는 까닭).
        (meta) => ((meta[K_VERSION] as number | undefined) ?? 0) !== confirmedVersion,
        (meta, scenes) => {
          liveVersion = (meta[K_VERSION] as number | undefined) ?? 0;
          external = scenes !== null;
          const base = scenes ?? confirmed;
          live = { ...base };
          for (const op of batch) {
            try {
              op.mutate(live);
            } catch (error) {
              // 화면(working)에서는 됐는데 저장소 내용 위에서는 던진 연산 — 다시 해도 같으므로 버린다.
              // 조용히 버리지 않는다: 그 연산을 기다리던 쪽은 실패를 받고, 콘솔에 남긴다.
              op.poisoned = true;
              console.error("[sceneStore] 재생할 수 없는 연산을 버립니다", error);
            }
          }
          stepOut = step ? step(live, meta) : stepOut;
          freezeScenes(live);
          wrote = batch.length > 0 || stepOut.changed;
          const write = diffScenes(base, live);
          const touched = write.puts.length + write.deletes.length > 0;
          if (touched) liveVersion += 1; // 씬이 실제로 바뀌었을 때만 — 다른 창이 다시 읽을 까닭이 생겼다
          if (wrote) lastWriteForTest = { puts: write.puts.map(([key]) => key), deletes: write.deletes };
          return {
            puts: [...write.puts, ...(touched ? ([[K_VERSION, liveVersion]] as Entries) : []), ...stepOut.entries],
            deletes: write.deletes,
          };
        },
      );
    } catch {
      // 확정 실패 — pending 은 그대로 둔다(다음 쓰기·타이머가 다시 시도). 기다리던 쪽에는 '지금은 안 됐다'.
      // confirmed 는 건드리지 않았다(위에서 live 에만 재생했다).
      for (const op of batch) {
        op.flying = false; // 쓰이지 않았다 — 다음 입력을 다시 합칠 수 있다
        op.poisoned = false; // 이번 재생의 판정은 버린다 — 다음 시도가 그때의 내용으로 다시 본다
        op.waiters.splice(0).forEach((fn) => fn(false));
      }
      flushListener?.(false);
      scheduleRetry();
      return false;
    }
    const hadConfirmedOnly = batch.some((op) => op.confirmedOnly);
    confirmed = live;
    confirmedVersion = liveVersion;
    pending = pending.filter((op) => !batch.includes(op));
    retryDelayMs = RETRY_MIN_MS;
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    after?.();
    // working = confirmed + 남은 pending. 내 묶음만 확정됐고 바깥 변화가 없으면 내용이 같아 다시 계산할
    // 필요가 없다(종전 working = 옛 confirmed + 묶음 + 나머지). 바깥 변화·step·확정 전용 연산이 있었으면
    // 다시 계산하고 화면에 알린다. 버린 연산이 있을 때도 — 화면 값에는 그 연산이 남아 있어서, 그대로 두면
    // 저장소에 없는 편집을 화면이 계속 보여 준다.
    const dropped = batch.some((op) => op.poisoned);
    if (external || stepOut.changed || hadConfirmedOnly || dropped) {
      rebaseWorking();
      externalSubs.forEach((fn) => fn());
    } else if (stepOut.notify) {
      externalSubs.forEach((fn) => fn());
    }
    for (const op of batch) op.waiters.splice(0).forEach((fn) => fn(!op.poisoned));
    if (wrote || stepOut.notify) {
      if (wrote) flushListener?.(true);
      announceWrite();
    }
    if (pending.length) scheduleFlush(); // 도중에 들어온 연산
    return true;
  });
}

function rebaseWorking(): void {
  const next: ScenesByProject = { ...confirmed };
  for (const op of pending) {
    if (op.confirmedOnly) continue;
    try {
      op.mutate(next);
    } catch {
      op.poisoned = true;
    }
  }
  freezeScenes(next);
  working = next;
}

// ── flush 예약·재시도 ────────────────────────────────────────────────────────────
let flushScheduled = false;
function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  // 같은 틱에 들어온 연산(밀린 입력 확정 → 이어지는 패치)을 한 트랜잭션으로 묶는다.
  // (queueMicrotask 가 아니라 Promise 인 까닭: 가짜 타이머가 queueMicrotask 까지 붙잡는 시험 환경에서
  //  저장이 영영 출발하지 않았다.)
  void Promise.resolve().then(() => {
    flushScheduled = false;
    if (pending.length) void runStoreTx();
  });
}

const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;
let retryDelayMs = RETRY_MIN_MS;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleRetry(): void {
  if (retryTimer !== undefined) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    if (pending.length) void runStoreTx();
  }, retryDelayMs);
  retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS); // 간격을 늘린다 — 막힌 저장소를 두드리지 않는다
}

let flushListener: ((ok: boolean) => void) | null = null;
/** flush 결과(확정 성공/실패)를 듣는다 — 데이터 계층이 '저장 실패' 알림과 DB 미러 통지에 쓴다. */
export function setSceneFlushListener(fn: ((ok: boolean) => void) | null): void {
  flushListener = fn;
}

// ── 쓰기(동기 얼굴) ──────────────────────────────────────────────────────────────
export interface SceneMutation<T> {
  /** false 면 아무것도 바꾸지 않는다 — 빈 버킷을 만들거나 헛쓰기를 하지 않기 위해서. */
  write: boolean;
  value: T;
}

// 저장소가 오래 막히면 연산이 쌓인다(연산마다 그때의 입력 — 카드 배열 한 벌 — 을 들고 있다).
//  · 같은 대상을 잇달아 고치는 연산은 **하나로 합친다**(merge). 한 씬을 계속 고치는 흔한 경우에는 밀린
//    연산이 하나뿐이라 쌓이지 않는다. 합친 결과는 차례로 재생한 것과 같다.
//  · 그래도 상한에 닿으면 **새 연산을 받지 않는다**(반환 ok:false — 호출부가 알린다).
//  ★쌓인 연산을 '지금 내 버킷 통째'로 바꿔 줄이지 않는다. 그렇게 뭉친 연산은 재생될 때 저장소의 그 버킷을
//    내 옛 사본으로 갈아 끼워, 그사이 다른 창이 확정한 변경을 흔적 없이 지운다(Codex 코드 리뷰 P1).
const PENDING_MAX = 200;

/** 바로 앞의 같은 연산에 합칠 수 있는 연산. replay(join(a, b)) 는 replay(a) 뒤 replay(b) 와 같아야 한다. */
export interface SceneOpMerge<P> {
  /** 같은 대상·같은 종류를 가리키는 이름(예: 어느 버킷의 어느 씬 갱신). */
  slot: string;
  patch: P;
  join: (previous: P, next: P) => P;
  /** 합친 입력으로 저장소 내용을 고친다 — mutate 와 같은 일을, 주어진 입력으로. */
  replay: (all: ScenesByProject, patch: P) => void;
}

let captureStack: PendingOp[][] = [];
let captureFailed: boolean[] = [];

/**
 * 연산 하나를 적용한다. **동기**로 working 에 반영하고 값을 돌려준다(확정은 뒤따른다).
 *
 * ★mutate 는 **순수**해야 한다 — 저장소 내용 위에서 다시 실행된다(재생). id·시각·계정·입력은 밖에서
 *  만들어 클로저로 넣고, 안에서 바깥 상태를 읽거나 바꾸지 않는다. 버킷은 새 배열로 **갈아 끼운다**
 *  (`all[key] = next`) — 들어 있는 배열·씬 객체를 제자리에서 고치지 않는다.
 */
export function applySceneOp<T, P = never>(
  mutate: (all: ScenesByProject) => SceneMutation<T>,
  options: { confirmedOnly?: boolean; merge?: SceneOpMerge<P> } = {},
): { ok: boolean; value: T } {
  ensureMemoryStoreOutsideBrowser();
  const { merge } = options;
  const last = pending[pending.length - 1];
  // 바로 앞 연산이 같은 대상이고 아직 저장으로 떠나지 않았으면 거기에 합친다.
  const host = merge && last?.absorb && last.slot === merge.slot && !last.flying && !options.confirmedOnly ? last : null;
  // 저장소 연결이 잠깐 끊긴 것(다시 열 수 있다)은 거절 사유가 아니다 — 연산은 받아 두고 저장이 다시 시도한다.
  const refused = !ready || (!host && pending.length >= PENDING_MAX);
  if (refused) {
    captureFailed = captureFailed.map(() => true);
    if (ready) flushListener?.(false); // 상한 — '저장 안 됨'을 다시 알린다(조용히 버리지 않는다)
    return { ok: false, value: mutate({ ...working }).value };
  }
  const draft: ScenesByProject = { ...working };
  const outcome = mutate(draft);
  if (!outcome.write) return { ok: true, value: outcome.value };
  if (!options.confirmedOnly) {
    freezeScenes(draft);
    working = draft;
  }
  let op: PendingOp;
  if (host && merge) {
    host.absorb?.(merge.patch);
    op = host;
  } else if (merge) {
    let patch = merge.patch;
    op = {
      confirmedOnly: Boolean(options.confirmedOnly),
      waiters: [],
      mutate: (all) => merge.replay(all, patch),
      slot: merge.slot,
      absorb: (next) => {
        patch = merge.join(patch, next as P);
      },
    };
    pending.push(op);
  } else {
    op = {
      confirmedOnly: Boolean(options.confirmedOnly),
      waiters: [],
      mutate: (all) => {
        mutate(all);
      },
    };
    pending.push(op);
  }
  for (const captured of captureStack) captured.push(op); // 겹쳐 잡는 바깥 쪽도 이 연산을 기다린다
  scheduleFlush();
  return { ok: true, value: outcome.value };
}

/**
 * `run` 안에서 접수된 연산들이 **저장소에 확정됐는지**를 알려 주는 Promise 를 함께 돌려준다.
 * 내구성이 필요한 흐름(생성 제출 전 표식·백업 복구 보고·판정 기억)만 쓴다 — 전역 '큐가 비었나'가 아니라
 * **그 작업의 연산**만 본다(계속 편집해 큐가 안 비어도 기다림이 끝난다).
 * false = 이번 시도에 확정되지 못했다(연산은 pending 에 남아 다시 시도된다).
 */
export function captureSceneOps<T>(run: () => T): { value: T; confirmed: Promise<boolean> } {
  captureStack.push([]);
  captureFailed.push(false);
  let value: T;
  let ops: PendingOp[];
  let failed: boolean;
  try {
    value = run();
  } finally {
    ops = captureStack.pop() ?? [];
    failed = captureFailed.pop() ?? false;
  }
  if (failed) return { value, confirmed: Promise.resolve(false) };
  const waits = ops.map((op) => new Promise<boolean>((resolve) => op.waiters.push(resolve)));
  return { value, confirmed: Promise.all(waits).then((results) => results.every(Boolean)) };
}

// ── 읽기(동기) ───────────────────────────────────────────────────────────────────
// 저장소가 든 객체는 밖에 내주지 않는다 — 받은 쪽이 고치면 저장소 값이 바뀐다. 내주는 것은 **씬별 사본**이다.
// 사본은 씬 객체마다 한 번만 만든다(글자로 바꿨다가 다시 읽는다 — 종전 localStorage 가 주던 것과 같은
// 정규화: undefined 필드가 빠진다). 안 바뀐 씬은 같은 사본을 다시 주므로, 읽기 비용이 '바뀐 씬의 크기'다.
// 종전에는 읽을 때마다 버킷 전체를 글자로 바꿨다가 다시 읽어, 편집마다 전체 양에 비례하는 시간이 들었다
// (15MB 에서 약 25ms, 44MB 에서 약 65ms 실측).
// ★그래서 **받은 씬은 고치지 않는다** — 같은 사본을 다른 독자도 받는다. 개발·시험 빌드에서는 사본을 얼려 두어
//  고치려 하면 그 자리에서 던진다. 목록(배열)은 매번 새로 준다 — 정렬·거르기·더하기는 마음대로 해도 된다.
interface SceneView {
  text: string;
  copy: Scene;
}
const viewOfScene = new WeakMap<Scene, SceneView>();
function viewOf(scene: Scene): SceneView {
  let view = viewOfScene.get(scene);
  if (!view) {
    const text = JSON.stringify(scene);
    const copy = JSON.parse(text) as Scene;
    if (FREEZE) deepFreeze(copy);
    view = { text, copy };
    viewOfScene.set(scene, view);
  }
  return view;
}
const owns = (all: ScenesByProject, key: string): boolean => Object.prototype.hasOwnProperty.call(all, key);
const copiesOf = (all: ScenesByProject, key: string): Scene[] =>
  owns(all, key) ? all[key].map((scene) => viewOf(scene).copy) : [];

/** 앱이 보는 값(확정 + 아직 확정 안 된 내 편집). */
export const readWorkingBucket = (key: string): Scene[] => {
  ensureMemoryStoreOutsideBrowser();
  return copiesOf(working, key);
};
export const hasWorkingBucket = (key: string): boolean => {
  ensureMemoryStoreOutsideBrowser();
  return owns(working, key);
};
/** 화면 값 기준 버킷의 씬 수 — 새 씬 기본 이름("씬 N")을 접수 시점에 정하는 데 쓴다. */
export const workingBucketLength = (key: string): number => {
  ensureMemoryStoreOutsideBrowser();
  return working[key]?.length ?? 0;
};
/** 저장소에 확정된 값만. DB 미러·복구 판정은 이것을 본다. */
export const readConfirmedBucket = (key: string): Scene[] => copiesOf(confirmed, key);
export const hasConfirmedBucket = (key: string): boolean => owns(confirmed, key);
/** 확정본을 씬별 **글자**로 — DB 미러가 올리는 모양 그대로다. 안 바뀐 씬은 다시 글자로 바꾸지 않는다. */
export const readConfirmedTexts = (key: string): Array<{ id: string; name: string; text: string }> =>
  owns(confirmed, key)
    ? confirmed[key].map((scene) => ({ id: scene.id, name: scene.name, text: viewOf(scene).text }))
    : [];

/** working 전체의 사본 — 시험·실측용. 제품 코드는 버킷 단위 읽기를 쓴다. */
export function readScenesCache(): ScenesByProject {
  ensureMemoryStoreOutsideBrowser();
  return structuredClone(working);
}

// 브라우저가 아닌 런타임(시험의 jsdom)에서는 부팅 게이트를 거치지 않고도 읽고 쓸 수 있게 메모리로
// 연다. ★브라우저에서는 indexedDB 가 늘 존재하므로 이 경로로 빠지지 않는다.
function ensureMemoryStoreOutsideBrowser(): void {
  if (ready || typeof indexedDB !== "undefined") return;
  memory = memory ?? new Map();
  ready = true;
}

// ── 부팅 ────────────────────────────────────────────────────────────────────
export type SceneStoreInit =
  | { kind: "ready"; migrated: boolean; absorbed: SceneAbsorbPlan | null }
  /** IDB 를 쓸 수 없다 — 화면은 오류·재시도에 머물러야 한다. 빈 데이터로 진행하면 안 된다. */
  | { kind: "failed"; error: string };

const failed = (error: string): SceneStoreInit => {
  ready = false;
  return { kind: "failed", error };
};

/**
 * 저장소를 연다. 처음이면 옛 저장소에서 1회 이관하고, 그 뒤에는 옛 저장소에 남은 변경을 흡수한다.
 *
 * @param readLegacy 옛 저장소(localStorage)의 씬 묶음. 없거나 못 읽으면 null.
 * @param legacyMark 바깥에 적힌 이관 표식(없으면 null).
 * @param writeLegacyMark 바깥 표식을 적는다. **적혔는지**를 돌려준다(조용한 실패 금지).
 */
export async function initSceneStore(
  readLegacy: () => ScenesByProject | null,
  legacyMark: LegacyMark | null,
  writeLegacyMark: (mark: LegacyMark) => boolean,
): Promise<SceneStoreInit> {
  try {
    if (typeof indexedDB === "undefined") memory = memory ?? new Map();
    else db = db ?? (await openDb());
    const legacy = shapedBuckets(readLegacy());
    let migrated = false;

    // ① 분류용 1차 조회. 아래 쓰기는 전부 트랜잭션 안에서 **다시 확인하고** 쓴다 — 그 사이 다른 창이
    //    먼저 했으면 덮지 않는다.
    const INIT_KEYS = [K_LAYOUT, K_LEGACY_SCENES, K_GENERATION];
    const never = () => false;
    // 저장소가 이미 초기화돼 있는가 — 씬별 키 배치의 표식이 있거나, 풀어야 할 옛 배치가 있다.
    const initialized = (meta: StoreValues) => meta[K_LAYOUT] === 2 || meta[K_LEGACY_SCENES] !== undefined;
    let head = (await readStore(INIT_KEYS, never)).meta;
    if (head[K_LAYOUT] !== 2 && head[K_LEGACY_SCENES] !== undefined) {
      // (v1) 옛 배치(씬 전체가 한 키)로 저장돼 있다 → 씬별 키로 푼다. 버전·세대·흡수 기준·충돌은 같은 키라
      //      그대로 두고, 옛 키는 지운다. 한 트랜잭션이라 중간에 끊겨도 옛 배치 그대로 남아 다음에 다시 한다.
      await storeTx(INIT_KEYS, never, (meta) => {
        if (meta[K_LAYOUT] === 2 || meta[K_LEGACY_SCENES] === undefined) return NO_WRITE; // 다른 창이 먼저 풀었다
        const unpacked = diffScenes({}, shapedBuckets(meta[K_LEGACY_SCENES] as ScenesByProject) ?? {});
        return { puts: [...unpacked.puts, [K_LAYOUT, 2]], deletes: [K_LEGACY_SCENES] };
      });
      head = (await readStore(INIT_KEYS, never)).meta;
    }
    if (head[K_LAYOUT] !== 2) {
      if (legacyMark?.state === "committed") {
        // (a) 이관을 끝냈는데 IDB 가 사라졌다(사이트 데이터 삭제 등). 옛 저장소를 '최신'으로 되살리면
        //     이관 뒤의 작업이 통째로 옛 상태로 돌아간다 — 되살리지 않고 **빈 상태로 열어** DB 백업
        //     복구에 맡긴다(옛 저장소는 남아 있으므로 자료가 사라지는 것은 아니다).
        await storeTx(INIT_KEYS, never, (meta) =>
          initialized(meta)
            ? NO_WRITE
            : {
                puts: [
                  [K_LAYOUT, 2],
                  [K_VERSION, 1],
                  [K_BASE, legacy ?? {}],
                  [K_GENERATION, legacyMark.generation],
                  [K_CONFLICTS, []],
                ],
                deletes: [],
              },
        );
      } else {
        // (b) 표식이 'pending' = 첫 이관이 중간에 끊겼다 → 옛 저장소가 아직 정답이므로 다시 이관.
        // (c) 표식이 없다 = 처음 이관.
        const next = legacy ?? {};
        const generation =
          legacyMark?.generation ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        // ★표식을 먼저, **적혔는지 확인하고** 남긴다. 조용히 실패하면 다음 실행이 (c)로 보고 다시
        //  이관하는데, 그 사이의 작업이 옛 내용으로 덮인다.
        if (!writeLegacyMark({ state: "pending", generation })) {
          return failed("이관 표식을 남기지 못했습니다(저장소 접근 차단)");
        }
        await storeTx(INIT_KEYS, never, (meta) => {
          if (initialized(meta)) return NO_WRITE; // 다른 창이 먼저 이관했다
          migrated = true;
          return {
            puts: [
              ...diffScenes({}, next).puts,
              [K_LAYOUT, 2],
              [K_VERSION, 1],
              [K_BASE, next],
              [K_GENERATION, generation],
              [K_CONFLICTS, []],
            ],
            deletes: [],
          };
        });
        // ★확정 표식도 실패를 삼키지 않는다. 'pending' 이 남은 채로 쓰다가 IDB 가 사라지면 다음 실행이
        //  (b)로 보고 낡은 옛 저장소를 다시 이관해 그동안의 작업을 덮는다.
        if (!writeLegacyMark({ state: "committed", generation })) {
          return failed("이관 표식을 확정하지 못했습니다(저장소 접근 차단)");
        }
      }
    } else if (legacyMark?.state !== "committed") {
      // 저장소에 씬이 있는데 표식이 확정이 아니다 = 확정 기록만 실패했다. 지금 고쳐 둔다.
      const generation = legacyMark?.generation ?? String(head[K_GENERATION] ?? "");
      if (!writeLegacyMark({ state: "committed", generation })) {
        return failed("이관 표식을 고치지 못했습니다(저장소 접근 차단)");
      }
    }

    // ② 최신 상태를 **한 트랜잭션에서** 읽고, 옛 저장소에 남은 변경을 흡수한다(이벤트를 놓쳤어도
    //    여기서 따라잡는다). 이 결과가 confirmed·working 의 출발점이다.
    ready = true;
    pending = [];
    confirmedVersion = -1; // 첫 트랜잭션이 반드시 '바깥 변화'로 보고 working 을 계산하게
    const absorbed = await absorbInTx(legacy);
    if (absorbed === false) return failed("저장소를 열었지만 첫 정리에 실패했습니다");
    return { kind: "ready", migrated, absorbed };
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}

// 충돌은 **해결될 때까지 남아야** 한다. 기준(B)은 흡수 뒤 최신으로 올라가므로, 다음에 열면 L=B 가 되어
// 같은 충돌이 다시 잡히지 않는다 — 저장해 두지 않으면 조용히 사라진다(Codex 리뷰·브라우저 실측에서 재현).
function mergeConflicts(kept: SceneAbsorbConflict[], found: SceneAbsorbConflict[]): SceneAbsorbConflict[] {
  const byKey = new Map(kept.map((c) => [`${c.bucket}\u0000${c.sceneId}`, c]));
  for (const c of found) byKey.set(`${c.bucket}\u0000${c.sceneId}`, c); // 새 것이 이긴다
  return [...byKey.values()];
}

/** 옛 저장소 내용을 흡수한다. legacy 가 null 이면 최신 상태를 읽어 오기만 한다. false = 트랜잭션 실패. */
async function absorbInTx(legacy: ScenesByProject | null): Promise<SceneAbsorbPlan | null | false> {
  let plan: SceneAbsorbPlan | null = null;
  let merged: SceneAbsorbConflict[] = [];
  const ok = await runStoreTx(
    [K_BASE, K_CONFLICTS],
    (live, current) => {
      // ★기준(B)·충돌도 **트랜잭션 안에서 읽는다** — 창마다 들고 있는 사본으로 판정하면 다른 창이
      //  이미 확정한 기준을 못 보고 오판하거나, 그 창이 보존한 충돌을 지운다.
      const base = (current[K_BASE] as ScenesByProject | undefined) ?? null;
      const kept = (current[K_CONFLICTS] as SceneAbsorbConflict[] | undefined) ?? [];
      merged = kept;
      if (!legacy) return { changed: false, entries: [] };
      plan = planAbsorption(base, live, legacy);
      merged = mergeConflicts(kept, plan.conflicts);
      const entries: Entries = [
        [K_BASE, legacy],
        [K_CONFLICTS, merged],
      ];
      if (!plan.changed) return { changed: false, entries, notify: plan.conflicts.length > 0 };
      for (const key of Object.keys(live)) delete live[key];
      Object.assign(live, plan.next);
      return { changed: true, entries };
    },
    () => {
      conflictList = merged;
    },
  );
  return ok ? plan : false;
}

/** 옛 판 창이 옛 저장소에 썼다(storage 이벤트) — 그 변경을 흡수한다. */
export async function absorbLegacyScenes(legacy: ScenesByProject): Promise<SceneAbsorbPlan | null> {
  if (!ready) return null;
  const plan = await absorbInTx(shapedBuckets(legacy));
  return plan === false ? null : plan;
}

/**
 * 옛 저장소에서 읽은 묶음을 저장소가 다룰 수 있는 모양으로 — 배열이 아닌 버킷, id 없는 항목, 같은 id 의 둘째
 * 이후는 뺀다. 씬별 키는 (버킷, id)로 자리를 정하므로 이 셋은 담을 수 없다(흡수 판정도 같은 기준으로 본다 —
 * sceneAbsorb 의 indexOf). 옛 저장소는 지우지 않으므로 빠진 것이 사라지지는 않는다.
 * ★넘겨받은 씬 객체는 저장소가 그대로 가진다(복제하지 않는다) — 호출부는 넘긴 뒤 고치지 않는다.
 */
function shapedBuckets(raw: ScenesByProject | null): ScenesByProject | null {
  if (!raw || typeof raw !== "object") return null;
  const out: ScenesByProject = {};
  for (const [bucket, list] of Object.entries(raw)) {
    if (!Array.isArray(list) || bucket in Object.prototype) continue;
    const seen = new Set<string>();
    out[bucket] = list.filter((scene) => {
      if (!scene || typeof scene !== "object" || typeof scene.id !== "string" || seen.has(scene.id)) return false;
      seen.add(scene.id);
      return true;
    });
  }
  return out;
}

// ── 충돌 정리·전체 추출/가져오기 ───────────────────────────────────────────────────
/**
 * 한 버킷의 충돌을 정리한다 — 옛 창 쪽 내용(theirs)을 **새 씬으로 살려 두고** 충돌 목록에서 뺀다.
 * 내 쪽 씬은 건드리지 않는다(충돌 당시의 mine 은 스냅샷일 뿐, 지금 씬을 그것으로 되돌리지 않는다).
 * 사본 추가와 충돌 제거를 **한 트랜잭션**에서 하고, 그 안에서 충돌을 다시 읽는다 — 두 창이 같은
 * 사본을 중복으로 만들거나, 그사이 새로 생긴 충돌을 지우지 않게.
 * @param place 버킷의 씬 목록에 옛 창 쪽 내용을 놓은 **새 목록**을 준다(보통은 사본을 뒤에 더한다. 같은 씬의
 *              손대지 않은 사본이 이미 있으면 그 자리를 갈아 끼울 수 있다). 트랜잭션 안에서 한 번만 불린다.
 * @returns copied = 새로 더한 사본 수, refreshed = 있던 사본을 최신으로 갈아 끼운 수,
 *          keptMine = 옛 창이 지웠던(내 것만 남은) 충돌 수. 실패면 null.
 */
export async function settleConflictsAsCopies(
  bucketKey: string,
  place: (scenes: Scene[], theirs: Scene) => Scene[],
): Promise<{ copied: number; refreshed: number; keptMine: number } | null> {
  let copied = 0;
  let refreshed = 0;
  let keptMine = 0;
  let remaining: SceneAbsorbConflict[] = [];
  const ok = await runStoreTx(
    [K_CONFLICTS],
    (live, current) => {
      const all = (current[K_CONFLICTS] as SceneAbsorbConflict[] | undefined) ?? [];
      const mine = all.filter((c) => c.bucket === bucketKey);
      remaining = all.filter((c) => c.bucket !== bucketKey); // 다른 계정 버킷의 충돌은 그 계정이 정리한다
      if (!mine.length) return { changed: false, entries: [] };
      let list = live[bucketKey] || [];
      for (const conflict of mine) {
        if (!conflict.theirs) {
          keptMine += 1;
          continue;
        }
        const next = place(list, conflict.theirs);
        if (next.length > list.length) copied += 1;
        else refreshed += 1;
        list = next;
      }
      const changed = copied + refreshed > 0;
      if (changed) live[bucketKey] = list;
      return { changed, entries: [[K_CONFLICTS, remaining]], notify: true };
    },
    () => {
      conflictList = remaining;
    },
  );
  return ok ? { copied, refreshed, keptMine } : null;
}

export interface SceneStoreDump {
  buckets: ScenesByProject;
  conflicts: SceneAbsorbConflict[];
}

/**
 * 저장소 내용 전체를 **한 시점**으로 읽는다 — 전체 내보내기용. 버킷 키·씬 id·빈 버킷 그대로.
 * ★아직 확정 안 된 내 편집도 싣는다. 저장소가 막혀서 내보내는 것이라면 그 편집이야말로 건져야 할 것이다.
 *  저장소를 읽지도 못하면 화면 값을 그대로 준다 — 내보내기는 저장소 사정으로 실패하지 않는다.
 */
export function dumpSceneStore(): Promise<SceneStoreDump> {
  return enqueueTx(async () => {
    try {
      if (!(await ensureDb())) throw new Error("scene store not open");
      const { meta, scenes } = await readStore([K_CONFLICTS], () => true);
      const buckets: ScenesByProject = { ...scenes };
      for (const op of pending) {
        try {
          op.mutate(buckets);
        } catch {
          // 재생할 수 없는 연산 — 확정 때 버려지고 그 작업에 알린다. 내보내기에서는 건너뛴다.
        }
      }
      return {
        buckets,
        conflicts: (meta[K_CONFLICTS] as SceneAbsorbConflict[] | undefined) ?? [],
      };
    } catch {
      return { buckets: cloneStored(working), conflicts: cloneStored(conflictList) };
    }
  });
}

/** 한 버킷을 합친 결과. next 가 local 과 같은 배열이면 '바뀐 것 없음'이다. */
export interface SceneBucketMerge {
  next: Scene[];
  added: number;
  recovered: number;
}

/**
 * 전체 내보내기 파일을 저장소에 **합친다**(덮지 않는다). 버킷 키는 그대로 두고(빈 버킷도 만든다),
 * 버킷마다 무엇을 더할지는 mergeBucket 이 정한다(sceneArchive — 없는 씬은 더하고, 같은 id 인데 내용이
 * 다르면 사본으로 따로 둔다).
 * @param mergeBucket (지금 목록, 파일의 목록) → 합친 목록. 트랜잭션 안에서 버킷마다 한 번만 불린다.
 * @returns 더한 씬 수 / 복구 사본 수. 실패면 null.
 */
export async function mergeSceneStoreDump(
  dump: SceneStoreDump,
  mergeBucket: (local: Scene[], incoming: Scene[]) => SceneBucketMerge,
): Promise<{ added: number; recovered: number } | null> {
  let added = 0;
  let recovered = 0;
  let mergedConflicts: SceneAbsorbConflict[] = [];
  const ok = await runStoreTx(
    [K_CONFLICTS],
    (live, current) => {
      let changed = false;
      for (const [bucket, scenes] of Object.entries(dump.buckets)) {
        const local = live[bucket] || [];
        const out = mergeBucket(local, scenes || []);
        added += out.added;
        recovered += out.recovered;
        if (out.next !== local || !(bucket in live)) {
          live[bucket] = out.next;
          changed = true;
        }
      }
      const kept = (current[K_CONFLICTS] as SceneAbsorbConflict[] | undefined) ?? [];
      mergedConflicts = mergeConflicts(dump.conflicts || [], kept); // 지금 저장소의 충돌이 이긴다
      return { changed, entries: [[K_CONFLICTS, mergedConflicts]], notify: true };
    },
    () => {
      conflictList = mergedConflicts;
    },
  );
  return ok ? { added, recovered } : null;
}

// ── 창 사이 통지 ────────────────────────────────────────────────────────────
// localStorage 는 다른 창에 `storage` 이벤트를 보내 줬지만 **IndexedDB 는 아무 신호도 안 보낸다**.
// 확정된 뒤 알리고, 받은 창은 저장소에서 다시 읽어 confirmed 를 맞추고 working 을 다시 계산한다.
const CHANNEL_NAME = "mvhub-scenes";
let channel: BroadcastChannel | null = null;
const externalSubs = new Set<() => void>();

/** 이 창이 한 편집이 아닌 이유로 씬이 바뀌었다(다른 창의 저장·옛 창 흡수·충돌 정리) — 목록을 다시 읽어야 한다. */
export function subscribeSceneStoreExternal(fn: () => void): () => void {
  externalSubs.add(fn);
  openChannel();
  return () => externalSubs.delete(fn);
}

function openChannel(): void {
  if (channel || typeof BroadcastChannel === "undefined") return;
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = () => {
    void refreshFromStore();
  };
}

function announceWrite(): void {
  openChannel();
  channel?.postMessage("saved");
}

/** 다른 창이 썼다 — 저장소를 다시 읽는다. 내 pending 이 있으면 그 김에 같이 확정한다. */
function refreshFromStore(): Promise<boolean> {
  if (pending.length) {
    let conflicts: SceneAbsorbConflict[] = conflictList;
    let conflictsChanged = false;
    return runStoreTx(
      [K_CONFLICTS],
      (_live, current) => {
        conflicts = (current[K_CONFLICTS] as SceneAbsorbConflict[] | undefined) ?? [];
        conflictsChanged = conflicts.length !== conflictList.length;
        return { changed: false, entries: [], notify: conflictsChanged };
      },
      () => {
        conflictList = conflicts;
      },
    );
  }
  return enqueueTx(async () => {
    if (!ready || !(await ensureDb())) return false;
    // 버전이 그대로면 씬은 읽지 않는다(충돌 목록만 본다).
    let read: Awaited<ReturnType<typeof readStore>>;
    try {
      read = await readStore(
        [K_VERSION, K_CONFLICTS],
        (found) => ((found[K_VERSION] as number | undefined) ?? 0) !== confirmedVersion,
      );
    } catch {
      return false; // 못 읽었다 — 지금 값을 그대로 둔다(다음 통지·다음 저장이 따라잡는다)
    }
    const { meta, scenes } = read;
    const conflicts = (meta[K_CONFLICTS] as SceneAbsorbConflict[] | undefined) ?? [];
    const conflictsChanged = conflicts.length !== conflictList.length;
    conflictList = conflicts;
    if (!scenes) {
      if (conflictsChanged) externalSubs.forEach((fn) => fn());
      return true;
    }
    confirmed = scenes;
    confirmedVersion = (meta[K_VERSION] as number | undefined) ?? 0;
    rebaseWorking();
    externalSubs.forEach((fn) => fn());
    return true;
  });
}

/** 지금 접수돼 있는 연산을 바로 확정하러 보낸다(창이 가려질 때 등). 확정을 기다리지는 않는다. */
export function flushSceneStoreNow(): void {
  if (pending.length) void runStoreTx();
}

// ── 시험 전용 ────────────────────────────────────────────────────────────────
// 저장 실패(용량 초과·접근 차단)와 느린 저장소를 만들어 낸다. 제품 경로에는 영향이 없다.
let failWritesForTest = false;
let abortWritesForTest = false;
let delayWritesForTest = 0;
let lastWriteForTest: { puts: string[]; deletes: string[] } = { puts: [], deletes: [] };
export function failSceneStoreWritesForTest(on: boolean): void {
  failWritesForTest = on;
}
/** 쓰기 요청을 낸 **뒤에** 트랜잭션을 중단시킨다 — 씬·순서·버전이 반쯤 남지 않는지(원자성) 본다. */
export function abortSceneStoreWritesForTest(on: boolean): void {
  abortWritesForTest = on;
}
export function delaySceneStoreWritesForTest(ms: number): void {
  delayWritesForTest = ms;
}
/** 마지막 저장이 **무엇을 썼나**(씬별 키). 편집 한 번이 그 씬만 쓰는지 본다. */
export function lastSceneStoreWriteForTest(): { scenes: string[]; orders: string[]; deleted: string[] } {
  const kindOf = (key: string) => (JSON.parse(key) as string[])[0];
  const label = (key: string) => (JSON.parse(key) as string[]).slice(1).join("/");
  return {
    scenes: lastWriteForTest.puts.filter((key) => kindOf(key) === "s").map(label),
    orders: lastWriteForTest.puts.filter((key) => kindOf(key) === "o").map(label),
    deleted: lastWriteForTest.deletes.map(label),
  };
}
/** 시험 전용 — 옛 배치(씬 전체가 한 키)로 저장된 상태를 만든다. 메모리 대체 저장소에서만. */
export function seedLegacyLayoutForTest(scenes: ScenesByProject, meta: Record<string, unknown> = {}): void {
  memory = new Map<string, unknown>([[K_LEGACY_SCENES, cloneStored(scenes)], [K_VERSION, 1], ...Object.entries(meta)]);
}
/** 시험 전용 — 저장소에 실제로 든 키(메모리 대체). */
export function sceneStoreKeysForTest(): string[] {
  return [...(memory?.keys() ?? [])];
}

/**
 * 시험 전용 — **다른 창이 쓴 것처럼** 저장소 내용을 바꾼다(이 창의 화면 값·확정본은 모른 채로 둔다).
 * 메모리 대체 저장소에서만 동작한다. 실제 두 창의 동작은 frontend/measure 의 브라우저 실측이 본다.
 */
export function writeSceneStoreAsOtherWindowForTest(mutate: (all: ScenesByProject) => void): void {
  if (!memory) throw new Error("memory scene store only");
  const before = assembleScenes(sceneEntries(memory));
  const after: ScenesByProject = { ...before };
  mutate(after);
  const write = diffScenes(before, after);
  for (const [key, value] of write.puts) memory.set(key, cloneStored(value));
  for (const key of write.deletes) memory.delete(key);
  memory.set(K_VERSION, ((memory.get(K_VERSION) as number | undefined) ?? 0) + 1);
}

/** 시험·실측용 — 저장소 전체를 갈아 끼우고 **확정을 기다린다**. */
export async function writeScenesStore(next: ScenesByProject): Promise<boolean> {
  const snapshot = structuredClone(next);
  const { value, confirmed: done } = captureSceneOps(() =>
    applySceneOp<null>((all) => {
      for (const key of Object.keys(all)) delete all[key];
      Object.assign(all, snapshot);
      return { write: true, value: null };
    }),
  );
  return value.ok && (await done);
}

/** 접수된 연산이 모두 확정될 때까지 기다린다(시험용). 실패 중이면 false. */
export async function settleSceneStoreForTest(): Promise<boolean> {
  if (pending.length) await runStoreTx();
  await txQueue;
  return pending.length === 0;
}

/** 시험 전용 — 모듈 상태를 비운다. */
export function resetSceneStoreForTest(): void {
  channel?.close();
  channel = null;
  externalSubs.clear();
  db?.close();
  db = null;
  memory = null;
  ready = false;
  confirmed = {};
  confirmedVersion = 0;
  working = {};
  pending = [];
  conflictList = [];
  captureStack = [];
  captureFailed = [];
  flushScheduled = false;
  if (retryTimer !== undefined) clearTimeout(retryTimer);
  retryTimer = undefined;
  retryDelayMs = RETRY_MIN_MS;
  txQueue = Promise.resolve();
  failWritesForTest = false;
  abortWritesForTest = false;
  delayWritesForTest = 0;
  lastWriteForTest = { puts: [], deletes: [] };
}
