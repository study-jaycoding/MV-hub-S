// 씬 저장소 — IndexedDB. localStorage(출처당 약 5MB 고정)를 대신한다.
//
// 왜: 씬은 전부 localStorage 에 있었고, 큰 씬 9개면 5MB 가 찼다. 차면 저장이 실패하는데 화면은
// 조용히 저장본으로 되돌아가, 쓰는 사람에겐 "연결이 안 되는 버그"로 보였다(2026-10-07 신고).
// IndexedDB 는 같은 프로필 폴더 안이지만 한도가 디스크 여유 기준이라 그 벽이 없다.
//
// 설계(Codex 적대적 검토 r1~r6 합의):
//  · **읽기는 동기** — 부팅 때 한 번 읽어 캐시에 두고, 화면/상태 초기화는 종전처럼 동기로 읽는다.
//    (읽기 호출부 43곳을 비동기로 바꾸지 않는다.) **쓰기만** 비동기다 — 저장 완료가 곧 계약이라
//    트랜잭션이 끝난 뒤에만 성공을 보고한다.
//  · **옛 저장소(localStorage)는 지우지 않는다.** 앱 업데이트가 옛 창을 닫아 주지 않으므로
//    (브라우저 창은 일부러 업데이트 대상 밖에서 돈다), 지우면 살아남은 옛 창이 깨진다. 대신
//    옛 저장소에 남는 변경을 흡수한다(sceneAbsorb).
//  · **이관 세대 표식을 양쪽에 둔다.** IDB 안에만 두면 IDB 가 통째로 날아갔을 때 표식도 함께
//    사라져, 낡은 옛 저장소를 '처음 이관'으로 착각해 최신인 양 되살린다.
import { planAbsorption, type SceneAbsorbConflict, type SceneAbsorbPlan } from "./sceneAbsorb";
import type { ScenesByProject } from "./scenes";

const DB_NAME = "mvhub-scenes";
const DB_VERSION = 1;
const STORE = "kv";
const K_SCENES = "scenes"; // 씬 묶음 전체(버킷 맵)
const K_BASE = "absorbBase"; // 마지막으로 처리한 옛 저장소 내용(흡수 판정의 B)
const K_GENERATION = "generation"; // 이관 세대 — 옛 저장소의 같은 키와 짝을 이룬다
const K_CONFLICTS = "conflicts"; // 해결 전까지 남겨 두는 흡수 충돌
/** 옛 저장소에 두는 바깥 표식. IDB 가 사라져도 남아, '처음 이관'과 'IDB 소실'을 구분한다. */
export const LEGACY_GENERATION_KEY = "ch.scenes.migration";

/** 옛 저장소의 이관 표식. pending=시작했지만 아직 확정 안 됨, committed=끝남. 둘을 구분하지 않으면
 *  "첫 이관이 끊긴 것"과 "이관 뒤 IDB 가 사라진 것"을 섞어, 빈 상태를 성공으로 열어 버린다. */
export interface LegacyMark {
  state: "pending" | "committed";
  generation: string;
}

let db: IDBDatabase | null = null;
// IndexedDB 가 아예 없는 런타임(브라우저가 아닌 곳 — 시험의 jsdom)용 대체 저장. ★브라우저에서는
// 시크릿 창·사이트 데이터 차단이어도 indexedDB 자체는 존재하고 open 이 실패하므로, 이 경로로
// 빠지지 않는다(그때는 'failed' 로 오류 화면). 즉 제품에서 조용히 메모리에 저장하는 일은 없다.
let memory: Map<string, unknown> | null = null;
let cache: ScenesByProject = {};
let ready = false;
let conflictList: SceneAbsorbConflict[] = [];
// 마지막으로 처리한 옛 저장소 내용(흡수 판정의 B). 큐 안에서 IDB 를 또 읽지 않도록 들고 있는다.
let baseSnapshot: ScenesByProject | null = null;

