// 앱 창(전용 브라우저 창) 감지 — 런처가 ?appwin=1 을 붙여 연다.
// Host 콘솔의 '앱 종료' 버튼(우리 디자인 확인창) 노출 여부를 이 표식으로 판정한다.
// (X 닫기는 확인 없이 조용히 닫힌다 — 크롬 기본 확인창은 디자인 교체가 불가해 제거, Jay 결정)
// SPA 내비게이션이 쿼리를 지워도 유지되게 sessionStorage 에 승격해 둔다(새로고침에도 유지).
// 인자는 테스트 주입용 — 실사용은 무인자 호출로 브라우저 전역을 읽는다.
// 브라우저 전역 접근은 전부 try 안에서 한다 — 쿠키 전면 차단 환경에서는
// window.sessionStorage getter 자체가 예외를 던지므로 기본 인자에서 읽으면 렌더가 죽는다.

const KEY = "mvhub.app-window";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function isAppWindow(search?: string, storage?: StorageLike | null): boolean {
  try {
    if (search === undefined) {
      search = typeof window === "undefined" ? "" : window.location.search;
    }
    if (storage === undefined) {
      storage = typeof window === "undefined" ? null : window.sessionStorage;
    }
    if (new URLSearchParams(search).get("appwin") === "1") {
      try {
        storage?.setItem(KEY, "1");
      } catch {
        // 승격 저장 실패 — 표식이 명시된 이번 화면만이라도 앱 창으로 취급
      }
      return true;
    }
    return storage?.getItem(KEY) === "1";
  } catch {
    return false; // storage 차단 환경 — 확인창 없이 종전 동작
  }
}
