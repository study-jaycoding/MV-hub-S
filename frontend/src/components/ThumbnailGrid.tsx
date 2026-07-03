// 썸네일 그리드 (DESIGN.md §4). 에셋 파트(AssetsView)와 동일한 선택 시스템:
//  · 카드 클릭 = 단일 선택, Shift/Ctrl 클릭 = 추가/토글
//  · 빈 공간 드래그 = 마퀴(러버밴드) 다중 선택
//  · 더블클릭 = 미리보기. (카드 드래그는 프롬프트 재사용 — 마퀴 대신 네이티브 드래그)
// 선택 상태는 App 이 Set<string>(id) 로 보유 — 일괄 작업/select-bar 가 의존.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Virtualizer, type VirtualizerHandle } from "virtua";
import {
  buildGenerationDateGroups,
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
import { computeMarquee, marqueeHits } from "../lib/marquee";
import { matchShortcut } from "../lib/shortcuts";
import { addWindowMouseDrag, removeWindowMouseDrag } from "../lib/windowDrag";
import type { Generation, InfoTarget, PreviewTarget } from "../types";
import type { GradeMode } from "../lib/gradeStep";
import { GenerationCard } from "./GenerationCard";

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
  onBulkGradeStep?: (mode: GradeMode) => void; // 다중선택 시 S(단일/더블)를 선택 전체에 등급 규칙 적용
  onOpenComments: (g: Generation) => void; // C/c → 공유 코멘트 스레드 패널
  onRegenerate: (g: Generation) => void;
  onPublish: (g: Generation) => void;
  onUnpublish: (g: Generation) => void;
  onFinalize: (g: Generation) => void; // v02 CMS: Supervisor 최종(골드) 지정
  onUnfinalize: (g: Generation) => void; // 최종 해제
  canFinalize?: (g: Generation) => boolean; // 그 프로젝트 supervisor/PM 일 때만 최종 지정 가능(없으면 허용)
  onImport: (g: Generation) => void;
  onRestore: (g: Generation) => void; // 휴지통 복구
  dimDeleted: boolean; // 지운 카드 흐림 적용('함께 보기'만 true, '지운 것만'은 false)
  onColor: (g: Generation, color: string | null) => void;
  onTags: (g: Generation) => void;
  onInfo: (t: InfoTarget) => void;
  onPreview: (t: PreviewTarget) => void;
  onShowHistory?: (g: Generation) => void; // 히스토리 뱃지 → 가계 패널
  // 무한 스크롤 — 로드된 DOM 을 다 보여준 뒤 바닥에 닿으면 서버 다음 페이지 요청.
  hasMore?: boolean; // 서버에 더 받을 페이지가 있나
  loadingMore?: boolean;
  onLoadMore?: () => void;
  resetKey?: string; // 필터/정렬 변경 신호(genQuery 직렬화) — 바뀌면 점진 렌더(shown)를 초기화
}

