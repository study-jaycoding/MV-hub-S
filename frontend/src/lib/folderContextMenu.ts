// 폴더 우클릭 메뉴(팀 공유 / 공유 저장 · 최종 저장 / 원본 위치 열기 / 모두 확인) — 순수 규칙.
//  · 내 작업 탭: "팀 공유" — 그 폴더(하위 포함)의 내 완료·미공유 결과물을 팀에 공유한다.
//  · 공유&리뷰(팀) 탭: "공유 저장" · "최종 저장" — 완료 탭의 두 단추와 같은 저장을 그 폴더(하위 포함)로만 좁혀서.
//  · 모든 탭: 메뉴 우상단 "원본 위치 열기" 아이콘 — 해당 실제 폴더만 연다.
//  · 공유&리뷰(팀) 탭 + 새로 들어온 항목(+N)이 있으면: "모두 확인 (+N)" — 그 범위(프로젝트 행=전체, 폴더=하위 포함)의
//    신규 항목을 한꺼번에 확인 처리(카드 글로우·+N 배지 해제). 프로젝트 행 우클릭은 이 단추만(Jay 2026-09-10).
//  · 버튼 색은 폴더 자체의 아이콘 색(최상위=하늘색, 하위=라임). 선택 분홍과 무관(Jay). '모두 확인'은 +N 배지 색(라임).
export type FolderMenuKind = "share" | "save-shared" | "save-finals" | "open-folder";
export type FolderActionKind = Exclude<FolderMenuKind, "open-folder">;
export type FolderMenuTab = "my" | "team";

export const FOLDER_MENU_W = 240;
export const FOLDER_MENU_H = 84; // 이름 줄 + 단추 1개
export const FOLDER_MENU_BTN_H = 36; // 단추 하나가 더 붙을 때 늘어나는 높이(단추 30 + 간격 6)

export function folderMenuHeight(buttons: number): number {
  return FOLDER_MENU_H + Math.max(0, buttons - 1) * FOLDER_MENU_BTN_H;
}

export function ackAllLabel(count: number): string {
  return `모두 확인 (+${count})`;
}

export interface FreshItemLike {
  id: string;
  project_id: string | null;
  folder_path: string | null;
  shared_at: string | null;
  ack_key?: string | null;
}

// 우클릭한 행 범위의 미확인 신규 항목 — path "" = 프로젝트 전체(폴더 미지정 포함), 아니면 그 폴더와 하위 폴더.
// isAcked 는 teamSeen.isAckedFor(ack_key 우선, 구서버는 id) — 순수 함수로 두려고 주입받는다.
export function freshItemsInScope<T extends FreshItemLike>(
  items: T[],
  projectId: string,
  path: string,
  isAcked: (ackKey: string, sharedAt: string | null | undefined) => boolean,
): T[] {
  const prefix = (path || "").replace(/\/+$/, "");
  return items.filter((it) => {
    if (it.project_id !== projectId) return false;
    if (prefix) {
      const folder = it.folder_path || "";
      if (folder !== prefix && !folder.startsWith(prefix + "/")) return false;
    }
    return !isAcked(it.ack_key || it.id, it.shared_at);
  });
}

// 탭별 동작 단추(위에서 아래로). 팀 탭은 완료 탭과 같은 순서 — 공유 저장 · 최종 저장.
export function folderMenuKinds(tab: FolderMenuTab): FolderActionKind[] {
  return tab === "team" ? ["save-shared", "save-finals"] : ["share"];
}

const FOLDER_MENU_LABELS: Record<FolderMenuKind, string> = {
  share: "팀 공유",
  "save-shared": "공유 저장",
  "save-finals": "최종 저장",
  "open-folder": "원본 위치 열기",
};

export function folderMenuLabel(kind: FolderMenuKind): string {
  return FOLDER_MENU_LABELS[kind];
}

// 트리 깊이 → 색조. FolderTreeView 의 .folder-tree-row.root(하늘색) / :not(.root)(라임)와 같은 기준.
export function folderTone(depth: number): "root" | "child" {
  return depth <= 0 ? "root" : "child";
}

export function folderConfirmText(kind: FolderActionKind, name: string): string {
  if (kind === "save-finals")
    return `'${name}' 폴더를 최종 저장하시겠습니까?\n하위 폴더를 포함한 저장 대상 최종본만 프로젝트 렌더 폴더에 저장합니다.`;
  if (kind === "save-shared")
    return `'${name}' 폴더를 공유 저장하시겠습니까?\n하위 폴더를 포함해 공유 중인 것(최종 제외)을 프로젝트 렌더 폴더의 각 컷 폴더 안 shared 폴더에 저장합니다.`;
  return `'${name}' 폴더를 공유하시겠습니까?\n하위 폴더까지 포함해 내가 만든 완료 결과물 중 아직 공유하지 않은 것을 모두 팀 공유합니다.`;
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
