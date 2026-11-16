/** MCP 앱 탭 표시(`X-MVHub-Tab`) — 서버가 탭 소유 확인에 쓰는 값이라 32~128자 영문·숫자·`-`·`_` 이고 예측하기 어려워야 한다
 *  (`backend/app/routers/mcp.py` `_secret`). `crypto.randomUUID` 는 보안 환경(HTTPS·localhost) 전용이라 공유 서버의 LAN HTTP 주소엔
 *  없지만 `getRandomValues` 는 있다(Codex 리뷰 01a1e38d — 대체값이 20자라 403 으로 거절되던 것). */
export function mcpTabId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) return Array.from(c.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  // shortcut: crypto 가 아예 없는 아주 옛 브라우저 — 길이·형식만 맞춘 예측 가능한 값, 그런 브라우저가 실제로 나오면 막는 쪽으로 바꾼다
  let out = "";
  for (let i = 0; i < 32; i += 1) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}
