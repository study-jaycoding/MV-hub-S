// 폴더 우클릭 메뉴(팀에 공유 / 최종 경로로 저장) — 순수 규칙. 사이드바(라이브러리·캔버스)가 같은 메뉴를 띄운다(2026-09-09).
//  · 내 작업 탭: "팀에 공유" — 그 폴더(하위 포함)의 내 완료·미공유 결과물을 팀에 공유.
//  · 공유&리뷰(팀) 탭: "최종 경로로 저장" — 저장 대상 최종본만 프로젝트 렌더 폴더에 폴더 구조대로 저장.
//  · 버튼 색은 폴더 자체의 아이콘 색(최상위=하늘색, 하위=라임). 선택 분홍과 무관(Jay).
export type FolderMenuKind = "share" | "save-finals";
export type FolderMenuTab = "my" | "team";

export const FOLDER_MENU_W = 240;
export const FOLDER_MENU_H = 84;

export function folderMenuKind(tab: FolderMenuTab): FolderMenuKind {
  return tab === "team" ? "save-finals" : "share";
}

export function folderMenuLabel(kind: FolderMenuKind): string {
  return kind === "save-finals" ? "최종 경로로 저장" : "팀에 공유";
}

// 트리 깊이 → 색조. FolderTreeView 의 .folder-tree-row.root(하늘색) / :not(.root)(라임)와 같은 기준.
export function folderTone(depth: number): "root" | "child" {
  return depth <= 0 ? "root" : "child";
}

export function folderConfirmText(kind: FolderMenuKind, name: string): string {
  return kind === "save-finals"
    ? `'${name}' 폴더를 최종 경로로 저장하시겠습니까?\n하위 폴더를 포함한 저장 대상 최종본만 프로젝트 렌더 폴더에 저장합니다.`
    : `'${name}' 폴더를 공유하시겠습니까?\n하위 폴더까지 포함해 내가 만든 완료 결과물 중 아직 공유하지 않은 것을 모두 팀에 공유합니다.`;
}

// 화면 가장자리에서 잘리지 않게 좌표 보정(고정 위치 메뉴).
export function clampMenuPosition(
  x: number,
  y: number,
  viewportW: number,
  viewportH: number,
  w = FOLDER_MENU_W,
  h = FOLDER_MENU_H,
): { left: number; top: number } {
  const pad = 4;
  return {
    left: Math.max(pad, Math.min(x, viewportW - w - pad)),
    top: Math.max(pad, Math.min(y, viewportH - h - pad)),
  };
}
