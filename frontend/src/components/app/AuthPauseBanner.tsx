// 다른 탭에서 로그아웃했는데 이 창에 저장하지 못한 것이 있다(Jay 결정 4B) — 화면은 남기고 서버 요청은 멈춘 채 알린다.
//  옮겨 적은 뒤 단추를 누르면 공유 서버 방식의 메인 창은 로그인 화면으로, 그 밖(로컬 허브·분리 창)은 새로 고침으로 간다.
import { useSyncExternalStore } from "react";
import { getApiPause, subscribeApiPause } from "../../lib/http";
import { leavePopupPause } from "../../lib/otherTabLogout";
import { unsavedPlaces } from "../../lib/unloadGuard";

export function AuthPauseBanner({ action, onLeave }: { action: "login" | "reload"; onLeave: () => void }) {
  const places = unsavedPlaces();
  return (
    <div className="auth-pause-banner" role="alert">
      <span>
        다른 탭에서 로그아웃했습니다 — {places ? `저장하지 못한 ${places} 내용` : "이 화면"}을 남겨 두고 서버 요청은 멈췄습니다. 옮겨 적은 뒤 누르세요.
      </span>
      <button type="button" onClick={onLeave}>
        {action === "login" ? "로그인 화면으로" : "새로 고침"}
      </button>
    </div>
  );
}

/** 분리 창(Assets·관리) — 멈춘 동안만 띠를 띄운다. 이 창에는 로그인 화면이 없어 단추는 묻고 새로 고친다. */
export function PopupAuthPauseBanner() {
  const paused = useSyncExternalStore(subscribeApiPause, getApiPause);
  return paused ? <AuthPauseBanner action="reload" onLeave={leavePopupPause} /> : null;
}