/** 부팅 게이트가 끝났는가. false 면 캐시는 믿을 수 없다(빈 데이터로 오해하면 안 된다). */
export const sceneStoreReady = (): boolean => ready;
/** 자동으로 정하지 못해 사람이 골라야 하는 흡수 충돌. */
export const sceneStoreConflicts = (): SceneAbsorbConflict[] => conflictList;

// ── IndexedDB 얇은 어댑터 ────────────────────────────────────────────────────
// 이 파일에서 IDB 를 직접 만지는 곳은 아래 셋뿐이다. 판정 로직은 sceneAbsorb(순수)에 있다.
function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("scene store blocked"));
  });
}

/**
 * **한 readwrite 트랜잭션 안에서** 읽고, 계산하고, 쓴다.
 *
 * ★읽기와 쓰기를 따로 열면 그 사이에 다른 창이 끼어들어 서로를 덮는다 — 큐는 이 창 안의 순서만
 *  지킬 뿐이다(Codex 재현). IndexedDB 는 한 트랜잭션 안에서 get→put 을 허용하므로, 다른 창의
 *  같은 작업은 이 트랜잭션이 끝날 때까지 기다린다.
 * ★`decide` 는 **동기**여야 한다. IDB 트랜잭션은 보류 중인 요청이 없는 채로 마이크로태스크를
 *  넘기면 저절로 닫힌다 — 안에서 IDB 가 아닌 Promise 를 기다리면 트랜잭션이 죽는다.
 *
 * @param readKeyName 계산에 쓸 값을 읽을 키(필요 없으면 null)
 * @param decide 읽은 값으로 '쓸 항목들'을 정한다. 빈 배열이면 아무것도 쓰지 않는다.
 */
type StoreValues = Record<string, unknown>;

function readThenWrite(
  readKeys: string[],
  decide: (current: StoreValues) => Array<[string, unknown]>,
): Promise<void> {
  if (failWritesForTest) return Promise.reject(new Error("scene store write blocked (test)"));
  if (memory) {
    const active = memory;
    const current: StoreValues = {};
    for (const key of readKeys) current[key] = active.get(key);
    for (const [key, value] of decide(current)) active.set(key, value);
    return Promise.resolve();
  }
  if (!db) return Promise.reject(new Error("scene store not ready"));
  const active = db;
  return new Promise((resolve, reject) => {
    const tx = active.transaction(STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("scene store aborted"));
    const store = tx.objectStore(STORE);
    const current: StoreValues = {};
    let pending = readKeys.length;
    const apply = () => {
      try {
        for (const [key, value] of decide(current)) store.put(value, key);
      } catch (error) {
        tx.abort();
        reject(error);
      }
    };
    if (!pending) return apply();
    for (const key of readKeys) {
      const got = store.get(key) as IDBRequest<unknown>;
      got.onsuccess = () => {
        current[key] = got.result;
        // 같은 트랜잭션 안에서 전부 읽은 뒤 계산하고 쓴다 — 사이에 다른 창이 못 들어온다.
        if (--pending === 0) apply();
      };
      got.onerror = () => reject(got.error);
    }
  });
}

async function readKey<T>(key: string): Promise<T | undefined> {
  if (memory) return memory.get(key) as T | undefined;
  if (!db) return undefined;
  const tx = db.transaction(STORE, "readonly");
  return request<T | undefined>(tx.objectStore(STORE).get(key) as IDBRequest<T | undefined>);
}

// ── 부팅 ────────────────────────────────────────────────────────────────────
export type SceneStoreInit =
  | { kind: "ready"; migrated: boolean; absorbed: SceneAbsorbPlan | null }
  /** IDB 를 쓸 수 없다 — 화면은 오류·재시도에 머물러야 한다. 빈 데이터로 진행하면 안 된다. */
  | { kind: "failed"; error: string };

