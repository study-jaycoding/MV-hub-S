// 공유&리뷰(team) 탭 '새로 들어옴' — **항목 단위 확인(ack)** 모델.
//  · 기준선(base): 이 계정이 기능을 처음 쓴 시각 — 그 전에 공유된 과거분은 새것 취급 안 함
//    (도입 첫날 전체가 글로우로 뒤덮이는 것 방지). 이후로는 움직이지 않는다(아래 프루닝 제외).
//  · base 이후 공유된 항목은 **내가 그 카드를 클릭(확인)할 때까지** 새것 — 탭을 오가거나
//    앱을 껐다 켜도 유지된다. 확인한 항목만 하나씩 꺼진다(사용자 확정 동작).
//  · 확인 기록(seen)·기준선은 계정별 localStorage(ch.lib.teamSeen). 60일 지난 항목은 기준선을
//    올리며 정리해 무한 성장을 막는다(두 달 묵은 미확인 항목은 조용히 만료 — 허용된 트레이드오프).
//  · 시각 형식은 서버 share.shared_at 과 같은 UTC "YYYY-MM-DD HH:MM:SS" — 사전순 비교=시간 비교,
//    서버 folder-counts?since= 에도 그대로 쓴다.
import { loadJSON, loadString, saveJSON } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";

interface SeenEntry {
  at: string; // 그 항목의 shared_at — 프루닝 기준
}
interface AccountSeen {
  base: string; // 기준선 — 이 시각 이전 공유분은 새것 아님
  seen: Record<string, SeenEntry>; // 확인(클릭)한 항목 — genId → 정보
}

const PRUNE_DAYS = 60;

const ns = () => {
  const acct = loadString(STORAGE_KEYS.activeAccount);
  return acct ? `acct:${acct}` : "local";
};

export function utcNowSql(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function cutoffSql(): string {
  return new Date(Date.now() - PRUNE_DAYS * 86400_000).toISOString().slice(0, 19).replace("T", " ");
}

// ── 저장/캐시 ── localStorage 왕복을 렌더마다 하지 않게 메모리 캐시(쓰기 시 동기 갱신).
let cacheNs: string | null = null;
let cache: AccountSeen | null = null;

function load(): AccountSeen {
  const n = ns();
  if (cache && cacheNs === n) return cache;
  const map = loadJSON<Record<string, unknown>>(STORAGE_KEYS.teamSeen) || {};
  const raw = map[n];
  let acc: AccountSeen;
  if (typeof raw === "string") acc = { base: raw, seen: {} }; // 구(방문시각) 형식 이관
  else if (raw && typeof raw === "object") acc = raw as AccountSeen;
  else acc = { base: "", seen: {} };
  if (!acc.seen) acc.seen = {};
  // 프루닝 — 60일 이전은 기준선을 올리고, 그보다 오래된 확인 기록은 버린다(어차피 새것 아님).
  const cut = cutoffSql();
  if (acc.base && acc.base < cut) {
    acc.base = cut;
    for (const id in acc.seen) if (acc.seen[id].at <= cut) delete acc.seen[id];
    // 저장까지 해야 실제로 줄어든다(코덱스 P3 — 메모리만 정리하면 localStorage 는 계속 자람).
    // persist() 아님: load() 는 렌더 중에도 불리므로 bump(리렌더 신호)는 내지 않는다.
    map[n] = acc;
    saveJSON(STORAGE_KEYS.teamSeen, map);
  }
  cacheNs = n;
  cache = acc;
  return acc;
}

function persist(acc: AccountSeen): void {
  const map = loadJSON<Record<string, unknown>>(STORAGE_KEYS.teamSeen) || {};
  map[ns()] = acc;
  saveJSON(STORAGE_KEYS.teamSeen, map);
  cache = acc;
  cacheNs = ns();
  bump();
}

// ── 구독(리렌더 신호) ── 카드 클릭으로 확인되면 글로우·사이드바 +N 이 즉시 반영되게.
let version = 0;
const subs = new Set<() => void>();
function bump(): void {
  version++;
  subs.forEach((f) => f());
}
export const subscribeTeamSeen = (fn: () => void): (() => void) => {
  subs.add(fn);
  return () => subs.delete(fn);
};
export const getTeamSeenVersion = (): number => version;

// 기준선 보장 — 팀 탭 최초 진입 시 App 이 호출. 이미 있으면 그대로.
export function ensureTeamBase(): void {
  const acc = load();
  if (acc.base) return;
  persist({ ...acc, base: utcNowSql() });
}

export function getTeamBase(): string | null {
  return load().base || null;
}

// 이 항목이 '새로 들어옴'인가 — 기준선 이후 공유 + 아직 확인(클릭) 안 함.
// ★확인은 '그 공유 시점(shared_at)에 대한 확인' — 공유해제 후 재공유되면 shared_at 이 새로워져
//   다시 새것이 된다(과거에 확인했더라도). 같은 초 재공유는 구별 불가(초 단위 strict > — 허용 오차).
export function isFreshGen(g: {
  id: string;
  shared_at?: string | null;
}): boolean {
  const acc = load();
  if (!acc.base || !g.shared_at || g.shared_at <= acc.base) return false;
  const seen = acc.seen[g.id];
  return !seen || g.shared_at > seen.at;
}

// 카드 클릭 = 확인 — 글로우 해제 + 사이드바 +N 에서 제외. 새것 아닌 카드는 no-op.
export function ackTeamFresh(g: { id: string; shared_at?: string | null }): void {
  if (!isFreshGen(g)) return;
  const acc = load();
  persist({ ...acc, seen: { ...acc.seen, [g.id]: { at: g.shared_at as string } } });
}

// '그 공유 시점'을 이미 확인했나 — 사이드바 +N 이 서버 신규 목록에서 확인분을 제외할 때 쓴다.
// >= 인 이유: ack 은 확인한 카드의 shared_at 을 저장하므로 같은 시점이면 확인된 것(코덱스 검증).
// 재공유로 서버 shared_at 이 더 새로우면(저장값 < sharedAt) 미확인 → 다시 +N.
export function isAckedFor(id: string, sharedAt: string | null | undefined): boolean {
  const seen = load().seen[id];
  if (!seen) return false;
  // 시점 미상(shared_at 을 안 주는 구버전 서버 응답) — id 확인만으로 인정.
  // 아니면 확인해도 +N 이 영원히 안 줄어드는 잠김이 된다(재공유 정밀 판정만 포기).
  if (!sharedAt) return true;
  return seen.at >= sharedAt;
}
