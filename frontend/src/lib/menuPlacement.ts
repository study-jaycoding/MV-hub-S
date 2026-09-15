// 떠 있는 메뉴가 '잘리는 조상' 안에 들어가도록 방향·높이·좌우를 정하는 순수 계산.
//
// ★왜 필요한가: 캔버스 '폴더 보기' 창(.folder-peek)은 overflow: hidden 이고 액션바가 창 맨
//  아래에 붙는다. 그 위로 열리는 '프로젝트에 담기' 메뉴(320px)가 창 위 경계를 넘어 잘렸다 —
//  640x400 에서 위로 79px, 480x600 에서 오른쪽으로 33.8px(2026-09-15 코덱스 실측). 잘린 자리의
//  항목은 눌러도 뒤의 막이 받아 창이 닫혔다.
//
// 경계는 '가장 가까운 잘림 조상' 하나가 아니라 **자르는 조상 전부의 교집합**이다 — 가까운 조상
//  안에 들어가도 그 바깥이 다시 자를 수 있다. 축(가로/세로)마다 따로 본다.

export interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PlacementInput {
  /** 메뉴를 여는 단추의 화면 좌표 */
  anchor: Rect;
  /** 메뉴를 자르는 경계(뷰포트 ∩ 잘림 조상들) */
  bounds: Rect;
  /** 인라인 top/left 의 기준이 되는 요소(.proj-assign)의 화면 좌표 */
  origin: Rect;
  /** 제한이 없을 때 메뉴가 갖고 싶어 하는 크기 — ★잘려서 작아진 현재 크기를 넣으면 안 된다 */
  content: { height: number; width: number };
  /** 선호 방향 — 기존 CSS 가 정하던 것. 넣을 수 있으면 이쪽을 유지한다 */
  prefer: "up" | "down";
  /** 단추와 메뉴 사이 간격 */
  gap: number;
}

export interface Placement {
  direction: "up" | "down";
  /** origin 기준 상대 좌표. 쓰지 않는 쪽은 null → 호출부가 "auto" 로 넣는다 */
  top: number | null;
  bottom: number | null;
  left: number;
  maxHeight: number;
  maxWidth: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function computeMenuPlacement(input: PlacementInput): Placement {
  const { anchor, bounds, origin, content, prefer, gap } = input;

  // 세로 — 단추 위/아래로 각각 얼마나 쓸 수 있나(간격 포함).
  const availUp = Math.max(0, anchor.top - bounds.top - gap);
  const availDown = Math.max(0, bounds.bottom - anchor.bottom - gap);

  // 방향: ① 선호 쪽에 다 들어가면 유지 ② 안 되면 반대쪽 검토 ③ 둘 다 모자라면 넓은 쪽.
  //  ★판정에 쓰는 높이는 '내용이 원하는 높이' 다. 이미 제한된 높이를 다시 넣으면 방향이 오락가락한다.
  const preferAvail = prefer === "up" ? availUp : availDown;
  const otherAvail = prefer === "up" ? availDown : availUp;
  let direction: "up" | "down" = prefer;
  if (preferAvail < content.height) {
    if (otherAvail >= content.height) direction = prefer === "up" ? "down" : "up";
    else if (otherAvail > preferAvail) direction = prefer === "up" ? "down" : "up";
  }

  const avail = direction === "up" ? availUp : availDown;
  const maxHeight = Math.max(0, Math.min(content.height, avail));

  // 가로 — 경계보다 넓으면 폭부터 줄이고, 그 다음 양쪽으로 밀어 넣는다.
  const boundsWidth = Math.max(0, bounds.right - bounds.left);
  const maxWidth = Math.max(0, Math.min(content.width, boundsWidth));
  // 기본은 단추가 속한 기준 요소의 왼쪽 끝(옛 CSS 의 left: 0 과 같은 자리).
  const desiredLeft = origin.left;
  const left = boundsWidth <= 0 ? desiredLeft : clamp(desiredLeft, bounds.left, bounds.right - maxWidth);

  // 화면 좌표 → 기준 요소 상대 좌표(인라인 스타일이 쓰는 좌표계).
  return {
    direction,
    top: direction === "down" ? anchor.bottom + gap - origin.top : null,
    bottom: direction === "up" ? origin.bottom - (anchor.top - gap) : null,
    left: left - origin.left,
    maxHeight,
    maxWidth,
  };
}

/** 두 사각형의 교집합 — 겹치지 않으면 넓이 0 인 사각형을 준다. */
export function intersectRect(a: Rect, b: Rect): Rect {
  const top = Math.max(a.top, b.top);
  const bottom = Math.min(a.bottom, b.bottom);
  const left = Math.max(a.left, b.left);
  const right = Math.min(a.right, b.right);
  return {
    top,
    bottom: Math.max(top, bottom),
    left,
    right: Math.max(left, right),
  };
}
