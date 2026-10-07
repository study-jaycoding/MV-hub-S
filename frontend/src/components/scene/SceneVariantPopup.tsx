// '생성 결과' 창 — 캔버스 카드에 쌓인 결과를 라이브러리와 같은 격자·툴바·선택 막대로 본다(Jay 2026-10-07: 폴더 창처럼).
//  데이터(씬의 genData)·선택·캔버스 고유 동작(대표 지정·비활성·다빈치 선택)은 SceneBoard 가 갖고, 여기는 라이브러리 부품을
//  조립만 한다. 창 껍데기는 '폴더 보기' 창의 모양을 쓰되 .folder-peek 클래스는 달지 않는다 — 그 클래스는 "이 안의 키는
//  라이브러리 몫"이라는 표시라(sceneKeyboard·useGenerationKeyboardActions), 달면 씬의 색·비활성 단축키가 이 창에서 죽는다.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { SceneCard } from "../../lib/scenes";
import { variantIds } from "../../lib/scenes";
import type { Generation, InfoTarget, PreviewTarget, Project } from "../../types";
import type { GradeMode } from "../../lib/gradeStep";
import type { WorkspaceCommandOperation, WorkspaceCommandTarget } from "../../lib/workspaceCommand";
import { DRAG_TYPES } from "../../lib/dragTypes";
import { ThumbnailGrid } from "../ThumbnailGrid";
import { BoardSelectionActionBar } from "../app/SelectionActionBar";

// Resolve 전송 컨트롤 묶음 — App 의 resolveTransfer 파이프라인을 SceneBoard 를 거쳐 그대로 전달.
export interface VariantResolveControls {
  send: (selected: Generation[]) => void;
  retry: (() => void) | null;
  retryProjectName: string;
  busy: boolean;
  pendingCount: number;
}

const noop = () => {};

