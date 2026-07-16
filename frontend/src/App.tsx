// 앱 루트: 탭·필터 상태, 데이터 로딩, WebSocket 진행률, 액션 오케스트레이션.
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
// 코드 스플리팅 — 드물게 여는 구성보드는 지연 로드해 초기 번들에서 분리.
const HistoryBoard = lazy(() =>
  import("./components/HistoryBoard").then((m) => ({ default: m.HistoryBoard })),
);
import { LoginScreen } from "./components/LoginScreen";
import { ServerLoginScreen } from "./components/ServerLoginScreen";
import { FilterSidebar } from "./components/FilterSidebar";
import { LibraryToolbar } from "./components/LibraryToolbar";
import { SpotlightPrompt } from "./components/SpotlightPrompt";
import { ThumbnailGrid } from "./components/ThumbnailGrid";
import { TopBar } from "./components/TopBar";
import { SceneBar } from "./components/scene/SceneBar";
import { SceneBoard } from "./components/scene/SceneBoard";
import { AppOverlays } from "./components/app/AppOverlays";
import {
  BoardSelectionActionBar,
  LibrarySelectionActionBar,
} from "./components/app/SelectionActionBar";
import { KEY_COLORS } from "./lib/appConstants";
import { generationQueryKey } from "./lib/appGenerationQuery";
import { generationsByIds } from "./lib/generationTags";
import { useAppNavigation } from "./lib/useAppNavigation";
import {
  listScenes,
  variantIds,
  type SceneRef,
} from "./lib/scenes";
import { useDebouncedCallback } from "./lib/useDebouncedCallback";
import { useGenerationAutoRefresh } from "./lib/useGenerationAutoRefresh";
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
  PreviewTarget,
} from "./types";

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
  const [history, setHistory] = useState<History | null>(null); // 히스토리(가계) 패널 대상
  // Canvas 씬(빈 캔버스) 상태·CRUD 는 useSceneCoordination 훅으로 추출. S1: 프로젝트 무관 전역(projectId=null).
  const {
    scenes, activeSceneId, activeScene,
    sceneBinding, setSceneBinding, sceneSelGens, setSceneSelGens, sceneActionRef,
    selectScene, addScene, renameScene, removeSceneById, patchActiveScene,
  } = useSceneCoordination();
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
  const { flash, toast } = useAppToast();
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
    setGens,
    stats,
    unassignedCount,
  } = useGenerationLibraryData({ authReady, filters, flash, genQuery });
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

  const {
    composerExpanded,
    promptVisible,
    toggleComposerExpanded,
  } = usePromptDock(LS);

  // 태그 reload 디바운스 — 연속 태그 입력 중 매 입력마다 reload 하면, 아직 저장 안 끝난 옵티미스틱
  // 상태를 옛 서버값으로 덮어써 '방금 넣은 태그가 사라지는' 레이스가 난다. 마지막 입력 후 1회만 reconcile.
  const { run: scheduleTagReload } = useDebouncedCallback(() => void reload(false, true), 600);
  const {
    onBulkAddAutoTags,
    onBulkAddTags,
    onBulkRemoveAutoTags,
    onBulkRemoveTags,
    onSetAutoTags,
    onSetTags,
  } = useGenerationTagActions({ flash, gensRef, scheduleTagReload, selectedRef, setGens });
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

  // 로컬 우선: 내 작업(tab=my)은 로컬 DB 를 그대로 읽으므로 로드된 페이지가 곧 화면 결과
  // (진행중·실패 placeholder 포함). 별도 머지 불필요.
  const visibleGens = gens;
  // 회색 버튼 ON → 비활성(회색)으로 표시된 카드를 그리드에서 제외(숨김). 색 dot 과 반대 방향 필터.
  // (비활성은 로컬 시각 상태라 서버가 모름 → 클라이언트 측에서 거른다.)
  // id 직접 비활성(d) + 폴더 비활성을 합친 '확장 집합' — 라이브러리 회색/숨김, 썸네일그리드에 공통 사용.
  const effectiveDisabled = useMemo(
    () => expandDisabledGenerationIds(visibleGens, disabledGen, disabledFolders),
    [visibleGens, disabledGen, disabledFolders],
  );
  // memo — App 은 진행률·토스트 등으로 자주 리렌더되므로 매번 전량 filter 하지 않게.
  const gridGens = useMemo(
    () => filterDisabledGenerations(visibleGens, effectiveDisabled, grayOn),
    [visibleGens, effectiveDisabled, grayOn],
  );
  // 이번에 받은 페이지가 회색필터로 전부 가려지면(빈 그리드) ThumbnailGrid 가 센티넬을 못 그려
  // onLoadMore 가 영영 안 불린다 → 뒤 페이지의 활성 항목이 사라진 것처럼 보임. hasMore 인 한
  // 활성 항목이 나오거나 끝날 때까지 다음 페이지를 자동으로 당긴다(필터·페이지네이션 분리).
  useEffect(() => {
    if (grayOn && gridGens.length === 0 && hasMore && !loadingMore) loadMore();
  }, [grayOn, gridGens.length, hasMore, loadingMore, loadMore]);

  // 미확인 코멘트 여부·실패 수는 전역 파생값 → 서버 stats 에서(전량 로드 대체).
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
    openOverlay,
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
  const {
    bulkDownload,
    onShowHistory,
    openAssetsWindow,
    openManageWindow,
  } = useGenerationUtilityActions({
    flash,
    openOverlay,
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
  const trayBinding =
    sceneMode && activeScene && sceneBinding
      ? { key: `${activeScene.id}:${sceneBinding.cardId}`, refs: sceneBinding.refs }
      : null;
  // 씬 생성 카드의 레퍼런스를 프롬프트 트레이 편집(순서변경·추가·삭제)으로 되돌려 저장.
  const setSceneCardRefs = (refs: SceneRef[]) => {
    if (!activeScene || !sceneBinding) return;
    const nextCards = activeScene.cards.map((c) =>
      c.id === sceneBinding.cardId ? { ...c, refs } : c,
    );
    patchActiveScene({ cards: nextCards });
  };
  // 생성 완료 → 결과 gen id 를 선택 카드에 바인딩(카드에 썸네일 표시). 씬 모드에선 구성보드 부모 자동연결은 건너뜀.
  const onPromptCreated = async (created?: Generation[], dragParentId?: string | null) => {
    if (sceneMode && activeScene && sceneBinding) {
      const newIds = (created || []).map((x) => x.id); // 복수 생성이면 여러 장 → 카드에 모두 누적
      if (newIds.length) {
        // 최신 씬을 다시 읽어(생성 대기 중 편집분 보존) 해당 카드에만 변형 append — 덮어쓰지 않는다.
        const cards = listScenes(null).find((s) => s.id === activeScene.id)?.cards || activeScene.cards;
        const nextCards = cards.map((c) => {
          if (c.id !== sceneBinding.cardId) return c;
          const genIds = [...variantIds(c)]; // legacy genId + 기존 genIds 병합(누락 방지)
          for (const id of newIds) if (!genIds.includes(id)) genIds.push(id);
          return { ...c, genId: newIds[0], genIds, status: "pending" as const }; // 첫 장을 대표로 표시
        });
        patchActiveScene({ cards: nextCards });
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
            />
            <SceneBar
              scenes={scenes}
              activeId={activeSceneId}
              onSelect={selectScene}
              onAdd={addScene}
              onRename={renameScene}
              onDelete={removeSceneById}
            />
            {activeScene ? (
              <SceneBoard
                scene={activeScene}
                onChange={(patch) => patchActiveScene(patch)}
                onBindingChange={setSceneBinding}
                // 세션 중 씬 전환했다 돌아와도 복원되게 카메라도 저장.
                onCameraChange={(camera) => patchActiveScene({ camera })}
                onPreview={openPreview}
                onInfo={setInfo}
                onRegenerate={onRegenerate}
                onPublish={onPublish}
                onUnpublish={onUnpublish}
                onFinalize={onFinalize}
                onUnfinalize={onUnfinalize}
                canFinalize={canFinalize}
                projects={projects}
                onVariantShare={boardShare}
                onVariantDownload={bulkDownload}
                onVariantCompare={setCompareGens}
                onVariantAssign={boardAssign}
                onVariantCreateAssign={boardCreateAssign}
                onVariantDelete={deleteReturningIds}
                onSelectionGens={setSceneSelGens}
                actionRef={sceneActionRef}
                grayOn={grayOn}
                typeFilter={typeFilter}
                colorFilter={colorFilter}
                tagFilter={tagFilter}
                sharedOnly={sharedOnly}
                commentOnly={commentOnly}
                finalOnly={finalOnly}
                onSetTags={onSetTags}
                onSetAutoTags={onSetAutoTags}
                autoTagOptions={facets.auto_tags}
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
                    onSelectedChange={setSelected}
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

      {/* 프롬프트 입력바 — 구성탭에서도 표시. Ctrl/⌘+K 로 표시/숨김 토글(display 토글로 입력 상태 보존) */}
      <div style={promptVisible ? undefined : { display: "none" }}>
        <SpotlightPrompt
          expanded={composerExpanded || sceneMode}
          onToggleExpand={toggleComposerExpanded}
          onPreview={openPreview}
          trayBinding={trayBinding}
          onTrayBindingRefsChange={setSceneCardRefs}
          armedAutoTags={[...armedAutoTags]}
          armedFolder={armedFolder}
          activeProjectId={
            filters.project_id && filters.project_id !== "none"
              ? filters.project_id
              : undefined
          }
          topSlot={
            filters.tab === "compose" ? (
              // 씬(캔버스)이 열려 있으면 씬 선택 결과카드 기준, 아니면 히스토리 보드 선택 노드 기준.
              activeScene ? (
                sceneSelGens.length > 0 ? (
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
            ) : undefined
          }
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
        commentLabel={
          // 패널이 열렸을 때만 조회 — 닫힌 상태(null)에서 매 렌더 전량 find 방지.
          commentGenId
            ? (gens.find((g) => g.id === commentGenId)?.prompt || "").slice(0, 40) || "생성본"
            : "생성본"
        }
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
        onCompare={setCompareGens}
        onCompareClose={() => setCompareGens(null)}
        onHistoryChanged={reload}
        onInfo={setInfo}
        onInfoClose={() => setInfo(null)}
        onInfoOpenInBoard={(g) => {
          setInfo(null);
          onOpenInBoard(g);
        }}
        onOpenInBoard={onOpenInBoard}
        onOpenInBoardFromPreview={onOpenInBoardFromPreview}
        onPreview={openPreview}
      />
    </div>
  );
}
