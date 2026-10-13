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
  editTimeline: "ch.editTimeline", // 편집 탭의 화면 설정(`.ui`)·마지막으로 연 시퀀스(`.last:<계정>`) + 문서의 **옛 자리**(`:<계정>:…` — 아래로 옮긴다)
  // 편집 탭 문서 — `:<계정>:<project_id>:<폴더>` 를 붙여 시퀀스마다 하나(docs/EDIT_TAB.md). **`ch.` 로 시작하지 않는다**: 편집 탭이 없던
  //  옛 판의 계정 전환 정리가 보존 목록 밖의 `ch.*` 를 전부 지워, 새 판을 쓰다 옛 판으로 되돌린 뒤 계정을 바꾸면 편집본이 사라졌다.
  editDocs: "mvhub.editDoc",

  historyPos: "ch.history.pos",
  historyPosLegacy: "ch.lineage.pos",
  historyView: "ch.history.view",
  libraryFilters: "ch.lib.filters",
  workspaceContext: "ch.workspaceContext", // 선택 워크스페이스(크레딧 컨텍스트) — 관리/에셋 창 범위와 동기
  modelPolicy: "ch.modelPolicy", // 그룹 사용 모델 정책의 마지막 서버 값 — `:<서버|이메일|워크스페이스>` 접미
  manageColorTags: "ch.manage.colorTags",
  manageTab: "ch.manage.tab",
  manageWorkFilters: "ch.manage.workFilters",
  manageWorkView: "ch.manage.workView",
  notificationCurrentVersion: "ch.notifications.currentVersion",
  notificationCompletedUpdate: "ch.notifications.completedUpdate",
  // 서버 이사 알림을 '나중에'로 닫은 표식 — ★sessionStorage 전용(localStorage 아님).
  // 주소를 옮기지 않으면 앱이 서버에 닿지 못하므로 다음 기동엔 다시 눈에 띄어야 한다.
  notificationRelocationDismissed: "ch.notifications.relocationDismissed",
  // '주소가 바뀌었다' 정보 알림(이미 새 주소인 PC)을 읽은 표식 — localStorage(한 번 읽으면 다시 안읽음으로 안 뜬다)
  notificationRelocationMovedRead: "ch.notifications.relocationMovedRead",
  projectFolderExpanded: "ch.projects.folderExpanded",
  promptHistory: "ch.promptHistory",
  resolveSelectionFollow: "ch.resolveSelectionFollow",
  scenes: "ch.scenes", // Canvas 씬(빈 캔버스) — 카드·연결·카메라, 프로젝트별
  scenesActive: "ch.scenes.active", // 프로젝트별 마지막으로 연 씬 id
  sceneRefVerdicts: "ch.scenes.refVerdicts", // 씬 참조의 서버 판정(계정별 맵) — 한 번 확인한 그림은 다음 실행에 NAS 를 다시 훑지 않는다
  shortcuts: "ch.shortcuts",
  stateGlow: "ch.lib.stateGlow", // 내가 방금 공유·보류·최종으로 바꾼 카드(계정별 맵) — 선택 전까지 상태색 빛
  teamSeen: "ch.lib.teamSeen", // 공유&리뷰 탭 마지막 방문 시각(계정별 맵) — 신규 글로우·배지 기준선
} as const;
