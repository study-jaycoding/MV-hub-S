// 캔버스 '방금 생성됨' glow 를 SceneBoard 생명주기와 분리한 모듈 레벨 store(genId 기준).
//  · SceneBoard 는 탭 전환 시 언마운트되므로, 그 안에서만 전환(pending·running→done)을 관찰하면 왕복 시
//    baseline·glow 가 유실된다. 이 store 는 App 레벨 watcher(탭 무관 폴링) + SceneBoard 관찰이 함께 써서
//    '방금 완료'를 언마운트에도 유지한다.
//  · 규칙: '처음 본 done'은 baseline 만 두고 glow 안 함(새로고침·과거 결과 제외). active(pending/running…)를
//    한 번이라도 본 genId 가 done 이 되면 recentlyDone 에 넣어 glow. 종결(settled) 이후엔 늦게 온 응답을 전부
//    무시 → ack(클릭 해제) 후 genData 재조회로 done 이 다시 들어와도 glow 가 재발화하지 않는다.
//  · 새로고침하면 이 module 이 비므로 과거 done 은 자연히 제외. TTL/cap 으로 장기 누적 방지.

const ACTIVE = new Set(["pending", "running", "queued", "processing"]);
const RECENT_TTL_MS = 24 * 60 * 60 * 1000; // 방금 완료 glow 유지 최대 24h(내 작업 탭에 오래 있다 와도 남게)
const MAX_WATCH_MS = 30 * 60 * 1000; // pending 이 영원히 안 끝나도 30분이면 폴링 포기(무한폴 방지)
const MAX_SEEN = 2000; // activeSeen·settled 상한(긴 세션 누적 방지)

const activeSeen = new Set<string>(); // active 를 한 번이라도 본 genId(전환 baseline)
const settled = new Set<string>(); // 종결(done/실패/삭제) 을 본 genId — 이후 관찰 전부 무시
const watch = new Map<string, number>(); // 미확정 genId → watch 시작 시각(App watcher 폴링 대상 + stuck 상한)
const recent = new Map<string, number>(); // genId → done 시각(glow 중, ack 전까지)

let version = 0;
const listeners = new Set<() => void>();
function notify(): void {
  version += 1;
  for (const l of listeners) l();
}

// 오래된 항목 제거(호출 시점 정리). recent=TTL, settled/activeSeen=상한초과분(watch/recent 중이 아닌 것부터).
function pruneRecent(): void {
  const cut = Date.now() - RECENT_TTL_MS;
  for (const [id, ts] of recent) if (ts < cut) recent.delete(id);
}
function capSet(set: Set<string>): void {
  if (set.size <= MAX_SEEN) return;
  let excess = set.size - MAX_SEEN;
  for (const id of set) {
    if (excess <= 0) break;
    if (!watch.has(id) && !recent.has(id)) {
      set.delete(id);
      excess -= 1;
    }
  }
}

// 생성 직후 placeholder id 를 미리 등록 — '첫 폴링이 이미 done' 이어도 glow 하도록 baseline 확보.
export function seedPending(ids: string[]): void {
  let changed = false;
  for (const id of ids) {
    if (!id || recent.has(id) || settled.has(id)) continue;
    if (!activeSeen.has(id)) {
      activeSeen.add(id);
      changed = true;
    }
    if (!watch.has(id)) {
      watch.set(id, Date.now());
      changed = true;
    }
  }
  capSet(activeSeen);
  if (changed) notify();
}

// 관찰된 상태 반영 — 전환 규칙 적용. (App watcher 폴링 + SceneBoard genData 관찰이 공동으로 호출)
export function observeStatus(genId: string, status: string | null | undefined): void {
  if (!genId || !status) return;
  if (recent.has(genId) || settled.has(genId)) return; // 이미 glow 중이거나 종결됨 → 늦게 온 응답 무시(재발화 방지)
  const s = String(status);
  if (ACTIVE.has(s)) {
    let changed = false;
    if (!activeSeen.has(genId)) {
      activeSeen.add(genId);
      changed = true;
    }
    if (!watch.has(genId)) {
      watch.set(genId, Date.now());
      changed = true;
    }
    if (changed) {
      capSet(activeSeen);
      notify();
    }
  } else if (s === "done") {
    watch.delete(genId);
    settled.add(genId);
    capSet(settled);
    if (activeSeen.has(genId)) recent.set(genId, Date.now()); // active 를 본 적 있어야 glow(전환)
    pruneRecent();
    notify();
  } else {
    // 실패/nsfw/삭제 등 종결 — glow 없이 종결 처리.
    watch.delete(genId);
    settled.add(genId);
    capSet(settled);
    notify();
  }
}

// glow 확인(클릭) — 해당 genId 들을 recentlyDone 에서 제거. settled 는 유지해 재발화 막음.
export function ackDone(ids: string[]): void {
  let changed = false;
  for (const id of ids) if (recent.delete(id)) changed = true;
  if (changed) notify();
}

// App watcher 가 폴링할 대상. 30분 넘게 안 끝난 stuck 은 종결 처리하고 뺀다(무한폴 방지).
export function getWatchIds(): string[] {
  const cut = Date.now() - MAX_WATCH_MS;
  let stuck = false;
  for (const [id, ts] of watch) {
    if (ts < cut) {
      watch.delete(id);
      settled.add(id);
      stuck = true;
    }
  }
  if (stuck) {
    capSet(settled);
    notify();
  }
  return [...watch.keys()];
}

// watcher discovery 용 — 이미 store 가 아는 genId 인지(중복 폴 방지).
export function isKnownGen(genId: string): boolean {
  return activeSeen.has(genId) || settled.has(genId) || watch.has(genId);
}

export function isRecentlyDone(genId: string): boolean {
  const ts = recent.get(genId);
  if (ts === undefined) return false;
  if (Date.now() - ts > RECENT_TTL_MS) {
    recent.delete(genId); // lazy 만료(읽기 시점). 리렌더 불필요 — 다음 notify 때 반영.
    return false;
  }
  return true;
}

export function subscribeRecentDone(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// useSyncExternalStore 용 — 값이 바뀔 때만 identity 가 변하는 primitive(버전).
export function getRecentDoneVersion(): number {
  return version;
}
