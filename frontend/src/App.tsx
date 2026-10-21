import { getAccountNamespace } from "./lib/accountScope";
import { captureSubmissionScope, configureOperationContext, watchOperationContext } from "./app/operationContext";
import { prepareRegenerateSubmission, runSubmission } from "./features/generation/api";
import { canFinishDraft } from "./lib/seedanceDraft";
import { useDraftRequests } from "./lib/useDraftRequests";
// 앱 루트: 탭·필터 상태, 데이터 로딩, WebSocket 진행률, 액션 오케스트레이션.
import { cloneElement, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
// 코드 스플리팅 — 드물게 여는 구성보드는 지연 로드해 초기 번들에서 분리.
// 씬 카드가 선택되지 않았을 때의 트레이 바인딩 refs — 렌더마다 같은 참조여야 한다(아래 trayBinding 주석).
const EMPTY_SCENE_REFS: SceneRef[] = [];

const HistoryBoard = lazy(() =>
  import("./components/HistoryBoard").then((m) => ({ default: m.HistoryBoard })),
);
import { LoginScreen } from "./components/LoginScreen";
import { ServerLoginScreen } from "./components/ServerLoginScreen";
import { FilterSidebar } from "./components/FilterSidebar";
import { CanvasFolderSidebar } from "./components/sidebar/CanvasFolderSidebar";
import { LibraryToolbar } from "./components/LibraryToolbar";
import {
  SpotlightPrompt,
  type SpotlightPromptHandle,
} from "./components/SpotlightPrompt";
import { ThumbnailGrid } from "./components/ThumbnailGrid";
import { ensureTeamBase } from "./lib/teamSeen";
import { TopBar } from "./components/TopBar";
const McpConnection = lazy(() => import("./components/mcp/McpConnection").then((m) => ({ default: m.McpConnection })));
import { SceneBar } from "./components/scene/SceneBar";
import { SceneBoardBoundary } from "./components/scene/SceneBoardBoundary";
const SceneBoard = lazy(() =>
  import("./components/scene/SceneBoard").then((m) => ({ default: m.SceneBoard })),
);
import { AppOverlays, VideoCompareOverlay } from "./components/app/AppOverlays";
import { ResolveNotices } from "./components/app/ResolveNotices";
import { AuthPauseBanner } from "./components/app/AuthPauseBanner";
import { getApiPause } from "./lib/http";
const EditTab = lazy(() =>
  import("./components/timeline/EditTab").then((m) => ({ default: m.EditTab })),
);
import {
  BoardSelectionActionBar,
  LibrarySelectionActionBar,
} from "./components/app/SelectionActionBar";
import { KEY_COLORS } from "./lib/appConstants";
import { useCanvasGenerationLinks } from "./lib/useCanvasGenerationLinks";
import { canvasTarget } from "./features/canvas/api";
import { useSceneGenerationSubmission } from "./lib/useSceneGenerationSubmission";
import { useMcpCanvasTasks } from "./lib/mcpCanvasTasks";
import { folderPeekQuery, generationQueryKey } from "./lib/appGenerationQuery";
import { useResolveLibraryFollow } from "./lib/useResolveLibraryFollow";
import { generationsByIds, uniqueTagNames } from "./lib/generationTags";
import { reloadedIntoEdit, useAppNavigation } from "./lib/useAppNavigation";
import {
  exportSceneText,
  listScenes,
  parseSceneImport,
  SCENE_IMPORT_MAX_BYTES,
  variantIds,
  type SceneRef,
} from "./lib/scenes";
import {
  collectGenText,
  collectGenModel,
  resolvePortEdges,
} from "./lib/sceneEdges";
import {
  collectSceneGenerationAssignment,
  type SceneGenerationAssignment,
} from "./lib/sceneGenerationInputs";
import { downloadText } from "./lib/download";
import { downloadSceneArchive } from "./lib/sceneArchive";
import { buildRecipeScene } from "./lib/recipeScene";
import { useGenerationAutoRefresh } from "./lib/useGenerationAutoRefresh";
import { useCommentBadgePoll } from "./lib/useCommentBadgePoll";
import { useGenerationAutoTagActions } from "./lib/useGenerationAutoTagActions";
import { useGenerationCardActions } from "./lib/useGenerationCardActions";
import { useGenerationFilterActions } from "./lib/useGenerationFilterActions";
import { useGenerationKeyboardActions } from "./lib/useGenerationKeyboardActions";
import { useGenerationLibraryData, type LibraryOwner } from "./lib/useGenerationLibraryData";
import { useGenerationProgress } from "./lib/useGenerationProgress";
import { useGenerationProjectActions } from "./lib/useGenerationProjectActions";
import { useGenerationSelection, withoutHidden } from "./lib/useGenerationSelection";
import { useGenerationShareActions } from "./lib/useGenerationShareActions";
import { useBackgroundEscape } from "./lib/useEscapeClose";
import { backgroundKeysBlocked, floatHost, isTypingTarget, usePageSelectAllGuard } from "./lib/keyGate";
import { isKeyHandled, markKeyHandled } from "./lib/keyHandled";
import { manageApi } from "./lib/manageApi";
import { folderMenuLabel, type FolderMenuKind } from "./lib/folderContextMenu";
import { useGenerationTagActions } from "./lib/useGenerationTagActions";
import { useGenerationWorkspaceActions } from "./lib/useGenerationWorkspaceActions";
import { useGenerationTrashActions } from "./lib/useGenerationTrashActions";
import { useGenerationUtilityActions } from "./lib/useGenerationUtilityActions";
import { useResolveTransferActions } from "./lib/useResolveTransferActions";
import { useHubAuth } from "./lib/useHubAuth";
import { startEditDocBackup } from "./lib/editDocBackup";
import { hubHasFeature } from "./lib/hubFeatures";
import { useAppToast } from "./lib/useAppToast";
import { useDisabledGenerations } from "./lib/useDisabledGenerations";
import { useLibraryFilters } from "./lib/useLibraryFilters";
import { useWorkspaceFilterOptions } from "./lib/useWorkspaceFilterOptions";
import { useRelinkOnWorkspaceChange, useSceneCoordination } from "./lib/useSceneCoordination";
import { useSceneCompletionWatcher } from "./lib/useSceneCompletionWatcher";
import { seedPending } from "./lib/sceneRecentDoneStore";
import { useHistoryBoardState } from "./lib/useHistoryBoardState";
import { usePromptDock } from "./lib/usePromptDock";
import { usePromptCreatedActions } from "./lib/usePromptCreatedActions";
import { APP_EVENTS } from "./lib/appEvents";
import { useCustomEvent } from "./lib/useCustomEvent";
import {
  resolveSceneForGeneration,
  resolveSelectionGenerationIds,
  type ResolveOpenPopup,
  type ResolveSceneSelectionTarget,
} from "./lib/resolveSelection";
import { useResolveSelectionFollow } from "./lib/resolveSelectionSettings";
import { postLibraryChanged } from "./lib/libraryBroadcast";
import { UpdateProgressOverlay } from "./components/UpdateProgressOverlay";
import { PartialEditHost } from "./components/edit/PartialEditHost";
import {
  canFinalizeGeneration,
  expandDisabledGenerationIds,
  filterDisabledGenerations,
} from "./lib/generationDisplay";
import { useDisabledFolders } from "./lib/useDisabledFolders";
import { useGradeStep } from "./lib/useGradeStep";
import type { GradeMode } from "./lib/gradeStep";
import { reviewTargets } from "./lib/generationReview";
import { GradeStepModal } from "./components/GradeStepModal";
import { useAskPrompt } from "./lib/prompt";
import { makeStore } from "./lib/storage";
import { TEAM_LOCATION_KEY, type TeamLocationMemory } from "./lib/useLibraryPersistence";
import type {
  CardMark,
  FolderCard,
  Generation,
  History,
  InfoTarget,
  PreviewTarget,
  WorkspaceContext,
} from "./types";
import type { EditCardMenu, EditCutFolder } from "./components/timeline/EditTab";
import { api } from "./api";
import { FolderCardGrid } from "./components/FolderCardGrid";
import { folderCardsPlace, folderUnder, hasFindFilters, parentFolder, singleTeamWorkspace, type FolderCardsScope } from "./lib/folderCards";
import { fillFolderCards, groupGenerations, lacksCounts } from "./lib/folderCardsLocal";
import { FETCH_ALL_MAX } from "./lib/fetchAllGenerations";
import { useLocalFolderCards } from "./lib/useLocalFolderCards";
import { placeViewKey } from "./lib/placeViews";
import { FolderTabs } from "./components/common/FolderTabs";
import { useLibraryFolderTabs } from "./lib/useLibraryFolderTabs";
import { usePlaceView } from "./lib/usePlaceView";
import { prefetchFolderCards, useFolderCards, useSameQueryRevision } from "./lib/useFolderCards";
import { CutInfoPopup } from "./components/CutInfoPopup";
import { CutReel, type ReelMode } from "./components/CutReel";
import {
  loadStoredWorkspaceContext,
  saveStoredWorkspaceContext,
  UNKNOWN_WORKSPACE,
  sameWorkspace,
} from "./lib/workspaceContext";
import { configureModelPolicy } from "./lib/modelPolicy";
import { normalizeSceneWorkspace, sceneMatchesWorkspace, type SceneMove, type SceneWorkspace } from "./lib/sceneWorkspace";
import { STORAGE_KEYS } from "./lib/storageKeys";
import { useT } from "./lib/i18n";
import { hasWorkspaceFilter, workspaceViewKey } from "./lib/libraryWorkspaceScope";

// 마지막으로 보던 라이브러리 상태 영속화(탭·서브탭·필터·크기·레이아웃 등)
const LS = makeStore("ch.lib.");
// 폴더를 옮긴 뒤 격자 자리를 비우거나 잠가 두는 최대 시간 — 응답이 매달려도 이 뒤엔 전처럼 화면의 목록을 보이고 누르게 둔다(아래 waitExpired).
const LIST_WAIT_MAX_MS = 4000;
const NO_GENERATIONS: Generation[] = []; // 자동 조회가 보는 행이 없을 때 — 렌더마다 새 배열이면 그 훅의 판정이 매번 다시 돈다

// 3색(빨강·초록·파랑) 필터 도트 — 툴바 여러 곳에 같은 값이라 모듈 상수로(매 렌더 배열 재생성 제거).
const COLOR_DOTS = [
  { k: "r", hex: KEY_COLORS.r },
  { k: "g", hex: KEY_COLORS.g },
  { k: "b", hex: KEY_COLORS.b },
];

export default function App() {
  const t = useT();
  // 생성·과금 문맥은 기존대로 유지하고 공유&리뷰의 보기만 이 선택을 따라간다.
  const [workspaceContext, setWorkspaceContext] = useState<WorkspaceContext>(
    () => loadStoredWorkspaceContext() ?? UNKNOWN_WORKSPACE,
  );
  // 편집 탭(docs/EDIT_TAB.md) — filters.tab 의 값이 아니라 본문만 바꾸는 별도 '보기'다. 밑의 탭 상태·목록 훅은 그대로 돈다.
  //  떠 있는 동안: 캔버스 폴더 창 닫힘(folderPeek) · 프롬프트 단축키 쉼 · 다빈치 따라가기 쉼. 라이브러리 단축키는 편집 탭이 연
  //  폴더 창이 떠 있을 때만 듣는다(아래 teamPeek).
  const [editOpen, setEditOpen] = useState(reloadedIntoEdit); // 새로 고침해도 편집 탭에 남는다(Jay 2026-10-14)
  const editOpenRef = useRef(editOpen);
  editOpenRef.current = editOpen;
  // 편집 탭이 연 '폴더 보기' 창(컷 더블클릭, Jay 2026-10-08) — 공유 & 리뷰의 폴더 창을 그대로 쓴다. 그 창은 하나뿐인 목록
  //  조회를 빌려 그리고 카드 동작이 탭에 묶여 있어, 떠 있는 동안 목록·카드·액션만 공유 & 리뷰로 본다(useLibraryFilters 의
  //  teamPeek). 편집을 떠나면 그 렌더부터 꺼진 것으로 본다(&& editOpen) — 떠난 탭이 한순간 공유 & 리뷰로 그려지지 않게.
  const [teamPeek, setTeamPeek] = useState(false);
  // 라이브러리 필터/뷰 상태 + genQuery/selectionResetKey 파생 + LS 저장(useLibraryPersistence)은 useLibraryFilters 훅으로 추출.
  const libraryFilters = useLibraryFilters(LS, workspaceContext, teamPeek && editOpen);
  const {
    filters, storedTab, setFilters, patch, restoreLocation, adoptShownLocation, restoredLocationRef, teamScopeKey, teamAutoReady,
    typeFilter, setTypeFilter, scale: legacyScale, fill: legacyFill,
    showFilters, setShowFilters, colorFilter, setColorFilter,
    sharedOnly, setSharedOnly, reviewFilter, setReviewFilter, tagFilter, setTagFilter, tagPanelOpen, setTagPanelOpen,
    commentOnly, setCommentOnly, finalOnly, setFinalOnly, grayOn, setGrayOn,
    armedAutoTags, setArmedAutoTags, armedFolder, setArmedFolder,
    generationScope, filterAutoTags, followLocation, toggleAutoTag, manualRevision, followRevision,
    workspaceChips, setWorkspaceChips,
    genQuery, selectionResetKey, workspaceFollow, workspaceScopeKey, workspaceQueryReady,
  } = libraryFilters;
  // 공간 변경은 **동기**다 — 네트워크를 타지 않으므로 늦게 온 응답이 선택을 덮을 일이 없다.
  //  (예전엔 허브에 `workspace set` 을 보내느라 변경 순번으로 옛 응답을 걸러야 했다. 2026-09-11 에
  //   허브가 CLI 전역을 안 건드리게 되면서 그 장치가 통째로 필요 없어졌다.)
  const changeWorkspaceContext = useCallback((next: WorkspaceContext) => {
    setWorkspaceContext((previous) =>
      sameWorkspace(previous, next) && previous.name === next.name ? previous : next,
    );
  }, []);
  // 별도 키로 영속화 — 관리/에셋 창이 이 키(storage 이벤트)로 같은 범위를 따라간다.
  useEffect(() => {
    saveStoredWorkspaceContext(workspaceContext);
  }, [workspaceContext]);
  // 다른 메인 탭이 전환하면 이 탭도 따라간다 — 안 따라가면 이 탭의 생성이 옛 컨텍스트로 스탬프된다.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEYS.workspaceContext) return;
      if (getApiPause()) return; // 다른 탭 로그아웃 뒤 멈춘 중 — 다른 계정의 범위를 따라가지 않는다(Jay 결정 4B)
      const stored = loadStoredWorkspaceContext();
      if (stored) changeWorkspaceContext(stored);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [changeWorkspaceContext]);
  // 사이드바 프로젝트 목록 스코프 — 실제 선택된 워크스페이스의 프로젝트만 보인다(생성물 가시성과 별개).
  const projectWorkspaceId =
    workspaceContext.scope === "team" ? workspaceContext.id || undefined : undefined;
  const [compareGens, setCompareGens] = useState<Generation[] | null>(null); // DAM 버전 비교
  // 단순 미디어 비교(레퍼런스 포함) — 열림 대상 + 씬 선택이 미디어비교 가능한지(상단 선택바가 비교버튼 표시).
  type CompareMedia = { url: string; name: string; type: "image" | "video"; fallback?: string; full?: string };
  const [videoCompare, setVideoCompare] = useState<CompareMedia[] | null>(null);
  const [sceneCompareMedia, setSceneCompareMedia] = useState<CompareMedia[] | null>(null);
  const { flash, toast } = useAppToast();
  // 앱 창 X 닫기는 확인 없이 조용히 닫힌다(Jay 결정 — 크롬 기본 확인창 디자인을 못 바꾸므로 제거).
  // 확인이 필요한 종료는 Host 콘솔의 '앱 종료' 버튼(우리 디자인 확인창) 경로가 담당한다.
  // Canvas 씬(빈 캔버스) 상태·CRUD 는 useSceneCoordination 훅으로 추출. S1: 프로젝트 무관 전역(projectId=null).
  //  flash 전달 — 다른 탭이 이 씬을 바꾸면(멀티탭) 비파괴 알림용.
  const {
    scenes, activeSceneId, activeScene,
    sceneBinding, setSceneBinding, sceneSelGens, setSceneSelGens, sceneActionRef,
    flushScenePending, selectScene, addScene, importSceneSnapshot, relinkSceneRefsNow, findSceneRefs, renameScene,
    removeSceneById,
    canvasDocument, writeBoardSnapshot, refreshSceneById, reorderScenes, setSceneWorkspace, backupOnly, importBackupScenes,
    sceneSaveFailing, sceneBackupSkippedIds,
  } = useSceneCoordination(flash);
  // 위에서 고른 워크스페이스가 바뀌면 탭에 공간이 없는 씬의 참조를 새 공간으로 한 번 묻는다(2026-10-01 점검 R2-2).
  //  ★선택 저장 effect(위 190행) 뒤에 둔다 — 묻는 쪽이 저장된 선택을 읽는다(앞에 두면 옛 공간으로 묻는다).
  useRelinkOnWorkspaceChange(`${workspaceContext.scope}:${workspaceContext.id ?? ""}`, relinkSceneRefsNow);
  const [resolveSceneSelection, setResolveSceneSelection] =
    useState<ResolveSceneSelectionTarget | null>(null);
  const resolveSelectionNonceRef = useRef(0);
  const resolveSelectionFollow = useResolveSelectionFollow();
  useEffect(() => setResolveSceneSelection(null), [resolveSelectionFollow]);
  const resolveSelectionEventRef = useRef("");
  // 다빈치(미디어 풀)에서 마지막으로 고른 생성물 — 편집 탭의 풀·타임라인이 빨간 '다빈치' 표로 보인다(Jay 2026-10-14). 탭과 상관없이 둔다
  //  (편집 탭을 열기 전에 고른 것도 열면 보인다). 다빈치에서 선택을 풀면 빈다.
  const [resolvePicked, setResolvePicked] = useState<ReadonlySet<string>>(() => new Set());
  const resolvePickedRef = useRef(resolvePicked);
  // 편집 탭 타임라인을 그 클립까지 넘기라는 신호 — 표시와 달리 화면을 옮기는 일이라 '따라가는 탭'만 올린다(Codex 리뷰)
  const [resolveScroll, setResolveScroll] = useState(0);
  const resolveOpenPopupRef = useRef<ResolveOpenPopup | null>(null);
  // 캔버스 '생성 결과' 창이 떠 있나 — 창이 라이브러리 툴바·격자를 쓰므로 '폴더 보기' 창과 겹쳐 두지 않고(격자 둘이 같은
  //  바깥 끌기·키를 받는다), 보드 툴바의 태그 패널도 창 쪽 하나만 띄운다.
  const [variantOpen, setVariantOpen] = useState(false);
  const onResolvePopupChange = useCallback((popup: ResolveOpenPopup | null) => {
    resolveOpenPopupRef.current = popup;
    setVariantOpen(!!popup);
    if (popup) setFolderPeek(false);
  }, []);
  const resolveFollowerTabIdRef = useRef(
    `mvhub-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  useEffect(() => {
    // Resolve를 클릭하는 순간 브라우저는 OS 포커스를 잃는다. 그래서 "지금 포커스인가"가 아니라
    // 마지막으로 사용한 MV Hub 탭을 기억해 두고, 그 탭만 선택 이벤트를 따라가게 한다.
    const claim = () => {
      if (document.visibilityState !== "visible") return;
      try {
        if (
          localStorage.getItem("ch.resolve-follower-tab") !== resolveFollowerTabIdRef.current
        )
          localStorage.setItem("ch.resolve-follower-tab", resolveFollowerTabIdRef.current);
      } catch {
        // 저장소를 막은 브라우저는 보이는 탭 기준으로 동작한다.
      }
    };
    const claimIfActive = () => {
      if (document.hasFocus()) claim();
    };
    const release = () => {
      try {
        if (localStorage.getItem("ch.resolve-follower-tab") === resolveFollowerTabIdRef.current)
          localStorage.removeItem("ch.resolve-follower-tab");
      } catch {
        // 저장소를 막은 브라우저는 해제할 값도 없다.
      }
    };
    claimIfActive();
    window.addEventListener("focus", claim);
    window.addEventListener("pointerdown", claim, true);
    document.addEventListener("visibilitychange", claimIfActive);
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("focus", claim);
      window.removeEventListener("pointerdown", claim, true);
      document.removeEventListener("visibilitychange", claimIfActive);
      window.removeEventListener("pagehide", release);
    };
  }, []);
  // ── 캔버스별 워크스페이스(Jay 2026-09-11) ──────────────────────────────────
  //  씬 탭을 우클릭해 팀 워크스페이스를 지정하면, 다른 공간을 보고 있을 때 그 탭은 회색이고
  //  누르면 **그 공간으로 바꾸면서** 씬을 연다. 전환은 계정 메뉴와 같은 뜻이다 —
  //  이후 생성 요청에 그 공간이 실려 나가고, 에이전트가 제출 직전에 CLI 를 그 공간으로 맞춘다.
  //  ★이미 제출된 잡·대기 중인 잡은 영향 없다: 제출 시점에 힉스필드에서 확정되고, 대기 잡은
  //   요청에 박힌 공간으로 나간다(agent_push._ensure_request_workspace — 현재 CLI 값을 추측하지 않는다).
  // 공간이 바뀐 것을 알리는 한 줄 — 씬 탭·계정 메뉴가 같은 문구를 쓴다. 이름을 굵게 강조하고,
  // 개인 공간은 이름이 없어 "개인"으로 표기한다.
  const flashWorkspaceSwitched = useCallback(
    (name: string | null) =>
      flash(
        name ? (
          <>
            워크스페이스 <b className="toast-ws-name">{name}</b> — 이후 생성 크레딧은 이 공간에서
            차감됩니다.
          </>
        ) : (
          "워크스페이스 전환 — 이후 생성 크레딧은 이 공간에서 차감됩니다."
        ),
      ),
    [flash],
  );
  const selectSceneWithWorkspace = (id: string | null) => {
    selectScene(id); // 단일 관문(밀린 입력 flush 포함) — 씬은 언제나 먼저 연다
    if (!id) return;
    const scene = scenes.find((item) => item.id === id);
    const assigned = scene ? normalizeSceneWorkspace(scene.workspace) : undefined;
    if (!assigned) return; // 지정 없는 씬은 어느 공간에서나 연다
    if (workspaceContext.scope === "team" && (workspaceContext.id || "") === assigned.id) return;
    // ★전환은 **동기**다 — 허브에 아무것도 안 보낸다. 앱이 고른 공간이 곧 생성 대상이고,
    //  에이전트가 제출 직전에 요청에 박힌 그 공간으로 CLI 를 맞춘다(agent_push._ensure_request_workspace,
    //  2026-09-11 부터는 생성 호출의 HIGGSFIELD_WORKSPACE_ID 로 못 박는다).
    //  예전엔 여기서 허브에 `workspace set` 을 시켜 CLI 전역을 맞췄다 — 왕복 1.4초가 걸렸고,
    //  그 전역을 에이전트와 나눠 쓰는 바람에 '확인 뒤 제출 전' 에 끼어드는 과금 경합이 있었다.
    changeWorkspaceContext({ scope: "team", id: assigned.id, name: assigned.name });
    flashWorkspaceSwitched(assigned.name);
  };
  // 지금 보고 있는 캔버스에서 생성을 막아야 하는가 — 앱 공간이 그 캔버스의 지정 공간과 다를 때다
  //  (계정 메뉴로 딴 데 갔거나 지정 공간이 사라졌다). 어긋난 채로 만들면 의도하지 않은 공간에서
  //  크레딧이 빠진다. ★'CLI 전환 실패' 분기는 없앴다 — 허브가 더는 CLI 를 바꾸지 않아 실패할 게 없다.
  const activeSceneWorkspace = activeScene ? normalizeSceneWorkspace(activeScene.workspace) : undefined;
  const sceneWorkspaceBlock =
    activeScene && !sceneMatchesWorkspace(activeScene, workspaceContext)
      ? `이 캔버스는 '${activeSceneWorkspace?.name || "다른"}' 워크스페이스입니다. 탭을 다시 눌러 그 공간으로 바꾼 뒤 생성하세요.`
      : null;
  // 씬 탭 바 호버 → SceneBoard 좌상단 씬 패널(저장/불러오기) 표시 트리거(평소 숨김).
  const [sceneBarHover, setSceneBarHover] = useState(false);
  // 공유&리뷰 '새로 들어옴' — 항목 단위 확인(ack) 모델. 여기선 기준선만 보장한다(최초 진입 시각).
  // 글로우 판정·확인 처리는 ThumbnailGrid/GenerationCard 가 teamSeen 스토어를 직접 구독.
  useEffect(() => {
    if (filters.tab === "team") ensureTeamBase();
  }, [filters.tab]);
  // 캔버스 '방금 생성' glow — App 레벨에서 완료를 상시 감시(탭 전환·SceneBoard 언마운트와 무관).
  //  후보 = 활성 씬 생성·저장된 Comfy 카드의 변형 genId(새로고침 뒤 store가 빈 경우 발견 보완).
  const glowCandidateIds = useMemo(
    () =>
      (activeScene?.cards || [])
        .filter(
          (c) =>
            c.kind === "generation" ||
            (c.kind === "comfy" && Boolean(c.genIds?.length || c.genId)),
        )
        .flatMap((c) => variantIds(c)),
    [activeScene],
  );
  // 현재 SceneBoard의 id는 useSceneGenData가 담당하므로 App watcher에서만 제외한다. watcher 자체는
  // 계속 살아 있어 P34의 다른 씬 동시 렌더·히스토리 화면에서도 백그라운드 완료를 놓치지 않는다.
  //  편집 탭이 떠 있으면 SceneBoard 가 없다 — 그 id 도 App 감시가 맡아야 완료를 놓치지 않는다.
  const sceneBoardCoveredIds = filters.tab === "compose" && activeScene && !editOpen ? glowCandidateIds : [];
  useSceneCompletionWatcher(glowCandidateIds, { coveredIds: sceneBoardCoveredIds });
  // 배치수(한 번에 N장)를 App 이 보유 — 하단 프롬프트와 '카드 아래 Generate 버튼'이 공유. submit 은 ref 로 노출.
  const [batchCount, setBatchCount] = useState(1);
  // 프롬프트가 지금 보여주는 오류 — Ctrl+K 로 프롬프트를 숨겼을 때 하단 중앙에 대신 띄운다.
  const [promptError, setPromptError] = useState<string | null>(null);
  const spotlightPromptRef = useRef<SpotlightPromptHandle>(null);
  // 구성탭 히스토리 보드(계보 트리) 상태는 useHistoryBoardState 훅으로 추출.
  const {
    boardFocusId, setBoardFocusId, boardFocusIdRef,
    boardSignal, bumpBoard, boardArrange, setBoardArrange,
    boardSelected, setBoardSelected, boardSelectedRef,
    boardStats, setBoardStats, boardControl, lastBoardFocusRef,
  } = useHistoryBoardState(LS);
  const [info, setInfo] = useState<InfoTarget | null>(null); // 휠클릭 정보 팝업
  // 씬(캔버스) 툴바 카운트 — SceneBoard 가 생성카드 안 생성물(변형 전부) 중 타입 필터 통과 수를 보고.
  const [sceneTypeCount, setSceneTypeCount] = useState(0);
  const [commentGenId, setCommentGenId] = useState<string | null>(null); // 공유 코멘트 스레드 패널 대상
  const [syncTick, setSyncTick] = useState(0); // WS 'synced' 수신 카운터 — 열린 코멘트 패널 실시간 갱신용
  const [preview, setPreview] = useState<PreviewTarget | null>(null); // 클릭 미리보기
  const [folderPeek, setFolderPeek] = useState(false); // 캔버스 '폴더 보기' 창 — 규칙은 아래 folderSel 옆
  const folderPeekRef = useRef<HTMLElement>(null);
  const folderPeekOpenRef = useRef(folderPeek);
  folderPeekOpenRef.current = folderPeek;
  // 카드의 폴더 이름표로 연 '폴더 보기' 창(작업 공간·공유 & 리뷰, Jay 2026-10-07) — 캔버스 창과 같은 원리다: 창이 떠 있는
  //  동안 목록 조회가 그 폴더로 바뀌고(folderPeekQuery), 하나뿐인 격자·툴바·선택 막대를 창에 그린다. 닫으면 본 목록을
  //  처음부터 다시 받는다. 사이드바 필터(filters)는 건드리지 않는다 — patch() 는 다음 생성 위치까지 바꾼다.
  //  ctx = 연 시점의 문맥. 탭·보던 위치·휴지통 보기·계정·공간이 바뀌면 그 렌더부터 닫힌 것으로 본다(아래 listPeek).
  //  genId = 이름표를 누른 그 카드 — 창 안에서 '방금 누른 카드' 로 표시하고, 아래쪽에 있으면 보이게 내려가서 연다.
  //  edit = 편집 탭이 연 창(위 teamPeek) — genId 는 열릴 때 보이게 할 카드("" = 없음).
  //  묶음 보기의 컷 카드로 열면 그런 카드가 없다(null) — 표시도 이동도 없이 맨 위부터 보인다.
  const [folderWindow, setFolderWindow] = useState<{
    projectId: string | null; path: string; projectName: string; genId: string | null; ctx: string; edit?: boolean;
  } | null>(null);
  const [editReloadSignal, setEditReloadSignal] = useState(0); // 편집 탭이 연 창이 닫혔다 — 편집 탭이 공유 목록을 다시 받는다
  // 그 창의 카드에 붙는 표("V1 - 선택 카드") — 창이 떠 있는 동안 편집 탭이 넣고 바꾸는 대로 다시 알린다(창을 조회·스크롤과
  //  묶인 folderWindow 에 두지 않는다 — 표가 바뀔 때마다 창의 조회 조건이 새 객체가 된다). 창의 카드를 휠 클릭하면 편집 탭의
  //  트랙 메뉴를 연다(편집 탭이 ref 에 걸어 둔다).
  const [editMarks, setEditMarks] = useState<Record<string, CardMark>>({});
  const editCardMenuRef = useRef<EditCardMenu | null>(null);
  const openEditCardMenu = useCallback<EditCardMenu>((g, x, y) => editCardMenuRef.current?.(g, x, y), []);
  // 회색(비활성) — 카드별 비활성화 표시(d 키, gen id 기준 로컬). grayOn(useLibraryFilters)=ON 이면 목록에서 제외.
  const disabledGen = useDisabledGenerations();
  const disabledFolders = useDisabledFolders(); // 폴더 단위 비활성(그 폴더·하위 생성물 자동 회색)
  const [adminOpen, setAdminOpen] = useState(false); // 관리자 창(로고 클릭)
  const [mcpOpen, setMcpOpen] = useState(false);
  const [mcpLoaded, setMcpLoaded] = useState(false);
  const askPrompt = useAskPrompt(); // 플로팅 입력(네이티브 prompt 대체)
  const {
    account,
    apiPause,
    authConfig,
    authPending,
    authReady,
    finalizeProjects,
    hubAccount,
    leavePause,
    loggedOutElsewhere,
    logout,
    onProxyConnected,
    setAccount,
    sharedSrv,
  } = useHubAuth();
  useEffect(() => {
    if (authPending || !authReady || !hubAccount || apiPause || !hubHasFeature("edit_doc_backup_v1")) return;
    return startEditDocBackup();
  }, [authPending, authReady, hubAccount?.email, apiPause]);
  // 그룹 사용 모델 정책 — (공간, 로그인 이메일, 서버)가 바뀔 때만 다시 조회. 생성 창·캔버스 모델 노드·제출 가드가 함께 읽는다.
  useEffect(() => {
    configureModelPolicy({
      context: workspaceContext,
      email: hubAccount?.email ?? null,
      serverKey: sharedSrv?.url ?? "",
    });
  }, [workspaceContext, hubAccount?.email, sharedSrv?.url]);
  // genQuery(서버 쿼리)·selectionResetKey 는 useLibraryFilters 훅에서 파생(위 destructure).
  const { clearSelect, selected, selectedRef, setSelected, toggleSelect } = useGenerationSelection({
    resetKey: selectionResetKey,
  });
  const libraryAuthKey = JSON.stringify([hubAccount?.email, account?.email, account?.creator_uid, sharedSrv?.url]);
  useLayoutEffect(() => {
    configureOperationContext({ key: libraryAuthKey, ready: authReady && !apiPause && (!hubAccount?.email || getAccountNamespace() === `acct:${hubAccount.email}`),
      serverOrigin: sharedSrv?.url || window.location.origin,
      authority: authConfig?.auth_enabled ? "team" : "local" });
    return watchOperationContext();
  }, [libraryAuthKey, authReady, apiPause, sharedSrv?.url, authConfig?.auth_enabled]);
  useMcpCanvasTasks({ authReady, authKey: libraryAuthKey, workspace: workspaceContext, flushScenePending, refreshSceneById });
  // 보는 자리의 문맥(계정·서버·공간 범위) — 브라우저 기록(lib/useAppNavigation)과 공유 탭의 마지막 자리 기억이 같은 문맥의 자리만 되살린다.
  //  탭마다 센다 — 기록의 자리는 **그 기록의 탭**이 지금 갖게 될 문맥과 견준다(공유 탭의 폴더 → 작업 공간 탭 → 뒤로 가기).
  const locationCtxFor = useCallback(
    (tab: "my" | "team" | "compose") => JSON.stringify([libraryAuthKey, tab === "team" ? teamScopeKey : ""]),
    [libraryAuthKey, teamScopeKey],
  );
  const locationCtx = locationCtxFor(filters.tab);
  const currentLocation = useMemo(
    () => ({
      project_id: filters.project_id, folder_path: filters.folder_path,
      deleted_only: filters.deleted_only || undefined, include_deleted: filters.include_deleted || undefined, ctx: locationCtx,
    }),
    [filters.project_id, filters.folder_path, filters.deleted_only, filters.include_deleted, locationCtx],
  );
  // 공유 탭의 마지막 자리를 기억하는 문맥 — 확정된 자동 공간일 때만(전체 보기·공간 미확정은 저장도 복원도 안 한다, Codex 설계 검토)
  const teamMemoryCtx = teamAutoReady ? JSON.stringify([libraryAuthKey, teamScopeKey]) : "";
  const pushLocationRef = useRef(false); // 다음 자리 변경이 명시적 이동(컷 카드·사이드바를 눌러 들어감)인가 — 기록을 한 칸 쌓는다
  const previousWorkspaceView = useRef(workspaceScopeKey);
  useLayoutEffect(() => {
    if (previousWorkspaceView.current === workspaceScopeKey) return;
    previousWorkspaceView.current = workspaceScopeKey;
    if (filters.tab !== "team") return;
    setInfo(null);
    setPreview(null);
    setCommentGenId(null);
    setCompareGens(null);
    setVideoCompare(null);
    selectedRef.current = new Set();
    setSelected(new Set());
  }, [workspaceScopeKey, filters.tab]);
  // 휴지통 보기도 문맥이다 — 목록 훅은 filters.deleted_only 로 휴지통 조회를 고르는데 그 조회에는 폴더 조건이 없다(창에 휴지통 전체가 뜬다).
  const listPeekCtx = JSON.stringify([
    filters.tab, filters.project_id ?? null, filters.folder_path ?? null, !!filters.deleted_only, libraryAuthKey, workspaceScopeKey,
    editOpen, // 편집 탭에 들어가면 창은 닫힌 것으로 본다(창은 .body 밖에 그려지고 .body 를 inert 로 만든다)
  ]);
  const listPeekCtxRef = useRef(listPeekCtx);
  listPeekCtxRef.current = listPeekCtx;
  // 편집 탭이 연 창의 문맥 = 계정·공간뿐이다. 탭·위치는 창이 스스로 정하고(공유 & 리뷰·그 컷 폴더), 창 안에서 W(자동/전체)를
  //  바꾸는 것은 문맥 변경이 아니다 — 그것까지 넣으면 W 를 고르는 순간 창이 닫힌다(Codex 설계 검토).
  const editPeekCtx = JSON.stringify([libraryAuthKey, workspaceViewKey(workspaceContext)]);
  const editPeekCtxRef = useRef(editPeekCtx);
  editPeekCtxRef.current = editPeekCtx;
  const listPeek = folderWindow && (folderWindow.edit
    ? editOpen && teamPeek && folderWindow.ctx === editPeekCtx
    : folderWindow.ctx === listPeekCtx) ? folderWindow : null;
  const listPeekRef = useRef(listPeek);
  listPeekRef.current = listPeek;
  // 라이브러리 단축키(r/g/b/d·격자 키)는 편집 탭에서 쉰다 — 편집 탭이 연 폴더 창이 떠 있을 때만 듣는다(그때 편집 키는 쉰다).
  const libraryKeysOffRef = useRef(false);
  libraryKeysOffRef.current = editOpen && !listPeek;
  // 모양(리스트/그리드 · 리스트 한 번 더)은 **보는 폴더**마다 기억한다(Jay 2026-10-13 저녁 — lib/usePlaceView). 폴더 창이 떠 있으면 그 창의 폴더가
  //  보는 폴더다: 창 안에서 바꾼 모양은 그 폴더 것으로 적히고, 닫으면 뒤 화면은 제 모양 그대로다(뒤 폴더에 적히지 않는다 — Codex 코드 리뷰).
  //  창이 없을 때의 자리는 **저장된 탭**의 것이다 — 편집 탭이 연 창이 무효가 된 렌더(창은 닫혔는데 teamPeek 는 아직 참)에서는 filters.tab 이
  //  공유 & 리뷰라, 보지도 않은 공유 탭 자리에 모양이 적혔다(Codex 코드 리뷰).
  const { layout, setLayout, groupByDate, setGroupByDate, scale, setScale, fill, setFill,
    folders: cutView, setFolders: setCutViewState } = usePlaceView(LS, placeViewKey(
    listPeek ? { tab: filters.tab, project_id: listPeek.projectId ?? undefined, folder_path: listPeek.path } : { ...filters, tab: storedTab },
  ), { scale: legacyScale, fill: legacyFill, folders: LS.get("cutView", "1") === "1" });
  useEffect(() => {
    LS.set("scale", String(scale));
    LS.set("fill", fill ? "1" : "0");
    LS.set("cutView", cutView ? "1" : "0");
  }, [scale, fill, cutView]);
  const listGenQuery = useMemo(() => (listPeek ? folderPeekQuery(genQuery, listPeek) : genQuery), [genQuery, listPeek]);
  // 지금 화면의 자료 주인 — 아래(걸러진 목록까지 본 뒤)에서 판정해 커밋마다 적는다. 목록 훅은 다시 받을 때 이것을 읽는다(83회차 — 늦은 state 로
  //  넘기면 판정이 오기 전에 200건이 먼저 출발한다).
  const ownerRef = useRef<LibraryOwner | null>(null);
  const readOwner = useCallback(() => ownerRef.current, []);
  const readCutOwned = useCallback(() => ownerRef.current?.kind === "cut", []);
  // 창의 격자는 열 때마다 새로 마운트되므로 nonce 는 고정값이면 된다(한 번 열 때 한 번만 이동).
  const listPeekScroll = useMemo(() => (listPeek?.genId ? { generationId: listPeek.genId, nonce: 0 } : null), [listPeek]);
  const {
    archivedCount,
    facets,
    filtersRef,
    gens,
    gensRef,
    hasMore,
    listRevision,
    loadError,
    loadMore,
    loading,
    loadingMore,
    projects,
    projectsLoadedRef,
    reload,
    reloadIfStale,
    revealLocated,
    locatedVisibleIds,
    locatedSettle,
    isLocatedView,
    setFacets,
    setGens,
    beginComposeList,
    colorLedger,
    staleList,
    shownStaleCopy,
    listBehind,
    autoRefreshPaused,
    stats,
    unassignedCount,
  } = useGenerationLibraryData({
    authReady: authReady && workspaceQueryReady,
    authKey: libraryAuthKey,
    filters,
    flash,
    genQuery: listGenQuery,
    workspaceScopeKey,
    projectWorkspaceId,
    composeListEnabled: folderPeek, // 창이 열려 있을 때만 compose 탭에서 목록 조회·추가 로드
    owner: readOwner,
  });
  // ── 폴더 묶음 보기(공유 & 리뷰 탭, Jay 2026-10-08) ──
  //  폴더를 고르면 그 바로 아래 폴더(컷)마다 카드 한 장으로 보인다. 컷 카드 두 번 클릭 = 모아보기, 우클릭 = 그 폴더의 창(Jay 2026-10-13 낮 —
  //  아침의 ② '두 번 클릭 = 들어가기' 를 뒤집음), 에피소드 카드 두 번 클릭 = 들어가기. 창 안·들어간 낱장 목록의 카드 위 [대표] 로 그 폴더의
  //  대표(팀이 같이 보는 값 — 공유 서버가 권위)를 정한다. 묶어 보일 수 있는 조회인지는 lib/folderCards 가 정한다(무엇을 찾는 조건이 켜져
  //  있으면 지금처럼 한 장씩).
  //  shortcut: 안 거른 묶음 보기(서버 카드만)에서는 본 목록(한 장씩)도 지금처럼 받는다 — 그 화면의 유일한 갱신 신호다(옛 서버 채우기 포함).
  //   걸러 보는 컷 화면은 본 목록을 받지 않는다(아래 '이 화면의 자료 주인', 83회차). 안 거른 화면까지 줄이려면 서버 카드에 바뀜 신호가 필요하다.
  //  **찾는 조건(종류·작성자·태그·색·검색·회색 숨김…)이 켜져 있어도 묶음은 풀리지 않는다**(Jay 2026-10-13 저녁 — 전엔 조건이 하나라도 켜지면
  //  낱장이 됐다). 그때는 서버 카드(그 폴더의 전부를 센다) 대신 걸러진 목록을 따로 끝까지 받아 화면이 직접 묶는다(lib/useLocalFolderCards ·
  //  lib/folderCardsLocal). cutScope 는 '자리'(프로젝트·폴더·공간)다 — 찾는 조건과 무관하다.
  const cutScope = useMemo(() => folderCardsPlace(genQuery), [genQuery]);
  const cutFiltered = cutScope !== null && hasFindFilters(genQuery, grayOn);
  // 창이 떠 있으면 그 폴더의 부모를 받는다 — 그 폴더의 지금 대표를 알려고. 컷 카드로 연 창이면 뒤의 묶음과 같은 요청이다.
  const cardsScope = useMemo<FolderCardsScope | null>(() => {
    if (filters.tab !== "team" || !authReady || !workspaceQueryReady) return null;
    if (!listPeek) return cutView ? cutScope : null;
    if (!listPeek.projectId) return null;
    const workspaceId = singleTeamWorkspace(genQuery);
    return { projectId: listPeek.projectId, parent: parentFolder(listPeek.path), ...(workspaceId ? { workspaceId } : {}) };
  }, [filters.tab, authReady, workspaceQueryReady, listPeek, cutView, cutScope, genQuery]);
  // 폴더 카드를 다시 받는 신호 = 목록이 **같은 조회를 다시 받았을 때**(주기 조회·통보·내 조작 뒤의 다시 받기). 조회가 바뀌어(폴더 이동·찾는 조건·
  //  폴더 창) 받은 첫 쪽은 변경 통보가 아니다 — 자리가 바뀐 것은 훅이 스스로 받는다. 둘 다 따라가면 폴더를 옮길 때마다 같은 묶음 조회가 두 번
  //  나간다(아래 두 훅이면 네 번 — Codex 코드 리뷰 10-13).
  //  주인(아래 cutOwns — 커밋된 값)도 조회의 일부다 — 컷 화면이 주인이던 동안 뒤 목록을 되찾은 첫 적용은 같은 조회의 재갱신이 아니다
  //  (그동안의 서버 카드는 컷 쪽 갱신이 같이 받았다, Codex FE-05).
  const [ownerKind, setOwnerKind] = useState<LibraryOwner["kind"]>("list");
  const listQueryKey = useMemo(
    () => JSON.stringify([libraryAuthKey, workspaceScopeKey, listGenQuery, ownerKind]), [libraryAuthKey, workspaceScopeKey, listGenQuery, ownerKind],
  );
  const cardsReloadKey = useSameQueryRevision(listQueryKey, listRevision);
  const {
    cards: folderCards, unsupported: folderCardsUnsupported, loading: folderCardsLoading, reload: reloadFolderCards, refresh: refreshFolderCards,
  } = useFolderCards({
    scope: cardsScope, authKey: libraryAuthKey, reloadKey: cardsReloadKey,
  });
  // 지금 고른 자리의 서버 카드(안 거른 것) — 어느 폴더가 묶음인지·팀이 정한 대표가 무엇인지의 근거다.
  const baseHere =
    cutView && cutScope && cardsScope && folderCards &&
    cardsScope.projectId === cutScope.projectId && cardsScope.parent === cutScope.parent &&
    cardsScope.workspaceId === cutScope.workspaceId
      ? folderCards
      : null;
  // 목록에서 직접 묶을 때 — ① 걸러 보는 중(서버는 걸러진 범위를 못 센다) ② 옛 공유 서버(새 집계 칸이 없다 — 그 칸만 목록에서 세어 채운다).
  //  자료는 본 목록 훅의 것이 아니라 따로 끝까지 받는다(그 목록은 첫 쪽으로 줄고 폴더 창에 빌려 준다). 본 목록은 '바뀜 신호'로만 쓴다 —
  //  지금 조회의 것일 때만(창·사본·옛 조회·위치 주입의 목록은 신호가 아니다). 옛 서버(경로 없음)는 전처럼 묶지 않는다.
  //  옛 서버 채우기는 그 자리의 전부를 받을 수 있을 때만(상한 안) — 잘린 목록으로 센 값은 서버 건수와 어긋난다.
  const fillable = baseHere !== null && lacksCounts(baseHere)
    && baseHere.folders.reduce((sum, folder) => sum + folder.count, baseHere.own_count) <= FETCH_ALL_MAX;
  const localWanted = cutView && cutScope !== null && filters.tab === "team" && authReady && workspaceQueryReady && !folderCardsUnsupported
    && (cutFiltered || fillable);
  //  신호 = 첫 쪽의 내용 서명(객체가 아니라 내용 — 폴더 창을 닫으며 목록 훅이 만드는 사본 배열에 다시 받지 않게) + 서버 카드 객체.
  const listSig = useMemo(() => gens.map((g) => `${g.id}${g.is_final ? "f" : ""}${g.is_held ? "h" : ""}`).join(","), [gens]);
  const listOurs = !listPeek && !staleList && !listBehind && !isLocatedView; // 본 목록이 지금 조회의 것인가
  const local = useLocalFolderCards({
    place: localWanted ? cutScope : null, query: genQuery, authKey: libraryAuthKey,
    listSig: listOurs ? listSig : null, base: baseHere,
    // 옛 서버 채우기는 본 목록의 첫 쪽이 온 뒤에 출발한다 — 자리를 옮긴 직후 화면을 세우는 응답과 큰 요청이 겹치지 않게(걸러 보기는 바로)
    ready: cutFiltered || listOurs,
  });
  // 회색 숨김·비활성은 받은 것 위에서 다시 거른다(다시 받지 않는다 — 낱장 격자의 gridGens 와 같은 식).
  const localVisible = useMemo(
    () => local.gens && filterDisabledGenerations(local.gens, expandDisabledGenerationIds(local.gens, disabledGen, disabledFolders), grayOn),
    [local.gens, disabledGen, disabledFolders, grayOn],
  );
  //  서버 카드를 알기 전에는 묶지 않는다 — 하위 폴더 수(구조)를 모른 채 묶으면 에피소드가 잠깐 '컷'으로 보여 두 번 클릭이 들어가기 대신
  //  모아보기를 연다(Codex 코드 리뷰). 그동안은 서버 카드를 기다리는 빈 자리(cutLoading)다.
  const localCards = useMemo(
    () => (localVisible && cutScope && baseHere ? groupGenerations(localVisible, cutScope.projectId, cutScope.parent, baseHere) : null),
    [localVisible, cutScope, baseHere],
  );
  // ── 이 화면의 자료 주인(83회차 — Codex FH 1~4절) ──
  //  걸러 보는 컷 화면 — 서버 카드로 이 자리에 하위 폴더가 있음을 알고, 지금 조회로 거른 결과에도 묶을 폴더가 있거나 아직 모른다 — 은 걸러진 목록과
  //  서버 카드가 화면의 자료다. 본 목록 훅은 그 조회의 목록(200건 원문)을 보내지 않고 다시 받기(주기·통보·내 조작·창 복귀)를 이쪽에 맡긴다.
  //  그 밖(폴더 창·위치 주입·[전체]·옛 서버·서버 카드를 아직 모름·거른 결과에 폴더가 없어 낱장)은 본 목록이 주인이다. 서버 카드를 모르는 첫 진입은
  //  전처럼 둘 다 받는다(그 자리에 하위 폴더가 있는지 모른다) — 카드가 와서 주인이 바뀌어도 목록 요청을 더 만들지 않는다(Codex FF-03).
  const cutOwns = filters.tab === "team" && !listPeek && !isLocatedView && !folderCardsUnsupported && cutFiltered && localWanted
    && baseHere !== null && baseHere.folders.length > 0 && !(local.fresh && localCards !== null && localCards.folders.length === 0);
  const ownerSig = JSON.stringify([!!filters.deleted_only, listGenQuery]); // 목록 훅의 sig 꼴 — 이 판정이 어느 조회의 것인가
  const localRequest = local.request;
  const localContext = local.contextKey; // 조회 + 회차 — 컷 쪽 결과가 지금 주인의 것인지(A → B → A 의 옛 A 결과를 가린다, Codex fix8 P2)
  const localSide = cutFiltered && localWanted; // 낱장이어도 걸러진 목록이 표시 형태(묶음/낱장)를 정한다 — 실제 바뀜은 그쪽에도 넘긴다
  useLayoutEffect(() => {
    ownerRef.current = cutOwns
      ? { kind: "cut", sig: ownerSig, key: localContext(), request: (intent) => localRequest(intent, refreshFolderCards) }
      : { kind: "list", sig: ownerSig, key: null, request: localSide ? () => localRequest("invalidate") : null };
  });
  useLayoutEffect(() => {
    setOwnerKind(cutOwns ? "cut" : "list");
  }, [cutOwns]);
  // 본문에 그릴 묶음 — 하위 폴더가 하나라도 있을 때만. 창이 떠 있어도 뒤에 그대로 둔다.
  //  · 걸러 보는 중: 걸러진 목록을 묶은 것. 지금 조회의 답이 아직이면 같은 자리의 앞 결과(local 이 쥐고 있다)를, 그것도 없으면(막 켰다) 안 거른
  //    서버 카드를 그대로 둔다 — **같은 자리에서 조건만 바뀌는 동안 묶음이 null 이 되면 안 된다**: 낱장이 번쩍이고 고른 것이 지워진다(규칙 55).
  //    도구 줄이 '거르는 중…'을 알린다(cutFiltering).
  //  · 옛 서버: 서버 카드 그대로 두고, 목록을 끝까지 받았으면(잘리지 않았을 때만) 없는 칸을 채운다.
  const cutFiltering = cutFiltered && localWanted && !local.fresh && local.loading; // 지금 조회로 거른 답을 아직 모른다
  const shownCards = useMemo(() => {
    if (cutFiltered) {
      if (local.fresh) return localCards; // 지금 조회의 답 — 묶을 폴더가 없으면 낱장
      // 받는 중·받지 못함 — 같은 자리의 앞 결과를, 그것이 없거나 묶을 것이 없었으면 안 거른 서버 카드를 그대로 둔다
      return localCards && localCards.folders.length > 0 ? localCards : baseHere;
    }
    if (baseHere && fillable && localCards && local.fresh && !local.truncated) return fillFolderCards(baseHere, localCards);
    return baseHere;
  }, [cutFiltered, localCards, baseHere, fillable, local.fresh, local.truncated]);
  const cutCards = shownCards && shownCards.folders.length > 0 ? shownCards : null;
  const cutMode = cutCards !== null;
  // ── 폴더를 옮기는 동안(Jay 2026-10-13 ③ 깜빡임 → "아직 딜레이") ──
  //  묶음 보기에서 자리(프로젝트·폴더)를 옮기면 서버 답 둘(묶음·목록)이 오기 전의 화면이 문제다. 낱장 격자는 옛 자리의 목록을 들고 있어
  //  그대로 그리면 '전체 카드가 한 번 보였다가' 바뀐다. 그래서:
  //   · 묶음 답을 모르는 동안(cutLoading)은 격자 자리를 비운다 — 다시 온 폴더·컷은 `useFolderCards` 의 기억이 바로 답해 이 구간이 없다.
  //   · 목록이 아직 옛 조회의 것인 동안(narrowing)은 **이미 받아 둔 더 넓은 목록**(에피소드의 첫 쪽 — 아래 widePoolRef)에서 새 자리에 드는
  //     것만 골라 먼저 보인다(컷으로 들어갈 때 서버를 기다리지 않는다). 고른 것은 새 목록의 앞부분이다(둘 다 최신 순). 낡았을 수 있어 그동안은
  //     격자를 잠근다(staleList 와 같은 잠금 — listLocked)·더 받기도 쉰다. 고를 것이 없으면 자리를 비운다(cutPending).
  //  조회가 실패하면 꺼져 낱장으로(옛 서버는 unsupported). 창이 떠 있으면 격자는 창의 것이라 무관. 위치 주입(다빈치 따라가기)·사본·실패 화면은
  //  목록 훅이 캐시를 지운 구간이라 listBehind 가 참이어도 건드리지 않는다.
  //  이 둘은 **자리를 옮긴 뒤 그 자리의 화면이 다 설 때까지만** 한다(moved). 자리는 그대로 두고 보기 필터만 바꾼 때는 전처럼 옛 목록을 새 목록이
  //  올 때까지 보인다 — 필터 변경은 선택을 남기므로(규칙 55), 화면을 비우거나 바꿔 그리면 보이지 않는 선택에 선택 막대·전역 단축키가 걸린다
  //  (Codex 코드 리뷰). 자리를 옮기면 선택은 이미 비어 있고 잠긴 격자에서는 새로 생기지 않는다. '다 섰다' = 목록이 지금 조회의 것이고 묶음 답도
  //  안다 — 둘 중 하나만 온 때에 풀면 그 자리의 낱장이 잠깐 섰다가 컷 카드로 바뀐다(③).
  const cutWaiting = cutView && !listPeek && cardsScope !== null && !folderCardsUnsupported;
  const hereKey = JSON.stringify([filters.tab, filters.project_id ?? null, filters.folder_path ?? null, !!filters.deleted_only]);
  const seenHereRef = useRef(hereKey);
  const settledHereRef = useRef<string | null>(null);
  if (seenHereRef.current !== hereKey) {
    // 자리를 떠났다 — 되돌아와도 다시 서야 한다. 남기면 빠른 A→B→A 에서(B 는 목록만 오고 묶음 답은 아직) A 가 '선 자리'로 보여 B 의 목록이
    //  A 에 그대로, 잠금 없이 선다(Codex 31회차). 렌더 중 ref 갱신 — 같은 값이면 아무 일도 없어 두 번 그려도 같다.
    seenHereRef.current = hereKey;
    settledHereRef.current = null;
  }
  useEffect(() => {
    // '다 섰다' = 지금 조회·지금 주인의 자료가 왔다 — 컷 화면이 주인이면 걸러진 목록의 지금 조회 답, 아니면 본 목록의 지금 조회 첫 쪽.
    //  목록을 받지 않는 것은 증거가 아니다(Codex FE-02). 창이 떠 있으면 목록은 창의 것이다 — 적지 않는다(창은 자리를 바꾸지 않는다)
    const ready = cutOwns ? local.fresh : !listBehind;
    if (ready && !listPeek && !(cutWaiting && folderCardsLoading)) settledHereRef.current = hereKey;
  });
  const moved = settledHereRef.current !== hereKey;
  const cutLoadingRaw = cutWaiting && folderCardsLoading && moved;
  // 자리를 옮긴 뒤 새 목록이 오기 전(공유 탭) — 화면의 낱장은 옛 자리의 것이거나 아래에서 먼저 고른 것이다. **잠금은 묶어 보일 수 있는지와
  //  무관하다**: 기다리는 사이 검색어를 치면 묶음 조건이 풀리는데, 그때 잠금까지 풀면 옛 자리의 카드가 눌린다(Codex 31회차).
  //  먼저 골라 그리기(narrowing)·자리 비우기만 묶음 보기의 것이다. **조회를 보낼 수 있을 때만** — 공간을 아직 모르면(workspaceQueryReady 거짓)
  //  조회가 나가지 않아 목록이 영영 안 오고, 그 화면의 [전체 보기](main 안)까지 잠긴다(Codex 31회차 코드 리뷰).
  //  컷 화면이 주인인 동안은 본 목록을 기다리지 않는다(받지 않는다) — 낱장으로 넘어간 때부터 잰다.
  const behindRaw = !cutOwns && authReady && workspaceQueryReady && filters.tab === "team" && !listPeek && moved && !!listBehind
    && !staleList && !isLocatedView && !loadError;
  // 기다림은 길어야 LIST_WAIT_MAX_MS — 응답이 실패도 없이 매달리면(허브가 멎는 등) 자리를 비우거나 잠근 채로 남는다. 그 뒤엔 오늘 고치기 전처럼
  //  화면의 목록을 그대로 보이고 누르게 둔다(Codex 31회차 코드 리뷰 — 요청 자체의 제한 시간은 없다, 기록만). 자리마다 따로 잰다.
  const waitingAfterMove = cutLoadingRaw || behindRaw;
  const [waitExpiredAt, setWaitExpiredAt] = useState<string | null>(null);
  useEffect(() => {
    if (!waitingAfterMove) {
      setWaitExpiredAt(null);
      return;
    }
    const timer = window.setTimeout(() => setWaitExpiredAt(hereKey), LIST_WAIT_MAX_MS);
    return () => window.clearTimeout(timer);
  }, [waitingAfterMove, hereKey]);
  const waitExpired = waitExpiredAt === hereKey;
  const cutLoading = cutLoadingRaw && !waitExpired;
  const behindAfterMove = behindRaw && !waitExpired;
  const narrowing = cutWaiting && behindAfterMove;
  // ── 낱장 목록에서 나오는 잠금(main inert·고르기 잠금·더 받기 가리기)은 **낱장 격자를 실제로 그릴 때만** 건다(listShown) — 컷 카드가 보이는 동안에는 컷 카드·
  //  전환 단추를 잠그지 않는다(뒤에 숨은 본 목록의 상태는 컷 카드와 무관하다 — Codex FE-01·fix8d·fix8e). 낱장 유래 입력은 셋이다:
  //   · staleList — 폴더 창을 닫은 직후 옛 첫 쪽 사본을 보이는 중(새 첫 쪽이 오면 풀린다)
  //   · shownStaleCopy — 컷 화면의 갱신으로 낡았다고 알려진 사본(목록 훅). 자리 이동·기다림 한도(4초)와 무관하게 새 응답·실패 정리 때 풀린다(목록 요청은
  //     30초 제한 — 81회차 15A, Codex fix8b·fix8c)
  //   · behindAfterMove — 자리를 옮긴 뒤 새 첫 쪽 전(4초 한도 — 31회차: 앞 자리에서 실제로 받은 목록은 4초 뒤 누르게 둔다. 위 사본이 아닐 때 그대로다)
  //  컷 화면이 주인이면(cutOwns) 낱장이 없다. 컷 화면 자체의 기다림(cutLoading·cutPending)은 잠금이 아니라 자리 비움이다.
  const listShown = !cutMode;
  const listGate = listShown && (staleList || shownStaleCopy || behindAfterMove);
  const listLocked = !cutOwns && listGate;
  // 창이 보여 주는 폴더의 지금 대표 — 표지가 '가장 최근 것' 일 뿐이면 대표가 아니다(null).
  const peekFolderCard = listPeek ? folderCards?.folders.find((folder) => folder.path === listPeek.path) : undefined;
  const peekCoverId = peekFolderCard?.rep ? peekFolderCard.cover.id : null;
  // 들어간 폴더의 지금 대표 — 본 목록의 카드 위에 [대표]를 그린다(Jay 2026-10-13 ② A안: 사이드바로 컷에 들어가도 대표를 정할 수 있게 —
  //  낮에 두 번 클릭은 모아보기로 바뀌었지만 이것은 남긴다). 그 폴더 자신은 **부모**의 컷 카드 목록에 한 줄로 든다 — 부모 범위를 따로 받는다(위 cardsScope 는 하위 묶음용
  //  그대로, 저장 뒤엔 둘 다 다시 읽는다). 프로젝트 맨 위·휴지통·폴더 창이 떠 있는 동안은 없다. ponytail: 폴더에 들어가면 조회가 하나 더 간다(부모).
  const ownScope = useMemo<FolderCardsScope | null>(() => {
    if (filters.tab !== "team" || !authReady || !workspaceQueryReady || listPeek || filters.deleted_only) return null;
    if (!filters.project_id || filters.project_id === "none" || !filters.folder_path) return null;
    const workspaceId = singleTeamWorkspace(genQuery);
    return { projectId: filters.project_id, parent: parentFolder(filters.folder_path), ...(workspaceId ? { workspaceId } : {}) };
  }, [filters.tab, filters.project_id, filters.folder_path, filters.deleted_only, authReady, workspaceQueryReady, listPeek, genQuery]);
  const { cards: ownCards, reload: reloadOwnCards, refresh: refreshOwnCards } = useFolderCards({ scope: ownScope, authKey: libraryAuthKey, reloadKey: cardsReloadKey });
  // 컷 화면이 주인인 동안 부모 범위의 카드(들어간 폴더의 [대표])는 다시 받지 않았다 — 컷 쪽 갱신은 하위 묶음 카드만 받는다. 본 목록이 주인을 되찾으면
  //  (폴더 창 아님) 한 번 다시 받는다. 되찾은 첫 적용은 갱신 신호에서 빠지므로 그대로 두면 다음 주기 조회까지 옛 [대표]가 남는다(Codex fix8 P2).
  //  건너뛰는 것은 **넘김과 같은 커밋에 부모 범위가 바뀐 때**뿐이다 — 그 이동이 바뀐 범위를 방금 묻는다(받는 중에 얹으면 같은 부모를 두 번 묻는다, fix8b P2).
  //  그 앞의 이동 이력(A → B → A 등)으로는 건너뛰지 않는다 — 그 조회 뒤에 대표가 바뀌었을 수 있다(fix8c P2).
  const ownKey = ownScope ? JSON.stringify([ownScope.projectId, ownScope.parent, ownScope.workspaceId ?? null]) : null;
  const ownCutRef = useRef({ cut: cutOwns, key: ownKey });
  useEffect(() => {
    const was = ownCutRef.current;
    ownCutRef.current = { cut: cutOwns, key: ownKey };
    if (was.cut && !cutOwns && !listPeek && was.key === ownKey) void refreshOwnCards();
  }, [cutOwns, listPeek, ownKey, refreshOwnCards]);
  const ownFolderCard = ownScope ? ownCards?.folders.find((folder) => folder.path === filters.folder_path) : undefined;
  const ownCoverId = ownFolderCard?.rep ? ownFolderCard.cover.id : null;
  // 한 장씩 → 묶음으로 바뀌는 순간 고른 것을 비운다 — 남기면 보이지 않는 카드에 삭제·공유가 걸린다.
  //  (묶음 화면에는 격자가 없어 새로 고를 길도 없다. 창이 떠 있으면 고른 것은 창의 카드라 건드리지 않는다.)
  useLayoutEffect(() => {
    if (!cutMode || listPeekRef.current) return;
    selectedRef.current = new Set();
    setSelected(new Set());
  }, [cutMode]);
  const setCutView = useCallback((on: boolean) => {
    LS.set("cutView", on ? "1" : "0");
    setCutViewState(on);
  }, [setCutViewState]);
  // ── 컷 카드 고르기 · 컷 정보(휠 클릭) · 모아보기(Jay 2026-10-08) ──
  //  고른 것은 폴더 경로의 집합. 그릴 때 지금 카드로 걸러(없어진 폴더는 저절로 빠진다) 격자 순서의 목록을 만든다. 묶음의 범위
  //  (프로젝트·부모·공간)가 바뀌면 비운다. 두 창(컷 정보·모아보기)은 폴더 창처럼 연 시점의 문맥(listPeekCtx)을 들고 있어
  //  문맥이 바뀌면 그 렌더부터 닫힌 것으로 본다 — 다른 프로젝트의 같은 이름 폴더에 잘못 붙지 않게(Codex 설계 검토).
  //  창이 보여 주는 카드는 늘 지금 받아 둔 카드다(대표를 바꾸면 카드가 새로 와서 창도 새 값).
  const [cutSel, setCutSel] = useState<Set<string>>(() => new Set());
  const [cutInfo, setCutInfo] = useState<{ projectId: string; path: string; x: number; y: number; ctx: string } | null>(null);
  const [cutReel, setCutReel] = useState<{ paths: string[]; ctx: string } | null>(null);
  const [reelMode, setReelModeState] = useState<ReelMode>(() => (LS.get("cutReelMode", "grid") === "linked" ? "linked" : "grid"));
  const setReelMode = useCallback((mode: ReelMode) => {
    LS.set("cutReelMode", mode);
    setReelModeState(mode);
  }, []);
  const cutScopeKey = cutCards && cutScope ? JSON.stringify([cutScope.projectId, cutScope.parent, cutScope.workspaceId ?? null]) : null;
  useLayoutEffect(() => {
    setCutSel(new Set());
  }, [cutScopeKey]);
  const selectedCuts = useMemo(
    () => (cutCards ? cutCards.folders.filter((folder) => cutSel.has(folder.path)) : []),
    [cutCards, cutSel],
  );
  // 걸러 본 답이 끝까지 온 순간, 화면에 없는 폴더는 고른 것에서 뺀다(검색으로 가려진 카드를 선택에서 빼는 규칙과 같게) — 안 빼면 조건을 풀 때
  //  안 보이던 선택이 되살아난다. 받는 중(앞 결과·안 거른 카드를 보이는 동안)에는 빼지 않는다.
  useEffect(() => {
    if (!cutFiltered || !local.fresh || !cutCards) return;
    setCutSel((previous) => {
      const kept = [...previous].filter((path) => cutCards.folders.some((folder) => folder.path === path));
      return kept.length === previous.size ? previous : new Set(kept);
    });
  }, [cutFiltered, local.fresh, cutCards]);
  const cutInfoFolder = cutInfo && cutInfo.ctx === listPeekCtx && cutScope?.projectId === cutInfo.projectId
    ? cutCards?.folders.find((folder) => folder.path === cutInfo.path) ?? null
    : null;
  // 창의 조회 조건은 연 폴더(경로)와 지금 조회로만 — 카드가 다시 와서 folder 객체가 바뀌어도 조건은 같다(같으면 창이 다시 받지 않는다).
  const cutInfoQuery = useMemo(
    () => (cutInfo ? folderPeekQuery(genQuery, { projectId: cutInfo.projectId, path: cutInfo.path }) : null),
    [cutInfo, genQuery],
  );
  const cutReelFolders = useMemo(
    () => (cutReel && cutReel.ctx === listPeekCtx && cutCards ? cutCards.folders.filter((folder) => cutReel.paths.includes(folder.path)) : []),
    [cutReel, listPeekCtx, cutCards],
  );
  const cutReelOpen = cutReelFolders.length > 0;
  // 문맥이 바뀌어 무효가 된 창은 상태도 치운다(폴더 창과 같다).
  useEffect(() => {
    if (cutInfo && !cutInfoFolder) setCutInfo(null);
  }, [cutInfo, cutInfoFolder]);
  useEffect(() => {
    if (cutReel && !cutReelOpen) setCutReel(null);
  }, [cutReel, cutReelOpen]);
  // 캔버스(compose 탭)에서 태그하면 scheduleTagReload 가 compose·light 라 facets 를 안 불러와
  // '등록된 태그' 패널이 탭을 나갔다 와야 갱신되던 문제 → 새 태그 이름을 facets.tags 에 낙관적 병합해 즉시 반영.
  const mergeFacetTags = useCallback(
    (names: string[]) =>
      setFacets((f) => {
        const tags = uniqueTagNames([...f.tags, ...names]);
        return tags.length === f.tags.length && tags.every((tag, index) => tag === f.tags[index])
          ? f
          : { ...f, tags };
      }),
    [setFacets],
  );
  const { prepareCanvasGenerationBatch, prepareCanvasGeneration, confirmCanvasGeneration, settleCanvasGeneration, discardCanvasGeneration } =
    useCanvasGenerationLinks({ authReady, scenes, canvasDocument, setGens });
  const selectedGenerations = useMemo(() => generationsByIds(gens, selected), [gens, selected]);
  // 목록에서 사라진 카드는 선택에서도 뺀다(조작 규칙 42). 선택은 id 집합이라, 다른 폴더로 담거나 다른 창에서 지우거나 자동 새로고침으로
  //  목록에서 빠진 카드가 그대로 남았다 — 남은 카드를 더 골라 지우면 보이지 않는 그 카드까지 지워졌다(삭제·복원·담기·색·d 는 선택 id 를
  //  그대로 쓴다). 숨김 필터로 가린 카드(Ctrl+A 가 고른 것)는 목록에 있으므로 남는다. 그리기 전에 맞춘다 — 낡은 선택으로 조작이 나갈 틈이 없게.
  useLayoutEffect(() => {
    if (selectedGenerations.length === selected.size) return;
    setSelected(new Set(selectedGenerations.map((generation) => generation.id)));
  }, [selectedGenerations, selected, setSelected]);

  const {
    assignSelectedToProject,
    boardAssign,
    dropOnFolder,
    dropUnassign,
  } = useGenerationProjectActions({
    bumpBoard,
    filtersRef,
    flash,
    reload,
    selectedRef,
  });

  // 모든 필터(project_id·컬러·태그·타입 포함)가 서버 쿼리에 들어가므로, 무엇이 바뀌든
  // 첫 페이지부터 다시 받는다(무한 스크롤 누적 초기화). 서버가 거르니 누락 없이 정확.
  const serverFilterKey = useMemo(() => generationQueryKey(listGenQuery), [listGenQuery]);
  // 필터 변경 또는 인증 준비(로그인 완료/차단 off) 시 데이터 로드. 한 effect 로 합쳐 마운트 시
  // 중복 reload(예전엔 이 effect + 별도 authReady effect 가 둘 다 발화 → 2회) 제거. reload 내부가
  // authReadyRef 로 게이트하므로 authReady 가 false 면 no-op, true 로 바뀌면 여기서 다시 발화해 로드.
  // filters.tab 도 의존성에 포함 — compose 는 서버 쿼리상 'my' 로 합쳐져 serverFilterKey 가 같으므로,
  // 이게 없으면 compose→내작업 전환 때 즉시 reload 가 안 돌고 3초 폴링이 뒤늦게 채운다(전환 딜레이 원인).
  const reloadedWorkspaceScopeRef = useRef(projectWorkspaceId);
  useEffect(() => {
    const projectScopeChanged = reloadedWorkspaceScopeRef.current !== projectWorkspaceId;
    reloadedWorkspaceScopeRef.current = projectWorkspaceId;
    // 공간/필터를 한 번에 반영한다. my/compose의 목록 조건이 같아도 프로젝트는 다시 받는다.
    //  자료 주인이 바뀌어도(cutOwns) 새 주인의 진입이다 — 낱장으로 넘어가면 본 목록이 그 조회의 첫 쪽을 받고, 컷 화면이 되면 걸러진 목록에 합류한다.
    if (projectScopeChanged) void reload(true);
    else void reloadIfStale();
  }, [serverFilterKey, filters.tab, authReady, libraryAuthKey, reloadIfStale, reload,
    projectWorkspaceId, workspaceScopeKey, workspaceQueryReady, cutOwns]);

  // 프로젝트 미배정 = Supervisor 개념이 없음 → 본인 것이면 최종 가능(백엔드 require_edit 와 일치).
  const canFinalize = (g: Generation) => canFinalizeGeneration(g, finalizeProjects);

  // 등급 S 다중선택 — 카드 S(단일/더블)를 선택 전체에 한 칸씩 적용(공유/최종). 인앱 확인 모달.
  const grade = useGradeStep({
    canFinalize,
    reload: async () => {
      await reload();
    },
    flash,
  });
  const onBulkGradeStep = (mode: GradeMode) => grade.requestGradeStep(selectedGenerations, mode);


  // WebSocket 진행률: 상태 전이 메시지를 받으면 해당 카드만 갱신하고, 놓친 전이는 reload 로 따라잡는다.
  useGenerationProgress({
    enabled: !!hubAccount,
    gens,
    scopeKey: JSON.stringify([libraryAuthKey, authReady && workspaceQueryReady, workspaceScopeKey]),
    setGens,
    reload,
    bumpBoard,
    setSyncTick,
    historyBoardVisible: filters.tab === "compose" && !activeScene,
    commentsVisible: commentGenId !== null,
    colorLedger, // 완료 뒤 상세 조회의 응답도 색 장부를 탄다 — 출발 뒤에 칠한 색을 덮지 않게(규칙 6)
    cutOwned: readCutOwned, // 걸러 보는 컷 화면이 주인이면 완료 통지는 그쪽을 다시 받게 한다(목록 setter 로는 그 화면에 닿지 않는다)
  });

  // 진행중 잡·팀 탭 폴링 + 탭 재포커스 새로고침.
  // 새 첫 쪽을 기다리는 동안(폴더 창을 닫은 직후 staleList · 바뀐 조회의 첫 쪽 — 목록 훅의 autoRefreshPaused)에는 자동 조회를 쉰다
  //  — 끼어들면 받던 첫 쪽을 버리고 같은 목록을 한 번 더 받는다.
  //  걸러 보는 컷 화면이 주인이면 활성 잡은 그쪽이 쥔 행 전체로 보고(뒤 목록은 앞 조건의 것이다), 쉬지 않는다 — 그쪽의 확인은 받는 중이면 합류해
  //  받던 응답을 버리지 않는다. 숨은 본 목록의 사본·대기로 컷 화면의 갱신이 멈추지 않게(Codex FE-01).
  useGenerationAutoRefresh({
    generations: cutOwns ? local.gens ?? NO_GENERATIONS : gens, tab: filters.tab, reload, paused: !cutOwns && autoRefreshPaused,
  });

  // 코멘트 배지 실시간 갱신: 공유 카드의 미확인 여부만 가볍게 주기 조회해 제자리 갱신.
  // 새 미확인이 잡히면 syncTick 을 올려 열린 코멘트 패널도 즉시 새로고침.
  // ★격자가 실제로 떠 있을 때만 돈다 — 캔버스는 '폴더 보기' 를 열었을 때만 같은 격자를 쓴다.
  //  탭으로 판단하면 그 폴더 보기가 빠진다(2026-09-12).
  useCommentBadgePoll({
    generations: gens,
    setGens,
    gridVisible: filters.tab !== "compose" || folderPeek,
    openCommentGenId: commentGenId,
    onNewUnread: () => {
      setSyncTick((t) => t + 1);
      void reload(true, true, "check"); // 공유 카드 폴링이 새 코멘트를 잡으면 전역 벨 stats도 같은 값으로 갱신(목록은 확인 — 묶음이 바뀐 것은 아니다)
    },
  });

  const {
    composerExpanded,
    promptVisible,
    toggleComposerExpanded,
  } = usePromptDock(LS, editOpenRef);
  usePageSelectAllGuard(); // 입력칸 밖의 Ctrl+A 가 화면 글자를 긁지 않게(lib/keyGate)

  const {
    onBulkAddAutoTags,
    onBulkAddTags,
    onBulkRemoveAutoTags,
    onBulkRemoveTags,
    onSetAutoTags,
    onSetTags,
  } = useGenerationTagActions({
    flash,
    gensRef,
    onTagNamesAdded: mergeFacetTags,
    reload,
    selectedRef,
    setGens,
  });
  const { onWorkspaceCommand } = useGenerationWorkspaceActions({
    activeWorkspaceIds: genQuery.workspace_ids,
    activeWorkspaceScope: genQuery.workspace_scope,
    flash,
    gensRef,
    reload,
    selectedRef,
    setGens,
    setSelected,
    teamTab: filters.tab === "team",
  });
  // 캔버스(구성탭) 태그 편집기의 #+/#- — 캔버스 선택과 라이브러리 선택은 다른 세계라
  // 선택 ref 는 늘 비어 있다: 캔버스 노드는 '그 카드 단건', '생성 결과' 창은 고른 대상을 직접 넘긴다(4번째 인자).
  // 캔버스 카드는 전부 로컬 카드라 teamTab 아님.
  const canvasWsSelectionRef = useRef<Set<string>>(new Set());
  const { onWorkspaceCommand: onCanvasWorkspaceCommand } = useGenerationWorkspaceActions({
    activeWorkspaceIds: filters.workspace_ids,
    flash,
    gensRef,
    reload,
    selectedRef: canvasWsSelectionRef,
    setGens,
    setSelected,
    teamTab: false,
  });
  useGenerationKeyboardActions({
    clearSelect,
    filtersRef,
    flash,
    gensRef,
    reload,
    selectedRef,
    setGens,
    composeGridActiveRef: folderPeekOpenRef, // 캔버스 '폴더 보기' 창이 떠 있으면 compose 에서도 r/g/b/d
    inactiveRef: libraryKeysOffRef,
    colorLedger,
  });
  // 열고 닫을 때 목록을 먼저 비운다 — 조회가 끝날 때까지 본 목록 카드가 창에(닫을 때는 창의 카드가 뒤 목록 자리에) 비치지
  //  않게. 선택도 비운다: 창의 목록과 본 목록은 다른 카드라, 남기면 보이지 않는 카드에 일괄 작업이 걸린다.
  //  닫은 직후의 빈 화면은 '본 목록 첫 쪽 사본'으로 메운다(Jay 2026-10-07): 열 때 본 목록 조회의 키로 담고, 닫을 때 같은 키면
  //  먼저 그린다(목록 훅의 beginComposeList). 본 목록 조회의 키 = 창 조건이 섞이기 전의 genQuery — 창에서 툴바 필터를 바꾸면
  //  키가 달라져 사본을 쓰지 않는다.
  const backQueryKeyRef = useRef("");
  backQueryKeyRef.current = generationQueryKey(genQuery);
  // 창을 닫은 뒤 초점을 본 목록 격자로 돌려줄 뜻(닫는 순간의 문맥 = listPeekCtx, "*" = 컷 카드로 폴더에 들어간 뒤 — 어느 문맥이든). null = 돌려주지 않는다.
  const refocusGridRef = useRef<string | null>(null);
  const openFolderPath = useCallback((folder: {
    projectId: string | null; path: string; projectName: string; genId: string | null;
  }) => {
    if (filtersRef.current.tab === "compose" || !folder.path) return;
    beginComposeList({ keep: backQueryKeyRef.current });
    setSelected(new Set());
    setFolderWindow({ ...folder, ctx: listPeekCtxRef.current });
  }, [filtersRef, beginComposeList, setSelected]);
  // 편집 탭의 컷 더블클릭 — 같은 창을 그 컷 폴더로 연다(위 teamPeek). 한 핸들러 안에서 같이 바꿔, 다음 렌더가 곧바로
  //  '공유 & 리뷰 · 그 폴더'의 조회가 된다(사이에 다른 조회가 끼지 않는다). 밑의 탭 목록은 숨어 있어 사본을 담지 않는다.
  const openEditFolderWindow = useCallback((target: EditCutFolder) => {
    if (!editOpenRef.current || listPeekRef.current) return;
    beginComposeList();
    setSelected(new Set());
    setTeamPeek(true);
    setEditMarks(target.marks);
    setFolderWindow({
      projectId: target.projectId, path: target.path, projectName: target.projectName, genId: target.focusId ?? "",
      ctx: editPeekCtxRef.current, edit: true,
    });
  }, [beginComposeList, setSelected]);
  const openFolderWindow = useCallback((g: Generation) => {
    if (!g.folder_path) return;
    openFolderPath({ projectId: g.project_id, path: g.folder_path, projectName: g.project_name ?? "", genId: g.id });
  }, [openFolderPath]);
  // 캔버스 카드 우클릭(폴더 이름표가 붙은 카드, Jay 2026-10-15) → 그 폴더의 캔버스 '폴더 보기' 창. 사이드바 폴더 누름(onArmFolder)의 ②③만 —
  //  보는 자리만 옮기고(restoreLocation, adopt 없음) 다음 생성 위치·분홍 무장은 그대로다(라이브러리의 우클릭 폴더 창처럼). patch 는 생성 위치까지 옮긴다.
  const openCanvasFolder = useCallback((g: Generation) => {
    if (!g.project_id || !g.folder_path) return;
    restoreLocation({ project_id: g.project_id, folder_path: g.folder_path });
    setFolderPeek(true);
    sceneActionRef.current?.closeVariants(); // 두 창을 겹쳐 두지 않는다(사이드바와 같이)
  }, [restoreLocation, sceneActionRef]);
  // 컷 카드 우클릭·컷 정보 창의 [폴더 열기] → 그 폴더의 창. 누른 생성물 카드가 없으니 '방금 누른 카드'·이동 없이 맨 위부터 연다.
  //  (2026-10-13 낮 — 아침엔 두 번 클릭이 들어가기였고 창은 없었다. 그 전엔 컷 두 번 클릭이 이 창이었다.)
  // 에피소드 카드(하위 폴더 있음) 두 번 클릭 → 그 폴더로 들어간다 = 사이드바에서 그 폴더를 누른 것과 같다(생성 위치도 그 폴더, Jay 2026-10-09).
  //  컷(잎) 카드의 두 번 클릭은 모아보기(FolderCardGrid 가 가른다) — 컷에 들어가는 길은 사이드바다.
  const enterFolderCard = useCallback((folder: FolderCard) => {
    const projectId = folder.cover.project_id;
    if (!projectId) return;
    pushLocationRef.current = true; // 명시적 이동 — 브라우저 기록을 한 칸 쌓는다(뒤로 가기가 이 목록으로 돌아온다, 2026-10-13 ②)
    // 컷 카드 격자가 사라지니 초점을 새 목록의 격자로 돌려준다("*" = 어느 문맥이든 — 들어간 뒤의 문맥은 아직 모른다. 실측: 전엔 body 로 떨어졌다)
    refocusGridRef.current = "*";
    setArmedFolder({ projectId, path: folder.path });
    patch({ project_id: projectId, folder_path: folder.path });
  }, [setArmedFolder, patch]);
  const openFolderCard = useCallback((folder: FolderCard) => {
    if (folder.subfolders) {
      enterFolderCard(folder);
      return;
    }
    openFolderPath({
      projectId: folder.cover.project_id, path: folder.path, projectName: folder.cover.project_name ?? "", genId: null,
    });
  }, [enterFolderCard, openFolderPath]);
  // 들어가기 직전의 누름(두 번 클릭의 둘째·[열기]) — 들어간 뒤의 묶음(위 cardsScope 와 같은 자리)을 미리 묻는다(Jay 10-16 2A — 에피소드로
  //  들어갈 때 빈 칸). 들어간 훅의 첫 조회가 이 요청을 이어받는다. 묶음 보기가 아니거나 옛 서버면 묻지 않는다.
  const prefetchFolderCard = useCallback((folder: FolderCard) => {
    const projectId = folder.cover.project_id;
    if (!projectId || !cutView || folderCardsUnsupported) return;
    const workspaceId = singleTeamWorkspace(genQuery);
    prefetchFolderCards(libraryAuthKey, { projectId, parent: folder.path, ...(workspaceId ? { workspaceId } : {}) });
  }, [cutView, folderCardsUnsupported, genQuery, libraryAuthKey]);
  // 폴더 창의 [대표] — 그 폴더의 대표를 정한다. 누르자마자 먼저 그리지 않는다: 저장하는 동안 단추를 잠그고, 끝나면(성공·실패
  //  모두) 서버 값을 다시 읽은 뒤에 푼다 — 먼저 그리면 저장 전에 출발한 조회가 늦게 와서 방금 고른 대표를 지운다(Codex 설계 검토).
  //  다시 읽기는 '지금' 문맥의 것을 부른다: 저장 중에 창을 닫으면 닫기 전의 것은 옛 폴더를 받아 뒤 묶음의 카드를 밀어낸다.
  const [savingRep, setSavingRep] = useState(false);
  const savingRepRef = useRef(false);
  //  다시 읽기는 묶음(cardsScope)과 들어간 폴더의 부모(ownScope) 둘 다 — 어느 쪽이 그 폴더를 보여 주든 새 대표가 보이게.
  const reloadFolderCardsRef = useRef(async () => {});
  reloadFolderCardsRef.current = async () => { await Promise.all([reloadFolderCards(), reloadOwnCards()]); };
  //  컷 정보 창의 ★ 도 같은 저장 — 그쪽은 어느 폴더인지(where)를 같이 준다(폴더 창이 떠 있지 않다).
  //  돌려주는 값 = 저장했나(거른 누름은 undefined) — 컷 정보 창은 실패하면 자기 목록을 다시 받는다(50회차: 남이 옮긴 것이 남아 같은 404 를 되풀이했다).
  const pickFolderCover = useCallback(async (g: Generation, where?: { projectId: string | null; path: string }): Promise<boolean | undefined> => {
    const peek = listPeekRef.current;
    const target = where ?? (peek ? { projectId: peek.projectId, path: peek.path } : null);
    if (!target?.projectId || savingRepRef.current) return undefined;
    savingRepRef.current = true;
    setSavingRep(true);
    try {
      await api.setFolderCover(target.projectId, target.path, g.id);
      return true;
    } catch (error) {
      flash(`${t("썸네일을 정하지 못했습니다")} — ${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      await reloadFolderCardsRef.current();
      savingRepRef.current = false;
      setSavingRep(false);
    }
  }, [flash, t]);
  // 카드 위의 대표 표시/지정 — 폴더 창(peek)과 들어간 폴더(own)가 같은 모양을 쓴다. 캔버스 '생성 결과' 창과 같은 자리·같은 모양이다.
  const coverHeader = (coverId: string | null, pick: (g: Generation) => void) => (g: Generation) =>
    g.id === coverId ? (
      <span className="scene-varpop-cur">{t("썸네일")}</span>
    ) : g.assets?.[0] && !g.deleted ? (
      <button
        type="button"
        className="scene-varpop-rep"
        disabled={savingRep}
        title={t("이 결과를 이 폴더의 썸네일로 지정 (팀이 같이 봅니다)")}
        // preventDefault = 단추가 초점을 가져가 격자가 움직이는 것을 막는다. mousedown 에서 바로 정한다(생성 결과 창과 같다).
        //  왼쪽 단추만 — 우클릭·휠 클릭으로 팀의 대표가 바뀌면 안 된다(Codex 코드 리뷰).
        onMouseDown={(e) => {
          e.preventDefault();
          if (e.button === 0) pick(g);
        }}
        // Tab 으로 와서 Enter·Space 로 누른 것(키보드가 만든 click 은 detail 0) — mousedown 에만 걸면 키보드로는 못 정한다(조작 규칙 51).
        //  마우스의 click(detail 1 이상)은 위에서 이미 했다.
        onClick={(e) => {
          if (e.detail === 0) pick(g);
        }}
      >
        {t("썸네일")}
      </button>
    ) : null;
  const closeFolderWindow = useCallback(() => {
    // 한 번만 닫는다 — 같은 Esc 가 창의 키 처리와 전역 Esc 훅에 둘 다 닿을 수 있다. 두 번 비우면 방금 시작한 본 목록 조회의
    //  응답을 버려 뒤 목록이 빈 채로 남는다.
    if (!listPeekRef.current) return;
    const fromEdit = !!listPeekRef.current.edit;
    listPeekRef.current = null;
    if (fromEdit) {
      // 편집 탭이 연 창 — 밑의 탭 목록은 숨어 있다: 사본도 격자 초점도 없다. 비우고(창의 카드가 밑의 탭 캐시에 남지 않게)
      //  원래 조회로 돌아간다. 편집 탭에는 공유 목록을 다시 받으라고 알린다(창에서 공유를 풀거나 지웠을 수 있다).
      refocusGridRef.current = null;
      beginComposeList();
      setTeamPeek(false);
      setEditReloadSignal((n) => n + 1);
    } else {
      // 닫는 순간 초점이 창 안(또는 아무 데도 없음)이면, 본 목록이 조작 가능해진 뒤 격자로 돌려줄 뜻을 그 문맥과 함께 적어 둔다.
      //  초점이 창 밖 다른 곳(크게 보기·프롬프트 등)에 있으면 적지 않는다 — 남의 초점은 건드리지 않는다.
      //  창의 툴바가 연 태그 패널은 body 에 그려진다 — 그 안의 초점도 창 안의 초점이다(lib/keyGate floatHost).
      const active = document.activeElement as HTMLElement | null;
      refocusGridRef.current =
        !active || active === document.body || floatHost(active).closest(".folder-peek") ? listPeekCtxRef.current : null;
      beginComposeList({ restore: backQueryKeyRef.current });
    }
    setSelected(new Set());
    setFolderWindow(null);
  }, [beginComposeList, setSelected]);
  // 문맥이 바뀌어 무효가 된 창은 상태도 치운다(그 렌더부터 이미 닫힌 것으로 그렸다 — 목록은 바뀐 문맥의 조회가 채운다.
  //  선택은 문맥을 바꾼 쪽이 비운다: 필터 조작은 선택 초기화 키로, 공간 전환은 위 useLayoutEffect 로).
  //  ★여기서 목록을 비우지 않는다 — 바뀐 문맥의 조회가 이미 떠났고, 비우면 그 응답까지 버려 빈 채로 남는다(Codex 설계 검토).
  //  편집 탭이 연 창이었으면 teamPeek 도 끈다(편집을 떠났거나 계정·공간이 바뀌었다). 창 없이 teamPeek 만 남는 일도 막는다.
  useEffect(() => {
    if (folderWindow && !listPeek) setFolderWindow(null);
    if (teamPeek && !(folderWindow?.edit && listPeek)) setTeamPeek(false);
  }, [folderWindow, listPeek, teamPeek]);
  // 크게 보기의 [부분 수정]으로 넘어가면 창을 닫는다 — 부분 수정의 Esc 가 뒤에 남은 창까지 닫지 않게(코덱스 코드 리뷰 10-07).
  useCustomEvent(APP_EVENTS.partialEdit, closeFolderWindow);

  // 정보(ⓘ) 버튼: 복수 선택 상태에서 선택된 카드의 정보를 누르면 비교창, 그 외엔 단일 정보창.
  const handleInfo = (target: InfoTarget) => {
    if (target.kind === "generation" && selected.size >= 2 && selected.has(target.gen.id)) {
      if (selectedGenerations.length >= 2) {
        setCompareGens(selectedGenerations);
        return;
      }
    }
    setInfo(target);
  };


  // stale 프로젝트 필터 자동 해제 — 보던 프로젝트가 (다른 기기/세션에서) 삭제됐는데
  // localStorage 에 id 가 남아 재방문 시 빈 화면이 되는 것 방지. 'none'(미분류)은 항상 유효.
  useEffect(() => {
    if (!projectsLoadedRef.current) return; // 첫 로드 전엔 판단 보류
    // 자동 조회 위치는 재시작 후에도 생성 목적지와 다를 수 있다. 공간 제한 목록만으로 지우지 않는다.
    //  뒤로 가기·공유 탭 기억으로 **되살린** 자리(restoredLocationRef)도 지우지 않는다 — 보관·공간 제한 목록은 삭제의 증거가 아니고, 생성 목적지와
    //  우연히 같을 수 있다(작업 공간 탭에서 골랐다가 뒤로 가 맨 위 → 공유 탭. 2026-10-13 ① Codex 3차 P2).
    if (isLocatedView || restoredLocationRef.current || filters.project_id !== generationScope.project_id) return;
    const pid = filters.project_id;
    if (pid && pid !== "none" && !projects.some((p) => p.id === pid)) {
      patch({ project_id: undefined });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

  const { addAutoTag, removeAutoTag } = useGenerationAutoTagActions({
    askPrompt,
    flash,
    reload,
    setArmedAutoTags,
    workspaceContext,
    setWorkspaceChips,
    allowWorkspaceChipRegistration: filters.tab !== "team",
  });
  // 워크스페이스 침(옵트인 필터) — 툴바 필터와 **같은 선택**을 넣고 뺀다(중복 선택).
  //  최신 state 기준으로 뒤집는다(연속 클릭이 서로를 덮지 않게).
  const toggleWorkspaceChip = (id: string) =>
    setFilters((previous) => {
      const current = previous.workspace_ids ?? [];
      const next = current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id];
      return { ...previous, workspace_ids: next.length ? next : undefined };
    });
  // 등록 해제는 **보기 필터를 건드리지 않는다**(2026-09-14). 지금은 툴바에 해제용 칩이 늘 있어
  // 거기서 풀면 된다 — 등록을 지웠다고 보던 화면이 말없이 전체로 되돌아가면 안 된다.
  const removeWorkspaceChip = (id: string) => {
    setWorkspaceChips((prev) => prev.filter((chip) => chip.id !== id));
  };

  // 툴바 워크스페이스 필터 — 목록은 `#+` 피커·씬 메뉴와 같은 모듈 캐시를 쓴다.
  //  걸려 있을 때만 미리 받아 온다(칩에 이름을 보여줘야 하므로).
  // ★`!![]` 는 true 다 — 길이로 판단해야 안 걸렸을 때 헛 조회를 안 한다.
  const workspaceFilterOptions = useWorkspaceFilterOptions(
    (filters.workspace_ids?.length ?? 0) > 0,
  );
  const workspaceFilter = {
    value: filters.workspace_ids ?? [],
    options: workspaceFilterOptions.options,
    loading: workspaceFilterOptions.loading,
    failed: workspaceFilterOptions.failed,
    onOpen: workspaceFilterOptions.reload,
    onToggle: toggleWorkspaceChip,
    onClear: () => patch({ workspace_ids: undefined }),
    follow: workspaceFollow,
  };

  // comfy 노드 실행 중 목록(SceneBoard 통지) — '내 작업'에 임시 생성중 카드(Comfy 로고)를 프론트 전용으로 띄운다.
  const [comfyRunning, setComfyRunning] = useState<{ id: string; name: string }[]>([]);
  // 로컬 우선: 내 작업(tab=my)은 로컬 DB 를 그대로 읽으므로 로드된 페이지가 곧 화면 결과
  // (진행중·실패 placeholder 포함). 별도 머지 불필요.
  // 넓은 목록 하나 — **컷 카드를 보이는 자리**(하위 폴더가 있는 폴더)의 첫 쪽이 적용돼 있는 동안 든다. 컷(잎)에서는 바꾸지 않는다: 에피소드 →
  //  컷 → 형제 컷 동안 에피소드의 것이 남아, 형제 컷으로 옮길 때도 거기서 고른다. 문맥(계정·서버·공간·프로젝트)이 다르면 쓰지 않는다.
  //  ponytail: 하나뿐이라 새로 고친 뒤 컷에서 형제 컷으로 바로 가면 고를 것이 없다(목록 응답을 기다린다) — 에피소드를 한 번 보면 채워진다.
  const widePoolRef = useRef<{ ctx: string; folder: string; gens: Generation[] } | null>(null);
  //  찾는 조건도 문맥이다 — 조건이 켜진 채 받은 첫 쪽(걸러진 것)을 조건을 끈 뒤의 자리에 먼저 그리지 않는다(반대도). 자리(프로젝트·폴더)만 뺀 조회 전체.
  const poolCtx = cutScope
    ? JSON.stringify([libraryAuthKey, cutScope.workspaceId ?? null, cutScope.projectId, { ...genQuery, project_id: undefined, folder_path: undefined }, grayOn])
    : null;
  useEffect(() => {
    if (!cutMode || !cutScope || poolCtx === null || listPeek || listBehind || staleList || isLocatedView || loadError) return;
    widePoolRef.current = { ctx: poolCtx, folder: cutScope.parent, gens };
  }, [gens, cutMode, cutScope, poolCtx, listPeek, listBehind, staleList, isLocatedView, loadError]);
  const narrowed = useMemo(() => {
    if (!narrowing || !cutScope) return null;
    const pool = widePoolRef.current;
    if (!pool || pool.ctx !== poolCtx || !folderUnder(cutScope.parent, pool.folder)) return [];
    return pool.gens.filter((g) => !g.deleted && g.project_id === cutScope.projectId && folderUnder(g.folder_path ?? "", cutScope.parent));
  }, [narrowing, cutScope, poolCtx]);
  const visibleGens = narrowed ?? gens;
  // comfy 실행 중이면 '내 작업' 탭 그리드 맨 앞에 임시 생성중 카드(Comfy 로고). 서버 미저장 — 실행 끝나면 사라지고
  //  실제 저장물이 reload 로 들어온다. tab=my 에서만(내 로컬 실행이므로 팀 탭엔 안 띄운다).
  const comfyPlaceholders = useMemo<Generation[]>(() => {
    if (filters.tab !== "my" || !comfyRunning.length) return [];
    const now = new Date();
    const created = now.toISOString().slice(0, 19).replace("T", " "); // "YYYY-MM-DD HH:MM:SS"(UTC) — 그룹핑 정합
    return comfyRunning.map((c) => ({
      id: "comfy-pending:" + c.id,
      worker_id: "",
      worker_name: null,
      prompt: c.name || "Comfy",
      display_prompt: null,
      model: null,
      params: null,
      color: null,
      status: "running",
      created_at: created,
      sort_ts: Math.floor(now.getTime() / 1000),
      assets: [],
      references: [],
      tags: [],
      auto_tags: [],
      shared: false,
      parent_gen_id: null,
      is_source: false,
      source_name: null,
      comment: null,
      error: null,
      comment_count: 0,
      has_unread: false,
      local_only: true,
      creator_uid: account?.creator_uid ?? null,
      creator_name: null,
      workspace_scope: "unknown",
      workspace_id: null,
      workspace_name: null,
      is_mine: true,
      project_id: null,
      deleted: false,
      _comfyPending: true,
    }));
  }, [filters.tab, comfyRunning, account]);
  // comfy 실행이 방금 끝났으면(1개↑→0) reload 로 저장된 결과를 당겨 placeholder→실제 카드 전환 간극을 줄인다.
  const prevComfyRunningRef = useRef(0);
  useEffect(() => {
    if (prevComfyRunningRef.current > 0 && comfyRunning.length === 0) void reload();
    prevComfyRunningRef.current = comfyRunning.length;
  }, [comfyRunning, reload]);
  // 회색 버튼 ON → 비활성(회색)으로 표시된 카드를 그리드에서 제외(숨김). 색 dot 과 반대 방향 필터.
  // (비활성은 로컬 시각 상태라 서버가 모름 → 클라이언트 측에서 거른다.)
  // id 직접 비활성(d) + 폴더 비활성을 합친 '확장 집합' — 라이브러리 회색/숨김, 썸네일그리드에 공통 사용.
  const effectiveDisabled = useMemo(
    () => expandDisabledGenerationIds(visibleGens, disabledGen, disabledFolders),
    [visibleGens, disabledGen, disabledFolders],
  );
  // memo — App 은 진행률·토스트 등으로 자주 리렌더되므로 매번 전량 filter 하지 않게.
  const gridGens = useMemo(
    () => [...comfyPlaceholders, ...filterDisabledGenerations(visibleGens, effectiveDisabled, grayOn)],
    [comfyPlaceholders, visibleGens, effectiveDisabled, grayOn],
  );
  // 격자 자리를 비우는 동안 — 묶음 답을 모르거나, 낱장이 될 자리인데 먼저 보일 것이 없다(위 '폴더를 옮기는 동안').
  const cutPending = cutLoading || (narrowing && !cutMode && gridGens.length === 0);
  // 회색 숨김을 켜면 가려지는 카드는 선택에서 뺀다(29회차 Jay "검색과 같게" — 보이는 것만 남긴다). 숨김은 gridGens 만 줄이고 gens 는 그대로라
  //  위 규칙 42 효과가 걷지 못한다(Codex 코드 리뷰 P2 — 전엔 숨김 전환이 선택을 통째로 비웠다). 숨긴 채 Ctrl+A 로 고른 가려진 카드는 전처럼
  //  남는다(재제안 금지 — Ctrl+A 는 숨긴 카드까지 고른다).
  const toggleGray = () => {
    const next = !grayOn;
    setGrayOn(next);
    if (next && selected.size) setSelected((prev) => withoutHidden(prev, effectiveDisabled));
  };
  // 회색/휴지통 공간 필터가 페이지를 전부 가리면(빈 그리드) ThumbnailGrid 가 센티넬을 못 그려
  // onLoadMore 가 영영 안 불린다 → 뒤 페이지의 활성 항목이 사라진 것처럼 보임. hasMore 인 한
  // 활성 항목이 나오거나 끝날 때까지 다음 페이지를 자동으로 당긴다(필터·페이지네이션 분리).
  // 단 연쇄에 상한을 둔다 — 비활성 항목이 수십 페이지 이어지는 데이터 분포에서 무한 자동
  // 순회(요청 폭주)를 막는다. 활성 항목이 한 번이라도 보이면 카운터는 리셋된다.
  const grayAutoLoadCountRef = useRef(0);
  const scopedTrash = !!filters.deleted_only && hasWorkspaceFilter(genQuery);
  useEffect(() => { grayAutoLoadCountRef.current = 0; }, [serverFilterKey, workspaceScopeKey, libraryAuthKey]);
  useEffect(() => {
    if ((!grayOn && !scopedTrash) || gridGens.length > 0) {
      grayAutoLoadCountRef.current = 0;
      return;
    }
    if (hasMore && !loading && !loadingMore && grayAutoLoadCountRef.current < 10) {
      grayAutoLoadCountRef.current += 1;
      loadMore();
    }
  }, [grayOn, scopedTrash, gridGens.length, hasMore, loading, loadingMore, loadMore, workspaceScopeKey]);

  // 미확인 코멘트 여부·내 실패 수는 서버 stats 에서 계산한다(전량 로드 대체).
  const hasAnyUnread = stats.has_unread;
  const failedCount = stats.failed_count;
  const {
    clearTagFilter,
    deleteTagEverywhere,
    selectTagFilter,
    toggleColorFilter,
    toggleTagPanel,
  } = useGenerationFilterActions({
    flash,
    gensRef,
    reload,
    setColorFilter,
    setTagFilter,
    setTagPanelOpen,
  });

  const { boardShare, onPublish, folderShare } = useGenerationShareActions({
    bumpBoard,
    flash,
    reload,
  });
  // 폴더 우클릭 메뉴 — 팀 공유 / 공유 저장 · 최종 저장 / 원본 위치 열기.
  //  저장은 관리 권한(프로젝트 매니저)이 필요하다 — 없으면 서버의 403 사유를 그대로 보여준다.
  const onFolderAction = async (kind: FolderMenuKind, projectId: string, path: string, name: string) => {
    if (kind === "share") {
      await folderShare(projectId, path, name);
      return;
    }
    if (kind === "open-folder") {
      try {
        await api.openProjectFolder(projectId, path);
      } catch (e) {
        flash("원본 위치 열기 실패: " + String(e).replace(/^Error:\s*\d+:\s*/, ""));
      }
      return;
    }
    const label = folderMenuLabel(kind); // 공유 저장 / 최종 저장 — 완료 탭의 두 단추와 같은 저장을 이 폴더로만 좁힌다
    try {
      const r = await manageApi.saveFinals(projectId, path, kind === "save-shared" ? "shared" : undefined);
      const failed = r.errors.length ? ` · 실패 ${r.errors.length}(${r.errors[0].reason})` : "";
      flash(`'${name}' ${label} — 저장 ${r.saved} · 건너뜀 ${r.skipped}${failed}`);
    } catch (e) {
      flash(`${label} 실패: ` + String(e).replace(/^Error:\s*\d+:\s*/, ""));
    }
  };
  const {
    boardDelete,
    bulkDelete,
    bulkPurge,
    bulkRestore,
    clearFailed,
    deleteReturningIds,
    onRestore,
  } = useGenerationTrashActions({
      bumpBoard,
      clearSelect,
      failedCount,
      flash,
      reload,
      selected,
      setBoardSelected,
    });

  const {
    closeOverlay,
    navTab,
    enterBoard,
    openEdit,
    openPreview,
    openComment,
    openAdmin,
    syncLocation,
  } = useAppNavigation({
    currentTab: storedTab, // 저장된 탭 — 편집 탭이 연 폴더 창의 임시 '공유 & 리뷰'가 뒤로가기 기록에 남지 않게
    previewScopeKey: JSON.stringify([workspaceContext.scope, workspaceContext.id, workspaceFollow?.mode ?? "auto", libraryAuthKey]),
    lastBoardFocusRef,
    setPreview,
    setCommentGenId,
    setAdminOpen,
    setInfo,
    setBoardFocusId,
    setBoardArrange,
    setFilters,
    currentLocation,
    restoreLocation,
    locationCtxFor,
    setEditOpen,
  });
  const libraryTabs = useLibraryFolderTabs({
    library: libraryFilters, authKey: libraryAuthKey,
    enabled: authReady && !editOpen && !listPeek,
    canLeave: () => !editOpen && !listPeek && !listLocked,
    onNavigate: () => {
      clearSelect();
      setCutSel(new Set());
      setTagPanelOpen(false);
      refocusGridRef.current = null;
    },
  });
  const selectLibraryTab = (id: number) => {
    const changed = id !== libraryTabs.active;
    const selected = libraryTabs.select(id);
    if (selected && changed) pushLocationRef.current = true;
    return selected;
  };
  const openLibraryFolderTab = (projectId: string, path: string, name?: string) => {
    return libraryTabs.openFolder(projectId, path, name);
  };
  const closeLibraryTab = (id: number) => {
    if (id === libraryTabs.active && libraryTabs.tabs.length > 1 && !listLocked) pushLocationRef.current = true;
    libraryTabs.close(id);
  };
  useEffect(() => {
    const onBackspace = (event: KeyboardEvent) => {
      if (storedTab === "compose" || editOpen || listPeek || listLocked || !authReady || filters.deleted_only
        || event.key !== "Backspace" || event.defaultPrevented || isKeyHandled(event)
        || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.repeat || event.isComposing
        || isTypingTarget(event.target) || backgroundKeysBlocked()
        || (!filters.folder_path && !filters.project_id)) return;
      event.preventDefault();
      markKeyHandled(event);
      const path = filters.folder_path ? parentFolder(filters.folder_path.replace(/\\/g, "/")) : "";
      pushLocationRef.current = true;
      patch({ project_id: filters.folder_path ? filters.project_id : undefined, folder_path: path || undefined, search: undefined });
      adoptShownLocation();
      clearSelect();
      setCutSel(new Set());
      setTagPanelOpen(false);
    };
    window.addEventListener("keydown", onBackspace, true);
    return () => window.removeEventListener("keydown", onBackspace, true);
  });
  // 편집 탭에 들어오는 모든 길(단추·뒤로/앞으로)에서 밑의 목록 선택을 비운다 — 안 보이는 카드에 단축키·일괄 작업이 걸리지 않게.
  useEffect(() => {
    if (editOpen) setSelected((prev) => (prev.size ? new Set() : prev));
  }, [editOpen, setSelected]);
  // 보는 자리를 브라우저 기록에 맞춘다(렌더마다 — 같은 자리면 아무 일도 없다): 명시적 이동이면 한 칸 쌓고, 그 밖은 지금 기록을 고쳐 적는다.
  //  표식은 렌더마다 내린다 — 같은 폴더를 다시 눌러 자리가 안 바뀌어도 다음 자동 변경(따라가기)이 '명시적'으로 쌓이지 않게.
  //  편집 탭이 떠 있는 동안은 쉰다 — 그 안의 '폴더 보기' 창은 filters 를 임시로 공유 탭으로 보인다(useLibraryFilters 의 shown) — 그 임시 자리를
  //  기록에 적지 않는다(편집 탭 병합 10-13).
  useEffect(() => {
    const push = pushLocationRef.current;
    pushLocationRef.current = false;
    if (editOpen) return;
    syncLocation(currentLocation, push);
  });
  // 공유 탭의 마지막 자리 기억(2026-10-13 ①) — 확정된 자동 공간에서 **일반 목록**을 보는 동안 자리마다 적는다(휴지통 보기는 자리가 아니다 — 휴지통에
  //  들어가면 프로젝트가 지워져 마지막 일반 자리를 '맨 위'로 덮었다, Codex 코드 리뷰). 되살리는 곳은 상단바의 탭 누름(onTab). 편집 탭 동안은 같은 이유로 쉰다.
  useEffect(() => {
    if (editOpen || filters.tab !== "team" || !teamMemoryCtx || filters.deleted_only) return;
    LS.setJSON(TEAM_LOCATION_KEY, { ctx: teamMemoryCtx, project_id: filters.project_id, folder_path: filters.folder_path } satisfies TeamLocationMemory);
  }, [editOpen, filters.tab, filters.project_id, filters.folder_path, filters.deleted_only, teamMemoryCtx]);
  const canFollowResolve = useCallback(() => {
    if (document.visibilityState !== "visible") return false;
    try {
      return localStorage.getItem("ch.resolve-follower-tab") === resolveFollowerTabIdRef.current;
    } catch { return true; }
  }, []);
  // 폴더 창이 떠 있는 동안은 따라가지 않는다(체크를 끈 것과 같이 창에 보이는 카드만 강조) — 따라가기는 본 목록의 위치를 옮기고
  //  목록을 그 위치의 카드로 갈아 끼우는데, 위치가 안 바뀌는 경우(보던 폴더 안의 복수 선택)엔 창이 닫히지 않아 제목과 다른 카드가
  //  창에 남는다(코덱스 코드 리뷰 10-07). enabled 가 바뀌면 진행 중이던 조회 응답도 버려진다(훅의 context).
  //  창을 닫은 직후 옛 사본을 보이는 동안(staleList)에도 같다 — 따라가기가 사본 위에 목록을 갈아 끼우면 새 첫 쪽과 섞인다.
  //  컷 정보·모아보기 창이 떠 있는 동안도 같다 — 따라가기가 위치를 옮기면 창의 문맥이 깨져 닫힌다.
  const resolveLibrary = useResolveLibraryFollow({
    filters, enabled: resolveSelectionFollow && !listPeek && !staleList && !editOpen && !cutInfoFolder && !cutReelOpen,
    authReady: authReady && workspaceQueryReady,
    authKey: libraryAuthKey,
    workspaceFilter: filters.tab === "team" ? genQuery : undefined,
    workspaceScopeKey,
    onWorkspaceFilterUnsupported: () => flash(t("워크스페이스별 다빈치 확인에는 공유 서버 업데이트가 필요합니다. 임시로 전체 보기를 사용할 수 있습니다.")),
    manualRevision, gens: gridGens, locatedVisibleIds, locatedSettle, followLocation, revealLocated, colorLedger, canFollow: canFollowResolve,
  });
  useCustomEvent(APP_EVENTS.resolveSelection, (event) => {
    const detail = (
      event as CustomEvent<{
        generationId?: string; generationIds?: string[]; selectedCount?: number;
        truncated?: boolean; selectionId?: string;
      }>
    ).detail;
    const generationIds = resolveSelectionGenerationIds(detail?.generationIds, detail?.generationId);
    if (!generationIds.length && !Array.isArray(detail?.generationIds)) return;
    // 편집 탭의 '다빈치' 표는 화면을 옮기지 않는 표시라 **모든 탭**이 받는다 — 따라가는 탭만 받으면, 다른 탭에 있는 동안 다빈치에서
    //  선택을 풀어도 돌아온 탭에 옛 빨간 표가 남았다(서버는 바뀔 때만 보낸다 — Codex 리뷰). 같은 선택이 다시 오면(중복 신호) 그대로 둔다.
    const prevPicked = resolvePickedRef.current;
    const pickChanged = prevPicked.size !== generationIds.length || generationIds.some((id) => !prevPicked.has(id));
    if (pickChanged) {
      resolvePickedRef.current = new Set(generationIds);
      setResolvePicked(resolvePickedRef.current);
    }
    // 같은 계정의 여러 탭이 /ws를 받아도 마지막으로 사용한 MV Hub 탭 하나만 화면을 움직인다.
    if (document.visibilityState !== "visible") return;
    try {
      if (localStorage.getItem("ch.resolve-follower-tab") !== resolveFollowerTabIdRef.current)
        return;
    } catch {
      // 저장소를 막은 브라우저에서는 visibility만으로 최선의 탭을 고른다.
    }
    if (pickChanged && generationIds.length) setResolveScroll((count) => count + 1); // 편집 탭 타임라인을 그 클립까지(따라가는 탭만)
    if (editOpenRef.current) return; // 편집 탭 — 숨은 목록의 위치·활성 씬을 다빈치 선택이 바꾸지 않는다(표시만 — 위)
    const selectedCount = Math.max(generationIds.length,
      Number.isInteger(detail?.selectedCount) ? detail!.selectedCount! : 0);
    const truncated = detail?.truncated === true;
    const selectionId = String(detail?.selectionId || "");
    if (selectionId && resolveSelectionEventRef.current === selectionId) return;
    if (selectionId) resolveSelectionEventRef.current = selectionId;
    if (filters.tab !== "compose") {
      setResolveSceneSelection(null);
      resolveLibrary.receive(generationIds, truncated);
      return;
    }
    // 선택 해제·상한 초과·체크 OFF는 현재 창에만 전달한다. 복수 선택도 열린 창을 우선한다.
    const openPopup = resolveSelectionFollow && !truncated && generationIds.length > 0;
    if (!openPopup && filters.tab !== "compose") {
      setResolveSceneSelection(null);
      return;
    }
    const keepOpenPopup = selectedCount > 1 && filters.tab === "compose" &&
      resolveOpenPopupRef.current?.sceneId === activeSceneId;
    const targetScene = openPopup && !keepOpenPopup
      ? resolveSceneForGeneration(scenes, activeSceneId, generationIds)
      : activeScene;
    if (!targetScene) {
      setResolveSceneSelection(null);
      if (openPopup) flash("Resolve에서 선택한 생성물이 저장된 캔버스에 없습니다.");
      return;
    }
    resolveSelectionNonceRef.current += 1;
    setResolveSceneSelection({
      sceneId: targetScene.id,
      generationId: generationIds[0] ?? "",
      generationIds,
      selectedCount,
      truncated,
      nonce: resolveSelectionNonceRef.current,
      at: Date.now(),
      openPopup,
      followEnabled: resolveSelectionFollow,
    });
    if (openPopup) {
      if (filters.tab !== "compose") navTab("compose");
      if (activeSceneId !== targetScene.id) selectSceneWithWorkspace(targetScene.id);
    }
  });
  // 히스토리 버튼 → 그 생성물 recipe(어떻게 만들었나)를 새 씬 탭으로 연다(편집·재생성 가능). 팀 결과물도 동일.
  // history 없이도 연다 — 파일 드롭 복원처럼 계보 조회가 실패해도 레시피 본체(레퍼런스·모델·
  // 프롬프트)는 생성물 자체에 있어 그릴 수 있다(buildRecipeScene 이 null 을 허용).
  const openRecipe = (g: Generation, history: History | null) => {
    importSceneSnapshot(buildRecipeScene(g, history));
    setSceneBinding(null);
    setSceneSelGens([]);
    navTab("compose");
    flash(`"${g.model || "생성물"}" 을(를) 노드로 열었습니다.`);
  };
  // 캔버스에 떨어뜨린 파일이 우리가 내보낸 생성물이면(각인) 그 레시피를 노드로 펼친다.
  //  · 각인이 없거나 카탈로그에서 못 찾으면 false — 호출측이 평소대로 레퍼런스 카드로 넣는다.
  //  · 새 씬 탭으로 열리므로 지금 작업 중인 씬은 그대로 남는다.
  const openRecipeFromFile = async (file: File): Promise<boolean> => {
    let genId: string | null = null;
    try {
      genId = (await api.readFileStamp(file)).gen_id;
    } catch {
      return false; // 판독 실패(구버전 허브 등) — 평범한 파일로 처리
    }
    if (!genId) return false;
    try {
      const [gen, history] = await Promise.all([
        api.getGeneration(genId),
        api.history(genId).catch(() => null),
      ]);
      openRecipe(gen, history);
      return true;
    } catch {
      // 각인은 있는데 카탈로그에 없다 — 다른 PC·계정에서 만든 것일 수 있다.
      flash("이 파일의 생성 기록을 찾지 못했습니다 — 레퍼런스로 넣습니다.");
      return false;
    }
  };
  const {
    bulkDownload,
    onShowHistory,
    openAssetsWindow,
    openManageWindow,
  } = useGenerationUtilityActions({
    flash,
    openRecipe,
  });
  const resolveTransfer = useResolveTransferActions({ flash });
  const { handlePromptCreated } = usePromptCreatedActions({
    boardFocusIdRef,
    boardSelectedRef,
    bumpBoard,
    filtersRef,
    flash,
    reload,
    setGens,
  });
  // ── Canvas 씬 모드 ── 구성 탭에서 씬 생성 카드 1개를 선택하면 하단 프롬프트가 그 카드에 바인딩된다.
  const sceneMode = filters.tab === "compose" && !!activeScene && !!sceneBinding;
  // compose 탭 + 활성 씬이면 트레이는 항상 '캔버스 바인딩' 모드 —
  //  · 카드 선택 시: 그 카드의 refs 를 트레이에 로드
  //  · 아무것도 선택 안 함: refs=[] 로 줘서 트레이를 비운다(→ '선택 없음'을 시각적으로 알 수 있게).
  // 바인딩된 카드의 저장된 프롬프트 초안(카드 전환 시 입력창에 복원).
  const boundCardPrompt =
    activeScene && sceneBinding
      ? activeScene.cards.find((c) => c.id === sceneBinding.cardId)?.prompt ?? ""
      : "";
  // 수집 전 input(무선) 소스를 실제 소스로 해석한 엣지 — 텍스트/모델 모두 이 기준으로 잡는다.
  const boundCardsById =
    activeScene && sceneBinding ? new Map(activeScene.cards.map((c) => [c.id, c])) : null;
  const boundResolvedEdges =
    boundCardsById && activeScene ? resolvePortEdges(boundCardsById, activeScene.edges) : [];
  // 연결된 텍스트(text·text-list)가 있으면 그 합친 텍스트가 프롬프트의 진실원천(파생 우선). 없으면 카드 자체 프롬프트.
  const boundGenText =
    boundCardsById && sceneBinding
      ? collectGenText(sceneBinding.cardId, boundCardsById, boundResolvedEdges)
      : { text: "", count: 0 };
  const textDerived = boundGenText.count > 0;
  const derivedPrompt = textDerived ? boundGenText.text : boundCardPrompt;
  // 연결된 모델 노드(1개만 유효)의 설정 — 있으면 하단 프롬프트 모델로 적용.
  const boundModel =
    boundCardsById && sceneBinding
      ? collectGenModel(sceneBinding.cardId, boundCardsById, boundResolvedEdges)
      : null;
  const boundAssignment =
    boundCardsById && sceneBinding
      ? collectSceneGenerationAssignment(sceneBinding.cardId, boundCardsById, boundResolvedEdges)
      : undefined;
  const trayBinding =
    filters.tab === "compose" && activeScene
      ? sceneBinding
        ? {
            key: `${activeScene.id}:${sceneBinding.cardId}`,
            // promptKey: 같은 카드에서 연결 텍스트가 바뀌면 에디터를 다시 채우도록(파생 반영). 파생 아니면 고정.
            promptKey: textDerived ? `txt:${boundGenText.text}` : "card",
            promptDerived: textDerived,
            refs: sceneBinding.refs,
            prompt: derivedPrompt,
            model: boundModel,
            assignment: boundAssignment,
            // modelKey: 연결 모델(모델/타입/파라미터) 변경 감지 — 같은 카드에서 모델노드 바뀌면 재적용.
            modelKey: boundModel
              ? `${boundModel.model}|${boundModel.type ?? ""}|${JSON.stringify(boundModel.params ?? {})}`
              : "none",
          }
        : {
            key: `${activeScene.id}:none`,
            promptKey: "none",
            // ★고정 빈 배열 — 매 렌더 새 [] 를 주면 트레이 동기화(A)가 App 재렌더마다 다시 돌아, 카드 없이 '프롬프트
            //  재사용'으로 넣은 레퍼런스를 빈 배열로 되돌린다(폴더 보기 창을 닫는 순간 알약이 ⚠ 로 — 2026-09-09).
            refs: EMPTY_SCENE_REFS,
            prompt: "",
            model: null,
            modelKey: "none",
            assignment: undefined as SceneGenerationAssignment | undefined,
          }
      : null;
  // 씬 생성 카드의 레퍼런스를 프롬프트 트레이 편집(순서변경·추가·삭제)으로 되돌려 저장.
  // ★refs·prompt 저장이 같은 순간 겹치면(재사용 등) 서로를 덮어쓰지 않게, 렌더 스냅샷 대신
  //  '최신 씬'을 다시 읽어 그 위에 얹는다(onPromptCreated 와 동일 안전 패턴).
  const setSceneCardRefs = (refs: SceneRef[]): SceneRef[] => {
    if (!sceneBinding) return refs;
    // SceneBoard 의 명령형 핸들로 위임 — 연결 상태 정규화(연결=레퍼런스) + persist(undo 스택) 를 그쪽에서 처리.
    //  (예전엔 patchActiveScene 로 직접 저장해 undo 우회 + 연결 무시 문제가 있었다.)
    //  정규화된 결과를 반환 → 트레이가 재채택(전체비우기·재사용으로 연결 ref 가 빠져도 되살아난다).
    return sceneActionRef.current?.setCardRefs(sceneBinding.cardId, refs) ?? refs;
  };
  // 프롬프트 입력창 편집 → 현재 바인딩된 카드에 초안 저장(카드별 프롬프트 기억).
  const setSceneCardPrompt = (prompt: string) => {
    if (!activeScene || !sceneBinding) return;
    // 연결된 텍스트가 있으면 프롬프트는 파생(연결 텍스트 우선) — 에디터 편집을 카드에 저장하지 않는다.
    if (textDerived) return;
    canvasDocument.commit(canvasTarget(activeScene.id), { type: "editCardPrompt", cardId: sceneBinding.cardId, prompt });
  };
  // 생성 완료 → 결과 gen id 를 선택 카드에 바인딩(카드에 썸네일 표시). 씬 모드에선 구성보드 부모 자동연결은 건너뜀.
  const onPromptCreated = async (created?: Generation[], dragParentId?: string | null) => {
    if (sceneMode && activeScene && sceneBinding) {
      const newIds = (created || []).map((x) => x.id); // 복수 생성이면 여러 장 → 카드에 모두 누적
      if (newIds.length) seedPending(newIds); // 방금 생성 glow — 첫 폴링이 이미 done 이어도 뜨게 baseline 선등록
      if (newIds.length) {
        canvasDocument.commit(canvasTarget(activeScene.id), { type: "linkCardResults", cardId: sceneBinding.cardId, generationIds: newIds });
      }
      if (created?.length) {
        mergeFacetTags(created.flatMap((item) => item.tags || []));
        setGens((prev) => {
          const ids = new Set(prev.map((x) => x.id));
          const fresh = created.filter((x) => !ids.has(x.id));
          return fresh.length ? [...fresh, ...prev] : prev;
        });
      }
      flash("생성 잡을 시작했습니다.");
      void reload();
      bumpBoard();
      return;
    }
    return handlePromptCreated(created, dragParentId);
  };
  // 씬 저장 — 현재 활성 씬을 가벼운 텍스트(JSON)로 내려받는다. 미디어는 참조만(가볍게).
  //  camera 인자는 SceneBoard 의 '라이브 카메라'(debounce 로 지연된 activeScene.camera 대신 최신).
  const handleSaveScene = (camera?: { z: number; x: number; y: number }) => {
    if (!activeScene) return;
    const text = exportSceneText(camera ? { ...activeScene, camera } : activeScene);
    // 공용 헬퍼로 저장 — 앵커를 문서에 붙였다 떼고(브라우저에 따라 미부착 앵커의 click 은 무시됨),
    // object URL 회수도 클릭 뒤로 미룬다(동기 revoke 는 저장 전에 URL 이 사라질 수 있음).
    downloadText(
      `${(activeScene.name || "scene").replace(/[^\w가-힣 .-]/g, "_")}.mvscene.json`,
      text,
      "application/json",
    );
  };
  // 캔버스 전체를 파일로 — 탭 줄의 '저장 안 됨'이 부른다(설정 창의 [전체 내보내기]와 같은 파일).
  //  밀린 입력을 먼저 저장으로 넘겨, 방금 친 글까지 파일에 들어가게 한다.
  const exportAllScenes = () => {
    if (activeScene) flushScenePending(activeScene.id);
    void downloadSceneArchive().then(
      (count) => flash(`캔버스 ${count}개를 파일로 내려받았습니다.`),
      (error) => flash(error instanceof Error ? error.message : "내려받지 못했습니다."),
    );
  };
  // 씬 불러오기 — 파일을 검증해 '새 탭'으로 연다(현재 캔버스 보존). 선택·프롬프트 바인딩은 초기화.
  const handleLoadSceneFile = async (file: File) => {
    if (file.size > SCENE_IMPORT_MAX_BYTES) {
      flash("파일이 너무 큽니다(최대 5MB).");
      return;
    }
    try {
      const snap = parseSceneImport(await file.text());
      importSceneSnapshot(snap);
      setSceneBinding(null);
      setSceneSelGens([]);
      flash(`씬 "${snap.name}" 을(를) 새 탭으로 불러왔습니다.`);
    } catch (e) {
      flash(e instanceof Error ? e.message : "씬 불러오기에 실패했습니다.");
    }
  };
  // 폴더 필터가 해제되거나(프로젝트/라이브러리/미분류 선택) 다른 프로젝트로 바뀌면 무장 폴더(armedFolder)도
  // 함께 해제한다 — 안 그러면 폴더 필터를 풀어도 새 생성이 예전 폴더로 저장되던 문제(라이브러리·캔버스 공통).
  useEffect(() => {
    if (
      armedFolder &&
      (generationScope.folder_path !== armedFolder.path || generationScope.project_id !== armedFolder.projectId)
    ) {
      setArmedFolder(null);
    }
  }, [generationScope.folder_path, generationScope.project_id, armedFolder, setArmedFolder]);
  const {
    onFinalize,
    onReviewSelection,
    onReview,
    onImport,
    onRecoveryRequeue,
    onRegenerate,
    onSetSource,
    onUnfinalize,
    onUnpublish,
  } = useGenerationCardActions({
    armedAutoTags,
    bumpBoard,
    canFinalize,
    flash,
    navTab,
    reload,
    workspace: workspaceContext,
  });
  const { onSceneRegenerate, generateCards, generateCardRuns } = useSceneGenerationSubmission({
    activeScene, workspaceContext, sceneWorkspaceBlock, generationProjectId: generationScope.project_id,
    batchCount, armedFolder, armedAutoTags, flushScenePending, prepareCanvasGenerationBatch, confirmCanvasGeneration,
    settleCanvasGeneration, discardCanvasGeneration, onRegenerate, flash,
    reportPromptError: (message) => spotlightPromptRef.current?.reportError(message),
    mergeFacetTags, reload, bumpBoard,
  });
  const draftRequests = useDraftRequests(gens);
  const finishDraft = async (generation: Generation) => {
    if (!canFinishDraft(generation)) return;
    const scope = captureSubmissionScope(workspaceContext);
    const attempt = draftRequests.begin(generation.id, scope);
    if (!attempt) return;
    let link: Awaited<ReturnType<typeof prepareCanvasGenerationBatch>>[number] | undefined;
    let acceptedOrUnknown = false;
    try {
      if (activeScene) {
        flushScenePending(activeScene.id);
        const scene = listScenes(null).find((item) => item.id === activeScene.id) ?? activeScene;
        const card = scene.cards.find((item) => variantIds(item).includes(generation.id));
        if (!card) throw new Error("Draft 결과를 쌓을 캔버스 카드를 찾지 못했습니다.");
        link = (await prepareCanvasGenerationBatch(scene.id, [card.id]))[0];
        if (!link) throw new Error("캔버스 저장을 확인하지 못했습니다.");
      }
      const prepared = prepareRegenerateSubmission(generation.id, { finish_draft: true }, workspaceContext, link, scope);
      const result = await runSubmission(prepared, link ? {
        confirm: () => confirmCanvasGeneration([link!]),
        apply: (next) => settleCanvasGeneration(link!, next),
      } : undefined);
      acceptedOrUnknown = result.outcome.kind === "accepted" || result.outcome.kind === "accepted_local_pending" || result.outcome.kind === "acceptance_unknown";
      if (!scope.isCurrent!()) return;
      if (!result.generation) {
        if (result.outcome.kind === "acceptance_unknown") {
          // 서버의 Draft 예약이 중복 생성을 막으므로, 결과 id가 없는 시도는 다시 확인할 수 있게 한다.
          draftRequests.release(attempt);
          flash("Draft 요청의 접수 여부를 확인하지 못했습니다. 생성 목록에서 기존 요청을 확인하세요.");
          return;
        }
        throw result.error ?? new Error("Draft 생성 요청을 제출하지 못했습니다.");
      }
      draftRequests.accept(attempt, result.generation);
      flash(result.outcome.kind === "accepted_local_pending"
        ? "Draft 생성 요청은 접수됐습니다. 캔버스 연결은 재시작 시 복구됩니다."
        : "Draft 1080p 생성 요청을 접수했습니다.");
      await reload();
      if (scope.isCurrent!()) { bumpBoard(); postLibraryChanged(); }
    } catch (error) {
      if (scope.isCurrent!()) flash(`Draft 생성 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (!acceptedOrUnknown) {
        if (link && scope.isCurrent!()) discardCanvasGeneration(link);
        draftRequests.release(attempt);
      }
    }
  };

  // 정보팝업 '⧉ 히스토리' → 구성탭 계보 트리(뒤로가기로 직전 화면 복원).
  // ★씬 탭 바에서 고정 '히스토리' 탭이 빠져 이 버튼들이 유일한 진입로다 — 활성 씬을 내려놓아야
  //   (activeScene null) 캔버스 대신 트리가 실제로 렌더된다. 돌아갈 땐 씬 탭을 클릭.
  const onOpenInBoard = (g: Generation) => {
    selectScene(null);
    enterBoard(g.id);
  };

  // 미리보기(크게 보기) '구성에서 보기' → 구성탭 계보 트리(위와 동일).
  const onOpenInBoardFromPreview = (genId: string) => {
    selectScene(null);
    enterBoard(genId);
  };

  const onLogout = async () => {
    // 로그아웃된 뒤에 데이터를 비운다(조작 규칙 41). 전엔 먼저 비웠는데, 로그아웃하지 못하면(허브가 실패를 답했다 — 안내는 logout 이
    //  띄운다) 아직 그 계정인 채로 빈 목록만 남는다.
    if (await logout()) setGens([]);
  };

  // ★훅은 조기 return 위에서 무조건 호출돼야 한다(아래 authPending/로그인 게이트보다 위). memo 파생값.
  // 폴더 딤 대상 — 매 App 렌더마다 새 객체를 만들면 HistoryBoardNode memo 가 깨지므로 memo.
  const folderSel = useMemo(
    () =>
      filters.project_id && filters.project_id !== "none" && filters.folder_path
        ? { projectId: filters.project_id, path: filters.folder_path }
        : null,
    [filters.project_id, filters.folder_path],
  );
  // 캔버스 폴더 보기(2026-09-09, Jay) — 활성 씬이 열려 있으면 계보 보드가 숨어 폴더 내용이 안 보인다. 사이드바에서
  //  폴더를 고르면 가운데 플로팅 창에 라이브러리 격자(ThumbnailGrid, 같은 gridGens·툴바 필터·날짜 구분)를 그대로 띄워
  //  워크스페이스로 가지 않고 그 폴더에 뭐가 있는지 바로 본다. 닫기: ✕·Esc·바깥 클릭·씬 전환·탭 이탈·프로젝트만 선택.
  //  Esc 는 미리보기/정보 팝업이 위에 떠 있으면 그쪽이 먼저 닫히게 양보한다.
  useEffect(() => {
    if (filters.tab !== "compose" || !activeSceneId || !folderSel || editOpen) setFolderPeek(false);
  }, [filters.tab, activeSceneId, folderSel, editOpen]);
  // 열리거나(폴더 바뀜 포함) 열린 채 필터가 바뀌면 그 폴더 목록을 새로 받는다 — compose 는 평소 목록을 안 받아
  //  이전 탭(팀·휴지통) 카드가 남아 있을 수 있으니 먼저 비운다(코덱스 P1). 열릴 때 창으로 초점 이동 — 안 하면
  //  폴더 클릭 직후 Delete 가 뒤 캔버스 선택 노드를 지운다(코덱스 P2).
  //  비우기는 그리기 전에(layout) — 그린 뒤에 비우면 첫 화면에 직전 폴더(처음이면 워크스페이스 전체) 카드가 한 번 비쳤다. 그리고 아래 목록
  //  조회 effect(serverFilterKey)보다 먼저 — 뒤에 비우면 그 effect 가 방금 띄운 조회를 버리고 같은 조회를 줄 세워 요청이 두 번, 시간도
  //  두 배였다(69회차 격리 실측: 캔버스 우클릭 폴더 창 3단계·요청 2번 직렬 · 라이브러리 경로는 2단계·1번).
  useLayoutEffect(() => {
    if (folderPeek) beginComposeList(); // 소유 탭 전환 + 비우기(이전 탭 캐시 보존)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderPeek, serverFilterKey]);
  // 조회는 조건이 그대로일 때만(같은 폴더를 다시 열기 등) 여기서 — 조건이 바뀐 커밋은 목록 조회 effect 가 이미 띄웠다(compose 는 늘 다시 받는다)
  const peekQueryKeyRef = useRef(serverFilterKey);
  useEffect(() => {
    const queryChanged = peekQueryKeyRef.current !== serverFilterKey;
    peekQueryKeyRef.current = serverFilterKey;
    if (!folderPeek) return;
    if (!queryChanged) void reload();
    folderPeekRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderPeek, serverFilterKey]);
  // Esc(창 밖에 초점이 있을 때) — 창 안 초점은 section onKeyDown 이 직접 처리(stopPropagation 이 window 훅을 막는다).
  useBackgroundEscape(
    () => {
      // 초점이 창 안이면 그 Esc 의 주인은 창의 키 처리(renderFolderPeek)다. 이 훅은 선택이 없을 때만 켜지는데, 창이 선택을 풀면
      //  그 자리에서 다시 그려지며 이 훅이 켜지고 같은 키가 window 에 닿아 창까지 닫았다(2026-10-07 브라우저 실측: Esc 한 번에
      //  선택 해제 + 창 닫힘). 전파를 막는 대신 여기서 손을 뗀다 — 같은 Esc 를 기다리는 다른 창(등급 확인 등)은 그대로 받는다.
      if (folderPeekRef.current?.contains(document.activeElement)) return false;
      // 창 밖의 글 칸(하단 프롬프트 — 창이 뜬 동안에도 쓸 수 있다)에서 난 Esc 는 창을 닫지 않는다. 그 글 칸을 벗어나 창으로
      //  돌아오고, 한 번 더 누르면 닫힌다 — 창 안 글 칸·코멘트 입력칸의 Esc 와 같은 순서다(2026-10-10 격리 실측: 전엔 바로 닫혔다).
      if (isTypingTarget(document.activeElement)) {
        folderPeekRef.current?.focus();
        return;
      }
      if (listPeek) closeFolderWindow();
      else setFolderPeek(false);
    },
    (folderPeek || !!listPeek) && !preview && info === null && selected.size === 0, // 선택이 있으면 Esc 는 선택 해제(라이브러리와 동일)
  );
  // 컷 카드를 골랐을 때의 Esc = 고른 것 비우기 — 뒤 화면의 Esc 라, 그 위에 무엇이든(크게 보기·정보·컷 정보·모아보기·메뉴) 떠 있으면
  //  쉰다(lib/useEscapeClose). 폴더 창은 겹이 아니라 여기서 따로 본다 — 창을 닫은 Esc 는 '쓴 것'으로 표시돼 여기까지 오지 않는다
  //  (2026-10-10 실측: 폴더 창을 Esc 로 닫으면 뒤의 컷 선택까지 지워졌다).
  useBackgroundEscape(() => setCutSel(new Set()), cutMode && cutSel.size > 0 && !listPeek);
  // 목록 탭의 폴더 창도 열릴 때 초점을 창으로 — 조회는 위 serverFilterKey effect 가 맡는다(조회 조건이 그 폴더로 바뀌므로).
  useEffect(() => {
    if (listPeek) folderPeekRef.current?.focus();
  }, [listPeek]);
  // 폴더 창의 아래 끝 = 하단 프롬프트 위(app-shell.css 의 --peek-dock-gap). 프롬프트 높이는 바뀌므로(참조 줄·오류 줄·접힘) 창이 뜬 동안 잰다.
  //  프롬프트가 없는 화면이면 값을 두지 않는다(CSS 의 11vh 그대로).
  const peekOpen = folderPeek || !!listPeek;
  useEffect(() => {
    if (!peekOpen) return;
    const dock = document.querySelector(".sl-dock");
    if (!dock || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const measure = () => {
      const gap = Math.max(0, Math.round(window.innerHeight - dock.getBoundingClientRect().top));
      root.style.setProperty("--peek-dock-gap", `${gap + 12}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(dock);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      root.style.removeProperty("--peek-dock-gap");
    };
  }, [peekOpen]);
  // 닫으면 초점을 본 목록 격자로 돌려준다 — 창이 사라지면 초점이 BODY 로 떨어져, 격자의 키(Ctrl+A·방향키…)가 격자에 초점을 다시
  //  줄 때까지 먹지 않았다(2026-10-07 실측). 본 목록이 조작 가능해진 뒤에 한다(옛 첫 쪽을 보이는 동안 main 은 inert, 받는 중이면
  //  격자가 아직 없다). 스크롤은 그대로. 기다리는 사이 문맥이 한 번이라도 달라졌거나 초점이 어디로든 옮겨 갔으면 그만둔다 —
  //  복원하는 순간의 상태만 보면 안 된다: 문맥이 바뀌었다 되돌아온 경우, 초점을 받았던 요소가 사라져 다시 BODY 가 된 경우
  //  (메뉴에서 설정 창을 연 직후 등)에 남이 시작한 일 뒤의 격자로 초점을 보내게 된다(Codex 코드 리뷰).
  useEffect(() => {
    if (refocusGridRef.current !== null && refocusGridRef.current !== "*" && refocusGridRef.current !== listPeekCtx) refocusGridRef.current = null;
    // 컷 화면이 주인이면 컷 카드 격자가 그 자리다 — 숨은 본 목록의 '받는 중'을 기다리지 않는다(Codex FE-01)
    if (refocusGridRef.current === null || listLocked || (!cutOwns && loading)) return;
    // 묶음 응답을 기다리는 동안(③ cutPending)은 격자가 비어 있다 — 어느 복원이든 **최종 격자가 선 뒤**에. 에피소드로 들어간 뒤("*")만이 아니라
    //  폴더 창을 닫은 뒤도(낱장 조회가 묶음 조회보다 먼저 끝나면 빈 격자에서 표식이 소비돼 초점이 안 돌아왔다 — Codex 코드 리뷰). 옛 서버·실패면
    //  낱장 격자가 최종이다(실패 뒤에도 기다리던 것 — Codex 설계 검토).
    if (cutPending) return;
    refocusGridRef.current = null; // 한 번만 — 격자가 없으면(빈 목록·실패) 그대로 끝낸다
    // 묶음 보기면 컷 카드 격자가 그 자리다(둘 중 하나만 떠 있다)
    document.querySelector<HTMLElement>("main.main .gen-grid, main.main .cut-grid")?.focus({ preventScroll: true });
  }, [listLocked, loading, listPeekCtx, cutPending, cutOwns]);
  useEffect(() => {
    const cancel = () => { refocusGridRef.current = null; };
    document.addEventListener("focusin", cancel);
    return () => document.removeEventListener("focusin", cancel);
  }, []);
  // 코멘트 패널 라벨 — 열렸을 때만, gens 가 바뀔 때만 계산(매 렌더 전량 find 방지).
  const commentLabel = useMemo(
    () =>
      commentGenId
        ? (gens.find((g) => g.id === commentGenId)?.prompt || "").slice(0, 40) || "생성본"
        : "생성본",
    [commentGenId, gens],
  );
  // 여러 장을 골랐을 때 리뷰 메뉴에서 켤 항목 — 격자가 이 객체를 모든 카드에 그대로 넘긴다. 렌더마다 새 객체면 선택이 바뀔 때마다
  //  보이는 카드의 memo 가 전부 깨진다 → 네 값이 같으면 같은 객체를 쓴다(선택 목록에 걸면 선택마다 다시 만들어진다).
  //  훅이라 아래 조기 return 위에 둔다 — 격자 옆(return 뒤)에 두면 인증 확인이 끝나는 렌더에서 훅 수가 늘어 앱이 멈춘다.
  const allowUnshared = reviewTargets(selectedGenerations, "unshared", canFinalize).length > 0;
  const allowShared = reviewTargets(selectedGenerations, "shared", canFinalize).length > 0;
  const allowHeld = reviewTargets(selectedGenerations, "held", canFinalize).length > 0;
  const allowFinal = reviewTargets(selectedGenerations, "final", canFinalize).length > 0;
  const bulkReviewAllowed = useMemo(
    () => ({ unshared: allowUnshared, shared: allowShared, held: allowHeld, final: allowFinal }),
    [allowUnshared, allowShared, allowHeld, allowFinal],
  );

  // 인증 검증이 끝나기 전(authConfig 로딩 중 또는 토큰 me 검증 중)에는 화면을 보류한다.
  // → 새로고침 시 메인(전역 provider 이름)·로그인 화면이 잠깐 깜빡이는 것을 방지.
  if (authPending) {
    return null;
  }
  // 인증 게이트: 로그인 필요(서버 모드)한데 미로그인 → 앱 전체를 로그인 화면으로 가린다.
  if (authConfig?.auth_enabled && !account) {
    return <LoginScreen config={authConfig} onAuthed={setAccount} notice={loggedOutElsewhere ? "다른 탭에서 로그아웃했습니다." : undefined} />;
  }
  // 로컬 허브 게이트: 백엔드 AUTH off(로컬)에서는 '팀 서버 로그인'을 강제 — 로그인해야 사용
  // (신원=서버 계정). 서버 계정으로 작업·공유가 기록되고, 역할은 서버가 관리·강제.
  if (!authConfig?.auth_enabled) {
    if (sharedSrv === null) return null; // 연결 상태 로딩 중 — 깜빡임 방지
    if (!sharedSrv.has_token) {
      return (
        <ServerLoginScreen
          url={sharedSrv.url}
          serverName={sharedSrv.server_name}
          urlHistory={sharedSrv.url_history}
          onConnected={onProxyConnected}
        />
      );
    }
  }

  // 관리창(관리탭)은 로그인 사용자 모두에게 연다 — 작업/완료 탭은 전원 접근. 대시보드 탭만
  // 관리창 안에서 read_all(admin/PM/PD) 로 게이트한다(ManageWindow). 관리 기능 자체가 켜져 있어야.
  const canOpenManage = !!authConfig?.manage_enabled && !!hubAccount;

  // 멀티선택 액션바 — 프롬프트가 보이면 프롬프트 상단(topSlot)에, Ctrl+K 로 프롬프트를 숨기면 화면 상단
  // 중앙에 플로팅으로 유지한다(프롬프트와 함께 사라지지 않게). 아래에서 상태에 따라 한 곳에서만 마운트.
  // 라이브러리 선택 액션바 — 라이브러리 탭 본문과 캔버스 '폴더 보기' 창이 같은 요소를 쓴다.
  // 컷 카드를 골랐을 때의 막대 — [모아보기]. 생성물 선택 막대와 같은 자리(프롬프트 위·Ctrl+K 땐 상단 중앙)에 뜬다.
  //  폴더 창이 떠 있으면 뒤의 고른 컷은 보이지 않으니 막대도 없다.
  const cutSelectionBar =
    !listPeek && cutMode && selectedCuts.length > 0 ? (
      <div className="select-bar">
        <span className="sb-count">{selectedCuts.length}{t("컷 선택")}</span>
        <button
          type="button"
          title={t("고른 컷의 썸네일(없으면 최신 것)을 순서대로 모아 본다")}
          onClick={() => setCutReel({ paths: selectedCuts.map((folder) => folder.path), ctx: listPeekCtx })}
        >
          ▦ {t("모아보기")}
        </button>
        <button type="button" onClick={() => setCutSel(new Set())}>{t("선택 해제")}</button>
      </div>
    ) : undefined;
  const librarySelectionBar = cutSelectionBar ?? (
    selected.size > 0 ? (
      <LibrarySelectionActionBar
        selectedCount={selected.size}
        selectedGenerations={selectedGenerations}
        projects={projects}
        onShare={boardShare}
        onGradeStep={filters.tab === "team" ? onBulkGradeStep : undefined}
        onDownload={bulkDownload}
        onResolveTransfer={resolveTransfer.sendToResolve}
        onResolveRetry={resolveTransfer.retryable ? resolveTransfer.retryPreparedTransfer : null}
        resolveRetryProjectName={resolveTransfer.retryable?.target.project_name || ""}
        resolveTransferBusy={resolveTransfer.busy}
        resolveTransferPendingCount={resolveTransfer.pendingCount}
        onCompare={(items) => {
          if (items.length >= 2) setCompareGens(items);
        }}
        onAssign={assignSelectedToProject}
        onDelete={bulkDelete}
        onRestore={bulkRestore}
        onPurge={bulkPurge}
      />
    ) : undefined);

  const selectionBar =
    filters.tab === "compose" ? (
      // 씬(캔버스)이 열려 있으면 씬 선택 결과카드 기준, 아니면 히스토리 보드 선택 노드 기준.
      activeScene ? (
        sceneCompareMedia ? (
          // 레퍼런스 등 비생성 미디어가 섞인 선택 → 단순 미디어 비교(이미지·영상 나란히, 영상 동시재생).
          <div className="select-bar">
            <span className="sb-count">{sceneCompareMedia.length}개 선택</span>
            <button
              title="선택한 미디어를 나란히 비교(영상은 동시 재생, 보기 전용)"
              onClick={() => setVideoCompare(sceneCompareMedia)}
            >
              ⊞ 비교
            </button>
          </div>
        ) : sceneSelGens.length > 0 ? (
          <BoardSelectionActionBar
            selected={sceneSelGens}
            onFinishDraft={finishDraft}
            draftBusy={sceneSelGens.some((generation) => draftRequests.pending.has(generation.id))}
            draftDone={sceneSelGens.some((generation) => draftRequests.completed.has(generation.id))}
            projects={projects}
            onShare={boardShare}
            onDownload={bulkDownload}
            onCompare={(items) => setCompareGens(items)}
            onAssign={(pid, folder) => boardAssign(sceneSelGens, pid, folder)}
            onDelete={() => sceneActionRef.current?.deleteSelected()}
            onResolveTransfer={resolveTransfer.sendToResolve}
            onResolveRetry={resolveTransfer.retryable ? resolveTransfer.retryPreparedTransfer : null}
            resolveRetryProjectName={resolveTransfer.retryable?.target.project_name || ""}
            resolveTransferBusy={resolveTransfer.busy}
            resolveTransferPendingCount={resolveTransfer.pendingCount}
          />
        ) : undefined
      ) : boardSelected.length > 0 ? (
        <BoardSelectionActionBar
          selected={boardSelected}
          onFinishDraft={finishDraft}
          draftBusy={boardSelected.some((generation) => draftRequests.pending.has(generation.id))}
          draftDone={boardSelected.some((generation) => draftRequests.completed.has(generation.id))}
          projects={projects}
          onShare={boardShare}
          onDownload={bulkDownload}
          onCompare={(items) => setCompareGens(items)}
          onAssign={(pid, folder) => boardAssign(boardSelected, pid, folder)}
          onDelete={boardDelete}
          onResolveTransfer={resolveTransfer.sendToResolve}
          onResolveRetry={resolveTransfer.retryable ? resolveTransfer.retryPreparedTransfer : null}
          resolveRetryProjectName={resolveTransfer.retryable?.target.project_name || ""}
          resolveTransferBusy={resolveTransfer.busy}
          resolveTransferPendingCount={resolveTransfer.pendingCount}
        />
      ) : undefined
    ) : librarySelectionBar;

  // 라이브러리 툴바 — 라이브러리 탭 본문과 캔버스 '폴더 보기' 창이 같은 요소를 쓴다(창에서도 워크스페이스처럼 조작).
  // 도구 줄의 [컷별 | 전체] 전환 — 묶어 보일 수 있을 때만. 켜 둔 채로는 실제로 묶어 보이는 동안(응답을 기다리는 동안 포함 — 사라졌다 다시
  //  나타나지 않게, ③)에만 보인다 — 하위 폴더가 없는 폴더에서는 바꿀 것이 없다.
  const cutToggle =
    cutScope && !folderCardsUnsupported && (cutMode || !cutView || cutPending)
      ? {
          on: cutView,
          onChange: setCutView,
          // 묶음 답을 기다리는 동안 — 숫자는 낱장 목록 것이라 '전체 · N건 · 로딩…' 이 비쳤다가 '컷 N · M건' 으로 바뀌었다(70회차)
          pending: cutPending && cutView ? { top: cutScope.parent === "" } : undefined,
          summary: cutCards
            ? {
                top: cutScope.parent === "",
                folders: cutCards.folders.length,
                items: cutCards.folders.reduce((sum, folder) => sum + folder.count, cutCards.own_count),
                // 걸러 보는 중 — 답을 받는 동안(앞 결과·안 거른 카드를 보이는 중) '거르는 중…', 상한에서 잘렸으면 '최근 N건 기준'
                //  받지 못했으면 그렇다고 알린다 — 화면의 카드는 앞 조건의 것이거나 안 거른 것이다(완료처럼 보이면 안 된다, Codex 코드 리뷰)
                note: cutFiltering ? t("거르는 중…")
                  : cutFiltered && local.failed ? t("걸러 보기 실패")
                  : cutFiltered && local.fresh && local.truncated ? `${t("최근")} ${FETCH_ALL_MAX}${t("건 기준")}` : undefined,
              }
            : undefined,
        }
      : undefined;
  const libraryToolbar = (
    <LibraryToolbar
      workspaceFilter={workspaceFilter}
      typeFilter={typeFilter}
      onTypeFilter={setTypeFilter}
      scale={scale}
      onScale={setScale}
      fill={fill}
      onToggleFill={() => setFill((v) => !v)}
      layout={layout}
      onLayout={setLayout}
      groupByDate={groupByDate}
      onToggleGroupByDate={() => setGroupByDate((v) => !v)}
      filtersOpen={showFilters}
      onToggleFilters={() => setShowFilters((v) => !v)}
      count={gridGens.length}
      countMore={hasMore && !listGate}
      folderCards={listPeek ? undefined : cutToggle} // 창 안의 툴바에는 전환 단추가 없다
      grayOn={grayOn}
      onToggleGray={toggleGray}
      loading={loading}
      failedCount={failedCount}
      onClearFailed={clearFailed}
      colorDots={COLOR_DOTS}
      colorFilter={colorFilter}
      onToggleColor={toggleColorFilter}
      sharedOnly={sharedOnly}
      reviewFilter={reviewFilter}
      onReviewFilter={setReviewFilter}
      onToggleShared={() => setSharedOnly((v) => !v)}
      commentOnly={commentOnly}
      onToggleComment={() => setCommentOnly((v) => !v)}
      finalOnly={finalOnly}
      onToggleFinal={() => setFinalOnly((v) => !v)}
      hasUnread={hasAnyUnread}
      tags={facets.tags}
      tagFilter={tagFilter}
      onSelectTag={selectTagFilter}
      onDeleteTag={deleteTagEverywhere}
      onClearTags={clearTagFilter}
      tagPanelOpen={tagPanelOpen}
      onToggleTagPanel={toggleTagPanel}
    />
  );

  // 라이브러리 격자 — 라이브러리 탭 본문과 캔버스 '폴더 보기' 창이 같은 요소를 쓴다(동시에 마운트되지 않음).
  const thumbnailGrid = (
    <ThumbnailGrid
          resolveHighlightedIds={resolveLibrary.highlightedIds}
          // 폴더 창에서는 이름표를 누른 그 카드로 한 번 내려간다(다빈치 따라가기와 같은 장치 — 창이 떠 있는 동안 따라가기는 꺼져 있다)
          resolveScrollRequest={listPeekScroll ?? resolveLibrary.scrollRequest}
          openedFromId={listPeek && !listPeek.edit ? listPeek.genId : undefined}
          cardMarks={listPeek?.edit ? editMarks : undefined}
          onCardMenu={listPeek?.edit ? openEditCardMenu : undefined}
          onClearResolveHighlight={resolveLibrary.clear}
          generations={gridGens}
          disabledIds={effectiveDisabled}
          onBulkGradeStep={onBulkGradeStep}
          onBulkReview={(action) => void onReviewSelection(selectedGenerations, action, canFinalize)}
          bulkReviewAllowed={bulkReviewAllowed}
          tab={filters.tab === "team" ? "team" : "my"} // 캔버스 폴더 보기(compose)는 내 작업 격자
          myCreatorUid={account?.creator_uid ?? null}
          scale={scale}
          fill={fill}
          layout={layout}
          groupByDate={groupByDate}
          selectedIds={selected}
          // 창을 닫은 직후 옛 사본을 보이는 동안은 고를 수 없다 — 새 목록이 올 때까지(보통 0.5초 미만) 보이기만 한다.
          //  카드의 클릭·키는 <main inert> 가, 바깥에서 시작하는 끌기 선택과 그 결과는 여기서 막는다. 선택은 닫을 때 비웠고
          //  새로 생길 길이 이 둘뿐이라, 선택 막대·전역 단축키(선택이 있어야 움직인다)는 따로 막지 않아도 된다.
          selectLocked={listLocked}
          // 두 번 누름의 둘째가 '첫 누름으로 바뀐 화면'의 카드에 닿는 것을 버린다(조작 규칙 61) — 자리, 또는 그 위에 뜬 폴더 창이 화면이다
          placeKey={listPeek ? `peek:${listPeek.projectId ?? ""}:${listPeek.path}` : hereKey}
          loading={loading}
          onSelectedChange={(next) => {
            if (listLocked) return;
            // comfy 임시 카드(가짜 id)는 선택에서 제외 — 전체선택/범위선택으로 삭제·배정 API 에 흘러가지 않게.
            const clean = [...next].some((id) => id.startsWith("comfy-pending:"))
              ? new Set([...next].filter((id) => !id.startsWith("comfy-pending:")))
              : next;
            setSelected(clean);
            // 코멘트 패널이 열려 있으면 방금 클릭한(단일 선택) 카드로 따라가 그 카드 코멘트를 바로 보여준다.
            if (commentGenId != null && clean.size === 1) setCommentGenId([...clean][0]);
          }}
          onToggleSelect={toggleSelect}
          onSetSource={onSetSource}
          onSetTags={onSetTags}
          onBulkAddTags={onBulkAddTags}
          onBulkRemoveTags={onBulkRemoveTags}
          autoTagOptions={facets.auto_tags}
          onSetAutoTags={onSetAutoTags}
          onBulkAddAutoTags={onBulkAddAutoTags}
          onBulkRemoveAutoTags={onBulkRemoveAutoTags}
          onWorkspaceCommand={onWorkspaceCommand}
          onOpenComments={(g) => openComment(g.id)}
          onRegenerate={onRegenerate}
          onPublish={onPublish}
          onUnpublish={onUnpublish}
          onFinalize={onFinalize}
          onUnfinalize={onUnfinalize}
          onReview={onReview}
          canFinalize={canFinalize}
          onImport={onImport}
          onRestore={onRestore}
          dimDeleted={!filters.deleted_only}
      onInfo={handleInfo}
      onPreview={openPreview}
      onShowHistory={onShowHistory}
      // 폴더 이름표는 목록 탭의 본 목록에서만 — '폴더 보기' 창 안 격자(캔버스·목록 탭 모두)에는 붙이지 않는다(그 창이 이미
      //  폴더 보기다). 휴지통 보기도 뺀다: 휴지통 조회에는 폴더 조건이 없다.
      onOpenFolder={filters.tab === "compose" || filters.deleted_only || listPeek ? undefined : openFolderWindow}
      // 카드 위에 그 폴더의 대표 표시/지정(공유 & 리뷰 탭) — 폴더 창이 떠 있으면 그 폴더의, 아니면 **들어가 있는 폴더**의(컷 카드 두 번 클릭으로
      //  들어간 낱장 목록 — Jay 2026-10-13 ②). 그 폴더의 카드를 받아 온 뒤에만 그린다(옛 공유 서버·받기 전·묶음 보기 중에는 없다).
      cellHeader={
        listPeek?.projectId && filters.tab === "team" && folderCards
          ? coverHeader(peekCoverId, (g) => void pickFolderCover(g))
          : ownScope && ownCards && !cutMode
            ? coverHeader(ownCoverId, (g) => void pickFolderCover(g, { projectId: ownScope.projectId, path: filters.folder_path ?? "" }))
            : undefined
      }
      hasMore={hasMore && !listGate} // 자리를 옮긴 뒤 새 목록 전·낡은 사본·창을 닫은 뒤 사본에는 더 받지 않는다 — 커서가 옛 조회의 것이다
      loadingMore={loadingMore}
      onLoadMore={loadMore}
      resetKey={JSON.stringify([serverFilterKey, storedTab, libraryTabs.active])}
      loadError={loadError}
      onRetryLoad={() => void reload()}
    />
  );

  // '폴더 보기' 창 — 캔버스(사이드바 폴더 클릭)와 목록 탭(카드의 폴더 이름표)이 같은 창을 쓴다. 본문은 하나뿐인 라이브러리
  //  격자·툴바·선택 막대라, 창에서도 워크스페이스처럼 조작한다. 창 안 키 입력은 캔버스 전역 단축키(c·Delete·y…)로 새지 않는다.
  const renderFolderPeek = (title: string, tip: string, close: () => void) => (
    <>
      <div className="folder-peek-catcher" onMouseDown={close} />
      <section
        ref={folderPeekRef}
        className="folder-peek"
        role="dialog"
        aria-label="폴더 보기"
        tabIndex={-1}
        onKeyDown={(e) => {
          // 창 안 키는 라이브러리 단축키(r/g/b/d·격자 키)가 받는다 — 씬 단축키·붙여넣기는 .folder-peek 안 키를
          //  무시하므로(sceneKeyboard) 막지 않는다. Esc 순서: 팝업(미리보기/정보) → 텍스트 입력(그 입력 몫) →
          //  선택 해제(슬라이더 같은 비텍스트 입력에 초점이 있어도 — 전역 훅은 INPUT 전부를 무시한다) → 창 닫기.
          if (e.key !== "Escape") return;
          // 위에 뜬 것(크게 보기·정보·메뉴·확인 창)의 Esc, 또는 안쪽(격자의 선택 해제)이 이미 쓴 Esc 는 건드리지 않는다.
          if (isKeyHandled(e.nativeEvent) || backgroundKeysBlocked()) return;
          const t = e.target as HTMLElement | null;
          const tag = t?.tagName?.toUpperCase();
          const typing =
            (tag === "INPUT" && !["range", "checkbox", "radio", "button"].includes((t as HTMLInputElement).type)) ||
            tag === "TEXTAREA" ||
            !!t?.isContentEditable;
          if (typing) return;
          e.preventDefault();
          markKeyHandled(e.nativeEvent); // 이 Esc 는 여기서 썼다 — 같은 키로 뒤의 컷 선택·씬 선택까지 풀리지 않는다
          if (selected.size > 0) {
            clearSelect();
            return;
          }
          close();
        }}
      >
        <header className="folder-peek-hd">
          <span className="folder-peek-title" title={tip}>
            {title}
          </span>
          <span className="folder-peek-count">
            {gridGens.length}
            {hasMore ? "+" : ""}
          </span>
          <button type="button" className="folder-peek-x" onClick={close} title="닫기 (Esc)">
            ✕
          </button>
        </header>
        {libraryToolbar}
        {thumbnailGrid}
        {librarySelectionBar && <div className="folder-peek-selbar">{librarySelectionBar}</div>}
      </section>
    </>
  );

  // 폴더 창이 떠 있는 동안 그 뒤(상단바·사이드바·본문)는 inert 다 — 마우스는 창의 바깥 막이 막지만 Tab 으로는 닿았다(2026-10-11 실측:
  //  목록 탭의 창은 48번째 Tab 부터 상단바로, 캔버스의 창은 72번째부터 사이드바·상단바로 나갔다. 사이드바의 폴더 줄에 초점이 놓이면
  //  그 줄의 키 처리가 전파를 막아(common/FolderTreeView) Esc 로 창이 닫히지도 않았다). 그 밖에 남는 것 = 창·하단 프롬프트·창에서 연 것.
  //  창이 실제로 그려지는 조건과 같은 값으로 건다 — 상태(folderPeek)만 보면 창 없이 화면만 잠길 수 있다.
  //  편집 탭이 열려 있으면 캔버스는 그려지지 않는다 — 창도 같이 빠진다(창을 닫는 effect 는 한 박자 뒤에 돈다).
  const canvasPeek = !editOpen && filters.tab === "compose" && folderPeek && !!activeScene && !!folderSel;
  const behindInert = !!listPeek || canvasPeek;

  return (
    <div className="app">
      <TopBar
        filters={filters}
        searchResetKey={JSON.stringify([followRevision, storedTab, libraryTabs.active, libraryAuthKey, teamScopeKey, filters.project_id, filters.folder_path, filters.deleted_only])}
        onTab={(tab) => {
          navTab(tab); // 브라우저 히스토리 엔트리 추가(뒤로/앞으로 연동)
          if ((tab === "my" || tab === "team") && libraryTabs.resume(tab)) return;
          // 직접 탭 클릭은 다른 필터를 초기화하되 무장된 워크스페이스 침 필터는 유지
          setFilters((previous) => ({ tab, workspace_ids: previous.workspace_ids }));
          // 공유 탭을 **직접 눌러** 들어오면 같은 문맥의 마지막 자리로(2026-10-13 ①). **사이드바의 표시(= 다음 생성 위치·무장 폴더)도 그 자리로
          //  옮긴다**(2026-10-14 Jay: "이미지1처럼 선택되어있으면 이미지2처럼 나와야하고 만약 전에 눌러서 저 화면이 나왔다면 이미지3번처럼" —
          //  전에는 보는 자리만 되살려 사이드바는 프로젝트, 카드는 e035 였다. 뒤로·앞으로 가기와 같게(adopt)). 기억이 없거나 다른 문맥이면 프로젝트
          //  맨 위 — 사이드바의 표시도 맨 위로 맞춘다(Codex 코드 리뷰: 공간을 바꿔 공유 탭의 자리만 표시 전용으로 비운 뒤면 위의 setFilters 는 자리가
          //  그대로라 생성 위치를 안 건드려, 사이드바에 옛 폴더가 남았다). 뒤로·앞으로 가기는 여기를 거치지 않고 기록의 자리를 쓴다(lib/useAppNavigation).
          //  기억을 되살리는 것만 문맥이 있어야 한다 — 전체 보기(문맥 없음)에서도 사이드바의 표시는 맞춘다(Codex 36회차).
          if (tab === "team") {
            const remembered = teamMemoryCtx ? LS.loadJSON<TeamLocationMemory>(TEAM_LOCATION_KEY) : null;
            if (remembered && remembered.ctx === teamMemoryCtx && (remembered.project_id || remembered.folder_path)) {
              // 그사이 지워졌는지는 판정하지 않는다 — 사이드바의 프로젝트 목록은 보관·공간 제한이라 없다고 지워진 것이 아니고, 폴더는 알 길이 없다
              //  (컷 카드 0장은 공유 해제·필터로도 난다). 정말 사라졌으면 빈 목록이 보이고, 사이드바에서 다시 고르면 기억이 덮인다(Codex 코드 리뷰 2회).
              restoreLocation({ project_id: remembered.project_id, folder_path: remembered.folder_path }, true);
            } else adoptShownLocation();
          }
          clearSelect();
        }}
        editOpen={editOpen}
        onOpenEdit={openEdit}
        onSearch={(q) => patch({ search: q || undefined })}
        onWorkspaceSwitched={(context) =>
          flashWorkspaceSwitched(context.scope === "personal" ? "개인" : context.name)
        }
        workspaceContext={workspaceContext}
        onWorkspaceContextChange={changeWorkspaceContext}
        onImported={async (msg) => {
          await reload();
          flash(msg);
        }}
        onOpenAssets={openAssetsWindow}
        onOpenMcp={() => { setMcpLoaded(true); setMcpOpen(true); }}
        onOpenManage={canOpenManage ? openManageWindow : undefined}
        onOpenAdmin={openAdmin}
        account={hubAccount}
        onLogout={onLogout}
        localHub={!authConfig?.auth_enabled}
        manageEnabled={authConfig ? !!authConfig.manage_enabled : undefined}
        hasUnreadComments={stats.has_unread}
        notificationUnreadCount={stats.unread_count}
        onOpenNotificationComment={openComment}
        onNotificationsChanged={() => void reload(true, true, "check")}
        inert={behindInert}
      />
      {mcpLoaded && <Suspense fallback={null}><McpConnection
        open={mcpOpen}
        onClose={() => setMcpOpen(false)}
        authReady={authReady}
        authKey={libraryAuthKey}
        workspace={workspaceContext}
        activeSceneId={activeSceneId}
        canvasDocument={canvasDocument}
        prepareCanvasGenerationBatch={prepareCanvasGenerationBatch}
        confirmCanvasGeneration={confirmCanvasGeneration}
        settleCanvasGeneration={settleCanvasGeneration}
        discardCanvasGeneration={discardCanvasGeneration}
      /></Suspense>}
      {/* 폴더 창이 떠 있는 동안 뒤 화면(사이드바·본문)은 inert — 위 behindInert(React 18 타입에 inert 가 없어 spread 로 넘긴다). */}
      <div className="body" {...(behindInert ? { inert: "" } : {})}>
        {editOpen ? (
          <Suspense fallback={null}>
            <EditTab
              authKey={libraryAuthKey}
              authReady={authReady}
              workspace={workspaceContext}
              // 위에 뜬 창(관리자·미리보기·정보·비교·코멘트·등급 확인·폴더 창)이 있으면 편집 키는 쉰다.
              keysActive={!adminOpen && !preview && !info && !commentGenId && !compareGens && !videoCompare && !grade.pending && !listPeek}
              flash={flash}
              onOpenCutFolder={openEditFolderWindow}
              reloadSignal={editReloadSignal}
              peekPath={listPeek?.edit ? listPeek.path : null}
              onPeekMarks={setEditMarks}
              cardMenuRef={editCardMenuRef}
              resolvePicked={resolvePicked}
              resolveScroll={resolveScroll}
              onPreview={openPreview}
              onCompare={setCompareGens}
              resolve={{
                send: resolveTransfer.sendToResolve, busy: resolveTransfer.busy, pendingCount: resolveTransfer.pendingCount,
                sendTimeline: resolveTransfer.sendTimelineToResolve, timelineBusy: resolveTransfer.timelineBusy,
              }}
              onFolderAction={onFolderAction}
              // 최종 확정(클립 메뉴·목록 단추) — 공유 & 리뷰의 여러 장 등급 처리와 같은 길
              review={{
                canFinalize, apply: (gens, action) => onReviewSelection(gens, action, canFinalize),
                release: (gens) => onReviewSelection(gens, "shared", canFinalize, true),
              }}
              // 풀 카드의 호버 단추(Jay 2026-10-15) — 공유 & 리뷰 격자에 주는 것과 같은 동작. 정보는 라이브러리 선택(여러 장이면 비교)을 보지 않는다
              cardActions={{
                canFinalize, onReview, onPublish, onUnpublish, onFinalize, onUnfinalize, onSetTags, onSetAutoTags,
                autoTagOptions: facets.auto_tags, onOpenComments: (g) => openComment(g.id), onInfo: setInfo,
              }}
            />
          </Suspense>
        ) : filters.tab === "compose" ? (
          <>
            {showFilters && (
              <CanvasFolderSidebar
                filters={filters}
                onChange={patch}
                projects={projects}
                unassignedCount={unassignedCount}
                archivedCount={archivedCount}
                armedFolder={armedFolder}
                generationScope={generationScope}
                onArmFolder={(projectId, path) => {
                  // 폴더 선택 = ① 생성 라벨 무장 ② 그 폴더(하위 포함)로 계보 보드 필터 ③ 활성 씬이면 폴더 보기 창
                  setArmedFolder(path ? { projectId, path } : null);
                  patch({ project_id: projectId, folder_path: path || undefined });
                  setFolderPeek(!!path && !!activeSceneId);
                  if (path && activeSceneId) sceneActionRef.current?.closeVariants(); // 두 창을 겹쳐 두지 않는다
                }}
                onDropToFolder={(projectId, path, genId) => dropOnFolder(genId, projectId, path)}
                onDropToUnassigned={(genId) => dropUnassign(genId)}
                onFolderAction={onFolderAction}
              />
            )}
          <main className="main">
            {/* 구성탭에도 라이브러리 툴바 — 타입/컬러/태그/공유/코멘트 필터(노드 dim) +
                fill(블랙바↔꽉채우기) + scale(보드 확대)을 히스토리 보드에 그대로 적용. */}
            <LibraryToolbar
              typeFilter={typeFilter}
              onTypeFilter={setTypeFilter}
              scale={scale}
              onScale={setScale}
              fill={fill}
              onToggleFill={() => setFill((v) => !v)}
              layout={layout}
              onLayout={setLayout}
              groupByDate={groupByDate}
              onToggleGroupByDate={() => setGroupByDate((v) => !v)}
              filtersOpen={showFilters}
              onToggleFilters={() => setShowFilters((v) => !v)}
              // 씬(캔버스) 활성 시 boardStats 는 히스토리 보드 것(0으로 방치)이라 못 쓴다 —
              // SceneBoard 가 생성카드 안 생성물(변형 전부) 중 타입 필터 통과 수를 보고한다.
              count={activeScene ? sceneTypeCount : boardStats.count}
              grayOn={grayOn}
              onToggleGray={toggleGray}
              loading={loading}
              failedCount={failedCount}
              onClearFailed={clearFailed}
              colorDots={COLOR_DOTS}
              colorFilter={colorFilter}
              onToggleColor={toggleColorFilter}
              sharedOnly={sharedOnly}
              reviewFilter={reviewFilter}
              onReviewFilter={setReviewFilter}
              onToggleShared={() => setSharedOnly((v) => !v)}
              commentOnly={commentOnly}
              onToggleComment={() => setCommentOnly((v) => !v)}
              finalOnly={finalOnly}
              onToggleFinal={() => setFinalOnly((v) => !v)}
              hasUnread={hasAnyUnread}
              tags={facets.tags}
              tagFilter={tagFilter}
              onSelectTag={selectTagFilter}
              onDeleteTag={deleteTagEverywhere}
              onClearTags={clearTagFilter}
              tagPanelOpen={tagPanelOpen && !folderPeek && !variantOpen} // 창이 열려 있으면 창 툴바만 태그 패널을 띄운다(중복 방지)
              onToggleTagPanel={toggleTagPanel}
              zoomValue={boardStats.zoomPct / 100}
              onZoomValue={(v) => boardControl.current?.zoomTo(v)}
              // 씬(캔버스) 활성 시 슬라이더(히스토리 보드 배선이라 무동작)를 [맞춤][−][%][+]로 교체
              sceneZoom={
                activeScene
                  ? {
                      onFit: () => sceneActionRef.current?.zoomFit(),
                      onStep: (dir) => sceneActionRef.current?.zoomStep(dir),
                    }
                  : undefined
              }
              boardMode
              showFilterToggle
            />
            <SceneBar
              scenes={scenes}
              activeId={activeSceneId}
              workspaceContext={workspaceContext}
              // 씬 전환 직전 flush 는 selectScene(모든 전환의 단일 관문) 내부에서 중앙 처리된다.
              //  여기서는 그 관문을 감싸 '지정된 워크스페이스로 함께 전환'만 덧붙인다.
              onSelect={selectSceneWithWorkspace}
              onReorder={(move: SceneMove) => reorderScenes(move)}
              onAssignWorkspace={(sceneId: string, workspace: SceneWorkspace | null) =>
                setSceneWorkspace(sceneId, workspace)
              }
              onAdd={addScene}
              onRename={renameScene}
              onDelete={removeSceneById}
              onHoverChange={setSceneBarHover}
              backupOnly={backupOnly}
              onImportBackup={importBackupScenes}
              saveFailing={sceneSaveFailing}
              backupSkippedIds={sceneBackupSkippedIds}
              onExportAll={exportAllScenes}
            />
            {activeScene ? (
              <SceneBoardBoundary fallback={
                <div role="status" style={{ flex: 1, display: "grid", placeContent: "center", gap: 12 }}>
                  <span>{t("캔버스를 불러오지 못했습니다.")}</span>
                  <button type="button" onClick={() => window.location.reload()}>{t("새로고침")}</button>
                </div>
              }>
              <Suspense fallback={
                <div role="status" style={{ flex: 1, display: "grid", placeContent: "center" }}>
                  {t("캔버스를 불러오는 중…")}
                </div>
              }>
              <SceneBoard
                authKey={libraryAuthKey}
                authReady={authReady}
                scene={activeScene}
                onChange={(snapshot) => writeBoardSnapshot(canvasTarget(activeScene.id), snapshot)}
                // Ctrl+K 로 프롬프트 숨김 시 멀티선택 액션바를 캔버스 상단 중앙(씬 패널·미니맵 줄)에 얹는다.
                topCenterOverlay={!promptVisible ? selectionBar : undefined}
                onSaveScene={handleSaveScene}
                onLoadSceneFile={handleLoadSceneFile}
                onDroppedGenerationFile={openRecipeFromFile}
                onLocalRefsAdded={relinkSceneRefsNow}
                onFindRefs={findSceneRefs}
                ioPanelHot={sceneBarHover}
                onBindingChange={setSceneBinding}
                // 세션 중 씬 전환했다 돌아와도 복원되게 카메라도 저장.
                onCameraChange={(camera) => canvasDocument.commit(canvasTarget(activeScene.id), { type: "recordCamera", camera })}
                resolveSelection={
                  resolveSceneSelection?.sceneId === activeScene.id &&
                  resolveSceneSelection.followEnabled === resolveSelectionFollow
                    ? resolveSceneSelection
                    : null
                }
                onResolvePopupChange={onResolvePopupChange}
                onResolveSelectionConsumed={(nonce) =>
                  setResolveSceneSelection((current) =>
                    current?.nonce === nonce ? null : current,
                  )
                }
                onPreview={openPreview}
                onInfo={setInfo}
                onOpenFolder={openCanvasFolder}
                onRegenerate={onSceneRegenerate}
                onPublish={onPublish}
                onUnpublish={onUnpublish}
                onFinalize={onFinalize}
                onUnfinalize={onUnfinalize}
                canFinalize={canFinalize}
                projects={projects}
                onVariantShare={boardShare}
                onVariantDownload={bulkDownload}
                onVariantCompare={setCompareGens}
                onSelectionCompare={setSceneCompareMedia}
                onVariantAssign={boardAssign}
                variantResolve={{
                  send: resolveTransfer.sendToResolve,
                  retry: resolveTransfer.retryable ? resolveTransfer.retryPreparedTransfer : null,
                  retryProjectName: resolveTransfer.retryable?.target.project_name || "",
                  busy: resolveTransfer.busy,
                  pendingCount: resolveTransfer.pendingCount,
                }}
                onVariantDelete={deleteReturningIds}
                onSelectionGens={setSceneSelGens}
                actionRef={sceneActionRef}
                onGenerateCard={(cardId, batch, assignment) =>
                  spotlightPromptRef.current?.submit(batch, assignment, {
                    sceneId: activeScene.id,
                    cardId,
                  })
                }
                onCanvasRecoveryCandidates={() =>
                  api.canvasGenerationCandidates(50).then((result) => result.items)
                }
                onCanvasRecoveryClaim={(generationId, sceneId, cardId) =>
                  api.claimCanvasGenerationCandidate(generationId, sceneId, cardId).then(() => undefined)
                }
                onCanvasCardHistory={(sceneId, scope, cursor) => api.cardGenerationHistory(sceneId, scope, cursor)}
                // 지금 열려 있는 캔버스는 목록에 반드시 있다 — 없으면 로컬을 제대로 못 읽은 것이니
                // 판정을 접는다(코덱스 P1: 읽기 실패를 '전부 떨어짐'으로 바꾸면 멀쩡한 생성물이
                // 전부 미아로 보인다).
                readLocalScenes={() => {
                  const list = listScenes(null);
                  return list.some((item) => item.id === activeScene.id) ? list : null;
                }}
                onLoadGenerations={(ids) =>
                  api.getGenerationsBatch(ids).then((batch) => batch.items)
                }
                onRenderCards={generateCards}
                onRenderCardRuns={generateCardRuns}
                getGenerationFallbackModel={() => spotlightPromptRef.current?.currentModel() ?? null}
                onComfyRunningChange={setComfyRunning}
                grayOn={grayOn}
                fill={fill}
                typeFilter={typeFilter}
                onTypeCount={setSceneTypeCount}
                colorFilter={colorFilter}
                tagFilter={tagFilter}
                sharedOnly={sharedOnly}
                reviewFilter={reviewFilter}
                commentOnly={commentOnly}
                finalOnly={finalOnly}
                // 사이드바에서 폴더를 선택(project_id+folder_path)했을 때만 그 폴더 밖 카드를 딤.
                // 프로젝트/라이브러리 선택(folder_path 없음)이면 null → 딤 해제. (memo=folderSel)
                folderSel={folderSel}
                onSetTags={onSetTags}
                onSetAutoTags={onSetAutoTags}
                autoTagOptions={facets.auto_tags}
                onWorkspaceCommand={onCanvasWorkspaceCommand}
                onOpenComments={(g) => openComment(g.id)}
                // '생성 결과' 창 — 라이브러리와 같은 보기 설정·툴바(건수만 그 창의 것으로). 공간 필터·실패 정리는 목록의 것이라 뺀다.
                libraryView={{ scale, layout, groupByDate }}
                renderVariantToolbar={(count) =>
                  cloneElement(libraryToolbar, {
                    count, countMore: false, loading: false, workspaceFilter: undefined, failedCount: 0,
                  })
                }
                onVariantGradeStep={(gens, mode) => grade.requestGradeStep(gens, mode)}
                escBlocked={info !== null}
              />
              </Suspense>
              </SceneBoardBoundary>
            ) : (
            <Suspense fallback={null}>
            <HistoryBoard
              focusId={boardFocusId}
              reloadSignal={boardSignal}
              arrangeSignal={boardArrange}
              onPreview={openPreview}
              onInfo={setInfo}
              onRegenerate={onRegenerate}
              onPublish={onPublish}
              onUnpublish={onUnpublish}
              onFinalize={onFinalize}
              onUnfinalize={onUnfinalize}
              canFinalize={canFinalize}
              onSelectionChange={setBoardSelected}
              onStats={setBoardStats}
              controlRef={boardControl}
              fill={fill}
              scale={1}
              typeFilter={typeFilter}
              colorFilter={colorFilter}
              tagFilter={tagFilter}
              sharedOnly={sharedOnly}
              reviewFilter={reviewFilter}
              commentOnly={commentOnly}
              finalOnly={finalOnly}
            />
            </Suspense>
            )}
          </main>
          </>
        ) : (
          <>
            {showFilters && (
              <FilterSidebar
                onOpenFolderTab={openLibraryFolderTab}
                facets={facets}
                filters={filters}
                onChange={(p) => {
                  pushLocationRef.current = true; // 사이드바를 눌러 자리를 바꾸는 것은 명시적 이동 — 기록 한 칸(폴더 줄의 onFilter→onArmFolder 둘이 와도 한 칸)
                  patch(p);
                }}
                creatorWorkspaceFilter={genQuery}
                creatorQueryReady={authReady && workspaceQueryReady}
                creatorContextKey={libraryAuthKey}
                colorDots={COLOR_DOTS}
                colorFilter={colorFilter}
                onToggleColor={toggleColorFilter}
                finalOnly={finalOnly}
                onToggleFinal={() => setFinalOnly((v) => !v)}
                grayOn={grayOn}
                onToggleGray={toggleGray}
                armedAutoTags={filterAutoTags}
                onToggleAutoTag={toggleAutoTag}
                viewedFolder={resolveLibrary.viewedFolder}
                onAddAutoTag={addAutoTag}
                onDeleteAutoTag={removeAutoTag}
                workspaceChips={filters.tab === "team" ? [] : workspaceChips}
                onToggleWorkspaceChip={toggleWorkspaceChip}
                onRemoveWorkspaceChip={removeWorkspaceChip}
                armedFolder={armedFolder}
                generationScope={generationScope}
                onArmFolder={(projectId, path) => {
                  // 폴더 선택 = ① 생성 라벨 무장 ② 그 폴더(하위 포함)로 라이브러리 필터 — 명시적 이동(기록 한 칸)
                  pushLocationRef.current = true;
                  setArmedFolder(path ? { projectId, path } : null);
                  patch({ project_id: projectId, folder_path: path || undefined });
                }}
                onDropToFolder={(projectId, path, genId) =>
                  dropOnFolder(genId, projectId, path)
                }
                onDropToUnassigned={(genId) => dropUnassign(genId)}
                onFolderAction={onFolderAction}
                onCreatorChanged={reload}
                projects={projects}
                unassignedCount={unassignedCount}
                archivedCount={archivedCount}
              />
            )}
            {/* staleList = 폴더 창을 닫은 직후 옛 첫 쪽을 먼저 보이는 중 — 새 목록이 올 때까지 조작을 막는다(낡은 카드에 삭제·공유가 걸리지 않게) */}
            <main className="main" aria-busy={listLocked || undefined} {...(listLocked ? { inert: "" } : {})}>
              {/* 폴더 창이 떠 있으면 툴바·격자는 창에 그린다(하나뿐인 격자) — 뒤 목록 자리는 닫을 때까지 비워 둔다.
                  도구 줄 자리에는 **눌리지 않는 사본**을 남긴다 — 창을 열 때 도구 줄이 사라져 뒤 화면이 위로 당겨지지 않고, 모아보기처럼
                  뒤가 그대로 흐려 보이게(Jay 2026-10-13). 뒤 화면은 통째로 inert 다(behindInert) — 사본은 그림일 뿐이다: 창 밖에 뜨는
                  태그 패널은 창의 툴바만 그린다. 사본을 먼저 그리므로 창의 툴바가 뒤에 온다(둘은 같은 값을 받는다 — 전환 단추만 사본에). */}
              {listPeek ? (
                <div className="lib-toolbar-behind" aria-hidden="true">
                  {cloneElement(libraryToolbar, { folderCards: cutToggle, tagPanelOpen: false })}
                </div>
              ) : (
                libraryToolbar
              )}
              <FolderTabs label={storedTab === "team" ? "공유 & 리뷰 폴더 탭" : "워크스페이스 폴더 탭"}
                tabs={libraryTabs.tabs.map((tab) => ({ id: tab.id, view: {
                  dir: tab.view.filters.folder_path || "",
                  project: projects.find((project) => project.id === tab.view.filters.project_id)?.name || tab.view.projectName || "",
                  name: tab.view.filters.deleted_only ? t("휴지통") : tab.view.filters.project_id === "none" ? t("미분류") : undefined,
                } }))}
                active={libraryTabs.active} onSelect={selectLibraryTab} onClose={closeLibraryTab} onReorder={libraryTabs.reorder} />
              {/* 묶음 보기 — 격자 자리에 컷 카드. 폴더 창이 떠 있어도 뒤에 그대로 둔다(body 가 inert 라 눌리지 않는다). */}
              {cutCards ? (
                <FolderCardGrid
                  folders={cutCards.folders} scale={scale} fill={fill} layout={layout} onEnter={enterFolderCard} onOpen={openFolderCard}
                  onOpenTab={(folder) => { if (cutScope) openLibraryFolderTab(cutScope.projectId, folder.path); }}
                  onPrefetch={prefetchFolderCard}
                  table={groupByDate} onPreview={openPreview} // 리스트 단추 한 번 더(낱장 목록의 '날짜별 구분' 자리) = 표 · 컷 줄의 생성물 띠 = 크게 보기
                  placeKey={hereKey} // 두 번 누름의 둘째가 들어간 화면에 닿는 것을 버린다(조작 규칙 61)
                  top={!cutScope?.parent} selected={cutSel} onSelect={setCutSel}
                  onInfo={(folder, x, y) => {
                    if (cutScope) setCutInfo({ projectId: cutScope.projectId, path: folder.path, x, y, ctx: listPeekCtx });
                  }}
                  onReel={(paths) => setCutReel({ paths, ctx: listPeekCtx })} // 컷 두 번 클릭 = 모아보기(Jay 2026-10-13 낮) — 막대의 단추와 같은 창
                  outside={cutCards.own_count} onShowAll={() => setCutView(false)}
                />
              ) : listPeek ? null : cutPending ? (
                // 묶음 응답 전 — 낱장을 잠깐 보이지 않는다(③). 안내는 오래 걸릴 때만(0.3초 뒤 — 빨리 오면 글자가 번쩍이지 않게, 70회차)
                <div className="grid-wrap" aria-busy="true"><div className="empty grid-wait" role="status">{t("불러오는 중…")}</div></div>
              ) : !workspaceQueryReady ? (
                <div className="grid-wrap"><div className="empty" role="status">
                  <p>{t("워크스페이스를 확인한 뒤 공유물을 표시합니다.")}</p>
                  <button className="settings-action" onClick={() => workspaceFollow?.onChange("all")}>
                    {t("전체 보기")}
                  </button>
                </div></div>
              ) : thumbnailGrid}
            </main>
          </>
        )}
      </div>

      {/* Ctrl+K 로 프롬프트를 숨겨도 멀티선택 액션바는 유지. 캔버스(활성 씬)에선 SceneBoard 가 상단 중앙에 얹으므로 여기선 제외하고,
          그 외(라이브러리 등)에서는 **화면 아래 가운데**(프롬프트가 있던 자리 — Jay 2026-10-13 "밑으로", 전엔 상단바 아래)에 띄운다.
          프롬프트를 숨기면 그 안의 오류 문구도 같이 숨으므로(왜 생성이 안 되는지 알 수 없게 된다 — 레퍼런스 번호 오류 등) 같은 묶음의
          위 칸에 대신 띄운다 — 둘을 한 세로 묶음에 두어 서로 겹치지 않는다(Codex 설계 검토). 오류가 풀리면 저절로 사라진다.
          편집 탭에는 프롬프트도 선택 막대도 없다(편집 탭 병합). */}
      {!promptVisible && !editOpen && (promptError || (selectionBar && !listPeek && !(filters.tab === "compose" && !!activeScene))) && (
        <div className="dock-float">
          {promptError && (
            <div className="sl-error-float" role="status">
              {promptError}
            </div>
          )}
          {selectionBar && !listPeek && !(filters.tab === "compose" && !!activeScene) && (
            <div className="selbar-bottom-float">{selectionBar}</div>
          )}
        </div>
      )}
      {/* 프롬프트 입력바 — 구성탭에서도 표시. Ctrl/⌘+K 로 표시/숨김 토글(display 토글로 입력 상태 보존).
          숨김은 SpotlightPrompt 안에서 처리한다 — 여기서 도크를 통째로 감추면 상태줄(● Host/연결됨)까지
          같이 사라진다. 상태줄은 숨겨도 화면 우측 하단에 남아 있어야 한다(Jay 2026-09-15). */}
      <div>
        <SpotlightPrompt
          ref={spotlightPromptRef}
          visible={promptVisible && !editOpen} // 편집 탭에는 프롬프트가 없다(상태줄은 남는다)
          // 폴더 창(캔버스·목록 탭)이 뜬 동안 상태 줄은 키보드로도 닿지 않는다 — 마우스는 app-shell.css 가 막는다(규칙 16)
          statusInert={peekOpen}
          expanded={composerExpanded || sceneMode}
          onToggleExpand={toggleComposerExpanded}
          onPreview={openPreview}
          trayBinding={trayBinding}
          inCompose={filters.tab === "compose"}
          onTrayBindingRefsChange={setSceneCardRefs}
          onTrayBindingPromptChange={setSceneCardPrompt}
          count={batchCount}
          onCountChange={setBatchCount}
          canvasTarget={
            activeScene && sceneBinding
              ? { sceneId: activeScene.id, cardId: sceneBinding.cardId }
              : null
          }
          prepareCanvasGeneration={prepareCanvasGeneration}
          confirmCanvasGeneration={confirmCanvasGeneration}
          settleCanvasGeneration={settleCanvasGeneration}
          discardCanvasGeneration={discardCanvasGeneration}
          onCanvasBatchCreated={(created) => {
            mergeFacetTags(created.flatMap((item) => item.tags || []));
            flash(`생성 잡 ${created.length}개를 시작했습니다.`);
            void reload();
            bumpBoard();
          }}
          armedAutoTags={[...armedAutoTags]}
          armedFolder={armedFolder}
          activeProjectId={
            generationScope.project_id && generationScope.project_id !== "none"
              ? generationScope.project_id
              : undefined
          }
          workspace={workspaceContext}
          // 목록 탭의 폴더 창이 떠 있으면 선택 막대는 창 바닥에만 그린다(같은 막대가 두 곳에 뜨지 않게)
          topSlot={promptVisible && !listPeek ? selectionBar : undefined}
          onErrorChange={setPromptError}
          onCreated={onPromptCreated}
        />
      </div>
      {grade.pending && (
        <GradeStepModal
          pending={grade.pending}
          busy={grade.busy}
          onConfirm={grade.confirm}
          onCancel={grade.cancel}
        />
      )}
      {listPeek &&
        renderFolderPeek(
          listPeek.projectName ? `${listPeek.projectName} / ${listPeek.path}` : listPeek.path,
          listPeek.path,
          closeFolderWindow,
        )}
      {/* 캔버스의 폴더 창 — 목록 탭의 창처럼 본문(.body) 밖에 그린다. 전엔 main 안이라 뒤 화면을 잠글 수 없었다(위 behindInert).
          창과 막은 fixed 라 화면의 자리·쌓임은 그대로다. */}
      {canvasPeek && folderSel &&
        renderFolderPeek(
          `${projects.find((p) => p.id === folderSel.projectId)?.name ?? ""} / ${folderSel.path}`,
          folderSel.path,
          () => setFolderPeek(false),
        )}
      <AppOverlays
        account={account}
        adminOpen={adminOpen}
        localHub={!authConfig?.auth_enabled}
        commentGenId={commentGenId}
        commentLabel={commentLabel}
        compareGens={compareGens}
        info={info}
        myId={account?.creator_uid || "me"}
        preview={preview}
        projects={projects}
        syncTick={syncTick}
        toast={toast}
        onAdminClose={() => {
          closeOverlay(); // 히스토리 뒤로 → 관리자 창 닫힘 반영
          reload(); // 등급·프로젝트 변경이 라이브러리/필터에 반영되게
        }}
        onCloseOverlay={closeOverlay}
        onCommentClose={() => setCommentGenId(null)}
        onCompareClose={() => setCompareGens(null)}
        onHistoryChanged={reload}
        onInfoClose={() => setInfo(null)}
        onInfoOpenInBoard={(g) => {
          setInfo(null);
          onOpenInBoard(g);
        }}
        onInfoOpenCanvas={(g) => {
          setInfo(null);
          onShowHistory(g);
        }}
        onRecoveryRequeue={onRecoveryRequeue}
        onOpenInBoardFromPreview={onOpenInBoardFromPreview}
        onPreview={openPreview}
      />
      {/* Resolve 보내기 결과 가운데 확인이 필요한 것 — 알림 바로 아래에 닫을 때까지 남는다(겹이 아니다 — 뒤 화면을 그대로 쓴다) */}
      <ResolveNotices items={resolveTransfer.notices} onDismiss={resolveTransfer.dismissNotice} />
      {apiPause && <AuthPauseBanner action={apiPause === "shared" ? "login" : "reload"} onLeave={leavePause} />}
      {/* 컷 정보(휠 클릭)·모아보기 — 크게 보기(AppOverlays)보다 아래 층. 크게 보기가 떠 있는 동안은 Esc 를 그쪽에 넘긴다. */}
      {cutInfo && cutInfoFolder && cutInfoQuery && (
        <CutInfoPopup
          folder={cutInfoFolder} x={cutInfo.x} y={cutInfo.y} query={cutInfoQuery} savingRep={savingRep} previewOpen={!!preview}
          onClose={() => setCutInfo(null)}
          onOpen={(folder) => { setCutInfo(null); openFolderCard(folder); }} // [폴더 열기] = 그 폴더의 창(컷 카드 우클릭과 같다, 2026-10-13 낮)
          onPreview={openPreview}
          onPickCover={(folder, g) => pickFolderCover(g, { projectId: cutInfo.projectId, path: folder.path })}
        />
      )}
      {cutReelOpen && (
        <CutReel
          folders={cutReelFolders} mode={reelMode} onModeChange={setReelMode} previewOpen={!!preview}
          onClose={() => setCutReel(null)} onPreview={openPreview}
          // [폴더로] = 그 컷 폴더로 이동(사이드바에서 누른 것과 같다 — 기록 한 칸). 창을 먼저 닫는다(컷 정보 창의 [폴더 열기]와 같은 순서)
          onEnter={(folder) => { setCutReel(null); enterFolderCard(folder); }}
        />
      )}
      {/* 지연 로딩 창 — 틀(막·빈 창·Esc 겹)은 연 순간에 서고 본문만 늦게 온다(AppOverlays 의 LazyModalShell). */}
      {videoCompare && <VideoCompareOverlay videos={videoCompare} onClose={() => setVideoCompare(null)} />}
      {/* 부분 수정(브러시 인페인트) — InfoPopup 의 partialEdit 이벤트로 열림.
          onQueued 는 좁은 목록 merge 만 — handlePromptCreated 를 재사용하면 구성 탭
          선택 상태에 따라 무관한 부모가 derived 로 붙는다(코덱스 설계 검토 반영). */}
      {/* 업데이트 진행 덮개 — 설정·알림센터 어느 쪽에서 눌러도 뜬다(포털로 body 에 그린다). */}
      <UpdateProgressOverlay />
      <PartialEditHost
        workspace={workspaceContext}
        onQueued={(g) => {
          setGens((prev) => (prev.some((p) => p.id === g.id) ? prev : [g, ...prev]));
          flash("부분 수정 생성을 시작했습니다.");
          postLibraryChanged();
        }}
      />
    </div>
  );
}
