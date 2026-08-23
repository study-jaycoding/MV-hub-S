export const STORAGE_KEYS = {
  activeAccount: "ch.activeAccount",
  authToken: "ch.auth.token",
  assetsDir: "ch.assets.dir",
  assetsDisabled: "ch.assets.disabled",
  assetsDrag: "ch.assets.drag",
  assetsProject: "ch.assets.project",
  assetsSelection: "ch.assets.selection",
  compositionBoard: "content-hub-board",
  historyDisabled: "ch.history.disabled",
  historyDisabledLegacy: "ch.lineage.disabled",
  disabledFolders: "ch.lib.disabledFolders", // 폴더 단위 비활성화(생략) — projectId→폴더경로[]

  historyPos: "ch.history.pos",
  historyPosLegacy: "ch.lineage.pos",
  historyView: "ch.history.view",
  libraryFilters: "ch.lib.filters",
  workspaceContext: "ch.workspaceContext", // 선택 워크스페이스(크레딧 컨텍스트) — 관리/에셋 창 범위와 동기
  manageColorTags: "ch.manage.colorTags",
  manageFolderTrees: "ch.manage.folderTrees", // 프로젝트관리에서 렌더폴더 트리를 펼친 프로젝트 id 목록
  manageTab: "ch.manage.tab",
  manageWorkFilters: "ch.manage.workFilters",
  manageWorkView: "ch.manage.workView",
  notificationCurrentVersion: "ch.notifications.currentVersion",
  notificationCompletedUpdate: "ch.notifications.completedUpdate",
  notificationSeenAvailableVersion: "ch.notifications.seenAvailableVersion",
  // 서버 이사 알림을 '나중에'로 닫은 표식 — ★sessionStorage 전용(localStorage 아님).
  // 주소를 옮기지 않으면 앱이 서버에 닿지 못하므로 다음 기동엔 다시 눈에 띄어야 한다.
  notificationRelocationDismissed: "ch.notifications.relocationDismissed",
  projectFolderExpanded: "ch.projects.folderExpanded",
  promptHistory: "ch.promptHistory",
  scenes: "ch.scenes", // Canvas 씬(빈 캔버스) — 카드·연결·카메라, 프로젝트별
  scenesActive: "ch.scenes.active", // 프로젝트별 마지막으로 연 씬 id
  shortcuts: "ch.shortcuts",
  teamSeen: "ch.lib.teamSeen", // 공유&리뷰 탭 마지막 방문 시각(계정별 맵) — 신규 글로우·배지 기준선
} as const;
