// 생성물 변경을 창 간(같은 브라우저의 다른 창)으로 즉시 알린다 — 관리탭(별도 창)이 바로 재조회.
// 팀원(다른 PC) 변경은 이 채널로 안 오므로, 받는 쪽은 폴링을 함께 둔다(즉시=내 조작, 지연=팀).
import { BROADCAST_CHANNELS } from "./appEvents";

const NAME = BROADCAST_CHANNELS.generations;

// 송신 채널은 페이지 수명 동안 하나만 유지(재사용). 매번 만들고 바로 close 하면
// 메시지가 전달되기 전에 닫혀 유실될 수 있어서다. 미지원 환경은 null(폴링이 백업).
let sender: BroadcastChannel | null | undefined;
function getSender(): BroadcastChannel | null {
  if (sender !== undefined) return sender;
  try {
    sender = new BroadcastChannel(NAME);
  } catch {
    sender = null;
  }
  return sender;
}

// 담기/폴더이동·최종(★)·공유·삭제 등 작업탭에 영향 주는 변경 직후 호출.
export function postLibraryChanged(): void {
  try {
    getSender()?.postMessage("changed");
  } catch {
    // 무시(폴링이 백업).
  }
}

// 관리탭이 구독 — 메시지 오면 cb 실행. 해제 함수 반환.
export function onLibraryChanged(cb: () => void): () => void {
  let ch: BroadcastChannel | null = null;
  try {
    ch = new BroadcastChannel(NAME);
    ch.onmessage = () => cb();
  } catch {
    ch = null;
  }
  return () => {
    try {
      ch?.close();
    } catch {
      /* noop */
    }
  };
}
