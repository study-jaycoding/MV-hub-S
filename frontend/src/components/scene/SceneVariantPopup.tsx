// 변형(생성 결과 모아보기) 팝업 — SceneBoard 렌더 분할(R2 후속, 추가 모듈화 '지금' 항목).
//  상태(선택·마퀴·태그편집 위치)와 키보드/마퀴 배선은 SceneBoard 가 소유하고, 여기는 표시+로컬 파생만.
//  refs(varGridRef·varpopWrapRef)는 부모 소유를 그대로 attach — 부모의 마퀴·태그위치 측정 effect 가 계속 동작.
import type React from "react";
import { useRef } from "react";
import type { MutableRefObject, RefObject } from "react";
import type { SceneCard } from "../../lib/scenes";
import { variantIds } from "../../lib/scenes";
import type { Generation, InfoTarget, PreviewItem, PreviewTarget, Project } from "../../types";
import { generationStatusLabelFor } from "../../lib/generationDisplay";
import { thumbOf } from "../../lib/media";
import { APP_EVENTS, dispatchAppEvent } from "../../lib/appEvents";
import { downloadName, downloadOne } from "../../lib/download";
import { DRAG_TYPES } from "../../lib/dragTypes";
import { MediaThumbnail } from "../MediaThumbnail";
import { TagEditor } from "../TagEditor";
import { GenerationConfirmOverlay } from "../generation/GenerationConfirmOverlay";
import { BoardSelectionActionBar } from "../app/SelectionActionBar";

// Resolve 전송 컨트롤 묶음 — App 의 resolveTransfer 파이프라인을 SceneBoard 를 거쳐 그대로 전달.
export interface VariantResolveControls {
  send: (selected: Generation[]) => void;
  retry: (() => void) | null;
  retryProjectName: string;
  busy: boolean;
  pendingCount: number;
}

