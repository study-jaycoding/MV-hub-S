// 썸네일 그리드 (DESIGN.md §4). 에셋 파트(AssetsView)와 동일한 선택 시스템:
//  · 카드 클릭 = 단일 선택, Shift/Ctrl 클릭 = 추가/토글
//  · 빈 공간 드래그 = 마퀴(러버밴드) 다중 선택
//  · 더블클릭 = 미리보기. (카드 드래그는 프롬프트 재사용 — 마퀴 대신 네이티브 드래그)
// 선택 상태는 App 이 Set<string>(id) 로 보유 — 일괄 작업/select-bar 가 의존.
import { activationKeyOwned, backgroundKeysBlocked, isTypingTarget, pressStartedCovered, useLooseKeys } from "../lib/keyGate";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Virtualizer, type VirtualizerHandle } from "virtua";
import {
  previewTargetFromGenerations,
  toggleGenerationDateSelection,
} from "../lib/generationGrid";
import {
  buildGridRows,
  computeGridColumns,
  navigateGrid,
  type VirtualRow,
} from "../lib/gridVirtualRows";
import { useT } from "../lib/i18n";
import { isKeyHandled, markKeyHandled } from "../lib/keyHandled";
import { computeMarquee, marqueeHits } from "../lib/marquee";
import { useOutsideDragSelect } from "../lib/useOutsideDragSelect";
import { useStaleMultiClick } from "../lib/useStaleMultiClick";
import { onSelectionOutsidePress } from "../lib/useGenerationSelection";
import { matchShortcut } from "../lib/shortcuts";
import { addWindowMouseDrag, dragLost, removeWindowMouseDrag } from "../lib/windowDrag";
import type { CardMark, Generation, InfoTarget, PreviewTarget } from "../types";
import type { GradeMode } from "../lib/gradeStep";
import type { ReviewAction } from "../lib/generationReview";
import { GenerationCard } from "./GenerationCard";
import { useGenerationViewsSynced } from "../lib/useGenerationViewsSynced";
import { TEAM_SCOPE } from "../lib/generationViews";
import { ackStateGlow, getStateGlowVersion, observeReviewStates, stateGlowOf, subscribeStateGlow } from "../lib/stateGlow";
import { getTeamSeenVersion, isFreshGen, subscribeTeamSeen } from "../lib/teamSeen";
import type { WorkspaceCommandOperation, WorkspaceCommandTarget } from "../lib/workspaceCommand";

interface Props {
  generations: Generation[];
  disabledIds?: Set<string>; // 비활성(회색)으로 표시된 gen id — 카드를 회색 처리(크기는 유지)
  tab: "my" | "team";
  myCreatorUid?: string | null; // 내 creator_uid — 팀 탭 가져오기 버튼 노출 판별에 카드로 전달
  scale: number; // 카드 크기 배율 (그리드 모드)
  fill: boolean; // 썸네일 cover(꽉) ↔ contain(비율)
  layout: "grid" | "list";
  groupByDate: boolean; // 그리드에서 힉스필드 날짜별 섹션 구분
  selectedIds: Set<string>;
  resolveHighlightedIds?: ReadonlySet<string>; // 확인 표시 전용 — 일괄 작업 선택/Last viewed와 분리
  // focus = 이동과 함께 그 카드를 방향키·Shift 범위 선택의 기준으로 삼는다(캔버스 '생성 결과' 창의 다빈치 선택).
  resolveScrollRequest?: { generationId: string; nonce: number; focus?: boolean } | null;
  onClearResolveHighlight?: () => void;
  onSelectedChange: (next: Set<string>) => void; // 마퀴/클릭 선택 결과(전체 치환)
  onToggleSelect: (id: string) => void; // 리스트 모드 체크박스
  onSetSource: (g: Generation, name: string | null, isSource: boolean) => void;
  onSetTags: (g: Generation, tags: string[]) => void;
  onBulkAddTags?: (g: Generation, names: string[]) => void; // 다중선택 시 추가를 선택 전체에 적용
  onBulkRemoveTags?: (g: Generation, names: string[]) => void; // 다중선택 시 ×해제를 선택 전체에(공통 삭제)
  autoTagOptions?: string[]; // 내 전역(auto) 태그 목록 — 태그 에디터 # 두 번 모드
  onSetAutoTags?: (g: Generation, names: string[]) => void;
  onBulkAddAutoTags?: (g: Generation, names: string[]) => void; // 다중선택 시 전역 부여를 선택 전체에
  onBulkRemoveAutoTags?: (g: Generation, names: string[]) => void; // 다중선택 시 전역 해제를 선택 전체에
  onWorkspaceCommand?: (
    g: Generation,
    operation: WorkspaceCommandOperation,
    workspace: WorkspaceCommandTarget,
  ) => Promise<boolean>;
  onBulkGradeStep?: (mode: GradeMode) => void; // 다중선택 시 S(단일/더블)를 선택 전체에 등급 규칙 적용
  onOpenComments: (g: Generation) => void; // C/c → 공유 코멘트 스레드 패널
  onRegenerate: (g: Generation) => void;
  onPublish: (g: Generation) => void;
  onUnpublish: (g: Generation) => void;
  onFinalize: (g: Generation) => void; // v02 CMS: Supervisor 최종(골드) 지정
  onUnfinalize: (g: Generation) => void; // 최종 해제
  onReview?: (g: Generation, action: ReviewAction) => void;
  onBulkReview?: (action: ReviewAction) => void;
  bulkReviewAllowed?: Record<ReviewAction, boolean>;
  canFinalize?: (g: Generation) => boolean; // 그 프로젝트의 supervisor 나 전역 관리자일 때만 최종 지정 가능 — PM 은 아니다(없으면 허용)
  onImport: (g: Generation) => void;
  onRestore: (g: Generation) => void; // 휴지통 복구
  dimDeleted: boolean; // 지운 카드 흐림 적용('함께 보기'만 true, '지운 것만'은 false)
  onInfo: (t: InfoTarget) => void;
  onPreview: (t: PreviewTarget) => void;
  onShowHistory?: (g: Generation) => void; // 히스토리 뱃지 → 가계 패널
  onOpenFolder?: (g: Generation) => void; // 카드의 폴더 이름표 → 그 폴더의 생성물 창(안 주면 이름표 없음)
  openedFromId?: string | null; // 폴더 창을 연 카드 — 그 카드에 '방금 누른 카드' 표시
  cardMarks?: Readonly<Record<string, CardMark>>; // 편집 탭이 연 폴더 창 — 타임라인에 넣은 카드의 표(같은 자리)
  onCardMenu?: (g: Generation, x: number, y: number) => void; // 그 창 — 카드 휠 클릭(넣을 트랙 메뉴). 안 주면 휠 클릭 = 정보 그대로
  // ── 캔버스 '생성 결과' 창이 쓰는 선택 기능(안 주면 종전 그대로) ──
  cellHeader?: (g: Generation) => React.ReactNode; // 카드 위(셀 안)에 그리는 칸 — '대표' 단추
  lastViewedId?: string | null; // 주면(null 포함) '마지막으로 본' 표시를 이 값으로 — 라이브러리 칸 대신 호출자의 칸
  dimIds?: ReadonlySet<string>; // 흐리게 보일 카드(캔버스에서 고른 폴더 밖)
  showFolder?: boolean; // onOpenFolder 없이도 폴더 표를 '표시만' 한다
  // 무한 스크롤 — 로드된 DOM 을 다 보여준 뒤 바닥에 닿으면 서버 다음 페이지 요청.
  hasMore?: boolean; // 서버에 더 받을 페이지가 있나
  loadingMore?: boolean;
  onLoadMore?: () => void;
  resetKey?: string; // 필터/정렬 변경 신호(genQuery 직렬화) — 바뀌면 점진 렌더(shown)를 초기화
  loadError?: string | null; // 목록 첫 로드 실패 사유 — 빈 상태와 구분해 재시도 UI 를 띄운다
  loading?: boolean; // 목록을 받는 중 — 비어 있을 때 "항목이 없습니다" 대신 "불러오는 중…"(받는 중인데 없다고 말하지 않는다)
  selectLocked?: boolean; // 바깥(상단바·사이드바 여백)에서 시작하는 끌기 선택을 끈다 — 낡은 사본을 보이는 동안
  placeKey?: string; // 지금 보여 주는 자리의 열쇠 — 바뀌면 다른 화면이다(두 번 누름의 둘째가 새 화면에 닿는 것을 버리는 근거, lib/useStaleMultiClick)
  onRetryLoad?: () => void; // 로드 실패 시 "다시 시도"
}

