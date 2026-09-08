// "Last viewed" 배지 — 마지막으로 크게 열어본 결과 위에 띄우는 유리 칩.
//  ★.thumb-overlay 안에 넣지 않는다 — 그 부모는 평소 숨어 있다가 호버 때 나타나므로 요구와 반대다.
//   여기서는 독립 요소로 띄우고(pointer-events: none) 호버 때 CSS 로 비켜준다(styles/scene.css).
//  캔버스 생성 카드·Comfy 카드·결과 모아보기 팝업 세 곳이 같은 것을 쓴다.
export function LastViewedBadge() {
  return (
    <span className="last-viewed-badge" aria-label="마지막으로 확인한 결과">
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
      Last viewed
    </span>
  );
}