export function SceneVariantPopup({
  cardId,
  cards,
  genData,
  disabledIds,
  folderSel,
  projects,
  autoTagOptions,
  ui,
  gen,
  actions,
}: {
  cardId: string; // cardMenu (열린 카드 id)
  cards: SceneCard[];
  genData: Record<string, Generation>;
  disabledIds: Set<string>;
  folderSel?: { projectId: string; path: string } | null;
  projects: Project[];
  autoTagOptions: string[];
  // 팝업 UI 상태 — 소유는 SceneBoard(키보드·마퀴·측정 effect 가 부모에 있음), 여기는 읽기+setter 호출만.
  ui: {
    popupSel: Set<string>;
    setPopupSel: React.Dispatch<React.SetStateAction<Set<string>>>;
    popupAnchorRef: MutableRefObject<string | null>;
    popupMarq: { l: number; t: number; w: number; h: number } | null;
    gripDragging: boolean;
    setGripDragging: (on: boolean) => void;
    tagEditGid: string | null;
    setTagEditGid: React.Dispatch<React.SetStateAction<string | null>>;
    tagEditorPos: { left: number; top: number } | null;
    varGridRef: RefObject<HTMLDivElement>;
    varpopWrapRef: RefObject<HTMLDivElement>;
    onVarGridMouseDown: (e: React.MouseEvent) => void;
  };
  // 생성물 조작(안정 참조 통과 — GenerationCard 의 hist 와 동일 원칙).
  gen: {
    sConfirm: { id: string; kind: "share" | "final" } | null;
    canFinalize?: (g: Generation) => boolean;
    onNodeSClick: (g: Generation) => void;
    onNodeSDouble: (g: Generation) => void;
    onNodeSConfirmYes: (g: Generation) => void;
    onNodeSConfirmNo: () => void;
    onInfo?: (t: InfoTarget) => void;
    onOpenComments?: (g: Generation) => void;
    onRegenerate?: (g: Generation) => void;
    onPreview?: (t: PreviewTarget) => void;
    tagsEnabled: boolean; // onSetTags 존재
    hasAutoTags: boolean; // onSetAutoTags 존재
    applyCardTags: (g: Generation, next: string[]) => void;
    applyCardAutoTags: (g: Generation, next: string[]) => void;
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
    // Resolve 전송(캔버스 선택바와 동일 파이프라인) — 있으면 팝업 선택바에도 버튼 노출.
    variantResolve?: VariantResolveControls;
  };
}) {
  // 배경 클릭 닫기는 '배경에서 누르기 시작한' 경우만. 팝업 안에서 시작한 드래그(마퀴·타일 끌기)가
  // 박스 밖에서 끝나면 브라우저가 공통 조상(배경)에 click 을 합성해 팝업이 닫히던 버그 방지.
  const backdropDownRef = useRef(false);
  const c = cards.find((x) => x.id === cardId);
  if (!c) return null;
  // 최신순(최근 생성이 맨 위) — sort_ts(정밀 epoch) 우선, 없으면 created_at. genData 없는 변형은 뒤로.
  const genTs = (gid: string): number => {
    const gg = genData[gid];
    if (!gg) return 0;
    if (typeof gg.sort_ts === "number") return gg.sort_ts;
    const t = Date.parse(gg.created_at);
    return Number.isNaN(t) ? 0 : t;
  };
  const ids = [...variantIds(c)].sort((a, b) => genTs(b) - genTs(a));
  // asset 있는(미리보기 가능) 변형만 방향키 목록으로 — pending/실패 섞임 방지.
  const previewItems: PreviewItem[] = [];
  for (const id of ids) {
    const a = genData[id]?.assets?.[0];
    if (a)
      previewItems.push({
        url: a.file_path,
        type: a.type,
        name: genData[id]?.prompt?.slice(0, 50) || "결과",
        genId: id,
      });
  }
  const openPreviewAt = (gid: string) => {
    const index = previewItems.findIndex((it) => it.genId === gid);
    if (index < 0) return;
    gen.onPreview?.({ ...previewItems[index], items: previewItems, index });
  };
  const selected = ids.map((id) => genData[id]).filter((g): g is Generation => !!g && ui.popupSel.has(g.id));
  const closeAndTrash = async () => {
    const done = await actions.onVariantDelete?.(selected);
    if (done && done.length) {
      const removed = new Set(done);
      actions.pruneVariants(c.id, removed);
      ui.setPopupSel((prev) => new Set([...prev].filter((id) => !removed.has(id))));
      // 남은 변형 판정은 최신 카드 기준(삭제 대기 중 뒤에서 append 됐을 수 있어 렌더 스냅샷 대신).
      const latest = actions.latestCard(c.id) || c;
      if (variantIds(latest).filter((id) => !removed.has(id)).length === 0) actions.setCardMenu(null);
    }
  };
  const toggleSel = (gid: string, additive: boolean) =>
    ui.setPopupSel((prev) => {
      if (!additive) return new Set([gid]);
      const n = new Set(prev);
      n.has(gid) ? n.delete(gid) : n.add(gid);
      return n;
    });
  // 클릭 선택 — Shift=앵커~현재 범위 선택(비활성 제외), Ctrl/Cmd=토글, 단독=단일. 앵커는 단독/토글에서 갱신.
  const selectPopup = (gid: string, e: React.MouseEvent) => {
    const anchor = ui.popupAnchorRef.current;
    if (e.shiftKey && anchor && anchor !== gid) {
      const ai = ids.indexOf(anchor);
      const bi = ids.indexOf(gid);
      if (ai >= 0 && bi >= 0) {
        const [lo, hi] = ai < bi ? [ai, bi] : [bi, ai];
        const range = ids.slice(lo, hi + 1).filter((id) => !disabledIds.has(id));
        ui.setPopupSel((prev) => {
          const base = e.ctrlKey || e.metaKey ? new Set(prev) : new Set<string>();
          for (const id of range) base.add(id);
          return base;
        });
        return; // 앵커 유지 → 연속 Shift 로 범위 확장 가능
      }
    }
    toggleSel(gid, e.ctrlKey || e.metaKey);
    ui.popupAnchorRef.current = gid;
  };
  // 드래그 페이로드 — 잡은 타일이 팝업 다중선택에 포함되면 선택 전체를 실어 폴더 드롭이
  // 한 번에 담게 한다. generation(단일)은 프롬프트 재사용 호환용으로 잡은 것 하나만.
  const setDragPayload = (e: React.DragEvent, gid: string, gg: Generation) => {
    e.dataTransfer.setData(DRAG_TYPES.generation, gg.id);
    const gids = ui.popupSel.has(gid) ? [...ui.popupSel] : [gid];
    const ids = gids.map((g) => genData[g]?.id).filter((id): id is string => !!id);
    e.dataTransfer.setData(DRAG_TYPES.generationList, (ids.length ? ids : [gg.id]).join(","));
    e.dataTransfer.effectAllowed = "copy";
    // 고스트 = 타일 카드 전체 — 드래그 소스(투명 레이어·작은 그립)를 그대로 쓰면 고스트가 안 보여
    // "드래그가 안 된다"로 느껴진다(실측: dragstart 는 정상 발생). 라이브러리 카드와 같은 체감으로.
    const tile = (e.currentTarget as HTMLElement).closest(".scene-varpop-item");
    if (tile instanceof HTMLElement) {
      const r = tile.getBoundingClientRect();
      e.dataTransfer.setDragImage(tile, e.clientX - r.left, e.clientY - r.top);
    }
  };
  return (
    <div
      className={"scene-varpop-backdrop" + (ui.gripDragging ? " drag-through" : "")}
      onMouseDown={(e) => {
        e.stopPropagation();
        backdropDownRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const armed = backdropDownRef.current;
        backdropDownRef.current = false;
        if (armed && e.target === e.currentTarget) actions.setCardMenu(null);
      }}
    >
      <div
        className="scene-varpop-wrap"
        ref={ui.varpopWrapRef}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="scene-varpop">
          <div className="scene-varpop-hd">
            <span>생성 결과 {ids.length}개</span>
            <button className="scene-varpop-x" title="닫기" onClick={() => actions.setCardMenu(null)}>
              ×
            </button>
          </div>
          <div className="scene-varpop-grid" ref={ui.varGridRef} onMouseDown={ui.onVarGridMouseDown}>
            {ids.map((gid) => {
              const gg = genData[gid];
              const a = gg?.assets?.[0];
              const isVideo = a?.type === "video"; // 영상: img 로는 못 그려 썸네일이 비었었음
              const rep = gid === c.genId; // 대표
              const on = ui.popupSel.has(gid); // 선택
              const off = disabledIds.has(gid); // 비활성(회색)
              // 선택 폴더(하위 포함) 밖 변형이면 흐리게 — 팝업 안에서 어떤 변형이 그 폴더에
              // 들어갔는지 한눈에(캔버스 카드 딤과 동일 규칙). folderSel 없으면 딤 없음.
              const folderDim =
                !!folderSel &&
                !!gg &&
                !(
                  gg.project_id === folderSel.projectId &&
                  (folderSel.path === "" ||
                    gg.folder_path === folderSel.path ||
                    (gg.folder_path?.startsWith(folderSel.path + "/") ?? false))
                );
              return (
                <div key={gid} className="scene-varpop-cell">
                  {/* 대표 라벨/지정 버튼 — 카드 '밖' 상단(요청). 대표면 라벨, 아니면 지정 버튼. */}
                  {rep ? (
                    <span className="scene-varpop-cur">★ 대표</span>
                  ) : gg && a ? (
                    <button
                      className="scene-varpop-rep"
                      title="이 결과를 카드 대표로 지정"
                      // preventDefault = 버튼이 포커스를 받아 그리드가 스크롤(옆으로 이동)되는 것 차단.
                      // mousedown 에서 바로 지정 → 빠르게 눌러도 확실히 선택(클릭 타이밍 의존 제거).
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        actions.setCardVariant(c.id, gid);
                      }}
                    >
                      대표
                    </button>
                  ) : null}
                  <div
                    data-gid={gid}
                    className={
                      "scene-varpop-item" +
                      (rep ? " rep" : "") +
                      (on ? " on" : "") +
                      (off ? " off" : "") +
                      (folderDim ? " foldim" : "")
                    }
                    title={gg?.prompt || ""}
                    onMouseDown={(e) => {
                      if (e.button === 1) e.preventDefault(); // 휠클릭 자동스크롤 방지
                    }}
                    onAuxClick={(e) => {
                      // 휠(중간)클릭 = 정보(계보·메인 라이브러리 카드와 동일)
                      if (e.button === 1 && gg) {
                        e.preventDefault();
                        gen.onInfo?.({ kind: "generation", gen: gg, x: e.clientX, y: e.clientY });
                      }
                    }}
                    onClick={(e) => selectPopup(gid, e)}
                    onDoubleClick={() => a && openPreviewAt(gid)}
                  >
                    {/* 영상도 확실히 보이게 — 썸네일 있으면 포스터, 없으면 첫 프레임(video). */}
                    <MediaThumbnail
                      thumb={gg ? thumbOf(gg) : null}
                      isVideo={isVideo}
                      src={a?.file_path}
                      fallback={
                        gg && (gg.status === "failed" || gg.status === "nsfw") ? (
                          // 실패·NSFW = 메인 카드와 동일한 경고 비주얼(어두운 빨강 + ⚠ + '실패').
                          <div
                            className={`thumb-placeholder status-${gg.status}`}
                            title={gg.error || undefined}
                          >
                            {generationStatusLabelFor(gg.status, gg.error, gg.execution_phase)}
                          </div>
                        ) : (
                          <span className="scene-varpop-ph">{String(gg?.status || "…")}</span>
                        )
                      }
                    />
                    {/* 카드 본체 드래그의 실제 시작점. 이미지 위 투명 레이어 자체가 draggable 이어야
                        실제 마우스에서도 dragstart 가 발생한다. 부모 타일까지 이벤트가 올라가기를
                        기대하면 Chrome 환경에 따라 카드가 전혀 잡히지 않는다. */}
                    {gg && a && (
                      <span
                        className="scene-varpop-draglayer"
                        draggable
                        title="사이드바 프로젝트 폴더로 드래그"
                        onDragStart={(e) => {
                          e.stopPropagation();
                          setDragPayload(e, gid, gg);
                        }}
                      />
                    )}
                    {isVideo && <span className="scene-varpop-vid">▶</span>}
                    {/* 좌상단 S/T/C — 생성탭 카드(.card-tl)와 동일 룩·조작(공유/태그/코멘트) */}
                    {gg && (
                      <div className="card-tl">
                        {(gg.is_mine ||
                          gg.is_final ||
                          (gg.shared && (gen.canFinalize ? gen.canFinalize(gg) : true))) && (
                          <button
                            className={
                              "card-sf" + (gg.shared ? " on" : "") + (gg.is_final ? " final" : "")
                            }
                            title={
                              gg.is_final
                                ? "최종(골드) — 더블클릭=최종 해제"
                                : gg.is_mine
                                  ? gg.shared
                                    ? "팀 공유됨 · 클릭=해제 · 더블클릭=최종"
                                    : "팀에 공유 (클릭) · 최종은 공유 후 더블클릭"
                                  : "더블클릭=최종 지정 (Supervisor)"
                            }
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              gen.onNodeSClick(gg);
                            }}
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              gen.onNodeSDouble(gg);
                            }}
                          >
                            {gg.is_final ? "★" : "S"}
                          </button>
                        )}
                        <button
                          className={"card-cm" + (gg.tags.length ? " on" : "")}
                          title={
                            gg.tags.length
                              ? `태그: ${gg.tags.join(", ")} · 클릭=태그 편집`
                              : "태그 편집"
                          }
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            ui.setTagEditGid((cur) => (cur === gid ? null : gid));
                          }}
                        >
                          T
                        </button>
                        <button
                          className={"card-cm" + (gg.has_unread ? " alert" : "")}
                          title={
                            gg.has_unread
                              ? `새 코멘트 · 총 ${gg.comment_count}개`
                              : gg.comment_count
                                ? `코멘트 ${gg.comment_count}개`
                                : "코멘트 스레드 열기"
                          }
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            gen.onOpenComments?.(gg);
                          }}
                        >
                          C
                        </button>
                      </div>
                    )}
                    {/* 좌상단 그립(생성탭 .card-drag-grip 과 동일 — S/T/C 바로 아래). 끌어내려/클릭해 프롬프트 재사용. */}
                    {gg && a && (
                      <span
                        className="card-drag-grip"
                        draggable
                        title="클릭 또는 끌어내려 프롬프트 재사용(프롬프트·옵션 불러오기)"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          dispatchAppEvent(APP_EVENTS.reusePrompt, gg.id);
                        }}
                        onDragStart={(e) => {
                          e.stopPropagation();
                          setDragPayload(e, gid, gg);
                          ui.setGripDragging(true);
                        }}
                        onDragEnd={() => ui.setGripDragging(false)}
                      >
                        ⠿
                      </span>
                    )}
                    {/* 색·비활성 표시(공유/최종은 위 S 버튼이 겸함) */}
                    {gg?.color && (
                      <span className="scene-varpop-colorbar" style={{ background: gg.color }} />
                    )}
                    {/* S(공유/최종) 확인 — 생성탭 카드와 동일 오버레이. 이 타일이 대상일 때만. */}
                    {gen.sConfirm?.id === gid && gg && (
                      <GenerationConfirmOverlay
                        mode={gen.sConfirm.kind}
                        shared={!!gg.shared}
                        isFinal={!!gg.is_final}
                        onYes={() => gen.onNodeSConfirmYes(gg)}
                        onNo={gen.onNodeSConfirmNo}
                      />
                    )}
                    {gg && a && (
                      // 호버 액션 오버레이 — 생성탭 카드(.thumb-overlay / .ov-icon)와 동일 클래스·크기.
                      // 상단=정보(우), 하단=다운로드/레퍼런스/재생성. 컨테이너 pointer-events:none, 버튼만 활성.
                      <div className="thumb-overlay">
                        <div className="ov-top">
                          <button
                            className="ov-icon"
                            style={{ marginLeft: "auto" }}
                            title="정보"
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              gen.onInfo?.({ kind: "generation", gen: gg, x: e.clientX, y: e.clientY });
                            }}
                          >
                            ⓘ
                          </button>
                        </div>
                        <div className="ov-bottom">
                          <button
                            className="ov-icon"
                            title="다운로드"
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              downloadOne(a.file_path, downloadName(gg, a.type), gg.id);
                            }}
                          >
                            ⤓
                          </button>
                          <button
                            className="ov-icon"
                            title="레퍼런스로 사용"
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              dispatchAppEvent(APP_EVENTS.addReference, gg.id);
                            }}
                          >
                            @
                          </button>
                          <button
                            className="ov-icon"
                            title="재생성"
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              gen.onRegenerate?.(gg);
                            }}
                          >
                            ↻
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {ui.popupMarq && (
              <div
                className="scene-varpop-marq"
                style={{ left: ui.popupMarq.l, top: ui.popupMarq.t, width: ui.popupMarq.w, height: ui.popupMarq.h }}
              />
            )}
          </div>
        </div>
        {selected.length > 0 && (
          <div className="scene-varpop-actions">
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
        {/* 태그 편집 — 타일은 overflow:hidden 이라 잘리므로 팝업 레벨에 절대배치하되, 편집 중인
            타일 rect 를 측정해 그 '바로 아래'에 띄운다(카드 밑으로). */}
        {ui.tagEditGid &&
          gen.tagsEnabled &&
          genData[ui.tagEditGid] &&
          ui.tagEditorPos &&
          (() => {
            const g = genData[ui.tagEditGid!]!;
            return (
              <div
                className="scene-varpop-tageditor"
                style={{ left: ui.tagEditorPos!.left, top: ui.tagEditorPos!.top }}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <TagEditor
                  tags={g.tags}
                  onChange={(next) => gen.applyCardTags(g, next)}
                  global={
                    gen.hasAutoTags
                      ? {
                          all: autoTagOptions,
                          assigned: g.auto_tags ?? [],
                          onChange: (next) => gen.applyCardAutoTags(g, next),
                        }
                      : null
                  }
                  onClose={() => ui.setTagEditGid(null)}
                />
              </div>
            );
          })()}
      </div>
    </div>
  );
}
