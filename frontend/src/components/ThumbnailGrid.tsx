// 썸네일 그리드 (DESIGN.md §4). 에셋 파트(AssetsView)와 동일한 선택 시스템:
//  · 카드 클릭 = 단일 선택, Shift/Ctrl 클릭 = 추가/토글
//  · 빈 공간 드래그 = 마퀴(러버밴드) 다중 선택
//  · 더블클릭 = 미리보기. (카드 드래그는 프롬프트 재사용 — 마퀴 대신 네이티브 드래그)
// 선택 상태는 App 이 Set<string>(id) 로 보유 — 일괄 작업/select-bar 가 의존.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import { computeMarquee, marqueeHits } from "../lib/marquee";
import { matchShortcut } from "../lib/shortcuts";
import type { Generation, InfoTarget, PreviewTarget } from "../types";
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

// created_at(UTC, "YYYY-MM-DD HH:MM:SS") → 로컬 날짜 그룹 키 + 표시 라벨("June 11, 2026").
function dayInfo(iso: string): { key: string; label: string } {
  const d = new Date(iso.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return { key: iso.slice(0, 10), label: iso.slice(0, 10) };
  const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const label = d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return { key, label };
}

export function ThumbnailGrid(props: Props) {
  const { generations, scale, layout, groupByDate, selectedIds, onSelectedChange } = props;
  const isList = layout === "list";
  const t = useT();

  // 날짜별 그룹(전체 기준) — 헤더 체크박스가 화면에 안 뜬 항목까지 포함해 그 날짜 전체를 선택.
  const dateGroups = useMemo(() => {
    const m = new Map<string, { label: string; ids: string[] }>();
    for (const g of generations) {
      const { key, label } = dayInfo(g.created_at);
      let e = m.get(key);
      if (!e) {
        e = { label, ids: [] };
        m.set(key, e);
      }
      e.ids.push(g.id);
    }
    return m;
  }, [generations]);

  // 날짜 헤더 체크박스 — 그 날짜의 모든 항목을 한 번에 선택/해제(토글).
  const toggleDate = (ids: string[], allSelected: boolean) => {
    const n = new Set(selectedIds);
    if (allSelected) ids.forEach((id) => n.delete(id));
    else ids.forEach((id) => n.add(id));
    onSelectedChange(n);
  };

  const gridRef = useRef<HTMLDivElement>(null);
  // 점진 렌더 — 로드된 데이터(generations)를 DOM 에는 보이는 만큼만. 바닥에서 더 보여줄 게
  // 없으면 서버 다음 페이지를 요청(onLoadMore) → 무한 스크롤이 클라이언트·서버 양쪽으로 작동.
  const PAGE = 60;
  const [shown, setShown] = useState(120);
  // 필터/정렬이 바뀌면(=새 첫 페이지로 교체) 점진 렌더를 초기값으로 되돌린다 — 스크롤로 커진 shown 이
  // 그대로면 새 목록 전체가 한꺼번에 마운트된다. 단순 prepend/append(목록 추가)는 resetKey 가 안 바뀌어
  // 영향 없다(스크롤 위치·노출량 보존).
  useEffect(() => {
    setShown(120);
  }, [props.resetKey]);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const moreToShow = shown < generations.length; // 로드된 것 중 아직 안 그린 게 있나
  const showSentinel = moreToShow || !!props.hasMore;
  // ref 로 최신 값을 봐서 IO 콜백을 안정 참조로 유지
  const loadMoreRef = useRef<() => void>(() => {});
  loadMoreRef.current = () => {
    if (shown < generations.length) {
      setShown((s) => Math.min(generations.length, s + PAGE)); // DOM 더 노출
    } else if (props.hasMore && !props.loadingMore) {
      props.onLoadMore?.(); // 서버 다음 페이지
    }
  };
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !showSentinel) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMoreRef.current();
      },
      { rootMargin: "800px" }, // 바닥 닿기 전에 미리 로드
    );
    io.observe(el);
    return () => io.disconnect();
  }, [showSentinel, shown, generations.length, props.hasMore, props.loadingMore]);
  const visible = generations.slice(0, shown);
  const hasMore = showSentinel; // 센티넬·진행표시 렌더 조건(아래에서 사용)

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

  const onDragMove = useCallback((e: MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
    d.moved = true;
    // 카드 위에서 시작한 드래그는 마퀴 안 만듦(클릭선택 판정 또는 카드 네이티브 드래그=프롬프트 재사용).
    if (d.cellId) return;
    const grid = gridRef.current;
    if (!grid) return;
    const { rect, b } = computeMarquee(grid, d, e);
    setMarquee(rect);
    const base = d.additive || d.range ? d.base : [];
    opsRef.current.onSelectedChange(
      marqueeHits<string>(grid, ".gen-cell", b, base, (el) => el.dataset.id || null),
    );
  }, []);

  const onDragUp = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", onDragUp);
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

  // 방향키 이웃 셀(레이아웃 무관, 화면 좌표 기반 최근접 — 에셋 파트와 동일).
  const neighbor = (cur: number, key: string): number | null => {
    const grid = gridRef.current;
    if (!grid) return null;
    const cells = Array.from(grid.querySelectorAll(".gen-cell")) as HTMLElement[];
    const curEl = cells.find((c) => Number(c.dataset.idx) === cur);
    if (!curEl) return cells.length ? Number(cells[0].dataset.idx) : null;
    const cr = curEl.getBoundingClientRect();
    const cx = (cr.left + cr.right) / 2, cy = (cr.top + cr.bottom) / 2;
    let best: number | null = null, bestScore = Infinity;
    for (const el of cells) {
      const idx = Number(el.dataset.idx);
      if (idx === cur) continue;
      const r = el.getBoundingClientRect();
      const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
      const dx = x - cx, dy = y - cy;
      let ok = false, primary = 0, secondary = 0;
      if (key === "ArrowRight") { ok = dx > 1; primary = dx; secondary = Math.abs(dy); }
      else if (key === "ArrowLeft") { ok = dx < -1; primary = -dx; secondary = Math.abs(dy); }
      else if (key === "ArrowDown") { ok = dy > 1; primary = dy; secondary = Math.abs(dx); }
      else if (key === "ArrowUp") { ok = dy < -1; primary = -dy; secondary = Math.abs(dx); }
      if (!ok) continue;
      const score = primary + secondary * 2;
      if (score < bestScore) { bestScore = score; best = idx; }
    }
    return best;
  };

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
      const nxt = focusIdx < 0 ? 0 : neighbor(cur, e.key);
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
      requestAnimationFrame(() =>
        gridRef.current
          ?.querySelector(`.gen-cell[data-idx="${nxt}"]`)
          ?.scrollIntoView({ block: "nearest" }),
      );
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
    const a = g.assets[0];
    if (!a) return;
    // 같은 그리드의 미디어 목록을 함께 넘겨 풀스크린에서 ←/→ 로 이전·다음 이동.
    const withAsset = generations.filter((x) => x.assets[0]);
    const items = withAsset.map((x) => ({
      url: x.assets[0].file_path,
      type: x.assets[0].type,
      name: x.prompt.slice(0, 50) || "(제목 없음)",
      genId: x.id,
    }));
    const index = withAsset.findIndex((x) => x.id === g.id);
    props.onPreview({
      url: a.file_path,
      type: a.type,
      name: g.prompt.slice(0, 50) || "(제목 없음)",
      genId: g.id,
      items,
      index,
    });
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
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragUp);
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
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", onDragUp);
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

  if (isList) {
    return (
      <div className="grid-wrap">
        <div className="gen-list">
          {(() => {
            // 그리드와 동일하게 날짜 구분 모드면 날짜가 바뀔 때 섹션 헤더를 끼워넣는다.
            const out: React.ReactNode[] = [];
            let lastDay: string | null = null;
            visible.forEach((g) => {
              if (groupByDate) {
                const { key, label } = dayInfo(g.created_at);
                if (key !== lastDay) {
                  lastDay = key;
                  const ids = dateGroups.get(key)?.ids ?? [];
                  const allSel = ids.length > 0 && ids.every((id) => selectedIds.has(id));
                  out.push(
                    <label className="gen-date-header" key={"h-" + key}>
                      <input
                        type="checkbox"
                        checked={allSel}
                        onChange={() => toggleDate(ids, allSel)}
                      />
                      <span className="gen-date-label">{label}</span>
                      <span className="gen-date-count">{ids.length}</span>
                    </label>,
                  );
                }
              }
              out.push(
                <div
                  className={"gen-cell list" + (props.disabledIds?.has(g.id) ? " deactivated" : "")}
                  data-id={g.id}
                  key={g.id}
                  style={{ height: Math.round(300 * scale) }}
                >
                  <GenerationCard
                    gen={g}
                    tab={props.tab}
                    myCreatorUid={props.myCreatorUid}
                    layout="list"
                    fill={props.fill}
                    dimDeleted={props.dimDeleted}
                    selected={selectedIds.has(g.id)}
                    editingField={editTarget?.id === g.id ? editTarget.field : null}
                    onRequestEdit={requestEdit}
                    onEditDone={editDone}
                    onToggleSelect={cb.onToggleSelect}
                    onSetSource={cb.onSetSource}
                    onSetTags={cb.onSetTags}
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
                </div>,
              );
            });
            return out;
          })()}
          {hasMore && (
            <div ref={sentinelRef} className="grid-sentinel">
              더 불러오는 중… ({visible.length}/{generations.length})
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="grid-wrap">
      <div
        ref={gridRef}
        className={"gen-grid" + (props.fill ? "" : " fit-contain")}
        tabIndex={0}
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${Math.round(180 * scale)}px, 1fr))` }}
        onMouseDown={onGridMouseDown}
        onDoubleClick={onGridDblClick}
        onDragStart={onGridDragStart}
        onKeyDown={onGridKeyDown}
      >
        {(() => {
          const out: React.ReactNode[] = [];
          let lastDay: string | null = null;
          visible.forEach((g, i) => {
            if (groupByDate) {
              const { key, label } = dayInfo(g.created_at);
              if (key !== lastDay) {
                lastDay = key;
                const grp = dateGroups.get(key);
                const ids = grp?.ids ?? [];
                const allSel = ids.length > 0 && ids.every((id) => selectedIds.has(id));
                out.push(
                  <label className="gen-date-header" key={"h-" + key}>
                    <input
                      type="checkbox"
                      checked={allSel}
                      onChange={() => toggleDate(ids, allSel)}
                    />
                    <span className="gen-date-label">{label}</span>
                    <span className="gen-date-count">{ids.length}</span>
                  </label>,
                );
              }
            }
            out.push(
              <div
                className={
                  "gen-cell" +
                  (i === focusIdx ? " focused" : "") +
                  (props.disabledIds?.has(g.id) ? " deactivated" : "")
                }
                data-id={g.id}
                data-idx={i}
                key={g.id}
              >
                <GenerationCard
                  gen={g}
                  tab={props.tab}
                  myCreatorUid={props.myCreatorUid}
                  layout="grid"
                  fill={props.fill}
                  dimDeleted={props.dimDeleted}
                  selected={selectedIds.has(g.id)}
                  editingField={editTarget?.id === g.id ? editTarget.field : null}
                  onRequestEdit={requestEdit}
                  onEditDone={editDone}
                  onToggleSelect={cb.onToggleSelect}
                  onSetSource={cb.onSetSource}
                  onSetTags={cb.onSetTags}
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
              </div>,
            );
          });
          return out;
        })()}
        {hasMore && (
          <div ref={sentinelRef} className="grid-sentinel">
            더 불러오는 중… ({visible.length}/{generations.length})
          </div>
        )}
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
