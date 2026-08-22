import { APP_EVENTS, dispatchAppEvent } from "./appEvents";
import { setAuthToken } from "./http";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const RECONNECT_JITTER_RATIO = 0.2;
// 유지보수 거부(1013)는 서버가 accept 한 뒤 바로 닫으므로 매번 onopen 이 뜬다 — '열렸다'는
// 사실만으로 백오프를 되돌리면 유지보수 내내 1초 간격 재접속이 된다. 그래서 백오프 리셋은
// '연결이 실제로 얼마간 유지된 뒤 끊겼을 때'로 제한한다. 기준 5초 = 거부(수 ms)와는 확실히
// 구분되고, 앱 하트비트 주기(25초)보다는 짧아 짧게 쓰인 정상 연결도 종전처럼 즉시 복구한다.
const STABLE_CONNECTION_MS = 5000;

export function isStableConnection(connectedForMs: number | null): boolean {
  return connectedForMs !== null && connectedForMs >= STABLE_CONNECTION_MS;
}

export function progressReconnectDelayMs(
  baseMs: number,
  random: () => number = Math.random,
): number {
  // 여러 작업자 PC가 서버 재시작 뒤 같은 순간에 몰리지 않게 ±20%로 분산한다.
  const unit = Math.max(0, Math.min(1, random()));
  const factor = 1 - RECONNECT_JITTER_RATIO + unit * RECONNECT_JITTER_RATIO * 2;
  return Math.min(RECONNECT_MAX_MS, Math.max(1, Math.round(baseMs * factor)));
}

// WebSocket 진행률 구독. 끊기면 자동 재연결(백오프)하고,
// 재연결될 때마다 onReconnect 로 알려 놓친 상태 전이를 reload 로 따라잡게 한다.
export function connectProgress(
  onMessage: (m: import("../types").ProgressMessage) => void,
  onReconnect?: () => void,
): () => void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let ws: WebSocket | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let backoff = RECONNECT_BASE_MS;
  let closed = false;
  let needsCatchUp = false;
  let openedAt: number | null = null;

  const connect = () => {
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      openedAt = Date.now();
      // 최초 연결은 App의 초기 reload와 겹치므로 보정 조회가 필요 없다. 실제로 한 번 연결된 뒤
      // 끊겼거나 최초 연결 시도부터 실패했다가 복구된 경우에만 그 사이 놓친 상태를 따라잡는다.
      if (needsCatchUp) onReconnect?.();
      needsCatchUp = false;
    };
    ws.onmessage = (ev) => {
      try {
        const message = JSON.parse(ev.data) as import("../types").ProgressMessage;
        // 서버가 계정 범위로 보낸 운영 안내도 기존 전역 토스트 채널을 재사용한다.
        // 데이터 갱신 소비자에도 그대로 넘겨 기존 progress/synced 계약은 바꾸지 않는다.
        if (
          message.type === "flash" &&
          typeof message.message === "string" &&
          message.message.trim()
        ) {
          dispatchAppEvent(APP_EVENTS.flash, message.message);
        }
        onMessage(message);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = (ev) => {
      if (ping) clearInterval(ping);
      if (closed) return;
      if (ev.code === 1008) {
        if (ev.reason === "auth-off-local-only") {
          // AUTH off 서버에 원격 접속한 정책 거부(백엔드 _WS_REASON_AUTH_OFF_LOCAL_ONLY).
          // 인증 실패가 아니므로 토큰을 지우거나 로그인 화면으로 보내면 오히려 오도한다 —
          // HTTP 403과 같은 문구로 안내만 하고 재연결을 멈춘다(재시도해도 같은 거부).
          dispatchAppEvent(
            APP_EVENTS.flash,
            "AUTH off 모드는 로컬에서만 접근할 수 있어 실시간 연결을 사용할 수 없습니다.",
          );
          return;
        }
        // 세션 만료/무효는 재시도해도 거부된다. 조용히 멈추지 않고 기존 HTTP 401과 같은
        // 인증 이벤트를 보내 로그인 화면과 사용자 안내가 즉시 나타나게 한다.
        setAuthToken(null);
        dispatchAppEvent(
          APP_EVENTS.flash,
          "로그인 인증이 만료되어 실시간 연결이 중지되었습니다. 다시 로그인해 주세요.",
        );
        dispatchAppEvent(APP_EVENTS.authRequired);
        return;
      }
      needsCatchUp = true;
      // 안정적으로 붙어 있다가 끊긴 연결만 백오프를 처음으로 되돌린다. accept 직후 닫히는
      // 일시 거부(1013 유지보수)는 여기서 리셋되지 않아 재접속 간격이 정상적으로 늘어난다.
      const connectedForMs = openedAt === null ? null : Date.now() - openedAt;
      openedAt = null;
      if (isStableConnection(connectedForMs)) backoff = RECONNECT_BASE_MS;
      const retryDelay = progressReconnectDelayMs(backoff);
      backoff = Math.min(backoff * 1.6, RECONNECT_MAX_MS);
      retry = setTimeout(connect, retryDelay);
    };
    ping = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, 25000);
  };
  connect();

  return () => {
    closed = true;
    if (ping) clearInterval(ping);
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}
