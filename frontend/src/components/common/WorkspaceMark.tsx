// 워크스페이스 표식 — 이름 첫 글자를 담은 작은 색 사각형.
//
// 툴바의 워크스페이스 필터(LibraryWorkspaceFilter), 씬 탭 우클릭 메뉴(SceneWorkspaceMenu),
// 그리고 **씬 탭 자체**(SceneBar)가 같은 목록을 다른 곳에서 보여 준다. 생김새가 다르면 같은
// 공간인지 알아보기 어려워, 표식을 한곳에서 만든다(Jay 2026-09-14 — 디자인 일관성).
//
// 색은 id 해시로 고른다 — 공간마다 **늘 같은 색**이면 되고, 서로 다른 공간이 가끔 비슷한 색이
// 되는 것은 이름이 옆에 있으므로 문제되지 않는다.
//
// ★색값은 **CSS 변수(--ws-h)로만** 넘긴다. 인라인 style 로 background·color 를 직접 박으면
//  스타일시트가 그것을 못 이긴다 — 라임 탭 위(.scene-tab-wrap.on)처럼 배경이 완전히 다른
//  자리에서는 대비를 다시 잡아야 하는데, 인라인이면 !important 없이는 불가능하다.
import type { CSSProperties } from "react";

/** id 로 정하는 색상환 각도(0~359). 같은 공간이면 화면 어디서든 같은 색이 나온다.
 *
 *  ★360 으로 바로 나머지를 내면 **한 글자만 다른 id 가 바로 옆 색**이 된다(`ws-1`→208,
 *   `ws-2`→209 … 눈으로는 같은 색). 큰 소수로 모은 뒤 360 과 서로소인 수를 곱해 색상환에
 *   흩뿌린다 — 이웃한 id 끼리 멀리 떨어진다. */
export function workspaceMarkHue(id: string): number {
  let hash = 0;
  for (const ch of id) hash = (hash * 131 + ch.codePointAt(0)!) % 100003;
  return (hash * 137) % 360;
}

export function WorkspaceMark({
  label,
  id,
  className,
  title,
}: {
  label: string;
  id: string;
  /** 크기·상태 변형 — `sm`(씬 탭용 작은 것) · `missing`(이 계정에서 못 찾는 공간) */
  className?: string;
  title?: string;
}) {
  return (
    <span
      className={"ws-mark-box" + (className ? " " + className : "")}
      style={{ "--ws-h": workspaceMarkHue(id) } as CSSProperties}
      title={title}
      aria-hidden="true"
    >
      {/* 코드포인트 단위로 첫 글자 — 이모지 이름이면 slice(0,1) 이 반쪽을 남긴다. */}
      {Array.from(label)[0] ?? "?"}
    </span>
  );
}
