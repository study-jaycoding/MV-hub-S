// 생성물 변경을 창 간(같은 브라우저의 다른 창)으로 즉시 알린다 — 관리탭(별도 창)이 바로 재조회.
// 팀원(다른 PC) 변경은 이 채널로 안 오므로, 받는 쪽은 폴링을 함께 둔다(즉시=내 조작, 지연=팀).
import { APP_EVENTS, BROADCAST_CHANNELS, dispatchAppEvent } from "./appEvents";

const NAME = BROADCAST_CHANNELS.generations;

// 이 탭(문서) 고유 id — 같은 문서의 '다른' BroadcastChannel 인스턴스도 내 메시지를 수신하므로,
// 수신측에서 '내 탭 발' 메시지를 무시해 same-window 이중 발화(BC + CustomEvent)를 없앤다.
// (교차창은 서로 TAB_ID 가 달라 그대로 전달됨.)
const TAB_ID =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

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
    getSender()?.postMessage({ tab: TAB_ID }); // 창 간(관리탭 등) — 발신 탭 표식 포함
  } catch {
    // 무시(폴링이 백업).
  }
  // 같은 창 알림 — BroadcastChannel 자기창 전달이 불안정한 환경에서도 사이드바 등이 확실히 반응.
  dispatchAppEvent(APP_EVENTS.libraryChanged);
}

// 관리탭이 구독 — 메시지 오면 cb 실행. 해제 함수 반환.
export function onLibraryChanged(cb: () => void): () => void {
  let ch: BroadcastChannel | null = null;
  try {
    ch = new BroadcastChannel(NAME);
    ch.onmessage = (ev) => {
      // 내 탭이 보낸 메시지는 무시 — same-window 는 CustomEvent 로만 반응, 여기선 교차창만 처리.
      if ((ev.data as { tab?: string } | null)?.tab === TAB_ID) return;
      cb();
    };
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
