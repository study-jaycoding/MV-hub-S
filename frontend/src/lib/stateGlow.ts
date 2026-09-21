// '방금 상태가 바뀐 카드'의 빛 — 공유·보류·최종으로 **내가 바꾼** 카드는 그 상태색으로 빛나고, 그 카드를 한 번 선택하면 꺼진다(Jay 2026-09-21).
//  · 바꾸는 길이 여럿이고(카드 S 메뉴·선택 막대 단계·일괄 공유) 부분 성공이 섞여서, 쓰기 지점은 성공 여부를 따지지 않고 바꾸기 직전에
//    armStateGlow(대상 id들) 로 **후보**만 알린다. 뒤이은 목록 재조회에서 그 후보 중 **상태가 실제로 달라진 카드**만 observe 가 기록한다.
//    후보가 아닌 카드의 변화(남이 바꾼 것이 자동 새로고침으로 들어온 경우)와 실패한 요청은 빛나지 않는다(Codex 리뷰 P2).
//    후보를 모르는 길(폴더 통째 공유)은 빛을 생략한다 — 틀린 표시보다 낫다.
//  · '이전 상태' 비교는 탭별로 따로 한다 — 작업 공간의 로컬 행과 공유&리뷰의 서버 행은 미러가 늦는 동안 잠깐 다른 상태일 수 있어,
//    한 장부로 비교하면 탭만 바꿔도 '바뀜'으로 읽히거나 기록이 지워진다(Codex 리뷰 P2). 저장·확인 키는 아래 앵커 하나를 같이 쓴다.
//  · 키는 teamSeen 과 같은 앵커(job_id 우선) — 작업 공간(로컬 id)과 공유&리뷰(서버 id)의 같은 생성물이 한 기록을 쓴다.
//  · 계정별 localStorage(새로고침해도 선택 전까지 유지). 14일 지난 기록은 읽을 때 버린다.
import { getAccountNamespace } from "./accountScope";
import { reviewState, type ReviewAction } from "./generationReview";
import { loadJSON, saveJSON } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";
import type { Generation } from "../types";

type GlowState = Exclude<ReviewAction, "unshared">;
type Marks = Record<string, { state: GlowState; at: number }>;
type Anchored = Pick<Generation, "id" | "job_id" | "is_final" | "is_held" | "shared">;

const ARM_MS = 20_000;
const KEEP_MS = 14 * 86_400_000;
const keyOf = (g: Pick<Generation, "id" | "job_id">): string => g.job_id || g.id;

const armed = new Map<string, number>(); // 후보 생성물 id → 만료 시각
const lastState = new Map<string, ReviewAction>(); // `탭:앵커` → 이 세션에서 마지막으로 본 상태. 처음 보는 카드는 비교 대상이 없어 빛나지 않는다
let cacheNs: string | null = null;
let cache: Marks | null = null;
let version = 0;
const subs = new Set<() => void>();

function load(): Marks {
  const ns = getAccountNamespace();
  if (cache && cacheNs === ns) return cache;
  const all = loadJSON<Record<string, Marks>>(STORAGE_KEYS.stateGlow) || {};
  const now = Date.now();
  cache = Object.fromEntries(Object.entries(all[ns] || {}).filter(([, mark]) => now - mark.at < KEEP_MS));
  cacheNs = ns;
  return cache;
}

function persist(marks: Marks): void {
  const all = loadJSON<Record<string, Marks>>(STORAGE_KEYS.stateGlow) || {};
  all[getAccountNamespace()] = marks;
  saveJSON(STORAGE_KEYS.stateGlow, all);
  cache = marks;
  cacheNs = getAccountNamespace();
  version++;
  subs.forEach((fn) => fn());
}

export const subscribeStateGlow = (fn: () => void): (() => void) => { subs.add(fn); return () => subs.delete(fn); };
export const getStateGlowVersion = (): number => version;

/** 상태를 바꾸는 동작 직전에 그 대상의 id 로 부른다 — 뒤이은 재조회에서 이 후보 중 상태가 달라진 카드만 빛난다. */
export function armStateGlow(ids: string[]): void {
  const now = Date.now();
  for (const [id, until] of armed) if (until <= now) armed.delete(id);
  for (const id of ids) armed.set(id, now + ARM_MS);
}

/** 목록이 바뀔 때마다 부른다(scope = 탭). 후보 중 상태가 달라진 카드를 기록하고, 일반으로 돌아간 카드의 기록은 지운다. */
export function observeReviewStates(generations: Anchored[], scope = ""): void {
  const now = Date.now();
  let next: Marks | null = null;
  for (const generation of generations) {
    const key = keyOf(generation);
    const state = reviewState(generation as Generation);
    const before = lastState.get(scope + ":" + key);
    lastState.set(scope + ":" + key, state);
    if (before === undefined || before === state) continue;
    const marks: Marks = next ?? load();
    if (state !== "unshared" && (armed.get(generation.id) ?? 0) > now) next = { ...marks, [key]: { state, at: now } };
    else if (marks[key] && marks[key].state !== state) { next = { ...marks }; delete next[key]; } // 기록과 같은 상태로 '따라온' 다른 탭의 행은 기록을 지우지 않는다
  }
  if (next) persist(next);
}

/** 이 카드가 지금 빛나야 하나 — 기록된 상태가 지금 상태와 같을 때만(그 뒤 또 바뀌었으면 옛 기록은 무효). */
export function stateGlowOf(generation: Anchored): GlowState | null {
  const mark = load()[keyOf(generation)];
  return mark && mark.state === reviewState(generation as Generation) ? mark.state : null;
}

/** 선택 = 확인. 빛나던 카드만 기록을 지운다(한 번에 저장 — 범위 선택으로 수십 장이 들어와도 렌더 1회). */
export function ackStateGlow(generations: Pick<Generation, "id" | "job_id">[]): void {
  const marks = load();
  const keys = generations.map(keyOf).filter((key) => marks[key]);
  if (!keys.length) return;
  const next = { ...marks };
  for (const key of keys) delete next[key];
  persist(next);
}

/** 시험 전용 — 모듈 상태 초기화. */
export function resetStateGlowForTest(): void { armed.clear(); lastState.clear(); cache = null; cacheNs = null; }
