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
  let backoff = 1000;
  let closed = false;

  const connect = () => {
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      backoff = 1000;
      onReconnect?.();
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
        // 세션 만료/무효는 재시도해도 거부되므로 무한 재연결을 멈춘다.
        return;
      }
      backoff = Math.min(backoff * 1.6, 15000);
      retry = setTimeout(connect, backoff);
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
