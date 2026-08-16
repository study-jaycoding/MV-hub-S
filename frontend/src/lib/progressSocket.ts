import { APP_EVENTS, dispatchAppEvent } from "./appEvents";
import { setAuthToken } from "./http";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const RECONNECT_JITTER_RATIO = 0.2;

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

  const connect = () => {
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      backoff = RECONNECT_BASE_MS;
      // 최초 연결은 App의 초기 reload와 겹치므로 보정 조회가 필요 없다. 실제로 한 번 연결된 뒤
      // 끊겼거나 최초 연결 시도부터 실패했다가 복구된 경우에만 그 사이 놓친 상태를 따라잡는다.
      if (needsCatchUp) onReconnect?.();
      needsCatchUp = false;
    };
    ws.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data));
      } catch {
        /* ignore */
      }
    };
    ws.onclose = (ev) => {
      if (ping) clearInterval(ping);
      if (closed) return;
      if (ev.code === 1008) {
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