/**
 * 저장소를 연다. 처음이면 옛 저장소에서 1회 이관하고, 그 뒤에는 옛 저장소에 남은 변경을 흡수한다.
 *
 * @param readLegacy 옛 저장소(localStorage)의 씬 묶음. 못 읽으면 null.
 * @param legacyGeneration 옛 저장소에 적힌 이관 세대(없으면 null).
 * @param writeLegacyGeneration 옛 저장소에 세대를 적는다(바깥 표식).
 */
export async function initSceneStore(
  readLegacy: () => ScenesByProject | null,
  legacyMark: LegacyMark | null,
  writeLegacyMark: (mark: LegacyMark) => boolean,
): Promise<SceneStoreInit> {
  try {
    if (typeof indexedDB === "undefined") memory = memory ?? new Map();
    else db = await openDb();
    const stored = await readKey<ScenesByProject>(K_SCENES);
    const legacy = readLegacy();

    // ① IDB 에 씬이 없다 — 세 가지 경우를 구분해야 한다(섞으면 자료를 잃거나 되살린다).
    if (stored === undefined) {
      // (a) 바깥 표식이 'committed' = 이관을 끝냈는데 IDB 가 사라졌다(사이트 데이터 삭제 등).
      //     옛 저장소를 '최신'으로 되살리면 이관 뒤의 작업이 통째로 옛 상태로 돌아간다.
      //     되살리지 않고 **빈 상태로 열어** DB 백업 복구에 맡긴다(옛 저장소는 남아 있다).
      if (legacyMark?.state === "committed") {
        // ★트랜잭션 안에서 다시 보고 쓴다 — 그 사이 다른 창이 이미 복구했으면 덮지 않는다.
        let took = false;
        await readThenWrite([K_SCENES], (current) => {
          if (current[K_SCENES] !== undefined) return [];
          took = true;
          return [
            [K_SCENES, {}],
            [K_BASE, legacy ?? {}],
            [K_GENERATION, legacyMark.generation],
            [K_CONFLICTS, []],
          ];
        });
        cache = took ? {} : ((await readKey<ScenesByProject>(K_SCENES)) ?? {});
        baseSnapshot = legacy ?? {};
        conflictList = (await readKey<SceneAbsorbConflict[]>(K_CONFLICTS)) ?? [];
        ready = true;
        return { kind: "ready", migrated: false, absorbed: null };
      }
      // (b) 표식이 'pending' = 첫 이관이 중간에 끊겼다. 옛 저장소가 아직 정답이므로 **다시 이관**한다.
      // (c) 표식이 없다 = 처음 이관.
      const next = legacy ?? {};
      const generation = legacyMark?.generation ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      // ★표식을 먼저, 그리고 **성공을 확인하고** 남긴다. 조용히 실패하면 다음 실행이 (c)로 보고
      //  다시 이관하는데, 그 사이의 작업이 옛 내용으로 덮인다.
      if (!writeLegacyMark({ state: "pending", generation })) {
        ready = false;
        return { kind: "failed", error: "이관 표식을 남기지 못했습니다(저장소 접근 차단)" };
      }
      // ★트랜잭션 안에서 다시 보고 쓴다 — 그 사이 다른 창이 먼저 이관했으면 그 결과를 덮지 않는다.
      let migratedHere = false;
      await readThenWrite([K_SCENES], (current) => {
        if (current[K_SCENES] !== undefined) return [];
        migratedHere = true;
        return [
          [K_SCENES, next],
          [K_BASE, next],
          [K_GENERATION, generation],
          [K_CONFLICTS, []],
        ];
      });
      if (!migratedHere) {
        // 다른 창이 먼저 끝냈다 — 그 결과를 읽어 연다.
        cache = (await readKey<ScenesByProject>(K_SCENES)) ?? {};
        baseSnapshot = (await readKey<ScenesByProject>(K_BASE)) ?? null;
        conflictList = (await readKey<SceneAbsorbConflict[]>(K_CONFLICTS)) ?? [];
        // ★여기서도 표식 실패를 삼키지 않는다 — 'pending' 이 남으면 나중에 IDB 가 사라졌을 때
        //  낡은 옛 저장소를 다시 이관해 그동안의 작업을 덮는다(Codex 재현).
        if (!writeLegacyMark({ state: "committed", generation })) {
          ready = false;
          return { kind: "failed", error: "이관 표식을 확정하지 못했습니다(저장소 접근 차단)" };
        }
        ready = true;
        return { kind: "ready", migrated: false, absorbed: null };
      }
      // ★확정 표식도 실패를 삼키지 않는다. 'pending' 이 남은 채로 쓰다가 IDB 가 사라지면,
      //  다음 실행이 (b)로 보고 **낡은 옛 저장소를 다시 이관**해 그동안의 작업을 덮는다(Codex).
      if (!writeLegacyMark({ state: "committed", generation })) {
        ready = false;
        return { kind: "failed", error: "이관 표식을 확정하지 못했습니다(저장소 접근 차단)" };
      }
      cache = next;
      baseSnapshot = next;
      conflictList = [];
      ready = true;
      return { kind: "ready", migrated: true, absorbed: null };
    }

    // ② 이미 이관됨 — 옛 저장소에 남은 변경을 흡수한다(이벤트를 놓쳤어도 여기서 따라잡는다).
    cache = stored;
    // 표식이 'pending' 인 채로 저장소에 씬이 있다 = 확정 기록만 실패했다. 지금 고쳐 둔다 —
    // 안 고치면 나중에 IDB 가 사라졌을 때 '첫 이관'으로 보고 낡은 옛 저장소를 되살린다(Codex).
    if (legacyMark?.state !== "committed") {
      const generation = legacyMark?.generation ?? ((await readKey<string>(K_GENERATION)) ?? "");
      // ★복구 실패를 삼키지 않는다. 표식이 끝내 안 남으면 나중에 IDB 가 사라졌을 때 '첫 이관'으로
      //  보고 낡은 옛 저장소를 최신인 양 되살린다 — 그 위험을 안고 열지 않는다(Codex 재현).
      if (!writeLegacyMark({ state: "committed", generation })) {
        ready = false;
        return { kind: "failed", error: "이관 표식을 고치지 못했습니다(저장소 접근 차단)" };
      }
    }
    // ★부팅 흡수도 **한 트랜잭션**에서 읽고 판정하고 쓴다 — 밖에서 읽은 `stored` 로 계산해 쓰면
    //  그 사이 다른 창이 저장한 것을 덮는다(Codex). 아래 판정은 전부 동기라 트랜잭션이 살아 있다.
    ready = true; // mutateScenesStore 의 관문을 지나기 위해 먼저 연다(실패하면 아래에서 되돌린다)
    let planAtBoot: SceneAbsorbPlan | null = null;
    let mergedAtBoot: SceneAbsorbConflict[] = [];
    let baseAtBoot: ScenesByProject | null = null;
    const booted = await mutateScenesStore<null>(
      (live, current) => {
        baseAtBoot = (current[K_BASE] as ScenesByProject | undefined) ?? null;
        const kept = (current[K_CONFLICTS] as SceneAbsorbConflict[] | undefined) ?? [];
        planAtBoot = legacy ? planAbsorption(baseAtBoot, live, legacy) : null;
        mergedAtBoot = mergeConflicts(kept, planAtBoot?.conflicts ?? []);
        if (!legacy) return { write: false, value: null };
        const extra: Array<[string, unknown]> = [
          [K_BASE, legacy],
          [K_CONFLICTS, mergedAtBoot],
        ];
        if (!planAtBoot?.changed) return { write: false, value: null, extra };
        for (const bucketKey of Object.keys(live)) delete live[bucketKey];
        Object.assign(live, planAtBoot.next);
        return { write: true, value: null, extra };
      },
      undefined,
      [K_BASE, K_CONFLICTS],
    );
    if (!booted.ok) {
      ready = false;
      return { kind: "failed", error: "저장소를 열었지만 첫 정리에 실패했습니다" };
    }
    baseSnapshot = legacy ?? baseAtBoot;
    conflictList = mergedAtBoot;
    return { kind: "ready", migrated: false, absorbed: planAtBoot };
  } catch (error) {
    ready = false;
    return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

// 충돌은 **해결될 때까지 남아야** 한다. 기준(B)은 흡수 뒤 최신으로 올라가므로, 다음에 열면 L=B 가 되어
// 같은 충돌이 다시 잡히지 않는다 — 저장해 두지 않으면 조용히 사라진다(Codex 코드 리뷰에서 재현).
function mergeConflicts(
  kept: SceneAbsorbConflict[],
  found: SceneAbsorbConflict[],
): SceneAbsorbConflict[] {
  const byKey = new Map(kept.map((c) => [`${c.bucket}\u0000${c.sceneId}`, c]));
  for (const c of found) byKey.set(`${c.bucket}\u0000${c.sceneId}`, c); // 새 것이 이긴다
  return [...byKey.values()];
}

// ── 읽기·쓰기 ───────────────────────────────────────────────────────────────
// 캐시는 **확정된 내용**만 담는다. 호출부가 받은 객체를 고쳐도 캐시가 움직이지 않도록 복사해서 준다
// (종전 saveScenes 는 loadAll 이 돌려준 객체를 그대로 고쳐 썼다 — 실패한 쓰기가 캐시에 남는다).
// 브라우저가 아닌 런타임(시험의 jsdom)에서는 부팅 게이트를 거치지 않고도 읽고 쓸 수 있게 메모리로
// 연다. ★브라우저에서는 indexedDB 가 늘 존재하므로 이 경로로 빠지지 않는다 — 제품에서 부팅 전 저장이
// 조용히 성공한 것처럼 보이는 일은 없다.
function ensureMemoryStoreOutsideBrowser(): void {
  if (ready || typeof indexedDB !== "undefined") return;
  memory = memory ?? new Map();
  ready = true;
}

export function readScenesCache(): ScenesByProject {
  ensureMemoryStoreOutsideBrowser();
  return structuredClone(cache);
}

// 내용을 바꾸지 않고 **자리만 옮기는** 정규화(옛 계정 키 → 현재 계정 키)를 캐시에 먼저 반영한다.
// ★이것만 예외로 두는 이유: 저장은 이제 기다리는 일인데, 그 사이에 다른 계정으로 바뀌면 아직 남아 있는
//  옛 키를 그 계정이 다시 가져간다(계정 재귀속). 자리만 바뀌는 변환이라 저장이 실패해도 잃는 내용이
//  없으므로, 캐시에는 즉시 반영하고 영속화는 뒤따르게 한다.
export function normalizeSceneCache(next: ScenesByProject): void {
  if (!ready) return;
  cache = structuredClone(next);
}

/** 씬 묶음 전체를 쓴다. 반환 = 트랜잭션이 끝났는가. 성공했을 때만 캐시를 바꾼다. */
export async function writeScenesStore(next: ScenesByProject): Promise<boolean> {
  return (await mutateScenesStore(() => ({ write: true, value: undefined }), next)).ok;
}

// ★읽기·변경·쓰기를 한 줄로 세운다. 저장이 비동기가 되면서, 같은 캐시를 읽은 두 변경이 각각 저장소
//  **전체**를 덮어 앞선 변경이 사라졌다(이름을 바꾸고 바로 카메라를 움직이면 이름이 되돌아감 — Codex
//  코드 리뷰에서 재현). 쓰기만 줄 세우면 소용없다: 변경을 계산할 때 읽은 값이 이미 낡았기 때문이다.
//  그래서 **확정된 최신 캐시를 임계 구역 안에서 읽어** 변경을 계산한다.
let writeQueue: Promise<unknown> = Promise.resolve();

export interface SceneMutation<T> {
  /** false 면 저장하지 않는다 — 바꿀 것이 없을 때 빈 버킷을 만들거나 헛쓰기를 하지 않기 위해서. */
  write: boolean;
  value: T;
  /** 같은 트랜잭션에 함께 쓸 것(흡수의 기준·충돌). 따로 쓰면 중간 상태가 남는다. */
  extra?: Array<[string, unknown]>;
}

export function mutateScenesStore<T>(
  mutate: (all: ScenesByProject, current: StoreValues) => SceneMutation<T>,
  replaceWith?: ScenesByProject,
  extraReads: string[] = [],
): Promise<{ ok: boolean; wrote: boolean; value: T }> {
  const run = writeQueue.then(async () => {
    ensureMemoryStoreOutsideBrowser();
    if (!ready || (!db && !memory)) {
      return { ok: false, wrote: false, value: mutate(structuredClone(cache), {}).value };
    }
    // ★읽기·계산·쓰기를 **한 트랜잭션**에서 한다. 캐시는 창마다 따로고, 읽기와 쓰기를 따로 열면
    //  그 사이에 다른 창이 끼어든다 — 둘 다 막아야 서로 덮지 않는다(Codex 재현).
    let draft: ScenesByProject = {};
    // 쓰지 않더라도 **트랜잭션에서 읽은 최신 값**은 캐시에 반영한다 — 안 그러면 다른 창이 그사이
    // 저장한 내용을 못 보고 낡은 목록으로 남는다(Codex).
    let liveSeen: ScenesByProject | null = null;
    // 상자에 담는다 — 콜백 안에서 대입한 값을 TypeScript 가 'never' 로 좁히지 않게.
    const box: Array<SceneMutation<T>> = [];
    let seen: StoreValues = {};
    try {
      await readThenWrite(replaceWith ? extraReads : [K_SCENES, ...extraReads], (current) => {
        seen = current;
        liveSeen = (current[K_SCENES] as ScenesByProject | undefined) ?? null;
        draft = structuredClone(replaceWith ?? liveSeen ?? cache);
        const result = mutate(draft, seen);
        box.push(result);
        if (!result.write) return result.extra ?? [];
        return [[K_SCENES, draft] as [string, unknown], ...(result.extra ?? [])];
      });
    } catch {
      // 트랜잭션을 못 열었으면 변경 계산도 안 돌았다 — 호출부는 '무엇을 하려 했는지'(found 등)를
      // 보고 실패 종류를 가리므로, 쓰지 않고 계산만 해서 값을 돌려준다.
      const value = (box[0] ?? mutate(structuredClone(cache), seen)).value;
      return { ok: false, wrote: false, value };
    }
    const done = box[0];
    if (!done) return { ok: false, wrote: false, value: mutate(structuredClone(cache), seen).value };
    if (!done.write) {
      if (liveSeen) cache = liveSeen;
      return { ok: true, wrote: false, value: done.value };
    }
    cache = draft;
    announceWrite(); // 다른 창도 저장소를 다시 읽게 — IDB 는 스스로 알리지 않는다
    return { ok: true, wrote: true, value: done.value };
  });
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** storage 이벤트(옛 창이 썼다)를 받았을 때의 흡수. 반환 = 실제로 바뀌었나. */
export async function absorbLegacyScenes(legacy: ScenesByProject): Promise<SceneAbsorbPlan | null> {
  if (!ready || (!db && !memory)) return null;
  // ★흡수도 저장 큐를 지난다. 밖에서 캐시를 읽어 전체를 저장하면, 그 사이에 들어온 일반 편집을
  //  덮는다(서로 다른 씬을 고쳐도 — Codex 재현). 큐 안에서 저장소를 읽어 계산한다.
  // 충돌은 **해결될 때까지 남아야** 한다 — 기준(B)이 최신으로 올라가면 다음에 열 때 L=B 라 같은
  // 충돌이 다시 잡히지 않는다. 그래서 데이터·기준·충돌을 **한 트랜잭션**으로 확정한다
  // (Codex 리뷰 + 브라우저 실측에서 재현).
  let merged: SceneAbsorbConflict[] = conflictList;
  // ★기준(B)과 충돌도 **트랜잭션 안에서 읽는다**. 창마다 들고 있는 사본으로 판정하면, 다른 창이
  //  이미 확정한 기준을 못 보고 오판하거나 그 창이 보존한 충돌을 지운다(Codex).
  const out = await mutateScenesStore<SceneAbsorbPlan>(
    (live, current) => {
      const base = (current[K_BASE] as ScenesByProject | undefined) ?? baseSnapshot;
      const kept = (current[K_CONFLICTS] as SceneAbsorbConflict[] | undefined) ?? conflictList;
      const computed = planAbsorption(base, live, legacy);
      merged = mergeConflicts(kept, computed.conflicts);
      const extra: Array<[string, unknown]> = [
        [K_BASE, legacy],
        [K_CONFLICTS, merged],
      ];
      if (!computed.changed) return { write: false, value: computed, extra };
      for (const bucketKey of Object.keys(live)) delete live[bucketKey];
      Object.assign(live, computed.next);
      return { write: true, value: computed, extra };
    },
    undefined,
    [K_BASE, K_CONFLICTS],
  );
  if (!out.ok) return null;
  baseSnapshot = legacy;
  conflictList = merged;
  // ★흡수는 **이 창에서** 일어났으므로 BroadcastChannel 로는 자기에게 안 돌아온다. 화면이 흡수
  //  결과를 보려면 여기서 직접 알려야 한다. 충돌만 바뀐 경우(write:false)에도 다른 창이 그 충돌을
  //  읽도록 방송한다(Codex).
  externalSubs.forEach((fn) => fn());
  announceWrite();
  return out.value;
}

// 시험 전용 — 저장 실패(용량 초과·접근 차단)를 만들어 낸다. 제품 경로에는 영향이 없다.
let failWritesForTest = false;
export function failSceneStoreWritesForTest(on: boolean): void {
  failWritesForTest = on;
}

// ── 창 사이 통지 ────────────────────────────────────────────────────────────
// localStorage 는 다른 창에 `storage` 이벤트를 보내 줬지만 **IndexedDB 는 아무 신호도 안 보낸다**.
// 그래서 다른 창이 저장해도 이 창의 목록·'다른 창이 고쳤다' 안내가 갱신되지 않는다(Codex).
// 저장이 확정된 뒤 알리고, 받은 창은 저장소에서 다시 읽어 캐시를 맞춘 뒤 화면에 알린다.
const CHANNEL_NAME = "mvhub-scenes";
let channel: BroadcastChannel | null = null;
const externalSubs = new Set<() => void>();

/** 다른 창이 씬을 저장했다 — 목록을 다시 읽어야 한다. */
export function subscribeSceneStoreExternal(fn: () => void): () => void {
  externalSubs.add(fn);
  openChannel();
  return () => externalSubs.delete(fn);
}

function openChannel(): void {
  if (channel || typeof BroadcastChannel === "undefined") return;
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = () => {
    void (async () => {
      const latest = await readKey<ScenesByProject>(K_SCENES);
      if (latest === undefined) return;
      cache = latest;
      conflictList = (await readKey<SceneAbsorbConflict[]>(K_CONFLICTS)) ?? conflictList;
      externalSubs.forEach((fn) => fn());
    })();
  };
}

function announceWrite(): void {
  openChannel();
  channel?.postMessage("saved");
}

/** 시험 전용 — 모듈 상태를 비운다. */
export function resetSceneStoreForTest(): void {
  channel?.close();
  channel = null;
  externalSubs.clear();
  db?.close();
  db = null;
  memory = null;
  baseSnapshot = null;
  failWritesForTest = false;
  cache = {};
  ready = false;
  conflictList = [];
}
