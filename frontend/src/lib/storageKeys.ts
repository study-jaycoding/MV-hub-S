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
  manageColorTags: "ch.manage.colorTags",
  manageFolderTrees: "ch.manage.folderTrees", // 프로젝트관리에서 렌더폴더 트리를 펼친 프로젝트 id 목록
  manageTab: "ch.manage.tab",
  manageWorkFilters: "ch.manage.workFilters",
  manageWorkView: "ch.manage.workView",
  projectFolderExpanded: "ch.projects.folderExpanded",
  promptHistory: "ch.promptHistory",
  scenes: "ch.scenes", // Canvas 씬(빈 캔버스) — 카드·연결·카메라, 프로젝트별
  scenesActive: "ch.scenes.active", // 프로젝트별 마지막으로 연 씬 id
  shortcuts: "ch.shortcuts",
} as const;
