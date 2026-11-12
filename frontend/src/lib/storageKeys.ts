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
  editShortcuts: "ch.editShortcuts", // 편집 탭 단축키 개인 지정(lib/editShortcuts) — 라이브러리 단축키(ch.shortcuts)처럼 계정 전환 때 지운다
  // 편집 공유의 화면 상태(방식·다른 편집 보기·V0 의 사람·색·확인된 내 판) — `:<계정·서버>:<project_id>:<폴더>` 를 붙여 시퀀스마다.
  //  `ch.` 로 시작하지 않는다(계정 전환 정리가 지우지 않게 — 계정·서버가 열쇠에 들어 있다).
  editShare: "mvhub.editShare",

  // 로컬 허브에서 로그아웃한 시각 — 같은 브라우저의 다른 탭이 storage 알림으로 듣는 신호(Jay 결정 4B). 값 자체는 쓰지 않는다.
  hubLogoutAt: "mvhub.hubLogoutAt",
  // Ask Agent 옆 칸(이 브라우저) — 열림 "1"/"0" · 마지막 모델 {engine, model, effort} · 마지막 대화 {account, id}(다시 열거나 새로 고치면 이어 붙는다).
  //  `ch.` 로 시작하지 않는다 — 계정 전환 정리가 지우지 않게(대화는 계정을 같이 적어 다른 계정이면 쓰지 않는다).
  agentPanelOpen: "mvhub.agentPanel.open",
  agentPanelModel: "mvhub.agentPanel.model",
  agentPanelConversation: "mvhub.agentPanel.conversation",
  agentPanelFloat: "mvhub.agentPanel.float", // 별도 창(?embed=agent) 모드 "1"/"0" — 새 창의 [옆 칸으로 붙이기]가 "0" 을 적으면 메인 창이 storage 알림으로 옆 칸을 연다
  agentPanelWidth: "mvhub.agentPanel.width", // 옆에 붙은 칸의 폭(px)
  agentPanelScreen: "mvhub.agentPanel.screen", // 메인 창의 '지금 화면' {context, label, projects} — 새 창이 따라 읽는다
  // 서랍 메뉴(docs/status/MVAgent_서랍메뉴_2026-11-12.md) — 서랍 폭(px) · 새 창에서 열기 요청{account,identity,id,nonce,at}과
  // 처리한 요청 번호(새 창만 받고, 요청 키는 지우지 않는다) · 지운 대화 알림{account,id,at}(다른 창이 그 대화를 비운다)
  agentDrawerWidth: "mvhub.agentPanel.drawerWidth",
  agentInfoOpen: "mvhub.agentPanel.infoOpen", // 머리글 정보 칸을 열어 둔 채인지(true) — 정보 단추를 다시 누를 때까지 떠 있다(Jay 11-12)
  agentInfoFold: "mvhub.agentPanel.infoFold", // 정보 칸에서 접어 둔 카드 이름들(screen·made·attached)
  agentPanelOpenRequest: "mvhub.agentPanel.openRequest",
  agentPanelOpenDone: "mvhub.agentPanel.openDone",
  agentPanelDeleted: "mvhub.agentPanel.deleted",
  // 휠 클릭으로 새로 여는 캔버스 창에 넘기는 화면 값(lib/popupWindows) — 그 창이 처음 그릴 때 한 번 읽고 지운다
  canvasHandoff: "mvhub.canvasHandoff",
  // GPU 보기 모드 개발 표식(features/canvas/gpu) — "1" 이면 켬, 그 밖은 끔(기본). 이 브라우저만.
  canvasGpuBoard: "mvhub.canvas.gpuBoard",
  // GPU 판 잠금(실패·느린 GPU) — sessionStorage, 페이지 시작 시각과 함께(새로 고침하면 풀림)
  canvasGpuLock: "mvhub.canvas.gpuLock",
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
  sceneKeepView: "mvhub.sceneKeepView", // 보관함 이미지/리스트 보기(내용은 저장하지 않는다)
  sceneRefVerdicts: "ch.scenes.refVerdicts", // 씬 참조의 서버 판정(계정별 맵) — 한 번 확인한 그림은 다음 실행에 NAS 를 다시 훑지 않는다
  // 탭 폴더마다 마지막으로 연 탭 {폴더 id: 씬 id}(이 브라우저) — 다른 탭을 골라도 폴더 칸 옆에 남긴다(Jay 2026-11-11).
  //  `ch.` 로 시작하지 않는다 — 계정 전환 정리가 지우지 않게(폴더 id 는 계정끼리 겹치지 않는다).
  tabFolderShown: "mvhub.tabFolderShown",
  shortcuts: "ch.shortcuts",
  stateGlow: "ch.lib.stateGlow", // 내가 방금 공유·보류·최종으로 바꾼 카드(계정별 맵) — 선택 전까지 상태색 빛
  teamSeen: "ch.lib.teamSeen", // 공유&리뷰 탭 마지막 방문 시각(계정별 맵) — 신규 글로우·배지 기준선
} as const;
