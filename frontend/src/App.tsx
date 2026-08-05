// 앱 루트: 탭·필터 상태, 데이터 로딩, WebSocket 진행률, 액션 오케스트레이션.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
// 코드 스플리팅 — 드물게 여는 구성보드는 지연 로드해 초기 번들에서 분리.
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
import { SceneBar } from "./components/scene/SceneBar";
import { SceneBoard } from "./components/scene/SceneBoard";
import { AppOverlays } from "./components/app/AppOverlays";
const VideoCompareModal = lazy(() =>
  import("./components/VideoCompareModal").then((m) => ({ default: m.VideoCompareModal })),
);
import {
  BoardSelectionActionBar,
  LibrarySelectionActionBar,
} from "./components/app/SelectionActionBar";
import { KEY_COLORS } from "./lib/appConstants";
import { generationQueryKey } from "./lib/appGenerationQuery";
import { generationsByIds } from "./lib/generationTags";
import { useAppNavigation } from "./lib/useAppNavigation";
import {
  exportSceneText,
  listScenes,
  parseSceneImport,
  SCENE_IMPORT_MAX_BYTES,
  variantIds,
  type Scene,
  type SceneRef,
} from "./lib/scenes";
import {
  collectGenText,
  collectGenModel,
  resolvePortEdges,
  type SceneGenerationRun,
} from "./lib/sceneEdges";
import {
  buildSceneGenerationJobInput,
  type SceneGenerationJobInput,
} from "./lib/sceneGenerationInputs";
import {
  acquireSceneGeneration,
  applySceneGenerationResults,
  executeSceneGenerationBatch,
} from "./lib/sceneGenerationSubmission";
import { buildRecipeScene } from "./lib/recipeScene";
import { useGenerationAutoRefresh } from "./lib/useGenerationAutoRefresh";
import { useCommentBadgePoll } from "./lib/useCommentBadgePoll";
import { useGenerationAutoTagActions } from "./lib/useGenerationAutoTagActions";
import { useGenerationCardActions } from "./lib/useGenerationCardActions";
import { useGenerationFilterActions } from "./lib/useGenerationFilterActions";
import { useGenerationKeyboardActions } from "./lib/useGenerationKeyboardActions";
import { useGenerationLibraryData } from "./lib/useGenerationLibraryData";
import { useGenerationProgress } from "./lib/useGenerationProgress";
import { useGenerationProjectActions } from "./lib/useGenerationProjectActions";
import { useGenerationSelection } from "./lib/useGenerationSelection";
import { useGenerationShareActions } from "./lib/useGenerationShareActions";
import { useGenerationTagActions } from "./lib/useGenerationTagActions";
import { useGenerationTrashActions } from "./lib/useGenerationTrashActions";
import { useGenerationUtilityActions } from "./lib/useGenerationUtilityActions";
import { useHubAuth } from "./lib/useHubAuth";
import { useAppToast } from "./lib/useAppToast";
import { useDisabledGenerations } from "./lib/useDisabledGenerations";
import { useLibraryFilters } from "./lib/useLibraryFilters";
import { useSceneCoordination } from "./lib/useSceneCoordination";
import { useSceneCompletionWatcher } from "./lib/useSceneCompletionWatcher";
import { seedPending } from "./lib/sceneRecentDoneStore";
import { useHistoryBoardState } from "./lib/useHistoryBoardState";
import { usePromptDock } from "./lib/usePromptDock";
import { usePromptCreatedActions } from "./lib/usePromptCreatedActions";
import {
  canFinalizeGeneration,
  expandDisabledGenerationIds,
  filterDisabledGenerations,
} from "./lib/generationDisplay";
import { useDisabledFolders } from "./lib/useDisabledFolders";
import { useGradeStep } from "./lib/useGradeStep";
import type { GradeMode } from "./lib/gradeStep";
import { GradeStepModal } from "./components/GradeStepModal";
import { useAskPrompt } from "./lib/prompt";
import { makeStore } from "./lib/storage";
import type {
  Generation,
  History,
  InfoTarget,
  ModelParam,
  PreviewTarget,
} from "./types";
import { api } from "./api";
import { buildSpotlightCreateBody } from "./lib/spotlightSubmit";
import { resolveAutoAspectRatio } from "./lib/aspectAuto";

// 마지막으로 보던 라이브러리 상태 영속화(탭·서브탭·필터·크기·레이아웃 등)
const LS = makeStore("ch.lib.");

// 3색(빨강·초록·파랑) 필터 도트 — 툴바 여러 곳에 같은 값이라 모듈 상수로(매 렌더 배열 재생성 제거).
const COLOR_DOTS = [
  { k: "r", hex: KEY_COLORS.r },
  { k: "g", hex: KEY_COLORS.g },
  { k: "b", hex: KEY_COLORS.b },
];

