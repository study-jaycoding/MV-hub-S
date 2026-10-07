// 카드의 폴더 이름표와 '폴더의 생성물' 창이 같이 쓰는 표시 규칙(순수).

export function folderSegments(path: string | null | undefined): string[] {
  return (path ?? "")
    .split(/[\\/]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

// 카드 이름표 — 폴더 이름만 보인다. 깊은 경로는 가장 구체적인 끝 두 칸('ep/seq/e035/c0010' → 'e035 c0010').
// 앞에서부터 자르면(CSS 말줄임) 정작 컷 이름이 잘려 나간다. 전체 경로는 title 로 준다.
export function folderChipLabel(path: string | null | undefined): string {
  return folderSegments(path).slice(-2).join(" ");
}

// 창 머리글·툴팁 — 프로젝트 이름(있으면) › 전체 경로.
export function folderFullLabel(projectName: string | null | undefined, path: string | null | undefined): string {
  return [projectName?.trim(), folderSegments(path).join("/")].filter(Boolean).join(" › ");
}
