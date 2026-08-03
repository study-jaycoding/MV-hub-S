// 씬 공용 상수 — SceneBoard 와 카드 컴포넌트들이 함께 쓴다(순환 import 방지용 분리, R2).

// 카드 기본 크기(px) — 리스트 썸네일 비례 계산(ListCard)·기본 배치 등 공용.
export const CARD_W = 152;
export const CARD_H = 130;

// 씬 공용 색 상수 — SceneBoard(그룹 팔레트)와 카드 컴포넌트(HeadCard 글씨색)가 함께 쓴다.
//  (R2 분할로 HeadCard 가 별도 파일이 되면서, SceneBoard 역참조(순환 import)를 피해 여기로 분리.)
// 그룹 고정 색 팔레트(팝오버 프리셋). 이 외의 색은 '커스텀'(네이티브 컬러픽커)으로 지정.
export const GROUP_COLORS = ["#e5484d", "#f5a524", "#e8c341", "#46a758", "#3b9eff", "#8b7bff", "#e93d82", "#8b98a5"];
