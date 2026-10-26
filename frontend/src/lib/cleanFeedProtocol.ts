// 클린 피드 전용 창(로컬 허브 방식 — Jay 2026-10-23 'd')의 앱 ↔ 허브 ↔ 피드 글과 순수 규칙. React·fetch 를 쓰지 않는다.
//  계약 = docs/status/편집탭_클린피드_전용창_구현_2026-10-23.md('구현에서 정한 것' 4·5·8·9) · 허브 = backend/app/services/clean_feed_session.py.

// ── 표본(시계) ────────────────────────────────────────────────────────────────────────────────────
// at = 만든 때(ms, performance.timeOrigin + performance.now() — 같은 PC 라 두 창의 시계가 같다) · moving = 그 프레임에 t 가 움직였나 ·
//  limit = 반복 끝·타임라인 끝(외삽이 넘지 않음) · sync = 앱이 받은 마지막 resync 번호
export interface FeedSample {
  rev: number;
  t: number;
  at: number;
  playing: boolean;
  moving: boolean;
  rate: number;
  limit: number;
  sync: number;
}

// 재생 표본이 이만큼 끊겨도 피드는 그 사이를 외삽해 혼자 이어 간다 — 앱 주 스레드가 잠깐 바빠도(편집 탭 다시 그리기) 앱의 영상은 그대로
//  돈다(2026-10-26 실측: 0.1초에 멈추던 때는 0.15초 끊김마다 멈칫·되감김). 넘으면 외삽한 그 자리에 선다(되감지 않는다).
export const HOLD_MS = 500;
export const SAMPLE_GAP_MS = 16; // 앱은 재생 중 rAF 마다 — 앞 표본에서 16ms 안이면 건너뛰고
export const SAMPLES_PER_SECOND = 60; // 지난 1초에 60개를 보냈으면 건너뛴다(16ms 간격만으로는 62개까지 간다)
export const BUFFER_LIMIT = 64 * 1024; // 앱의 WS 송신 버퍼가 이보다 크면 보내지 않고 최신 하나만 든다
export const BUFFER_STUCK_MS = 2000; // 그 상태가 이만큼 이어지면 다시 붙는다
export const OPEN_TIMEOUT_MS = 10_000; // 앱의 open 요청 시한
export const STATUS_RETRY_MS = 500; // 끊긴 뒤 status 를 다시 묻는 간격
export const STATUS_GIVE_UP_MS = 10_000;

export const nowMs = () => performance.timeOrigin + performance.now();

// 표본 비교 — (sync, rev, at) 이 큰 것이 최신. 낮은 번호·옛 표본이 늦게 와도 최신을 덮지 않는다.
export function newerSample(a: FeedSample | null, b: FeedSample): boolean {
  if (!a) return true;
  if (b.sync !== a.sync) return b.sync > a.sync;
  if (b.rev !== a.rev) return b.rev > a.rev;
  return b.at > a.at;
}

// 피드의 재동기 상태 — 숨김이면 재동기 안 됨, 보임 이후에는 visible 번호 이상의 표본이 오면 재동기됨(도착 순서에 기대지 않음).
export interface FeedSyncState {
  visibleSync: number;
  hidden: boolean;
  best: FeedSample | null;
}

export const synced = (state: FeedSyncState) => !state.hidden && !!state.best && state.best.sync >= state.visibleSync;

// 그 순간 피드가 보여 줄 시각과 재생 여부(추종기에 그대로) — 재생 = playing && moving && 재동기됨(moving=false·멈춤 표본은 즉시 멈춤)이고
//  표본이 HOLD_MS 안. 재생 표본은 at 기준으로 외삽한다(HOLD_MS 까지 · limit·0 안) — 넘으면 그 자리에 선다.
//  장면과 rev 가 다른 표본: 새 rev(장면이 아직 안 옴)는 들고 있고 그 전 시각(held)을 그대로 · 옛 rev 는 그 시각에 멈춘 채.
export function feedClock(state: FeedSyncState, now: number, sceneRev: number, held: number): { time: number; playing: boolean; rate: number } {
  const best = state.best;
  if (!best || best.rev > sceneRev) return { time: held, playing: false, rate: 1 };
  if (!(best.rev === sceneRev && best.playing && best.moving && synced(state))) return { time: best.t, playing: false, rate: best.rate || 1 };
  const age = Math.max(0, now - best.at);
  const time = Math.max(0, Math.min(best.limit, best.t + (Math.min(age, HOLD_MS) / 1000) * best.rate));
  return { time, playing: age <= HOLD_MS, rate: best.rate };
}