export function SceneVariantPopup({
  card,
  total,
  generations,
  dimIds,
  sceneId,
  viewedGenId,
  disabledIds,
  projects,
  autoTagOptions,
  view,
  toolbar,
  ui,
  gen,
  actions,
}: {
  card: SceneCard; // 열린 카드
  total: number; // 이 카드의 결과 수(필터로 가려진 것 포함) — 제목
  generations: Generation[]; // 보이는 결과(최신순 · 툴바 필터 통과) — SceneBoard 가 고른다
  dimIds: ReadonlySet<string>; // 캔버스에서 고른 폴더 밖 — 흐리게
  sceneId: string; // '마지막으로 본' 표시를 남길 씬 — card_id 는 씬 간 유일하지 않다
  viewedGenId?: string | null; // 이 묶음에서 마지막으로 크게 열어본 결과
  disabledIds: Set<string>;
  projects: Project[];
  autoTagOptions: string[];
  view: { scale: number; layout: "grid" | "list"; groupByDate: boolean; fill: boolean }; // 라이브러리와 같은 보기 설정
  toolbar?: ReactNode; // 라이브러리 툴바(App 이 이 창의 건수로 만들어 준다)
  // 창의 선택 상태 — 소유는 SceneBoard(전역 단축키·다빈치 선택이 거기 있다), 여기는 읽기+setter 호출만.
  ui: {
    selectedIds: Set<string>;
    setSelected: (next: React.SetStateAction<Set<string>>) => void;
    resolveHighlightedIds: ReadonlySet<string>;
    scrollRequest: { generationId: string; nonce: number; focus?: boolean } | null;
    gripDragging: boolean;
    setGripDragging: (on: boolean) => void;
  };
  // 생성물 조작 — 씬의 사본(genData)을 같이 고치는 SceneBoard 의 어댑터들.
  gen: {
    canFinalize?: (g: Generation) => boolean;
    onInfo?: (t: InfoTarget) => void;
    onOpenComments?: (g: Generation) => void;
    onRegenerate?: (g: Generation) => void;
    onPreview?: (t: PreviewTarget) => void;
    onSetTags?: (g: Generation, next: string[]) => void;
    onSetAutoTags?: (g: Generation, next: string[]) => void;
    onWorkspaceCommand?: (
      g: Generation,
      operation: WorkspaceCommandOperation,
      workspace: WorkspaceCommandTarget,
    ) => Promise<boolean>; // ## 모드 #+/#- — 라이브러리 카드와 동일한 워크스페이스 변경
    onBulkTags: (focus: Generation, names: string[], field: "tags" | "auto_tags", mode: "add" | "remove") => void;
    onGradeStep?: (gens: Generation[], mode: GradeMode) => void;
    onPublish: (g: Generation) => void;
    onUnpublish: (g: Generation) => void;
    onFinalize: (g: Generation) => void;
    onUnfinalize: (g: Generation) => void;
  };
  actions: {
    setCardMenu: (id: string | null) => void;
    setCardVariant: (cardId: string, gid: string) => void;
    pruneVariants: (cardId: string, removed: Set<string>) => void;
    latestCard: (id: string) => SceneCard | undefined; // cardsRef 기준 최신(삭제 대기 중 append 대비)
    onVariantDelete?: (sel: Generation[]) => Promise<string[]>;
    onVariantShare?: (sel: Generation[]) => void;
    onVariantDownload?: (sel: Generation[]) => void;
    onVariantCompare?: (sel: Generation[]) => void;
    onVariantAssign?: (
      sel: Generation[],
      projectId: string | null,
      folderPath?: string | null,
    ) => void;
    // Resolve 전송(캔버스 선택바와 동일 파이프라인) — 있으면 창의 선택 막대에도 버튼 노출.
    variantResolve?: VariantResolveControls;
  };
}) {
  // 배경 클릭 닫기는 '배경에서 누르기 시작한' 경우만. 창 안에서 시작한 드래그(마퀴·카드 끌기)가
  // 창 밖에서 끝나면 브라우저가 공통 조상(배경)에 click 을 합성해 창이 닫히던 버그 방지.
  const backdropDownRef = useRef(false);
  const windowRef = useRef<HTMLElement>(null);
  // 창의 아래 끝은 하단 프롬프트 위에서 멈춘다. 프롬프트는 화면에 고정돼 이 막보다 위 층이고 높이가 바뀐다(참조 줄·오류 줄·접힘) —
  //  고정 여백으로는 창 바닥의 선택 막대가 프롬프트 뒤로 숨었다(2026-10-07 실측: 프롬프트 201px, 여백 128px → 73px 가림). 그래서 잰다.
  const backdropRef = useRef<HTMLDivElement>(null);
  const [dockGap, setDockGap] = useState<number | null>(null);
  useLayoutEffect(() => {
    const backdrop = backdropRef.current;
    const dock = document.querySelector(".sl-dock");
    if (!backdrop || !dock) return; // 프롬프트가 없는 화면 — CSS 의 기본 여백을 쓴다
    const measure = () =>
      setDockGap(Math.max(0, Math.round(backdrop.getBoundingClientRect().bottom - dock.getBoundingClientRect().top)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(dock);
    observer.observe(backdrop);
    return () => observer.disconnect();
  }, []);
  const close = () => actions.setCardMenu(null);
  // 열리면 초점을 격자로 — 방향키·Enter·태그 키가 바로 듣는다(격자가 비었으면 창으로).
  useEffect(() => {
    const element = windowRef.current;
    (element?.querySelector<HTMLElement>(".gen-grid") ?? element)?.focus();
  }, [card.id]);
  // 끌기가 dragend 없이 끝나도(브라우저가 취소) 백드롭이 클릭통과로 남지 않게 푼다 — 남으면 창을 누를 수 없다.
  const dragging = ui.gripDragging;
  const setDragging = ui.setGripDragging;
  useEffect(() => {
    if (!dragging) return;
    const reset = () => setDragging(false);
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
    window.addEventListener("mouseup", reset);
    return () => {
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset);
      window.removeEventListener("mouseup", reset);
    };
  }, [dragging, setDragging]);

  const selected = generations.filter((g) => ui.selectedIds.has(g.id));
  const closeAndTrash = async () => {
    const done = await actions.onVariantDelete?.(selected);
    if (done && done.length) {
      const removed = new Set(done);
      actions.pruneVariants(card.id, removed);
      ui.setSelected((prev) => new Set([...prev].filter((id) => !removed.has(id))));
      // 남은 결과 판정은 최신 카드 기준(삭제 대기 중 뒤에서 append 됐을 수 있어 렌더 스냅샷 대신).
      const latest = actions.latestCard(card.id) || card;
      if (variantIds(latest).filter((id) => !removed.has(id)).length === 0) close();
    }
  };
  // 대표 표시/지정 — 카드 '밖' 위(Jay). 대표면 표시, 아니면 지정 단추.
  const cellHeader = (g: Generation) =>
    g.id === card.genId ? (
      <span className="scene-varpop-cur">★ 대표</span>
    ) : g.assets?.[0] ? (
      <button
        type="button"
        className="scene-varpop-rep"
        title="이 결과를 카드 대표로 지정"
        // preventDefault = 버튼이 포커스를 받아 격자가 스크롤되는 것 차단.
        // mousedown 에서 바로 지정 → 빠르게 눌러도 확실히 선택(클릭 타이밍 의존 제거).
        onMouseDown={(e) => {
          e.preventDefault();
          actions.setCardVariant(card.id, g.id);
          // 캔버스는 안에서 난 mousedown 마다 초점을 보드로 가져간다(onBoardMouseDownCapture) — 격자로 돌려놓아야
          //  이어서 방향키·태그 키가 듣는다(2026-10-07 실측: 대표를 누른 뒤 초점이 .scene-board 에 남았다).
          windowRef.current?.querySelector<HTMLElement>(".gen-grid")?.focus({ preventScroll: true });
        }}
      >
        대표
      </button>
    ) : null;

  return (
    <div
      ref={backdropRef}
      className={"scene-varpop-backdrop" + (dragging ? " drag-through" : "")}
      style={dockGap == null ? undefined : ({ "--dock-gap": `${dockGap + 12}px` } as CSSProperties)}
      onMouseDown={(e) => {
        e.stopPropagation();
        backdropDownRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const armed = backdropDownRef.current;
        backdropDownRef.current = false;
        if (armed && e.target === e.currentTarget) close();
      }}
    >
      <section
        ref={windowRef}
        className="scene-varwin"
        role="dialog"
        aria-label="생성 결과"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        // 끌기 — 카드(라이브러리 부품)는 자기 id 하나만 싣는다. 잡은 카드가 고른 묶음 안이면 묶음 전체를 실어 사이드바 폴더에
        //  한 번에 담기게 한다. 캡처 단계에서 — 카드의 그립은 dragstart 전파를 멈춘다.
        onDragStartCapture={(e) => {
          const id = (e.target as HTMLElement).closest<HTMLElement>(".gen-cell")?.dataset.id;
          if (!id) return;
          const ids = ui.selectedIds.has(id) ? selected.map((g) => g.id) : [id];
          e.dataTransfer.setData(DRAG_TYPES.generationList, ids.join(","));
          setDragging(true); // 백드롭을 클릭통과로 — 창 밑에 깔린 것 위로도 끌고 갈 수 있다(창은 열린 채). 캔버스는 생성물 끌기를 받지 않는다
        }}
        onDragEndCapture={() => setDragging(false)}
      >
        <header className="folder-peek-hd">
          <span className="folder-peek-title">생성 결과 {total}개</span>
          {generations.length !== total && <span className="folder-peek-count">{generations.length}개 표시</span>}
          <button type="button" className="folder-peek-x" onClick={close} title="닫기 (Esc)">
            ✕
          </button>
        </header>
        {toolbar}
        {generations.length === 0 ? (
          // 격자의 빈 안내('+ 새 생성')는 목록의 말이다 — 여기서 비는 것은 툴바 필터에 다 가려졌을 때뿐이다.
          <div className="grid-wrap">
            <div className="empty">이 조건에 맞는 결과가 없습니다. 위 필터를 풀면 다시 보입니다.</div>
          </div>
        ) : (
        <ThumbnailGrid
          generations={generations}
          disabledIds={disabledIds}
          tab="my"
          scale={view.scale}
          fill={view.fill}
          layout={view.layout}
          groupByDate={view.groupByDate}
          selectedIds={ui.selectedIds}
          resolveHighlightedIds={ui.resolveHighlightedIds}
          resolveScrollRequest={ui.scrollRequest}
          onSelectedChange={ui.setSelected}
          onToggleSelect={(id) =>
            ui.setSelected((prev) => {
              const next = new Set(prev);
              if (!next.delete(id)) next.add(id);
              return next;
            })
          }
          cellHeader={cellHeader}
          lastViewedId={viewedGenId ?? null}
          dimIds={dimIds}
          showFolder
          onSetSource={noop}
          onSetTags={(g, tags) => gen.onSetTags?.(g, tags)}
          onBulkAddTags={(g, names) => gen.onBulkTags(g, names, "tags", "add")}
          onBulkRemoveTags={(g, names) => gen.onBulkTags(g, names, "tags", "remove")}
          autoTagOptions={autoTagOptions}
          onSetAutoTags={gen.onSetAutoTags}
          onBulkAddAutoTags={(g, names) => gen.onBulkTags(g, names, "auto_tags", "add")}
          onBulkRemoveAutoTags={(g, names) => gen.onBulkTags(g, names, "auto_tags", "remove")}
          onWorkspaceCommand={gen.onWorkspaceCommand}
          onBulkGradeStep={gen.onGradeStep ? (mode) => gen.onGradeStep?.(selected, mode) : undefined}
          onOpenComments={(g) => gen.onOpenComments?.(g)}
          onRegenerate={(g) => gen.onRegenerate?.(g)}
          onPublish={gen.onPublish}
          onUnpublish={gen.onUnpublish}
          onFinalize={gen.onFinalize}
          onUnfinalize={gen.onUnfinalize}
          canFinalize={gen.canFinalize}
          onImport={noop}
          onRestore={noop}
          dimDeleted={false}
          onInfo={(target) => gen.onInfo?.(target)}
          // '마지막으로 본'은 이 카드 묶음에 남긴다 — 목록(방향키 이동)의 항목은 대상의 씬·카드를 물려받는다(MediaPreview).
          onPreview={(target) => gen.onPreview?.({ ...target, sceneId, cardId: card.id })}
        />
        )}
        {selected.length > 0 && (
          <div className="folder-peek-selbar">
            <BoardSelectionActionBar
              selected={selected}
              projects={projects}
              onShare={(s) => actions.onVariantShare?.(s)}
              onDownload={(s) => actions.onVariantDownload?.(s)}
              onCompare={(s) => actions.onVariantCompare?.(s)}
              onAssign={(pid, folder) => actions.onVariantAssign?.(selected, pid, folder)}
              onDelete={() => void closeAndTrash()}
              onResolveTransfer={actions.variantResolve?.send}
              onResolveRetry={actions.variantResolve?.retry ?? null}
              resolveRetryProjectName={actions.variantResolve?.retryProjectName || ""}
              resolveTransferBusy={actions.variantResolve?.busy}
              resolveTransferPendingCount={actions.variantResolve?.pendingCount}
            />
          </div>
        )}
      </section>
    </div>
  );
}
