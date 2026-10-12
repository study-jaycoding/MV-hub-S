// 주소 한 칸에 들어가는 이름(태그·전역 태그·Assets 등록 이름)의 공통 검사 — 만들기는 JSON 본문이라 어떤 이름이든 받지만, 삭제·해제는 이름을
//  `/tags/{tag}` 처럼 주소 한 칸에 넣는다: `/` 는 라우트를 가르고, `.`·`..` 은 브라우저가 경로를 정리해 다른 주소로 보낸다(조작 규칙 53, Codex 코드
//  리뷰). 만들 때 거절한다 — 이미 만들어진 이름은 서버 라우트 변경이 필요하다(docs/status/조작점검_2026-10-10.md 5-3).
export function urlSegmentProblem(name: string): string | null {
  if (name === "." || name === "..") return "이름이 . 이나 .. 일 수 없습니다";
  if (name.includes("/")) return "이름에 / 는 쓸 수 없습니다";
  return null;
}

/** 태그 목록(한 번에 여럿)에서 첫 문제 — 하나라도 있으면 전부 저장하지 않는다(조용히 빼지 않는다). */
export function tagsProblem(tags: readonly string[]): string | null {
  for (const tag of tags) {
    const problem = urlSegmentProblem(tag);
    if (problem) return `태그 ${problem}`;
  }
  return null;
}