const subscribeResize = (onChange: () => void) => {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
};

export function ThumbnailGrid(props: Props) {
  const { generations, scale, layout, groupByDate, selectedIds } = props;
  const resolveScrollGuardRef = useRef(false);
  const handledResolveScrollRef = useRef<string | null>(null);
  const [resolveScrollRelease, setResolveScrollRelease] = useState(0);
  const releaseResolveScrollGuard = () => {
    if (!resolveScrollGuardRef.current) return;
    resolveScrollGuardRef.current = false;
    // 목록이 짧으면 wheel을 해도 scroll 이벤트가 없다. underfill 검사도 다시 깨운다.
    setResolveScrollRelease((version) => version + 1);
  };
  // 앞선 Shift 클릭의 기준 — 그 클릭이 만든 선택이 그대로인 동안은 이어지는 Shift 클릭도 같은 기준을 쓴다(탐색기처럼 Shift 클릭은 기준을
  //  옮기지 않는다). 전엔 초점 카드가 없으면(마퀴·선택 칸으로만 골랐거나 밖에서 풀린 자리) '고른 것 중 마지막 카드'를 누를 때마다 다시 잡아,
  //  기준이 방금 만든 범위의 끝으로 옮겨 갔다(조작 점검 7회 R43-b). 격자가 선택을 달리 바꾸면(마퀴·방향키·Ctrl+A·Esc) 바로 아래에서
  //  잊고, 밖에서 바뀐 선택(선택 칸·밖에서 풀림·부모가 거른 선택)은 선택이 바뀌는 효과에서 잊는다(아래 [selectedIds] 효과).
  const rangeAnchorRef = useRef<{ anchor: string; ids: ReadonlySet<string> } | null>(null);
  const onSelectedChange = (next: Set<string>) => {
    rangeAnchorRef.current = null;
    releaseResolveScrollGuard();
    props.onClearResolveHighlight?.();
    props.onSelectedChange(next);
  };
  const resolveScrollKey = props.resolveScrollRequest
    ? JSON.stringify([props.resolveScrollRequest.generationId, props.resolveScrollRequest.nonce])
    : null;
  // 자동 이동 뒤 바닥/underfill 이벤트로 모든 과거 페이지가 줄줄이 로드되지 않게 한다.
  // 다음 사용자 스크롤 의도 또는 필터 변경 시 즉시 일반 무한 스크롤로 돌아간다.
  useLayoutEffect(() => {
    resolveScrollGuardRef.current = resolveScrollKey !== null &&
      resolveScrollKey !== handledResolveScrollRef.current;
  }, [resolveScrollKey, props.resetKey]);
  const isList = layout === "list";
  const t = useT();
  // 팀 탭 '새로 들어옴'(확인 전 글로우) — 카드 클릭으로 확인되면 스토어가 bump → 그 카드만 글로우 해제.
  const teamSeenVer = useSyncExternalStore(subscribeTeamSeen, getTeamSeenVersion);
  // '마지막으로 본' 결과 — Workspace 는 '' 칸, Share & Review 는 @team 칸(각자 하나씩, 사용자 확정).
  const genViews = useGenerationViewsSynced(props.tab === "team" ? TEAM_SCOPE : "");
  void teamSeenVer;
  // '방금 내가 상태를 바꾼 카드'의 빛(lib/stateGlow) — 목록이 바뀔 때 달라진 상태를 집고, **새로 선택된** 카드는 확인된 것으로 끈다.
  // 상태를 바꾸는 순간 이미 선택돼 있던 카드는 그대로 둔다(선택을 풀었을 때 빛이 보여야 한다) — 그래서 '선택돼 있음'이 아니라 '새로 들어옴'만 본다.
  void useSyncExternalStore(subscribeStateGlow, getStateGlowVersion);
  useEffect(() => observeReviewStates(generations, props.tab), [generations, props.tab]);
  const ackedSelectionRef = useRef(selectedIds);
  useEffect(() => {
    const before = ackedSelectionRef.current;
    ackedSelectionRef.current = selectedIds;
    const added = generations.filter((generation) => selectedIds.has(generation.id) && !before.has(generation.id));
    if (added.length) ackStateGlow(added);
  }, [selectedIds, generations]);

  // 날짜별 그룹은 rowModel.dateGroups 로 통합(별도 O(n) 스캔 제거) — 아래 rowModel 참고.

  // 날짜 헤더 체크박스 — 그 날짜의 모든 항목을 한 번에 선택/해제(토글).
  const toggleDate = (ids: string[], allSelected: boolean) => {
    onSelectedChange(toggleGenerationDateSelection(selectedIds, ids, allSelected));
  };

  const gridRef = useRef<HTMLDivElement>(null); // 스크롤 컨테이너(가상화 대상)
  const vRef = useRef<VirtualizerHandle>(null);
  // 반응형 컬럼 수 — CSS auto-fill 과 같은 공식으로 실측. 가상 행 모델이 이 값으로 카드 행을 자른다.
  // hasRows 를 의존성에 포함: 로딩(빈 상태)엔 .gen-grid 가 없어 측정 불가 → 데이터 도착해 그리드가
  // 실제로 마운트될 때 재측정해야 함(안 그러면 컬럼 1 로 고정됨). useLayoutEffect = 첫 페인트 전 측정.
  const [columns, setColumns] = useState(1);
  const hasRows = generations.length > 0;
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el || isList) {
      setColumns(1);
      return;
    }
    const measure = () => setColumns(computeGridColumns(el, Math.round(180 * scale), 12)); // gap 12 = .gen-vrow-grid
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scale, isList, hasRows]);

  // 가상 행 모델(헤더 행 + 카드 행) — virtua 가 이 rows 를 행 단위로 가상화한다(뷰포트+오버스캔만 마운트).
  const rowModel = useMemo(
    () => buildGridRows(generations, isList ? 1 : columns, groupByDate),
    [generations, isList, columns, groupByDate],
  );

  // 썸네일 요청 폭 버킷 — 카드 표시폭(≈180*scale)×DPR 이 256 이하면 256, 아니면 512. 1x 디스플레이·
  // 작은 줌에선 512 가 과해 256 으로 디코딩 메모리 1/4. 레티나·큰 줌에선 512 유지(화질 무손실).
  //  배율(DPR)은 모니터를 옮기거나 브라우저를 확대하면 바뀐다 — 창 크기 바뀜에 다시 읽는다(숫자라 바뀔 때만 다시 그린다. 51회차:
  //  옛 배율에 머물러 큰 배율 화면에서 256 을 계속 받았다).
  const dpr = useSyncExternalStore(subscribeResize, () => window.devicePixelRatio || 1, () => 1);
  const thumbSize = useMemo(() => {
    if (isList) return 512; // 리스트는 행이 커질 수 있어 안전하게 원해상도
    return Math.round(180 * scale) * dpr <= 256 ? 256 : 512;
  }, [isList, scale, dpr]);

  // underfill 보정 — 첫 화면이 뷰포트를 못 채우면 스크롤바가 없어 onScroll 이 안 오고 다음 페이지를
  // 못 당긴다. 렌더 후 높이를 재보고 안 채워졌으면 서버 다음 페이지 요청.
  useEffect(() => {
    if (!props.hasMore || props.loadingMore) return;
    const el = gridRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      if (!resolveScrollGuardRef.current && el.scrollHeight <= el.clientHeight + 40) props.onLoadMore?.();
    });
    return () => cancelAnimationFrame(id);
  }, [rowModel, props.hasMore, props.loadingMore, props.onLoadMore, resolveScrollRelease]);

  const [marquee, setMarquee] = useState<{ l: number; t: number; w: number; h: number } | null>(null);
  const [focusedGenerationId, setFocusedGenerationId] = useState<string | null>(null);
  // Resolve 대상 주입·다음 페이지 정렬로 순서가 바뀌어도 방향키/Shift 앵커는 같은 카드를 유지한다.
  const focusIdx = useMemo(() => generations.findIndex((g) => g.id === focusedGenerationId), [generations, focusedGenerationId]);
  // 카드 인라인 편집(S 이름·# 태그) — 버튼/단축키 공통 진실원. 한 번에 한 카드.
  // (C 코멘트는 인라인이 아니라 공유 스레드 패널 → onOpenComments)
  const [editTarget, setEditTarget] = useState<{ id: string; field: "source" | "tag" } | null>(null);
  const requestEdit = useCallback(
    (g: Generation, field: "source" | "tag") => setEditTarget({ id: g.id, field }),
    [],
  );
  // 밖에서 선택이 비면(격자 밖 단추를 눌러 풀림 등) 초점 카드도 지운다 — 남겨 두면 초점 잃은 키(c·#·h·Enter·Space)가 **고른 것도 없는데**
  //  옛 초점 카드에 실행된다(2026-10-10 최종 재실측: 계정 메뉴를 닫은 뒤 c 에 코멘트 패널이 뜨고 h 에 캔버스로 넘어갔다). 격자의 Space 로
  //  마지막 카드를 뺀 경우(Ctrl+클릭도)만 예외 — 그 자리에서 다시 고르고 방향키도 거기서 출발하게. 격자 자신의 Esc·빈 곳 클릭은 원래 지운다.
  const keepFocusRef = useRef(false);
  const hadSelectionRef = useRef(selectedIds.size > 0);
  // 밖에서 풀리며 지운 초점 자리 — **방향키·Shift 클릭의 기준으로만** 쓴다(c·#·Enter·Space 는 보지 않는다). 없으면 툴바 단추·슬라이더를 누른
  //  뒤의 방향키가 보던 자리가 아니라 목록 맨 위로 튄다(Codex 코드 리뷰). 다시 고르면 잊는다.
  const lastSpotRef = useRef<string | null>(null);
  const focusedIdRef = useRef(focusedGenerationId);
  focusedIdRef.current = focusedGenerationId;
  useEffect(() => {
    // 선택이 앞선 Shift 클릭이 만든 범위와 달라지면 그 기준을 잊는다 — 격자 밖에서 선택이 바뀌는 길(선택 칸·밖에서 풀림·부모가 거른 선택)은
    //  모두 여기를 지난다. **바뀐 순간에** 잊는다: 쓸 때 견주면 g1 을 켰다 끈 뒤(집합은 다시 같다) 옛 기준이 되살아났다(Codex 코드 리뷰).
    //  내용으로 견주는 까닭 — 부모가 같은 선택을 새 Set 으로 다시 줄 뿐일 때('생성 결과' 창의 자료 갱신)는 지킨다.
    const kept = rangeAnchorRef.current;
    if (kept && (kept.ids.size !== selectedIds.size || [...selectedIds].some((id) => !kept.ids.has(id)))) rangeAnchorRef.current = null;
    const had = hadSelectionRef.current;
    hadSelectionRef.current = selectedIds.size > 0;
    const keep = keepFocusRef.current;
    keepFocusRef.current = false; // 한 번의 선택 변경에만 유효
    if (selectedIds.size > 0) lastSpotRef.current = null;
    // '고른 것이 있다 → 없다'로 바뀔 때만 — 부모가 빈 Set 을 새로 만들어 줄 때마다(캔버스 '생성 결과' 창은 자료가 갱신될 때마다 그런다)
    //  Space 로 남겨 둔 초점까지 지우지 않게(Codex 코드 리뷰).
    else if (had && !keep) {
      lastSpotRef.current = focusedIdRef.current;
      setFocusedGenerationId(null);
    }
  }, [selectedIds]);
  // 선택이 이미 빈 채로 격자 밖을 눌렀다 — 위 효과는 '있다 → 없다'만 보므로 Space 로 남겨 둔 초점 카드가 그대로 남고, 초점 잃은 키
  //  (c·#·Enter·Space)가 고른 것도 없는데 그 카드에 실행됐다(조작 점검 7회 R43-a). 밖에서 풀릴 때와 같게 한다: 실행용 초점은 지우고
  //  자리만 방향키·Shift 클릭의 기준으로 기억한다. '밖'의 판정은 선택 훅이 한다(선택을 지키는 자리 = 초점 카드도 지키는 자리).
  useEffect(() => onSelectionOutsidePress(() => {
    if (hadSelectionRef.current || !focusedIdRef.current) return;
    lastSpotRef.current = focusedIdRef.current;
    setFocusedGenerationId(null);
  }), []);
  const editDone = useCallback(() => setEditTarget(null), []);
  // 인라인 편집이 키(Enter·Esc)로 끝나면 입력칸이 사라지며 초점이 BODY 로 떨어진다 — 격자로 돌려받아 방향키·#·c 가 바로 먹게 한다
  //  (캔버스의 결과 창에서는 초점 없는 키가 뒤 보드로 가 Delete 가 노드를 지운다). 다른 곳을 눌러 끝냈으면 그 초점을 둔다.
  const wasEditingRef = useRef(false);
  useEffect(() => {
    const lost = !document.activeElement || document.activeElement === document.body;
    if (wasEditingRef.current && !editTarget && lost) gridRef.current?.focus({ preventScroll: true });
    wasEditingRef.current = !!editTarget;
  }, [editTarget]);
  // 다중선택 태그 편집 중: 포커스가 아닌 '선택된' 카드에도 읽기전용 스트립을 보여 '적용 대상'임을 표시.
  // tagGlobalMode = 포커스 에디터가 전역 모드인지(다른 카드 배지를 '전역 적용'으로 전환). 편집 대상이 바뀌면 리셋.
  const [tagGlobalMode, setTagGlobalMode] = useState(false);
  useEffect(() => setTagGlobalMode(false), [editTarget?.id]);
  // 편집 카드가 다중선택에 포함될 때만 '적용 대상' 스트립을 띄운다(비선택 카드 편집 땐 안 띄움 — 오해 방지).
  const tagEditing =
    editTarget?.field === "tag" && editTarget.id != null &&
    selectedIds.has(editTarget.id) && selectedIds.size > 1;

  // 카드에 넘기는 콜백을 '안정 참조'로 — App(갓-컴포넌트)이 매 렌더 새 콜백을 줘도, 카드가 받는
  // 콜백 prop 의 identity 는 고정돼 React.memo(GenerationCard)가 불필요한 재렌더를 건너뛴다.
  // 항상 최신 props 콜백을 ref 경유로 호출하므로 stale 클로저는 없다(선택/포커스/편집 시 전체
  // 카드 재렌더 → 변경된 카드만 재렌더로 축소).
  const propsRef = useRef(props);
  propsRef.current = props;
  const cb = useMemo(
    () => ({
      onToggleSelect: (id: string) => {
        if (resolveScrollGuardRef.current) setResolveScrollRelease((version) => version + 1);
        resolveScrollGuardRef.current = false;
        propsRef.current.onClearResolveHighlight?.();
        propsRef.current.onToggleSelect(id);
      },
      onSetSource: (g: Generation, n: string | null, s: boolean) =>
        propsRef.current.onSetSource(g, n, s),
      onSetTags: (g: Generation, tg: string[]) => propsRef.current.onSetTags(g, tg),
      onBulkAddTags: (g: Generation, names: string[]) =>
        propsRef.current.onBulkAddTags?.(g, names),
      onBulkRemoveTags: (g: Generation, names: string[]) =>
        propsRef.current.onBulkRemoveTags?.(g, names),
      onSetAutoTags: (g: Generation, names: string[]) =>
        propsRef.current.onSetAutoTags?.(g, names),
      onBulkAddAutoTags: (g: Generation, names: string[]) =>
        propsRef.current.onBulkAddAutoTags?.(g, names),
      onBulkRemoveAutoTags: (g: Generation, names: string[]) =>
        propsRef.current.onBulkRemoveAutoTags?.(g, names),
      onWorkspaceCommand: (g: Generation, operation: WorkspaceCommandOperation, workspace: WorkspaceCommandTarget) =>
        propsRef.current.onWorkspaceCommand?.(g, operation, workspace) ?? Promise.resolve(false),
      onBulkGradeStep: (mode: GradeMode) => propsRef.current.onBulkGradeStep?.(mode),
      onOpenComments: (g: Generation) => propsRef.current.onOpenComments(g),
      onRegenerate: (g: Generation) => propsRef.current.onRegenerate(g),
      onPublish: (g: Generation) => propsRef.current.onPublish(g),
      onUnpublish: (g: Generation) => propsRef.current.onUnpublish(g),
      onFinalize: (g: Generation) => propsRef.current.onFinalize(g),
      onUnfinalize: (g: Generation) => propsRef.current.onUnfinalize(g),
      onReview: (g: Generation, action: ReviewAction) => propsRef.current.onReview?.(g, action),
      onBulkReview: (action: ReviewAction) => propsRef.current.onBulkReview?.(action),
      onImport: (g: Generation) => propsRef.current.onImport(g),
      onRestore: (g: Generation) => propsRef.current.onRestore(g),
      onInfo: (target: InfoTarget) => propsRef.current.onInfo(target),
      onPreview: (target: PreviewTarget) => propsRef.current.onPreview(target),
      onShowHistory: (g: Generation) => propsRef.current.onShowHistory?.(g),
      onOpenFolder: (g: Generation) => propsRef.current.onOpenFolder?.(g),
      canFinalize: (g: Generation) => propsRef.current.canFinalize?.(g) ?? true,
    }),
    [],
  );
  const renderDateHeader = (dayKey: string, label: string) => {
    const ids = rowModel.dateGroups?.get(dayKey)?.ids ?? [];
    const allSel = ids.length > 0 && ids.every((id) => selectedIds.has(id));
    return (
      <label className="gen-date-header" key={"h-" + dayKey}>
        <input
          type="checkbox"
          checked={allSel}
          onChange={() => toggleDate(ids, allSel)}
        />
        <span className="gen-date-label">{label}</span>
        <span className="gen-date-count">{ids.length}</span>
      </label>
    );
  };
  const renderGenerationCard = (generation: Generation, cardLayout: "grid" | "list") => (
    <GenerationCard
      gen={generation}
      lastViewed={(props.lastViewedId !== undefined ? props.lastViewedId : genViews.card[""]) === generation.id}
      tab={props.tab}
      fresh={props.tab === "team" && isFreshGen(generation)}
      stateGlow={stateGlowOf(generation) !== null}
      myCreatorUid={props.myCreatorUid}
      layout={cardLayout}
      thumbSize={thumbSize}
      fill={props.fill}
      dimDeleted={props.dimDeleted}
      selected={selectedIds.has(generation.id)}
      resolveHighlighted={props.resolveHighlightedIds?.has(generation.id)}
      editingField={editTarget?.id === generation.id ? editTarget.field : null}
      onRequestEdit={requestEdit}
      onEditDone={editDone}
      onToggleSelect={cb.onToggleSelect}
      onSetSource={cb.onSetSource}
      onSetTags={cb.onSetTags}
      onBulkAddTags={cb.onBulkAddTags}
      onBulkRemoveTags={cb.onBulkRemoveTags}
      selectedCount={selectedIds.has(generation.id) && selectedIds.size > 1 ? selectedIds.size : 1}
      onBulkGradeStep={cb.onBulkGradeStep}
      autoTagOptions={props.autoTagOptions}
      onSetAutoTags={cb.onSetAutoTags}
      onBulkAddAutoTags={cb.onBulkAddAutoTags}
      onBulkRemoveAutoTags={cb.onBulkRemoveAutoTags}
      onWorkspaceCommand={cb.onWorkspaceCommand}
      tagEditing={tagEditing}
      tagGlobalMode={tagGlobalMode}
      onGlobalModeChange={setTagGlobalMode}
      onOpenComments={cb.onOpenComments}
      onRegenerate={cb.onRegenerate}
      onPublish={cb.onPublish}
      onUnpublish={cb.onUnpublish}
      onFinalize={cb.onFinalize}
      onUnfinalize={cb.onUnfinalize}
      onReview={props.onReview ? cb.onReview : undefined}
      onBulkReview={props.onBulkReview ? cb.onBulkReview : undefined}
      bulkReviewAllowed={props.bulkReviewAllowed}
      canFinalize={cb.canFinalize}
      onImport={cb.onImport}
      onRestore={cb.onRestore}
      onInfo={cb.onInfo}
      onPreview={cb.onPreview}
      onShowHistory={props.onShowHistory ? cb.onShowHistory : undefined}
      onOpenFolder={props.onOpenFolder ? cb.onOpenFolder : undefined}
      openedHere={generation.id === props.openedFromId}
      mark={props.cardMarks?.[generation.id]}
      wheelMenu={!!props.onCardMenu}
      showFolder={props.showFolder}
      dimmed={props.dimIds?.has(generation.id)}
    />
  );
  const dragRef = useRef<{
    x: number; y: number; base: Set<string>; additive: boolean; range: boolean;
    anchor: string | null; moved: boolean; cellId: string | null;
  } | null>(null);

  // 대상이 실제로 목록에서 빠진 경우만 포커스를 해제한다.
  useEffect(() => {
    if (focusIdx < 0) setFocusedGenerationId(null);
  }, [focusIdx]);

  // 필터/정렬이 바뀌면(resetKey) 목록이 통째로 달라진다 — 인덱스 기반 포커스와 스크롤 위치를 처음으로
  //  되돌린다(옛 위치는 다른 항목을 가리킴). 첫 마운트는 건너뛴다(불필요한 스크롤 리셋 방지).
  const resetKeyFirstRef = useRef(true);
  useEffect(() => {
    if (resetKeyFirstRef.current) {
      resetKeyFirstRef.current = false;
      return;
    }
    setFocusedGenerationId(null);
    lastSpotRef.current = null;
    gridRef.current?.scrollTo({ top: 0 });
  }, [props.resetKey]);

  // resetKey의 맨 위 이동·열 수 측정 다음 프레임에 대상 행으로 한 번만 이동한다.
  // 아직 대상이 없으면 행 모델 갱신을 기다린다(과거 페이지를 전부 읽지 않는다).
  useEffect(() => {
    const target = props.resolveScrollRequest;
    if (!target || resolveScrollKey === handledResolveScrollRef.current) return;
    const generationIndex = generations.findIndex((g) => g.id === target.generationId);
    const navRow = generationIndex < 0 ? undefined : rowModel.posByGen[generationIndex]?.navRow;
    if (navRow === undefined) return;
    const rowIndex = rowModel.rowIndexOfNavRow[navRow];
    const frame = requestAnimationFrame(() => {
      if (!vRef.current) return;
      resolveScrollGuardRef.current = true;
      vRef.current.scrollToIndex(rowIndex, { align: "nearest" });
      handledResolveScrollRef.current = resolveScrollKey;
      if (target.focus) setFocusedGenerationId(target.generationId);
    });
    return () => cancelAnimationFrame(frame);
  }, [generations, rowModel, resolveScrollKey, props.resolveScrollRequest]);

  // 최신 props 를 ref 로 — 드래그 콜백을 안정 참조로 유지(stale 방지).
  const opsRef = useRef({ generations, onSelectedChange, onPreview: props.onPreview });
  opsRef.current = { generations, onSelectedChange, onPreview: props.onPreview };
  // 드래그 시작 시점의 선택·앵커도 ref 로 — 창 전역 리스너에서 낡은 값을 잡지 않게.
  const startRef = useRef({ selectedIds, focusedGenerationId });
  startRef.current = { selectedIds, focusedGenerationId };

  // 마퀴 히트 계산을 프레임당 1회로 코얼레스(러버밴드 드래그의 mousemove 폭주 → 셀 전체
  // querySelectorAll+getBoundingClientRect 반복을 프레임당 한 번으로).
  const marqueeRafRef = useRef<number | null>(null);
  const lastMoveRef = useRef<MouseEvent | null>(null);
  const flushMarquee = useCallback(() => {
    marqueeRafRef.current = null;
    const e = lastMoveRef.current;
    const d = dragRef.current;
    const grid = gridRef.current;
    if (!e || !d || d.cellId || !grid) return;
    const { rect, b } = computeMarquee(grid, d, e);
    setMarquee(rect);
    const base = d.additive || d.range ? d.base : [];
    opsRef.current.onSelectedChange(
      marqueeHits<string>(grid, ".gen-cell", b, base, (el) => el.dataset.id || null),
    );
  }, []);

  const onDragMove = useCallback(
    (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
      d.moved = true;
      // 카드 위에서 시작한 드래그는 마퀴 안 만듦(클릭선택 판정 또는 카드 네이티브 드래그=프롬프트 재사용).
      if (d.cellId) return;
      lastMoveRef.current = e;
      if (marqueeRafRef.current == null) marqueeRafRef.current = requestAnimationFrame(flushMarquee);
    },
    [flushMarquee],
  );

  const onDragUp = useCallback((e?: Event) => {
    // 놓친 끌기(창을 떠남·단추를 뗀 채 온 움직임 — lib/windowDrag) — 버린다(Alt+Tab 뒤 돌아온 움직임·클릭이 선택으로 이어지지 않게)
    const left = dragLost(e);
    if (marqueeRafRef.current != null) {
      cancelAnimationFrame(marqueeRafRef.current);
      marqueeRafRef.current = null;
      // 놓는 순간까지의 마지막 움직임을 버리지 않는다 — 빠르게 끌고 놓으면 마지막에 걸친 카드가 빠졌다(컷 카드 격자와 같은 처리).
      if (!left) flushMarquee();
    }
    const d = dragRef.current;
    dragRef.current = null;
    removeWindowMouseDrag(onDragMove, onDragUp);
    setMarquee(null);
    // 마퀴로 고른 뒤에는 초점 카드를 비운다 — 먼저 누른 카드가 남아 있으면 방향키·Shift 클릭이 (고르지도 않은) 그 카드에서 출발했다
    //  (최종 재실측). 비우면 '고른 것 중 마지막 카드'가 기준이 된다.
    if (d && d.moved && !d.cellId && !left) setFocusedGenerationId(null);
    if (!d || d.moved || left) return;
    // 드래그 없이 클릭만 → 선택 처리(+ 방향키 앵커 갱신)
    if (d.cellId) {
      const gens = opsRef.current.generations;
      const clickedIdx = gens.findIndex((g) => g.id === d.cellId);
      const anchorIdx = gens.findIndex((g) => g.id === d.anchor);
      if (d.range && anchorIdx >= 0 && clickedIdx >= 0) {
        // Shift-클릭 = 앵커~클릭 사이 전부 선택(앵커는 유지 → 연속 Shift-클릭으로 범위 조정).
        const lo = Math.min(anchorIdx, clickedIdx), hi = Math.max(anchorIdx, clickedIdx);
        const range = new Set(gens.slice(lo, hi + 1).map((g) => g.id));
        opsRef.current.onSelectedChange(range);
        rangeAnchorRef.current = { anchor: gens[anchorIdx].id, ids: range }; // 위 호출이 지운 뒤에 적는다 — 다음 Shift 클릭의 기준
      } else if (d.additive) {
        setFocusedGenerationId(d.cellId);
        const n = new Set(d.base);
        if (n.has(d.cellId)) n.delete(d.cellId);
        else n.add(d.cellId);
        keepFocusRef.current = n.size === 0;
        opsRef.current.onSelectedChange(n);
      } else {
        setFocusedGenerationId(d.cellId);
        opsRef.current.onSelectedChange(new Set([d.cellId]));
      }
    } else if (!d.additive && !d.range) {
      setFocusedGenerationId(null);
      opsRef.current.onSelectedChange(new Set());
    }
  }, [onDragMove, flushMarquee]);
  // 언마운트(폴더 창·결과 창이 닫히며 격자가 사라짐) — 누르고 있던 선택 끌기를 버린다. 안 버리면 window 에 남은 리스너가
  //  나중의 mouseup 에서 **사라진 격자의 옛 콜백**으로 선택을 만든다. 폴더 창을 닫은 직후의 조작 잠금도 그 옛 콜백은
  //  모른다 — 카드를 누른 채 Esc 로 닫고 마우스를 떼면 낡은 사본에 선택이 생겼다(Codex 코드 리뷰 2026-10-07).
  useEffect(() => () => {
    dragRef.current = null;
    removeWindowMouseDrag(onDragMove, onDragUp);
    if (marqueeRafRef.current != null) cancelAnimationFrame(marqueeRafRef.current);
  }, [onDragMove, onDragUp]);

  // 그리드 포커스 시에만 발동(프롬프트 입력 중엔 프롬프트가 ↑↓로 기록 탐색 — 포커스로 분리).
  // 고른 것 중 목록의 마지막 카드 — 초점 카드가 없을 때(마퀴·체크박스로만 골랐다) 방향키·Shift 클릭의 기준.
  const lastSelectedId = (gens: Generation[], ids: ReadonlySet<string>): string | null => {
    for (let i = gens.length - 1; i >= 0; i--) if (ids.has(gens[i].id)) return gens[i].id;
    return null;
  };
  // 격자의 키 — 격자에 초점이 있을 때(onKeyDown)와 초점 잃은 키(useLooseKeys)가 같이 쓴다. 그래서 React 이벤트가 아니라 원래 이벤트를 받는다.
  const onGridKey = (e: KeyboardEvent) => {
    // 카드 인라인 입력 중엔 무시(타이핑이 그리드 네비/단축키로 새지 않게). 체크박스 같은 글자 없는 입력은 격자 키를 그대로 받는다.
    if (isTypingTarget(e.target)) return;
    // 위에 창·메뉴가 떠 있으면 키는 그쪽 것이다(lib/keyGate) — 초점이 격자에 남아 있어도 쉰다. 방향키·Space·Page 의 기본 동작(뒤 격자
    //  스크롤)도 막는다 — 창 위에서 누른 키에 뒤 목록이 밀리지 않게.
    // 카드 안 조작 요소에 초점이 있을 때의 Enter/Space 는 그것을 누르는 키다(lib/keyGate activationKeyOwned — 입력은 언제나, 단추는 Tab 으로 온 초점만).
    const ownKey = activationKeyOwned(e);
    if (backgroundKeysBlocked()) {
      // 위에 뜬 것(카드의 확인 덮개 포함) 안의 단추를 누르는 키는 막지 않는다.
      if (!ownKey && /^(Arrow|Page|Home|End| )/.test(e.key)) e.preventDefault();
      return;
    }
    if (ownKey) return;
    if (e.altKey && e.key.startsWith("Arrow")) return; // Alt+←/→ 는 브라우저의 뒤로/앞으로
    if (/^(Arrow|Page|Home|End| )/.test(e.key)) releaseResolveScrollGuard();
    if (!generations.length) return;
    // 태그(#)·코멘트(c) — 포커스 카드에서 인라인 편집·코멘트(에셋 파트와 동일). 단축키 레지스트리로
    // 매칭(사용자 변경 가능). s 는 생성탭에선 비활성(공유는 카드 S 클릭/오버레이/선택바로만).
    const fgen = generations[focusIdx];
    // 태그(#): 포커스 카드 우선, 없으면 첫 선택 카드로 폴백(에셋과 동일) — 선택만 하고
    // 포커스가 없을 때(범위선택·체크박스 등)도 태그 입력이 열리게 한다.
    if (matchShortcut(e, "tag")) {
      const tagTarget = fgen || generations.find((g) => selectedIds.has(g.id));
      if (tagTarget) {
        e.preventDefault();
        setEditTarget({ id: tagTarget.id, field: "tag" });
        return;
      }
    }
    if (fgen && matchShortcut(e, "comment")) {
      e.preventDefault();
      props.onOpenComments(fgen);
      return;
    }
    if (fgen && matchShortcut(e, "showHistory")) {
      e.preventDefault();
      // 그 카드의 히스토리(가계) 패널 열기. 길게 눌린 반복은 받지 않는다 — 응답이 늦는 동안 요청이 반복마다 나가고,
      //  응답마다 가계 씬 탭이 하나씩 새로 생겼다(조작 규칙 38).
      if (!e.repeat) props.onShowHistory?.(fgen);
      return;
    }
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      // 기준 카드 = 초점 카드, 없으면 고른 것 중 목록의 마지막 카드, 그것도 없을 때만 첫 카드. 2026-10-10 실측: 마퀴로 고른 뒤
      //  방향키를 누르면 맨 첫 카드로 튀고(스크롤 맨 위) Shift+↓ 는 안 보이는 첫 카드를 더했다.
      const anchorId = focusIdx >= 0 ? null : lastSelectedId(generations, selectedIds) ?? lastSpotRef.current;
      const base = focusIdx >= 0 ? focusIdx : anchorId ? generations.findIndex((g) => g.id === anchorId) : -1;
      const cur = base < 0 ? 0 : base;
      // 가상화: DOM 기하 대신 행렬 모델로 이웃 계산(오프스크린 셀도 정확).
      const nxt = base < 0 ? 0 : navigateGrid(rowModel, cur, e.key);
      if (nxt == null) return;
      const nxtId = generations[nxt]?.id;
      setFocusedGenerationId(nxtId || null);
      if (e.shiftKey) {
        const n = new Set(selectedIds);
        const curId = generations[cur]?.id;
        if (curId) n.add(curId);
        if (nxtId) n.add(nxtId);
        onSelectedChange(n);
      } else if (nxtId) {
        onSelectedChange(new Set([nxtId]));
      }
      // 타깃 행으로 스크롤(언마운트 상태여도 virtua 가 마운트하며 이동).
      const navRow = rowModel.posByGen[nxt]?.navRow;
      if (navRow != null) {
        vRef.current?.scrollToIndex(rowModel.rowIndexOfNavRow[navRow], { align: "nearest" });
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.repeat) return; // 길게 눌린 Enter(확인 창을 Enter 로 닫으며 조금 길게 누른 것 등)에 크게 보기가 열리지 않게
      const g = generations[focusIdx];
      const a = g?.assets?.[0];
      if (g && a) onPreviewCell(g);
    } else if (e.key === " ") {
      e.preventDefault();
      if (e.repeat) return; // 길게 눌린 Space — 고르기는 토글이라 반복마다 뒤집힌다(조작 규칙 38)
      const id = focusIdx >= 0 ? generations[focusIdx]?.id : undefined;
      if (id) {
        const n = new Set(selectedIds);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        keepFocusRef.current = n.size === 0; // Space 로 마지막 카드를 뺐다 — 초점 카드는 그대로(한 번 더 누르면 다시 고른다)
        onSelectedChange(n);
      }
    } else if (matchShortcut(e, "selectAll")) {
      e.preventDefault();
      onSelectedChange(new Set(generations.map((g) => g.id)));
    } else if (e.key === "Escape") {
      // 위에 떠 있던 창이 이미 쓴 Esc 면 손대지 않는다 — 그 Esc 로 창이 닫히며 게이트는 이미 풀려 있다(Codex 코드 리뷰: 비교 창을
      //  닫은 Esc 가 초점이 남은 격자에 닿아 선택까지 지웠다).
      if (isKeyHandled(e)) return;
      // 선택을 푼 Esc 는 '쓴 것'으로 표시한다 — 같은 키로 뒤의 창까지 닫히지 않게(씬 단축키가 이 표시를 본다, lib/keyHandled).
      if (selectedIds.size > 0) markKeyHandled(e);
      setFocusedGenerationId(null);
      onSelectedChange(new Set());
    }
  };
  useLooseKeys(gridRef, onGridKey); // 초점 잃은 키(BODY·막 연 폴더 창·툴바 단추)도 이 격자가 받는다 — lib/keyGate

  const onPreviewCell = (g: Generation) => {
    const target = previewTargetFromGenerations(generations, g, thumbSize);
    // Share & Review 는 자기 칸(@team) — items 는 MediaPreview 에서 target 의 sceneId 를 물려받는다.
    if (target) props.onPreview(props.tab === "team" ? { ...target, sceneId: TEAM_SCOPE } : target);
  };

  // 드래그 시작(그리드 안·밖 공용). cellId 가 있으면 카드 위에서 시작한 것 = 마퀴 아님.
  const beginDrag = useCallback(
    (e: { clientX: number; clientY: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
     cellId: string | null) => {
      const { selectedIds: base, focusedGenerationId } = startRef.current;
      // Shift 범위의 기준 = 초점 카드, 없으면 앞선 Shift 클릭의 기준(그 뒤로 선택이 바뀌지 않았고 그 카드가 목록에 있을 때),
      //  그것도 없으면 고른 것 중 목록의 마지막 카드 — 마퀴로 고른 뒤의 Shift 클릭도 범위가 된다.
      const gens = opsRef.current.generations;
      const kept = rangeAnchorRef.current;
      const keptAnchor = kept && gens.some((g) => g.id === kept.anchor) ? kept.anchor : null;
      const anchorId = focusedGenerationId ?? keptAnchor ?? lastSelectedId(gens, base) ?? lastSpotRef.current;
      dragRef.current = {
        x: e.clientX,
        y: e.clientY,
        base: new Set(base),
        additive: e.ctrlKey || e.metaKey, // Ctrl/Cmd = 개별 토글
        range: e.shiftKey, // Shift = 앵커~클릭 범위 선택
        anchor: anchorId, // mousedown 이후 목록 순서가 바뀌어도 같은 카드로 범위를 잡는다.
        moved: false,
        cellId,
      };
      addWindowMouseDrag(onDragMove, onDragUp);
    },
    [onDragMove, onDragUp],
  );

  // 카드 영역 밖(상단바·툴바 줄·사이드바 여백)에서 시작한 드래그도 선택으로 잡는다.
  useOutsideDragSelect(".gen-grid", (e) => {
    if (!gridRef.current) return;
    e.preventDefault(); // 글자 선택·네이티브 드래그 방지
    gridRef.current.focus();
    beginDrag(e, null);
  }, !props.selectLocked);

  // 컷 줄의 [폴더로]·컷 띠를 두 번 누르면 둘째 누름이 들어온 이 목록의 같은 자리 카드에 닿는다(카드가 골라지고 크게 보기가 열리거나, 그 자리의
  //  S·T·C 단추가 눌린다) — 첫 누름 뒤로 자리가 바뀐 둘째 누름은 버린다(조작 규칙 61, lib/useStaleMultiClick). 자리의 열쇠가 없는 격자(캔버스의
  //  '생성 결과' 창)는 '이 격자가 첫 누름을 보지 못했다'만 본다. 뿌리의 잡는 단계에서 누름부터 삼킨다 — 카드의 '새 항목 확인'(누름의 잡는
  //  단계에서 저장한다)과 카드 끌기(프롬프트 재사용)가 그 누름으로 일어나지 않게.
  const multiClick = useStaleMultiClick(props.placeKey ?? "");
  // 우클릭 = 그 카드가 속한 폴더의 창 — 카드의 폴더 이름표를 누른 것과 같다(Jay 2026-10-13: 작업 공간에서도. 공유 탭의 컷 카드 우클릭과 같은
  //  뜻이다). 폴더가 없는 카드·폴더 창을 열 수 없는 격자(onOpenFolder 없음 — 폴더 창 안·휴지통·캔버스)에서는 아무 일도 없다(브라우저 메뉴 그대로).
  //  위에 뜬 메뉴를 닫는 우클릭은 열지 않는다 — contextmenu 는 단추를 뗀 뒤 오므로(윈도) 가림은 누름의 시작에 적어 둔다(FolderCardGrid 와 같은
  //  이유). 키보드의 메뉴 키(button 0)는 기록을 보지 않고 그 순간의 가림을 본다.
  const rightPressCoveredRef = useRef<boolean | null>(null);
  const onGridContextMenu = (e: React.MouseEvent) => {
    const open = props.onOpenFolder;
    if (!open || props.selectLocked) return;
    if ((e.target as HTMLElement).closest("input, textarea, a, [contenteditable]")) return; // 글 칸·링크 위는 브라우저 메뉴
    const cellEl = (e.target as HTMLElement).closest(".gen-cell") as HTMLElement | null;
    const g = cellEl && opsRef.current.generations.find((x) => x.id === cellEl.dataset.id);
    if (!g?.folder_path) return;
    e.preventDefault(); // 폴더에 속한 카드 위에서만 브라우저 메뉴를 막는다
    const covered = e.button === 2 ? (rightPressCoveredRef.current ?? backgroundKeysBlocked()) : backgroundKeysBlocked();
    rightPressCoveredRef.current = null;
    if (!covered) open(g);
  };
  const onGridMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault(); // 미들클릭 자동스크롤 방지(정보는 카드 auxclick 에서)
      return;
    }
    if (e.button === 2) {
      rightPressCoveredRef.current = pressStartedCovered(); // 고르기는 바꾸지 않는다
      return;
    }
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input, label")) return; // 오버레이 컨트롤 제외
    // 위에 메뉴·확인 덮개가 떠 있을 때의 누름은 그것을 닫는 누름이다 — 격자 안을 눌러 닫아도 선택을 바꾸지 않는다(격자 밖과 같은 규칙).
    if (pressStartedCovered()) return;
    gridRef.current?.focus(); // 그리드로 포커스 → 방향키 네비 활성(프롬프트와 분리)
    const cellEl = (e.target as HTMLElement).closest(".gen-cell") as HTMLElement | null;
    // 빈 곳에서 시작한 드래그 = 마퀴. 브라우저 기본 글자 선택을 막는다 — 안 막으면 포인터가
    // 툴바·상단바 위를 지날 때 그쪽 글자가 파랗게 긁히고 마퀴가 묻힌다(포커스는 위에서 직접 준다).
    if (!cellEl) e.preventDefault();
    beginDrag(e, cellEl?.dataset.id ?? null);
  };

  const onGridDblClick = (e: React.MouseEvent) => {
    // 버튼(S·T·C 등)·입력 위 더블클릭은 그 요소의 몫 — 클릭 2번이 미리보기로 승격되면 안 된다.
    if ((e.target as HTMLElement).closest("button, input, a, [contenteditable]")) return;
    const cellEl = (e.target as HTMLElement).closest(".gen-cell") as HTMLElement | null;
    if (!cellEl) return;
    const g = opsRef.current.generations.find((x) => x.id === cellEl.dataset.id);
    if (g) onPreviewCell(g);
  };

  // 카드 휠 클릭(onCardMenu 를 준 화면만 — 편집 탭이 연 폴더 창의 '넣을 트랙' 메뉴, Jay 2026-10-13: 그 전에는 우클릭이었다).
  //  잡는 단계에서 받아 전파를 막는다 — 안 막으면 카드의 휠 클릭(정보 창)이 같이 뜬다. 그 창에서 정보는 카드의 ⓘ 단추로 본다.
  //  글자를 넣는 칸 위는 건드리지 않는다(체크박스는 카드의 일부다 — 목록 보기의 선택 칸 위에서도 같은 메뉴, Codex 코드 리뷰).
  //  키보드의 메뉴 키(누름 없이 오는 contextmenu — button 이 2 가 아니다)는 전처럼 그 카드의 메뉴를 연다: 휠 클릭은 키보드로 할 수
  //  없다. 마우스 우클릭(button 2)은 건드리지 않는다 — 브라우저 메뉴 그대로.
  const onGridCardMenu = (e: React.MouseEvent) => {
    if (e.type === "auxclick" ? e.button !== 1 : e.button === 2) return;
    if ((e.target as HTMLElement).closest("textarea, [contenteditable], input:not([type=checkbox])")) return;
    const cellEl = (e.target as HTMLElement).closest(".gen-cell") as HTMLElement | null;
    const g = cellEl && opsRef.current.generations.find((x) => x.id === cellEl.dataset.id);
    if (!g) return;
    e.preventDefault();
    e.stopPropagation();
    props.onCardMenu?.(g, e.clientX, e.clientY);
  };

  // 카드 네이티브 드래그(프롬프트 재사용) 시작 → 진행 중이던 마퀴 추적 취소.
  const onGridDragStart = () => {
    dragRef.current = null;
    removeWindowMouseDrag(onDragMove, onDragUp);
    setMarquee(null);
  };

  if (generations.length === 0) {
    // 로드 실패는 "항목 없음"과 화면상 구분한다 — 안 하면 서버 순단 한 번에 사용자가
    // "내 생성물이 다 사라졌다"로 인지한다(토스트는 2.5초 뒤 사라져 증거가 안 남음).
    if (props.loadError) {
      return (
        <div className="grid-wrap">
          <div className="empty">
            <div>{t("목록을 불러오지 못했습니다.")}</div>
            <div style={{ opacity: 0.7, fontSize: "0.85em", margin: "6px 0" }}>{props.loadError}</div>
            {props.onRetryLoad && (
              <button className="settings-action" onClick={props.onRetryLoad}>
                ↻ {t("다시 시도")}
              </button>
            )}
          </div>
        </div>
      );
    }
    if (props.loading) {
      return (
        <div className="grid-wrap">
          <div className="empty" role="status">{t("불러오는 중…")}</div>
        </div>
      );
    }
    return (
      <div className="grid-wrap">
        <div className="empty">
          {props.hasMore ? (
            <>
              <div>{t("뒤쪽 페이지에 조건에 맞는 항목이 있을 수 있습니다.")}</div>
              <button className="settings-action" disabled={props.loadingMore} onClick={props.onLoadMore}>
                {props.loadingMore ? t("불러오는 중…") : t("더 보기")}
              </button>
            </>
          ) : <>{t("항목이 없습니다.")} <b>{t("+ 새 생성")}</b></>}
        </div>
      </div>
    );
  }

  const focusGenId = focusIdx >= 0 ? generations[focusIdx]?.id : undefined;
  // 편집(태그/소스) 중인 카드는 스크롤로 언마운트되면 입력 draft 가 사라짐 → 그 행은 항상 마운트 유지.
  const editingRow = (() => {
    if (!editTarget?.id) return undefined;
    const gi = generations.findIndex((g) => g.id === editTarget.id);
    const navRow = gi >= 0 ? rowModel.posByGen[gi]?.navRow : undefined;
    return navRow == null ? undefined : rowModel.rowIndexOfNavRow[navRow];
  })();
  const keepMounted = editingRow == null ? undefined : [editingRow];

  const renderVirtualRow = (row: VirtualRow) => {
    if (row.type === "header") return renderDateHeader(row.dayKey, row.label);
    return (
      <div
        key={row.key}
        className={isList ? "gen-vrow-list" : "gen-vrow-grid"}
        style={isList ? undefined : { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {row.items.map((g) => (
          <div
            className={
              "gen-cell" +
              (isList ? " list" : "") +
              (g.id === focusGenId ? " focused" : "") +
              (props.disabledIds?.has(g.id) ? " deactivated" : "") +
              (props.cellHeader ? " has-head" : "")
            }
            data-id={g.id}
            key={g.id}
            style={isList ? { height: Math.round(300 * scale) } : undefined}
          >
            {props.cellHeader && <div className="gen-cell-head">{props.cellHeader(g)}</div>}
            {renderGenerationCard(g, isList ? "list" : "grid")}
          </div>
        ))}
      </div>
    );
  };

  // 바닥 근처면 서버 다음 페이지 요청 — 가상화 후 sentinel 대신 스크롤 메트릭 기반.
  const onGridScroll = () => {
    const el = gridRef.current;
    if (!el || resolveScrollGuardRef.current || !props.hasMore || props.loadingMore) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 800) props.onLoadMore?.();
  };

  return (
    <div className="grid-wrap">
      <div
        ref={gridRef}
        className={
          "gen-grid gen-grid-virtual" +
          (props.fill ? "" : " fit-contain") +
          (isList ? " as-list" : "")
        }
        tabIndex={0}
        {...multiClick}
        onMouseDown={onGridMouseDown}
        onDoubleClick={onGridDblClick}
        onAuxClickCapture={props.onCardMenu ? onGridCardMenu : undefined}
        // onCardMenu 를 준 화면(편집 탭이 연 폴더 창)은 메뉴 키만 그 메뉴 · 그 밖은 우클릭 = 폴더 창. 두 속성은 겹치지 않는다(그 창에는 onOpenFolder 가 없다)
        onContextMenu={props.onCardMenu ? onGridCardMenu : onGridContextMenu}
        onDragStart={onGridDragStart}
        onKeyDown={(e) => onGridKey(e.nativeEvent)}
        onScroll={onGridScroll}
        onWheelCapture={releaseResolveScrollGuard}
        onTouchStartCapture={releaseResolveScrollGuard}
        onPointerDownCapture={releaseResolveScrollGuard}
      >
        <div className="gen-grid-head" />
        <Virtualizer
          ref={vRef}
          scrollRef={gridRef}
          data={rowModel.rows}
          bufferSize={400}
          startMargin={isList ? 10 : 14}
          keepMounted={keepMounted}
        >
          {(row: VirtualRow) => renderVirtualRow(row)}
        </Virtualizer>
        <div className="gen-grid-tail" />
        {props.loadingMore && <div className="grid-sentinel">더 불러오는 중…</div>}
        {marquee && (
          <div
            className="assets-marquee"
            style={{ left: marquee.l, top: marquee.t, width: marquee.w, height: marquee.h }}
          />
        )}
      </div>
    </div>
  );
}