export function ThumbnailGrid(props: Props) {
  const { generations, scale, layout, groupByDate, selectedIds, onSelectedChange } = props;
  const isList = layout === "list";
  const t = useT();

  // 날짜별 그룹(전체 기준) — 헤더 체크박스가 화면에 안 뜬 항목까지 포함해 그 날짜 전체를 선택.
  // groupByDate 꺼져 있으면 헤더가 없어 불필요 → 계산 생략.
  const dateGroups = useMemo(
    () => (groupByDate ? buildGenerationDateGroups(generations) : null),
    [generations, groupByDate],
  );

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

  // underfill 보정 — 첫 화면이 뷰포트를 못 채우면 스크롤바가 없어 onScroll 이 안 오고 다음 페이지를
  // 못 당긴다. 렌더 후 높이를 재보고 안 채워졌으면 서버 다음 페이지 요청.
  useEffect(() => {
    if (!props.hasMore || props.loadingMore) return;
    const el = gridRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      if (el.scrollHeight <= el.clientHeight + 40) props.onLoadMore?.();
    });
    return () => cancelAnimationFrame(id);
  }, [rowModel, props.hasMore, props.loadingMore, props.onLoadMore]);

  const [marquee, setMarquee] = useState<{ l: number; t: number; w: number; h: number } | null>(null);
  const [focusIdx, setFocusIdx] = useState(-1); // 방향키 네비 앵커(그리드 포커스 시)
  // 카드 인라인 편집(S 이름·# 태그) — 버튼/단축키 공통 진실원. 한 번에 한 카드.
  // (C 코멘트는 인라인이 아니라 공유 스레드 패널 → onOpenComments)
  const [editTarget, setEditTarget] = useState<{ id: string; field: "source" | "tag" } | null>(null);
  const requestEdit = useCallback(
    (g: Generation, field: "source" | "tag") => setEditTarget({ id: g.id, field }),
    [],
  );
  const editDone = useCallback(() => setEditTarget(null), []);
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
      onToggleSelect: (id: string) => propsRef.current.onToggleSelect(id),
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
      onBulkGradeStep: (mode: GradeMode) => propsRef.current.onBulkGradeStep?.(mode),
      onOpenComments: (g: Generation) => propsRef.current.onOpenComments(g),
      onRegenerate: (g: Generation) => propsRef.current.onRegenerate(g),
      onPublish: (g: Generation) => propsRef.current.onPublish(g),
      onUnpublish: (g: Generation) => propsRef.current.onUnpublish(g),
      onFinalize: (g: Generation) => propsRef.current.onFinalize(g),
      onUnfinalize: (g: Generation) => propsRef.current.onUnfinalize(g),
      onImport: (g: Generation) => propsRef.current.onImport(g),
      onRestore: (g: Generation) => propsRef.current.onRestore(g),
      onColor: (g: Generation, c: string | null) => propsRef.current.onColor(g, c),
      onTags: (g: Generation) => propsRef.current.onTags(g),
      onInfo: (target: InfoTarget) => propsRef.current.onInfo(target),
      onPreview: (target: PreviewTarget) => propsRef.current.onPreview(target),
      onShowHistory: (g: Generation) => propsRef.current.onShowHistory?.(g),
      canFinalize: (g: Generation) => propsRef.current.canFinalize?.(g) ?? true,
    }),
    [],
  );
  const renderDateHeader = (dayKey: string, label: string) => {
    const ids = dateGroups?.get(dayKey)?.ids ?? [];
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
      tab={props.tab}
      myCreatorUid={props.myCreatorUid}
      layout={cardLayout}
      fill={props.fill}
      dimDeleted={props.dimDeleted}
      selected={selectedIds.has(generation.id)}
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
      tagEditing={tagEditing}
      tagGlobalMode={tagGlobalMode}
      onGlobalModeChange={setTagGlobalMode}
      onOpenComments={cb.onOpenComments}
      onRegenerate={cb.onRegenerate}
      onPublish={cb.onPublish}
      onUnpublish={cb.onUnpublish}
      onFinalize={cb.onFinalize}
      onUnfinalize={cb.onUnfinalize}
      canFinalize={cb.canFinalize}
      onImport={cb.onImport}
      onRestore={cb.onRestore}
      onColor={cb.onColor}
      onTags={cb.onTags}
      onInfo={cb.onInfo}
      onPreview={cb.onPreview}
      onShowHistory={props.onShowHistory ? cb.onShowHistory : undefined}
    />
  );
  const dragRef = useRef<{
    x: number; y: number; base: Set<string>; additive: boolean; range: boolean;
    anchor: number; moved: boolean; cellId: string | null;
  } | null>(null);

  // 목록 길이가 줄면 포커스 인덱스를 범위 내로 클램프(매 렌더 리셋 방지 — 길이 변할 때만).
  useEffect(() => {
    setFocusIdx((f) => (f >= generations.length ? -1 : f));
  }, [generations.length]);

  // 최신 props 를 ref 로 — 드래그 콜백을 안정 참조로 유지(stale 방지).
  const opsRef = useRef({ generations, onSelectedChange, onPreview: props.onPreview });
  opsRef.current = { generations, onSelectedChange, onPreview: props.onPreview };

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

  const onDragUp = useCallback(() => {
    if (marqueeRafRef.current != null) {
      cancelAnimationFrame(marqueeRafRef.current);
      marqueeRafRef.current = null;
    }
    const d = dragRef.current;
    dragRef.current = null;
    removeWindowMouseDrag(onDragMove, onDragUp);
    setMarquee(null);
    if (!d || d.moved) return;
    // 드래그 없이 클릭만 → 선택 처리(+ 방향키 앵커 갱신)
    if (d.cellId) {
      const gens = opsRef.current.generations;
      const clickedIdx = gens.findIndex((g) => g.id === d.cellId);
      if (d.range && d.anchor >= 0 && clickedIdx >= 0) {
        // Shift-클릭 = 앵커~클릭 사이 전부 선택(앵커는 유지 → 연속 Shift-클릭으로 범위 조정).
        const lo = Math.min(d.anchor, clickedIdx), hi = Math.max(d.anchor, clickedIdx);
        opsRef.current.onSelectedChange(new Set(gens.slice(lo, hi + 1).map((g) => g.id)));
      } else if (d.additive) {
        setFocusIdx(clickedIdx);
        const n = new Set(d.base);
        if (n.has(d.cellId)) n.delete(d.cellId);
        else n.add(d.cellId);
        opsRef.current.onSelectedChange(n);
      } else {
        setFocusIdx(clickedIdx);
        opsRef.current.onSelectedChange(new Set([d.cellId]));
      }
    } else if (!d.additive && !d.range) {
      setFocusIdx(-1);
      opsRef.current.onSelectedChange(new Set());
    }
  }, [onDragMove]);

  // 그리드 포커스 시에만 발동(프롬프트 입력 중엔 프롬프트가 ↑↓로 기록 탐색 — 포커스로 분리).
  const onGridKeyDown = (e: React.KeyboardEvent) => {
    // 카드 인라인 입력 중엔 무시(타이핑이 그리드 네비/단축키로 새지 않게).
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    if (!generations.length) return;
    // 태그(#)·코멘트(c) — 포커스 카드에서 인라인 편집·코멘트(에셋 파트와 동일). 단축키 레지스트리로
    // 매칭(사용자 변경 가능). s 는 생성탭에선 비활성(공유는 카드 S 클릭/오버레이/선택바로만).
    const fgen = generations[focusIdx];
    if (fgen && matchShortcut(e, "tag")) {
      e.preventDefault();
      setEditTarget({ id: fgen.id, field: "tag" });
      return;
    }
    if (fgen && matchShortcut(e, "comment")) {
      e.preventDefault();
      props.onOpenComments(fgen);
      return;
    }
    if (fgen && matchShortcut(e, "showHistory")) {
      e.preventDefault();
      props.onShowHistory?.(fgen); // 그 카드의 히스토리(가계) 패널 열기
      return;
    }
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const cur = focusIdx < 0 ? 0 : focusIdx;
      // 가상화: DOM 기하 대신 행렬 모델로 이웃 계산(오프스크린 셀도 정확).
      const nxt = focusIdx < 0 ? 0 : navigateGrid(rowModel, cur, e.key);
      if (nxt == null) return;
      setFocusIdx(nxt);
      const nxtId = generations[nxt]?.id;
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
      const g = generations[focusIdx];
      const a = g?.assets[0];
      if (g && a) onPreviewCell(g);
    } else if (e.key === " ") {
      e.preventDefault();
      const id = focusIdx >= 0 ? generations[focusIdx]?.id : undefined;
      if (id) {
        const n = new Set(selectedIds);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        onSelectedChange(n);
      }
    } else if (matchShortcut(e, "selectAll")) {
      e.preventDefault();
      onSelectedChange(new Set(generations.map((g) => g.id)));
    } else if (e.key === "Escape") {
      setFocusIdx(-1);
      onSelectedChange(new Set());
    }
  };

  const onPreviewCell = (g: Generation) => {
    const target = previewTargetFromGenerations(generations, g);
    if (target) props.onPreview(target);
  };

  const onGridMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault(); // 미들클릭 자동스크롤 방지(정보는 카드 auxclick 에서)
      return;
    }
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input, label")) return; // 오버레이 컨트롤 제외
    gridRef.current?.focus(); // 그리드로 포커스 → 방향키 네비 활성(프롬프트와 분리)
    const cellEl = (e.target as HTMLElement).closest(".gen-cell") as HTMLElement | null;
    dragRef.current = {
      x: e.clientX,
      y: e.clientY,
      base: new Set(selectedIds),
      additive: e.ctrlKey || e.metaKey, // Ctrl/Cmd = 개별 토글
      range: e.shiftKey, // Shift = 앵커~클릭 범위 선택
      anchor: focusIdx, // mousedown 시점 앵커 캡처(stale 클로저 회피)
      moved: false,
      cellId: cellEl?.dataset.id ?? null,
    };
    addWindowMouseDrag(onDragMove, onDragUp);
  };

  const onGridDblClick = (e: React.MouseEvent) => {
    const cellEl = (e.target as HTMLElement).closest(".gen-cell") as HTMLElement | null;
    if (!cellEl) return;
    const g = opsRef.current.generations.find((x) => x.id === cellEl.dataset.id);
    if (g) onPreviewCell(g);
  };

  // 카드 네이티브 드래그(프롬프트 재사용) 시작 → 진행 중이던 마퀴 추적 취소.
  const onGridDragStart = () => {
    dragRef.current = null;
    removeWindowMouseDrag(onDragMove, onDragUp);
    setMarquee(null);
  };

  if (generations.length === 0) {
    return (
      <div className="grid-wrap">
        <div className="empty">
          {t("항목이 없습니다.")} <b>{t("+ 새 생성")}</b>
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
              (props.disabledIds?.has(g.id) ? " deactivated" : "")
            }
            data-id={g.id}
            key={g.id}
            style={isList ? { height: Math.round(300 * scale) } : undefined}
          >
            {renderGenerationCard(g, isList ? "list" : "grid")}
          </div>
        ))}
      </div>
    );
  };

  // 바닥 근처면 서버 다음 페이지 요청 — 가상화 후 sentinel 대신 스크롤 메트릭 기반.
  const onGridScroll = () => {
    const el = gridRef.current;
    if (!el || !props.hasMore || props.loadingMore) return;
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
        onMouseDown={onGridMouseDown}
        onDoubleClick={onGridDblClick}
        onDragStart={onGridDragStart}
        onKeyDown={onGridKeyDown}
        onScroll={onGridScroll}
      >
        <Virtualizer
          ref={vRef}
          scrollRef={gridRef}
          data={rowModel.rows}
          bufferSize={800}
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