// ── 키 ──────────────────────────────────────────────────────────────────────────────────────────
export interface FeedKey {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat: boolean;
}

export const feedKey = (event: KeyboardEvent): FeedKey => ({
  key: event.key, code: event.code, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey,
  repeat: event.repeat,
});

// 피드 창의 키 — 'forward' 앱으로 넘기고 막음 · 'block' 넘기지 않고 막음(Esc·F11) · 'os' 넘기지도 막지도 않음(Alt+F4·Alt+Tab·Win 조합 — OS 몫)
export function feedKeyRoute(event: Pick<KeyboardEvent, "key" | "code" | "altKey" | "metaKey">): "forward" | "block" | "os" {
  if (event.metaKey || event.key === "Meta" || event.key === "OS") return "os";
  if (event.altKey && (event.key === "F4" || event.code === "F4" || event.key === "Tab" || event.code === "Tab")) return "os";
  if (event.key === "Escape" || event.key === "F11" || event.code === "F11") return "block";
  return "forward";
}

// ── 탭 id·순번(허브가 같은 탭의 옛 open 을 거절한다) — 페이지마다 하나, 훅이 다시 마운트돼도 같은 탭 안에서 늘기만 ─────────────────
let seq = 0;
const randomId = () => {
  const bytes = new Uint8Array(12);
  globalThis.crypto?.getRandomValues?.(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("") || `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
};
export const FEED_CLIENT = randomId();
export const nextOpenSeq = () => ++seq;

// ── 허브 글 ─────────────────────────────────────────────────────────────────────────────────────
export type HubToMain =
  | { t: "resync"; sync: number }
  | { t: "key" } & FeedKey
  | { t: "closed"; reason: string }
  | { t: "taken"; reason: string }
  | { t: "focus-lost" }
  | { t: "error"; reason: string; detail?: string };

export function parseHubMessage(raw: unknown): { t: string; [name: string]: unknown } | null {
  if (typeof raw !== "string" || raw.length > 600_000) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && typeof value.t === "string" ? value : null;
  } catch {
    return null;
  }
}

export function asSample(value: Record<string, unknown>): FeedSample | null {
  const num = (name: string) => (typeof value[name] === "number" && Number.isFinite(value[name]) ? (value[name] as number) : null);
  const [t, at, rate, limit] = [num("time"), num("at"), num("rate"), num("limit")]; // 글의 't' 는 종류('clock') — 시각은 'time'
  const rev = value.rev;
  const sync = value.sync ?? 0;
  if (t === null || at === null || rate === null || limit === null || !Number.isInteger(rev) || !Number.isInteger(sync)) return null;
  return { rev: rev as number, t, at, playing: value.playing === true, moving: value.moving === true, rate, limit, sync: sync as number };
}

const socketBase = () => `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws/clean-feed`;

export const feedSocketUrl = (session: string, key: string, role: "main" | "feed") =>
  `${socketBase()}?${new URLSearchParams({ session, key, role })}`;

// ── 대기 창(끈 세션의 창을 허브가 숨겨 두었다가 다음 open 에 다시 쓴다 — 계약 docs/status/편집탭_클린피드_허브켜기단축_2026-10-26.md B) ──
// 토큰은 끝난 세션의 피드 연결에만 closed/taken 의 standby 로 온다 · 대기 WS 는 주소에 토큰을 두지 않고(uvicorn 이 INFO 로 경로+쿼리를 남긴다)
//  하위 프로토콜 `mvhub-standby.<토큰>` 하나로 붙는다(허브 clean_feed_session.STANDBY_PROTOCOL).
export const STANDBY_PROTOCOL = "mvhub-standby.";
export const isStandbyToken = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{16,128}$/.test(value);
export const standbySocketUrl = () => `${socketBase()}?${new URLSearchParams({ role: "standby", session: "standby" })}`;