export default function App() {
  // 라이브러리 필터/뷰 상태 + genQuery/selectionResetKey 파생 + LS 저장(useLibraryPersistence)은 useLibraryFilters 훅으로 추출.
  const {
    filters, setFilters, patch,
    typeFilter, setTypeFilter, scale, setScale, fill, setFill, layout, setLayout,
    showFilters, setShowFilters, groupByDate, setGroupByDate, colorFilter, setColorFilter,
    sharedOnly, setSharedOnly, tagFilter, setTagFilter, tagPanelOpen, setTagPanelOpen,
    commentOnly, setCommentOnly, finalOnly, setFinalOnly, grayOn, setGrayOn,
    armedAutoTags, setArmedAutoTags, armedFolder, setArmedFolder,
    genQuery, selectionResetKey,
  } = useLibraryFilters(LS);
  const [compareGens, setCompareGens] = useState<Generation[] | null>(null); // DAM 버전 비교
  // 단순 미디어 비교(레퍼런스 포함) — 열림 대상 + 씬 선택이 미디어비교 가능한지(상단 선택바가 비교버튼 표시).
  type CompareMedia = { url: string; name: string; type: "image" | "video"; fallback?: string; full?: string };
  const [videoCompare, setVideoCompare] = useState<CompareMedia[] | null>(null);
  const [sceneCompareMedia, setSceneCompareMedia] = useState<CompareMedia[] | null>(null);
  const [history, setHistory] = useState<History | null>(null); // 히스토리(가계) 패널 대상
  const { flash, toast } = useAppToast();
  // Canvas 씬(빈 캔버스) 상태·CRUD 는 useSceneCoordination 훅으로 추출. S1: 프로젝트 무관 전역(projectId=null).
  //  flash 전달 — 다른 탭이 이 씬을 바꾸면(멀티탭) 비파괴 알림용.
  const {
    scenes, activeSceneId, activeScene,
    sceneBinding, setSceneBinding, sceneSelGens, setSceneSelGens, sceneActionRef,
    flushScenePending, selectScene, addScene, importSceneSnapshot, renameScene, removeSceneById,
    patchSceneById, patchActiveScene,
  } = useSceneCoordination(flash);
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
  const sceneBoardCoveredIds = filters.tab === "compose" && activeScene ? glowCandidateIds : [];
  useSceneCompletionWatcher(glowCandidateIds, { coveredIds: sceneBoardCoveredIds });
  // 배치수(한 번에 N장)를 App 이 보유 — 하단 프롬프트와 '카드 아래 Generate 버튼'이 공유. submit 은 ref 로 노출.
  const [batchCount, setBatchCount] = useState(1);
  const spotlightPromptRef = useRef<SpotlightPromptHandle>(null);
  // 구성탭 히스토리 보드(계보 트리) 상태는 useHistoryBoardState 훅으로 추출.
  const {
    boardFocusId, setBoardFocusId, boardFocusIdRef,
    boardSignal, bumpBoard, boardArrange, setBoardArrange,
    boardSelected, setBoardSelected, boardSelectedRef,
    boardStats, setBoardStats, boardControl, lastBoardFocusRef,
  } = useHistoryBoardState(LS);
  const [info, setInfo] = useState<InfoTarget | null>(null); // 휠클릭 정보 팝업
  const [commentGenId, setCommentGenId] = useState<string | null>(null); // 공유 코멘트 스레드 패널 대상
  const [syncTick, setSyncTick] = useState(0); // WS 'synced' 수신 카운터 — 열린 코멘트 패널 실시간 갱신용
  const [preview, setPreview] = useState<PreviewTarget | null>(null); // 클릭 미리보기
  // 회색(비활성) — 카드별 비활성화 표시(d 키, gen id 기준 로컬). grayOn(useLibraryFilters)=ON 이면 목록에서 제외.
  const disabledGen = useDisabledGenerations();
  const disabledFolders = useDisabledFolders(); // 폴더 단위 비활성(그 폴더·하위 생성물 자동 회색)
  const [adminOpen, setAdminOpen] = useState(false); // 관리자 창(로고 클릭)
  const askPrompt = useAskPrompt(); // 플로팅 입력(네이티브 prompt 대체)
  const {
    account,
    authConfig,
    authPending,
    authReady,
    finalizeProjects,
    hubAccount,
    logout,
    onProxyConnected,
    setAccount,
    sharedSrv,
  } = useHubAuth();
  // genQuery(서버 쿼리)·selectionResetKey 는 useLibraryFilters 훅에서 파생(위 destructure).
  const { clearSelect, selected, selectedRef, setSelected, toggleSelect } = useGenerationSelection({
    resetKey: selectionResetKey,
  });
  const {
    archivedCount,
    facets,
    filtersRef,
    gens,
    gensRef,
    hasMore,
    loadMore,
    loading,
    loadingMore,
    projects,
    projectsLoadedRef,
    reload,
    setFacets,
    setGens,
    stats,
    unassignedCount,
  } = useGenerationLibraryData({ authReady, filters, flash, genQuery });
  // 캔버스(compose 탭)에서 태그하면 scheduleTagReload 가 compose·light 라 facets 를 안 불러와
  // '등록된 태그' 패널이 탭을 나갔다 와야 갱신되던 문제 → 새 태그 이름을 facets.tags 에 낙관적 병합해 즉시 반영.
  const mergeFacetTags = useCallback(
    (names: string[]) =>
      setFacets((f) => {
        const add = names.filter((n) => n && !f.tags.includes(n));
        return add.length ? { ...f, tags: [...f.tags, ...add] } : f;
      }),
    [setFacets],
  );
  const selectedGenerations = useMemo(() => generationsByIds(gens, selected), [gens, selected]);

  const {
    assignSelectedToProject,
    boardAssign,
    boardCreateAssign,
    createAndAssign,
    dropOnFolder,
    dropUnassign,
  } = useGenerationProjectActions({ bumpBoard, filtersRef, flash, reload, selectedRef });

  // 모든 필터(project_id·컬러·태그·타입 포함)가 서버 쿼리에 들어가므로, 무엇이 바뀌든
  // 첫 페이지부터 다시 받는다(무한 스크롤 누적 초기화). 서버가 거르니 누락 없이 정확.
  const serverFilterKey = useMemo(() => generationQueryKey(genQuery), [genQuery]);
  // 필터 변경 또는 인증 준비(로그인 완료/차단 off) 시 데이터 로드. 한 effect 로 합쳐 마운트 시
  // 중복 reload(예전엔 이 effect + 별도 authReady effect 가 둘 다 발화 → 2회) 제거. reload 내부가
  // authReadyRef 로 게이트하므로 authReady 가 false 면 no-op, true 로 바뀌면 여기서 다시 발화해 로드.
  // filters.tab 도 의존성에 포함 — compose 는 서버 쿼리상 'my' 로 합쳐져 serverFilterKey 가 같으므로,
  // 이게 없으면 compose→내작업 전환 때 즉시 reload 가 안 돌고 3초 폴링이 뒤늦게 채운다(전환 딜레이 원인).
  useEffect(() => {
    reload();
  }, [serverFilterKey, filters.tab, authReady, reload]);

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
  useGenerationProgress({ gensRef, setGens, reload, bumpBoard, setSyncTick });

  // 진행중 잡·팀 탭 폴링 + 탭 재포커스 새로고침.
  useGenerationAutoRefresh({ generations: gens, tab: filters.tab, reload });

  // 코멘트 배지 실시간 갱신: 공유 카드의 미확인 여부만 가볍게 주기 조회해 제자리 갱신(전 탭).
  // 새 미확인이 잡히면 syncTick 을 올려 열린 코멘트 패널도 즉시 새로고침.
  useCommentBadgePoll({
    generations: gens,
    setGens,
    onNewUnread: () => setSyncTick((t) => t + 1),
  });

  const {
    composerExpanded,
    promptVisible,
    toggleComposerExpanded,
  } = usePromptDock(LS);

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
  useGenerationKeyboardActions({ clearSelect, filtersRef, flash, gensRef, reload, selectedRef, setGens });

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
    const pid = filters.project_id;
    if (pid && pid !== "none" && !projects.some((p) => p.id === pid)) {
      patch({ project_id: undefined });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

  const { addAutoTag, removeAutoTag, toggleArmedAutoTag } = useGenerationAutoTagActions({
    askPrompt,
    flash,
    reload,
    setArmedAutoTags,
  });

  // comfy 노드 실행 중 목록(SceneBoard 통지) — '내 작업'에 임시 생성중 카드(Comfy 로고)를 프론트 전용으로 띄운다.
  const [comfyRunning, setComfyRunning] = useState<{ id: string; name: string }[]>([]);
  // 로컬 우선: 내 작업(tab=my)은 로컬 DB 를 그대로 읽으므로 로드된 페이지가 곧 화면 결과
  // (진행중·실패 placeholder 포함). 별도 머지 불필요.
  const visibleGens = gens;
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
  // 이번에 받은 페이지가 회색필터로 전부 가려지면(빈 그리드) ThumbnailGrid 가 센티넬을 못 그려
  // onLoadMore 가 영영 안 불린다 → 뒤 페이지의 활성 항목이 사라진 것처럼 보임. hasMore 인 한
  // 활성 항목이 나오거나 끝날 때까지 다음 페이지를 자동으로 당긴다(필터·페이지네이션 분리).
  useEffect(() => {
    if (grayOn && gridGens.length === 0 && hasMore && !loadingMore) loadMore();
  }, [grayOn, gridGens.length, hasMore, loadingMore, loadMore]);

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

  const { boardShare, onPublish } = useGenerationShareActions({
    bumpBoard,
    flash,
    reload,
  });
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
    openPreview,
    openComment,
    openAdmin,
  } = useAppNavigation({
    currentTab: filters.tab,
    lastBoardFocusRef,
    setPreview,
    setCommentGenId,
    setHistory,
    setAdminOpen,
    setInfo,
    setBoardFocusId,
    setBoardArrange,
    setFilters,
  });
  // 히스토리 버튼 → 그 생성물 recipe(어떻게 만들었나)를 새 씬 탭으로 연다(편집·재생성 가능). 팀 결과물도 동일.
  const openRecipe = (g: Generation, history: History) => {
    importSceneSnapshot(buildRecipeScene(g, history));
    setSceneBinding(null);
    setSceneSelGens([]);
    navTab("compose");
    flash(`"${g.model || "생성물"}" 을(를) 노드로 열었습니다.`);
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
  const trayBinding =
    filters.tab === "compose" && activeScene
      ? sceneBinding
        ? {
            key: `${activeScene.id}:${sceneBinding.cardId}`,
            // promptKey: 같은 카드에서 연결 텍스트가 바뀌면 에디터를 다시 채우도록(파생 반영). 파생 아니면 고정.
            promptKey: textDerived ? `txt:${boundGenText.text}` : "card",
            refs: sceneBinding.refs,
            prompt: derivedPrompt,
            model: boundModel,
            // modelKey: 연결 모델(모델/타입/파라미터) 변경 감지 — 같은 카드에서 모델노드 바뀌면 재적용.
            modelKey: boundModel
              ? `${boundModel.model}|${boundModel.type ?? ""}|${JSON.stringify(boundModel.params ?? {})}`
              : "none",
          }
        : { key: `${activeScene.id}:none`, promptKey: "none", refs: [] as SceneRef[], prompt: "", model: null, modelKey: "none" }
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
    const cards = listScenes(null).find((s) => s.id === activeScene.id)?.cards || activeScene.cards;
    const nextCards = cards.map((c) => (c.id === sceneBinding.cardId ? { ...c, prompt } : c));
    patchActiveScene({ cards: nextCards });
  };
  // 생성 완료 → 결과 gen id 를 선택 카드에 바인딩(카드에 썸네일 표시). 씬 모드에선 구성보드 부모 자동연결은 건너뜀.
  const onPromptCreated = async (created?: Generation[], dragParentId?: string | null) => {
    if (sceneMode && activeScene && sceneBinding) {
      const newIds = (created || []).map((x) => x.id); // 복수 생성이면 여러 장 → 카드에 모두 누적
      if (newIds.length) seedPending(newIds); // 방금 생성 glow — 첫 폴링이 이미 done 이어도 뜨게 baseline 선등록
      if (newIds.length) {
        flushScenePending(activeScene.id);
        // 최신 씬을 다시 읽어(생성 대기 중 편집분 보존) 해당 카드에만 변형 append — 덮어쓰지 않는다.
        // 재사용이든 아니든 '선택된 카드'에 쌓는다(사용자 결정: 카드 선택 후 재사용 = 그 카드에 누적).
        const cards = listScenes(null).find((s) => s.id === activeScene.id)?.cards || activeScene.cards;
        const nextCards = cards.map((c) => {
          if (c.id !== sceneBinding.cardId) return c;
          const genIds = [...variantIds(c)]; // legacy genId + 기존 genIds 병합(누락 방지)
          for (const id of newIds) if (!genIds.includes(id)) genIds.push(id);
          return { ...c, genId: newIds[0], genIds, status: "pending" as const }; // 첫 장을 대표로 표시
        });
        patchSceneById(activeScene.id, { cards: nextCards });
      }
      if (created?.length) {
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
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(activeScene.name || "scene").replace(/[^\w가-힣 .-]/g, "_")}.mvscene.json`;
    a.click();
    URL.revokeObjectURL(url);
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
  // 캔버스에서 '재생성' → 새 결과를 그 생성물이 속한 카드에 변형으로 쌓는다(라이브러리처럼 별도 카드가
  // 아니라 같은 카드에 누적). 배치 생성(onPromptCreated)과 동일한 append 규칙 — 새 것을 대표로.
  const onSceneRegenerate = async (g: Generation) => {
    const ng = await onRegenerate(g);
    if (!ng || !activeScene) return;
    seedPending([ng.id]); // 재생성 결과도 방금 생성 glow 대상
    flushScenePending(activeScene.id);
    const cards = listScenes(null).find((s) => s.id === activeScene.id)?.cards || activeScene.cards;
    const nextCards = cards.map((c) => {
      if (!variantIds(c).includes(g.id)) return c; // g 가 속한 카드에만
      const genIds = [...variantIds(c)];
      if (!genIds.includes(ng.id)) genIds.push(ng.id);
      return { ...c, genId: ng.id, genIds, status: "pending" as const };
    });
    patchSceneById(activeScene.id, { cards: nextCards });
  };
  // ── 렌더(배치) 노드 ── 연결된 생성카드들을 각자 자기 모델·refs·텍스트로 한 번에 생성한다.
  //  · 각 카드의 연결 모델(collectGenModel)·연결 텍스트(collectGenText)·카드 refs 로 body 를 조립(하단 프롬프트 재사용).
  //  · 모델이 안 붙은 카드는 건너뛴다(생성 불가). 잡은 전부 한 번에 제출하고 초과분은 서버 큐가 순서대로 처리.
  const genParamsCacheRef = useRef<Record<string, ModelParam[]>>({}); // 모델별 파라미터 스키마 캐시(auto 비율 해석용)
  // 씬별 렌더 진행 가드 — 같은 씬의 더블클릭만 막고, 느린 요청 중 다른 씬 작업은 허용한다.
  const renderingSceneIdsRef = useRef(new Set<string>());
  // 생성 1건의 조립 재료는 sceneGenerationInputs 공용 순수 함수가 만든다(실행 지문과 제출 규칙 공유).
  // job 목록 제출(공통) — 모델 파라미터 선로드→body 조립→각 job 1회씩 병렬 create→카드에 결과 id 누적.
  //  ★배치 반복은 호출자가 jobs 를 늘려서(같은 카드 N개) 결정한다 — 여기선 job 1개=1장.
  const submitGenJobs = async (
    jobs: SceneGenerationJobInput[],
    skipped: number,
    scene: Scene,
    projectId: string | undefined,
    folderPath: string | undefined,
  ) => {
    if (!jobs.length) {
      flash(skipped ? "모델이 연결된 생성 카드가 없습니다." : "생성할 카드가 없습니다.");
      return;
    }
    // 같은 모델 요청은 파라미터 조회 1회를 공유하되, 다른 모델 작업은 독립적으로 준비·제출한다.
    // 예전처럼 모든 모델 조회·body 조립을 먼저 Promise.all로 기다리면 느린 1건이 전체 시작을 막는다.
    const paramLoads = new Map<string, Promise<void>>();
    const ensureModelParams = (model: string): Promise<void> => {
      if (model in genParamsCacheRef.current) return Promise.resolve();
      const pending = paramLoads.get(model);
      if (pending) return pending;
      const load = api
        .modelParams(model)
        .then((r) => {
          genParamsCacheRef.current[model] = r.params;
        })
        .catch(() => {
          // 실패는 캐시하지 않는다 — 다음 렌더에서 다시 시도한다. 이번 작업은 빈 스키마로 계속 진행.
        });
      paramLoads.set(model, load);
      return load;
    };

    const applySuccess = (cardId: string, gen: Generation) => {
      seedPending([gen.id]);
      setGens((prev) => {
        if (prev.some((item) => item.id === gen.id)) return prev;
        return [gen, ...prev];
      });
      // 매 완료마다 최신 저장본 위에 붙인다. 카드/씬이 대기 중 삭제됐다면 되살리지 않는다.
      flushScenePending(scene.id);
      const latest = listScenes(null).find((item) => item.id === scene.id);
      if (latest) {
        const applied = applySceneGenerationResults(latest.cards, [
          { cardId, generationId: gen.id },
        ]);
        if (applied.attachedCardCount) patchSceneById(scene.id, { cards: applied.cards });
      }
    };

    const summary = await executeSceneGenerationBatch(
      jobs.map((job) => ({ cardId: job.cardId, input: job })),
      async (j) => {
        await ensureModelParams(j.model);
        const tunable = genParamsCacheRef.current[j.model] || [];
        const optionValues = await resolveAutoAspectRatio(j.params, tunable, j.refs);
        const { body } = buildSpotlightCreateBody({
          text: j.text,
          inlineRefs: [],
          trayRefs: j.refs,
          parts: [],
          displayPrompt: j.text,
          model: j.model,
          optionValues,
          armedAutoTags: [...armedAutoTags],
          activeProjectId: projectId,
          folderPath,
        });
        return body;
      },
      (body) => api.create(body),
      ({ cardId, result }) => applySuccess(cardId, result),
    );
    const { successes, buildFail, submitFail: createFail, applyFail } = summary;
    if (!successes.length && buildFail === jobs.length) {
      flash(`생성 요청을 만들 수 없습니다(카드 ${buildFail}개 실패, 모델 없음 ${skipped}개).`);
      return;
    }
    // 최종 배치 순서는 요청 순서로 한 번 정규화한다(점진 반영은 실제 응답 순서였을 수 있음).
    const byCard = new Map<string, string[]>();
    const freshGens: Generation[] = successes.map((item) => item.result);
    for (const success of successes) {
      const arr = byCard.get(success.cardId) || [];
      arr.push(success.result.id);
      byCard.set(success.cardId, arr);
    }
    let finalApplyFail = 0;
    try {
      const latest = listScenes(null).find((item) => item.id === scene.id);
      if (latest && successes.length) {
        const applied = applySceneGenerationResults(
          latest.cards,
          successes.map(({ cardId, result }) => ({ cardId, generationId: result.id })),
        );
        if (applied.attachedCardCount) patchSceneById(scene.id, { cards: applied.cards });
      }
    } catch {
      finalApplyFail = 1;
    }
    const notes: string[] = [];
    if (skipped) notes.push(`모델 없음 ${skipped}개`);
    if (buildFail) notes.push(`요청 실패 ${buildFail}개`);
    if (createFail) notes.push(`제출 실패 ${createFail}장`);
    if (applyFail || finalApplyFail) notes.push("화면 반영 실패 — 새로고침 필요");
    flash(
      `${byCard.size}개 카드에서 생성 시작(${freshGens.length}장)` +
        (notes.length ? ` · ${notes.join(" · ")}` : ""),
    );
    void reload();
    bumpBoard();
  };
  // ── 렌더(배치) 노드 ── 연결된 생성카드들을 각자 자기 모델·refs·텍스트로 batch 장씩 한 번에 생성.
  //  · comfy 없는(또는 comfy 결과를 짝으로 나누지 않는) 경로. 각 카드를 batch 수만큼 복제해 병렬 제출.
  const generateCards = async (cardIds: string[], batchOverride?: number) => {
    if (!activeScene || !cardIds.length) return;
    const sceneId = activeScene.id;
    const release = acquireSceneGeneration(renderingSceneIdsRef.current, sceneId);
    if (!release) {
      flash("이 씬은 이미 생성 요청을 제출하고 있습니다.");
      return;
    }
    try {
      const scene = listScenes(null).find((s) => s.id === sceneId) || activeScene;
      const cardsById = new Map(scene.cards.map((c) => [c.id, c] as const));
      const resolved = resolvePortEdges(cardsById, scene.edges);
      // 렌더 노드의 배치수(노드별)로 각 잡을 복제. 없으면 하단 스포트라이트 배치.
      const batch = Math.max(1, batchOverride ?? batchCount);
      const projectId =
        filters.project_id && filters.project_id !== "none" ? filters.project_id : undefined;
      const folderPath =
        armedFolder && armedFolder.projectId === projectId ? armedFolder.path : undefined;
      const jobs: SceneGenerationJobInput[] = [];
      let skipped = 0;
      for (const cid of cardIds) {
        const job = buildSceneGenerationJobInput(cid, cardsById, resolved);
        if (!job) {
          if (cardsById.get(cid)?.kind === "generation") skipped++; // 생성카드인데 모델 없음
          continue;
        }
        for (let i = 0; i < batch; i++) jobs.push({ ...job }); // 각 잡 × 배치수
      }
      await submitGenJobs(jobs, skipped, scene, projectId, folderPath);
    } finally {
      release();
    }
  };
  // ── 배치 짝 생성 ── 상류 comfy 를 배치수만큼 병렬 실행한 결과(runs)를 받아, 각 run 을 그 comfy 결과(overlay)와
  //  짝지어 1장씩 병렬 생성한다. SceneBoard 오케스트레이터가 runs 를 만들어 이 함수를 1회 호출한다
  //  (씬별 실행 가드에 조용히 막히지 않도록 반드시 1회). run 마다 overlay 가 달라 서로 다른 comfy 결과로 생성.
  const generateCardRuns = async (runs: SceneGenerationRun[]) => {
    if (!activeScene || !runs.length) return;
    const sceneId = activeScene.id;
    const release = acquireSceneGeneration(renderingSceneIdsRef.current, sceneId);
    if (!release) {
      flash("이 씬은 이미 생성 요청을 제출하고 있습니다.");
      return;
    }
    try {
      const scene = listScenes(null).find((s) => s.id === sceneId) || activeScene;
      const cardsById = new Map(scene.cards.map((c) => [c.id, c] as const));
      const resolved = resolvePortEdges(cardsById, scene.edges);
      const projectId =
        filters.project_id && filters.project_id !== "none" ? filters.project_id : undefined;
      const folderPath =
        armedFolder && armedFolder.projectId === projectId ? armedFolder.path : undefined;
      const jobs: SceneGenerationJobInput[] = [];
      let skipped = 0;
      for (const run of runs) {
        const job = buildSceneGenerationJobInput(
          run.cardId,
          cardsById,
          resolved,
          run.comfyOutputsById,
        );
        if (!job) {
          if (cardsById.get(run.cardId)?.kind === "generation") skipped++;
          continue;
        }
        jobs.push(job); // run 하나당 1장(overlay 로 그 짝의 comfy 결과 주입)
      }
      await submitGenJobs(jobs, skipped, scene, projectId, folderPath);
    } finally {
      release();
    }
  };
  // 폴더 필터가 해제되거나(프로젝트/라이브러리/미분류 선택) 다른 프로젝트로 바뀌면 무장 폴더(armedFolder)도
  // 함께 해제한다 — 안 그러면 폴더 필터를 풀어도 새 생성이 예전 폴더로 저장되던 문제(라이브러리·캔버스 공통).
  useEffect(() => {
    if (
      armedFolder &&
      (filters.folder_path !== armedFolder.path || filters.project_id !== armedFolder.projectId)
    ) {
      setArmedFolder(null);
    }
  }, [filters.folder_path, filters.project_id, armedFolder, setArmedFolder]);
  const {
    onColor,
    onFinalize,
    onImport,
    onRegenerate,
    onSetSource,
    onTags,
    onUnfinalize,
    onUnpublish,
  } = useGenerationCardActions({
    armedAutoTags,
    askPrompt,
    bumpBoard,
    flash,
    navTab,
    reload,
  });

  // 히스토리 패널 '구성에서 보기' → 구성탭 트리(뒤로가기로 직전 화면 복원).
  const onOpenInBoard = (g: Generation) => enterBoard(g.id);

  // 미리보기(크게 보기) '구성에서 보기' → 구성탭 트리(뒤로가기로 직전 화면 복원).
  const onOpenInBoardFromPreview = (genId: string) => enterBoard(genId);

  const onLogout = async () => {
    setGens([]); // 로그아웃 즉시 데이터 비우기
    await logout();
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
  // 코멘트 패널 라벨 — 열렸을 때만, gens 가 바뀔 때만 계산(매 렌더 전량 find 방지).
  const commentLabel = useMemo(
    () =>
      commentGenId
        ? (gens.find((g) => g.id === commentGenId)?.prompt || "").slice(0, 40) || "생성본"
        : "생성본",
    [commentGenId, gens],
  );

  // 인증 검증이 끝나기 전(authConfig 로딩 중 또는 토큰 me 검증 중)에는 화면을 보류한다.
  // → 새로고침 시 메인(전역 provider 이름)·로그인 화면이 잠깐 깜빡이는 것을 방지.
  if (authPending) {
    return null;
  }
  // 인증 게이트: 로그인 필요(서버 모드)한데 미로그인 → 앱 전체를 로그인 화면으로 가린다.
  if (authConfig?.auth_enabled && !account) {
    return <LoginScreen config={authConfig} onAuthed={setAccount} />;
  }
  // 로컬 허브 게이트: 백엔드 AUTH off(로컬)에서는 '팀 서버 로그인'을 강제 — 로그인해야 사용
  // (신원=서버 계정). 서버 계정으로 작업·공유가 기록되고, 역할은 서버가 관리·강제.
  if (!authConfig?.auth_enabled) {
    if (sharedSrv === null) return null; // 연결 상태 로딩 중 — 깜빡임 방지
    if (!sharedSrv.has_token) {
      return <ServerLoginScreen url={sharedSrv.url} onConnected={onProxyConnected} />;
    }
  }

  // 관리창(관리탭)은 로그인 사용자 모두에게 연다 — 작업/완료 탭은 전원 접근. 대시보드 탭만
  // 관리창 안에서 read_all(admin/PM/PD) 로 게이트한다(ManageWindow). 관리 기능 자체가 켜져 있어야.
  const canOpenManage = !!authConfig?.manage_enabled && !!hubAccount;

  // 멀티선택 액션바 — 프롬프트가 보이면 프롬프트 상단(topSlot)에, Ctrl+K 로 프롬프트를 숨기면 화면 상단
  // 중앙에 플로팅으로 유지한다(프롬프트와 함께 사라지지 않게). 아래에서 상태에 따라 한 곳에서만 마운트.
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
            projects={projects}
            onShare={boardShare}
            onDownload={bulkDownload}
            onCompare={(items) => setCompareGens(items)}
            onAssign={(pid) => boardAssign(sceneSelGens, pid)}
            onCreateAndAssign={(name) => boardCreateAssign(sceneSelGens, name)}
            onDelete={() => sceneActionRef.current?.deleteSelected()}
          />
        ) : undefined
      ) : boardSelected.length > 0 ? (
        <BoardSelectionActionBar
          selected={boardSelected}
          projects={projects}
          onShare={boardShare}
          onDownload={bulkDownload}
          onCompare={(items) => setCompareGens(items)}
          onAssign={(pid) => boardAssign(boardSelected, pid)}
          onCreateAndAssign={(name) => boardCreateAssign(boardSelected, name)}
          onDelete={boardDelete}
        />
      ) : undefined
    ) : selected.size > 0 ? (
      <LibrarySelectionActionBar
        selectedCount={selected.size}
        selectedGenerations={selectedGenerations}
        projects={projects}
        onDownload={bulkDownload}
        onCompare={(items) => {
          if (items.length >= 2) setCompareGens(items);
        }}
        onAssign={assignSelectedToProject}
        onCreateAndAssign={createAndAssign}
        onDelete={bulkDelete}
        onRestore={bulkRestore}
        onPurge={bulkPurge}
      />
    ) : undefined;

  return (
    <div className="app">
      <TopBar
        filters={filters}
        onTab={(tab) => {
          navTab(tab); // 브라우저 히스토리 엔트리 추가(뒤로/앞으로 연동)
          setFilters({ tab }); // 직접 탭 클릭은 다른 필터 초기화(기존 동작 유지)
          clearSelect();
        }}
        onSearch={(q) => patch({ search: q || undefined })}
        onWorkspaceSwitched={async () => {
          await reload();
          flash("워크스페이스 전환 — 라이브러리를 갱신했습니다.");
        }}
        onImported={async (msg) => {
          await reload();
          flash(msg);
        }}
        onOpenAssets={openAssetsWindow}
        onOpenManage={canOpenManage ? openManageWindow : undefined}
        onOpenAdmin={openAdmin}
        account={hubAccount}
        onLogout={onLogout}
        localHub={!authConfig?.auth_enabled}
      />
      <div className="body">
        {filters.tab === "compose" ? (
          <>
            {showFilters && (
              <CanvasFolderSidebar
                filters={filters}
                onChange={patch}
                projects={projects}
                unassignedCount={unassignedCount}
                archivedCount={archivedCount}
                armedFolder={armedFolder}
                onArmFolder={(projectId, path) => {
                  // 폴더 선택 = ① 생성 라벨 무장 ② 그 폴더(하위 포함)로 계보 보드 필터
                  setArmedFolder(path ? { projectId, path } : null);
                  patch({ project_id: projectId, folder_path: path || undefined });
                }}
                onDropToFolder={(projectId, path, genId) => dropOnFolder(genId, projectId, path)}
                onDropToUnassigned={(genId) => dropUnassign(genId)}
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
              count={boardStats.count}
              grayOn={grayOn}
              onToggleGray={() => setGrayOn((v) => !v)}
              loading={loading}
              failedCount={failedCount}
              onClearFailed={clearFailed}
              colorDots={COLOR_DOTS}
              colorFilter={colorFilter}
              onToggleColor={toggleColorFilter}
              sharedOnly={sharedOnly}
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
              zoomValue={boardStats.zoomPct / 100}
              onZoomValue={(v) => boardControl.current?.zoomTo(v)}
              boardMode
              showFilterToggle
            />
            <SceneBar
              scenes={scenes}
              activeId={activeSceneId}
              // 씬 전환 직전 flush 는 selectScene(모든 전환의 단일 관문) 내부에서 중앙 처리된다.
              onSelect={selectScene}
              onAdd={addScene}
              onRename={renameScene}
              onDelete={removeSceneById}
              onHoverChange={setSceneBarHover}
            />
            {activeScene ? (
              <SceneBoard
                scene={activeScene}
                onChange={(patch) => patchActiveScene(patch)}
                // Ctrl+K 로 프롬프트 숨김 시 멀티선택 액션바를 캔버스 상단 중앙(씬 패널·미니맵 줄)에 얹는다.
                topCenterOverlay={!promptVisible ? selectionBar : undefined}
                onSaveScene={handleSaveScene}
                onLoadSceneFile={handleLoadSceneFile}
                ioPanelHot={sceneBarHover}
                onBindingChange={setSceneBinding}
                // 세션 중 씬 전환했다 돌아와도 복원되게 카메라도 저장.
                onCameraChange={(camera) => patchActiveScene({ camera })}
                onPreview={openPreview}
                onInfo={setInfo}
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
                onVariantCreateAssign={boardCreateAssign}
                onVariantDelete={deleteReturningIds}
                onSelectionGens={setSceneSelGens}
                actionRef={sceneActionRef}
                onGenerateCard={(batch) => spotlightPromptRef.current?.submit(batch)}
                onRenderCards={generateCards}
                onRenderCardRuns={generateCardRuns}
                onComfyRunningChange={setComfyRunning}
                grayOn={grayOn}
                fill={fill}
                typeFilter={typeFilter}
                colorFilter={colorFilter}
                tagFilter={tagFilter}
                sharedOnly={sharedOnly}
                commentOnly={commentOnly}
                finalOnly={finalOnly}
                // 사이드바에서 폴더를 선택(project_id+folder_path)했을 때만 그 폴더 밖 카드를 딤.
                // 프로젝트/라이브러리 선택(folder_path 없음)이면 null → 딤 해제. (memo=folderSel)
                folderSel={folderSel}
                onSetTags={onSetTags}
                onSetAutoTags={onSetAutoTags}
                autoTagOptions={facets.auto_tags}
                onOpenComments={(g) => openComment(g.id)}
              />
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
                facets={facets}
                filters={filters}
                onChange={patch}
                colorDots={COLOR_DOTS}
                colorFilter={colorFilter}
                onToggleColor={toggleColorFilter}
                finalOnly={finalOnly}
                onToggleFinal={() => setFinalOnly((v) => !v)}
                grayOn={grayOn}
                onToggleGray={() => setGrayOn((v) => !v)}
                armedAutoTags={armedAutoTags}
                onToggleAutoTag={toggleArmedAutoTag}
                onAddAutoTag={addAutoTag}
                onDeleteAutoTag={removeAutoTag}
                armedFolder={armedFolder}
                onArmFolder={(projectId, path) => {
                  // 폴더 선택 = ① 생성 라벨 무장 ② 그 폴더(하위 포함)로 라이브러리 필터
                  setArmedFolder(path ? { projectId, path } : null);
                  patch({ project_id: projectId, folder_path: path || undefined });
                }}
                onDropToFolder={(projectId, path, genId) =>
                  dropOnFolder(genId, projectId, path)
                }
                onDropToUnassigned={(genId) => dropUnassign(genId)}
                onCreatorChanged={reload}
                projects={projects}
                unassignedCount={unassignedCount}
                archivedCount={archivedCount}
              />
            )}
            <main className="main">
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
                count={gridGens.length}
                countMore={hasMore}
                grayOn={grayOn}
                onToggleGray={() => setGrayOn((v) => !v)}
                loading={loading}
                failedCount={failedCount}
                onClearFailed={clearFailed}
                colorDots={COLOR_DOTS}
                colorFilter={colorFilter}
                onToggleColor={toggleColorFilter}
                sharedOnly={sharedOnly}
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
              <ThumbnailGrid
                    generations={gridGens}
                    disabledIds={effectiveDisabled}
                    onBulkGradeStep={onBulkGradeStep}
                    tab={filters.tab}
                    myCreatorUid={account?.creator_uid ?? null}
                    scale={scale}
                    fill={fill}
                    layout={layout}
                    groupByDate={groupByDate}
                    selectedIds={selected}
                    onSelectedChange={(next) => {
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
                    onOpenComments={(g) => openComment(g.id)}
                    onRegenerate={onRegenerate}
                    onPublish={onPublish}
                    onUnpublish={onUnpublish}
                    onFinalize={onFinalize}
                    onUnfinalize={onUnfinalize}
                    canFinalize={canFinalize}
                    onImport={onImport}
                    onRestore={onRestore}
                    dimDeleted={!filters.deleted_only}
                    onColor={onColor}
                    onTags={onTags}
                onInfo={handleInfo}
                onPreview={openPreview}
                onShowHistory={onShowHistory}
                hasMore={hasMore}
                loadingMore={loadingMore}
                onLoadMore={loadMore}
                resetKey={serverFilterKey}
              />
            </main>
          </>
        )}
      </div>

      {/* Ctrl+K 로 프롬프트를 숨겨도 멀티선택 액션바는 유지. 캔버스(활성 씬)에선 SceneBoard 가 상단 중앙에
          얹으므로 여기선 제외하고, 그 외(라이브러리 등)에서만 화면 상단 중앙에 띄운다. */}
      {!promptVisible && selectionBar && !(filters.tab === "compose" && !!activeScene) && (
        <div className="selbar-top-float">{selectionBar}</div>
      )}
      {/* 프롬프트 입력바 — 구성탭에서도 표시. Ctrl/⌘+K 로 표시/숨김 토글(display 토글로 입력 상태 보존) */}
      <div style={promptVisible ? undefined : { display: "none" }}>
        <SpotlightPrompt
          ref={spotlightPromptRef}
          expanded={composerExpanded || sceneMode}
          onToggleExpand={toggleComposerExpanded}
          onPreview={openPreview}
          trayBinding={trayBinding}
          inCompose={filters.tab === "compose"}
          onTrayBindingRefsChange={setSceneCardRefs}
          onTrayBindingPromptChange={setSceneCardPrompt}
          count={batchCount}
          onCountChange={setBatchCount}
          armedAutoTags={[...armedAutoTags]}
          armedFolder={armedFolder}
          activeProjectId={
            filters.project_id && filters.project_id !== "none"
              ? filters.project_id
              : undefined
          }
          topSlot={promptVisible ? selectionBar : undefined}
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
      <AppOverlays
        account={account}
        adminOpen={adminOpen}
        commentGenId={commentGenId}
        commentLabel={commentLabel}
        compareGens={compareGens}
        history={history}
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
        onCompare={setCompareGens}
        onCompareClose={() => setCompareGens(null)}
        onHistoryChanged={reload}
        onInfo={setInfo}
        onInfoClose={() => setInfo(null)}
        onInfoOpenInBoard={(g) => {
          setInfo(null);
          onOpenInBoard(g);
        }}
        onInfoOpenCanvas={(g) => {
          setInfo(null);
          onShowHistory(g);
        }}
        onOpenInBoard={onOpenInBoard}
        onOpenInBoardFromPreview={onOpenInBoardFromPreview}
        onPreview={openPreview}
      />
      {videoCompare && (
        <Suspense fallback={null}>
          <VideoCompareModal videos={videoCompare} onClose={() => setVideoCompare(null)} />
        </Suspense>
      )}
    </div>
  );
}
