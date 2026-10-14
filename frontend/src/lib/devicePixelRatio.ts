// 화면 배율(DPR) — 캔버스 끌기 층(SceneBoard)과 격자의 썸네일 요청 폭(ThumbnailGrid)이 같이 쓴다.
export const getDevicePixelRatio = () => window.devicePixelRatio;

// 모니터 배율이 바뀐 것을 듣는다(창을 배율이 다른 모니터로 옮김·OS 의 배율 변경) — `(resolution: <지금 배율>dppx)` 질의가 어긋나는 순간이
//  곧 바뀐 순간이다. 질의는 값 하나에 묶여 있어, 알림이 올 때마다 지금 배율로 다시 건다(허용하는 배율이 늘어도 이어서 듣는다).
//  창 크기는 그대로이고 배율만 바뀌면 resize 가 오지 않는다(51회차 — Codex 검토).
export function subscribeDevicePixelRatio(listener: () => void): () => void {
  let query: MediaQueryList | undefined;
  function onChange() {
    watch();
    listener();
  }
  function watch() {
    query?.removeEventListener("change", onChange);
    query = window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`);
    query?.addEventListener("change", onChange);
  }
  watch();
  return () => query?.removeEventListener("change", onChange);
}
