// "Last viewed" 배지 — 마지막으로 크게 열어본 결과 위에 띄우는 어두운 칩(라임 글자 + 눈).
//  ★.thumb-overlay 안에 넣지 않는다 — 그 부모는 평소 숨어 있다가 호버 때 나타나므로 요구와 반대다.
//   여기서는 독립 요소로 띄우고(pointer-events: none) 호버 때 CSS 로 비켜준다(styles/scene.css).
//  생성 탭·공유 탭·캔버스 카드·결과 모아보기·어셋 탭이 모두 이것 하나를 쓴다(Jay 10-26 통일).
//  글자는 span 으로 — 작은 칸(어셋 컷 띠·표 미리보기)은 CSS 로 글자를 감추고 눈만 남긴다.
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
      <span className="last-viewed-text">Last viewed</span>
    </span>
  );
}
