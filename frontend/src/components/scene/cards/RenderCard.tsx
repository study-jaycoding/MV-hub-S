// 렌더(배치 생성) 카드 본문 — SceneBoard 렌더 분할(R2). 셸은 부모 소유, Fragment 만 반환(규칙은 OutputCard 참고).
//  순서변경(startReorder)이 쓰는 data-reorder / data-reid 속성은 반드시 보존한다.
import type React from "react";
import type { SceneCard, SceneEdge } from "../../../lib/scenes";
import { cardBatch, variantIds } from "../../../lib/scenes";
import type { Generation, PreviewTarget } from "../../../types";
import { collectRenderGenCardIds } from "../../../lib/sceneEdges";
import { hideBrokenImg, showLoadedImg, thumbOf } from "../../../lib/media";

export function RenderCard({
  card,
  sel,
  cardsById,
  resolvedEdges,
  genData,
  disabledIds,
  rowSel,
  reorderFrom,
  showRenderBar,
  toggleRowSel,
  toggleRenderCheck,
  startReorder,
  getNodePreview,
  setCardMenu,
  setCardBatch,
  orchestrateRender,
  onOutPortDown,
  onResizeDown,
}: {
  card: SceneCard;
  sel: boolean;
  cardsById: Map<string, SceneCard>;
  resolvedEdges: SceneEdge[];
  genData: Record<string, Generation>;
  disabledIds: Set<string>;
  rowSel: { listId: string; cids: Set<string> };
  reorderFrom: string | null;
  showRenderBar: boolean; // sel && onRenderCards — 실행바 노출 조건(부모 prop 존재 여부 포함)
  toggleRowSel: (listId: string, cid: string, additive: boolean) => void;
  toggleRenderCheck: (renderId: string, cid: string) => void;
  startReorder: (e: React.MouseEvent, listId: string, cid: string, axis: "v" | "h") => void;
  getNodePreview: (cardId: string) => (p: PreviewTarget) => void;
  setCardMenu: (cardId: string | null) => void;
  setCardBatch: (cardId: string, n: number) => void;
  orchestrateRender: (renderId: string, checkedGenIds: string[]) => Promise<void>;
  onOutPortDown: (e: React.MouseEvent, cardId: string) => void;
  onResizeDown: (e: React.MouseEvent, cardId: string) => void;
}) {
  // 렌더(배치 생성) — 연결된 생성카드들을 모아 Render 버튼 한 번으로 각 카드를 자기 모델·refs·텍스트로 생성.
  const gcids = collectRenderGenCardIds(card.id, cardsById, resolvedEdges);
  const unchecked = new Set(card.unchecked || []); // 체크 해제된(렌더 제외) 카드들
  const activeGcids = gcids.filter((cid) => !unchecked.has(cid)); // 실제 Render 대상(체크된 것만)
  // 렌더에 직접 연결된 comfy 중 '아직 생성물이 없는' 것 — 생성이 없어도 이들만으로 실행 가능.
  //  (이미 출력을 저장한 comfy 는 위 gcids 에 생성물로 잡히므로 중복 카운트 제외.)
  const renderComfyIds = resolvedEdges
    .filter((e) => e.to === card.id)
    .map((e) => cardsById.get(e.from))
    .filter((c): c is SceneCard => c?.kind === "comfy")
    .map((c) => c.id)
    .filter((id) => !gcids.includes(id));
  const renderCount = activeGcids.length + renderComfyIds.length;
  return (
    <>
      <div className="scene-card-hd render scene-card-hd-float">렌더</div>
      <div className="scene-card-inner scene-listnode scene-rendernode">
        <div className="scene-listnode-body">
          {gcids.length ? (
            // 생성물 — 텍스트처럼 한 행씩(그립+작은 썸네일+개수). 그립을 잡아 드래그로 순서 변경, 더블클릭=결과 팝업.
            <div className="scene-listrows" data-reorder>
              {gcids.map((cid) => {
                const gc = cardsById.get(cid);
                const gid = gc?.genId || (gc ? variantIds(gc)[0] : undefined);
                const gen = gid ? genData[gid] : undefined;
                const src = gen ? thumbOf(gen, 128) : null;
                const n = gc ? variantIds(gc).length : 0;
                const off = !!gid && disabledIds.has(gid); // 비활성(회색) 결과
                const rsel = rowSel.listId === card.id && rowSel.cids.has(cid);
                return (
                  <div
                    key={cid}
                    className={"scene-listrow" + (off ? " off" : "") + (rsel ? " selrow" : "") + (reorderFrom === cid ? " reordering" : "")}
                    data-reid={cid}
                    onClick={(e) => { e.stopPropagation(); toggleRowSel(card.id, cid, e.ctrlKey || e.metaKey); }}
                  >
                    <span
                      className="scene-listrow-grip"
                      title="드래그해 순서 변경"
                      onMouseDown={(e) => startReorder(e, card.id, cid, "v")}
                      onClick={(e) => e.stopPropagation()}
                    >
                      ⠿
                    </span>
                    <input
                      type="checkbox"
                      className="scene-listrow-check"
                      checked={!unchecked.has(cid)}
                      title={unchecked.has(cid) ? "체크(렌더 대상)" : "체크 해제(렌더 제외)"}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleRenderCheck(card.id, cid)}
                    />
                    <span
                      className="scene-listrow-view"
                      title={gen?.assets?.[0] ? "클릭해 크게 보기" : undefined}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        const a = gen?.assets?.[0];
                        if (!a || !gid) return;
                        e.stopPropagation();
                        getNodePreview(cid)({ url: a.file_path, type: a.type, name: gen?.prompt?.slice(0, 50) || "결과", genId: gid });
                      }}
                    >
                      {src ? (
                        <img className="scene-listrow-thumb" src={src} alt="" draggable={false} onError={hideBrokenImg} onLoad={showLoadedImg} />
                      ) : (
                        <span className="scene-listrow-thumb scene-listthumb-ph" />
                      )}
                    </span>
                    <span
                      className="scene-listrow-count"
                      title={n > 0 ? "클릭해 이 카드의 생성 결과 모두 보기" : undefined}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        if (n <= 0) return;
                        e.stopPropagation();
                        setCardMenu(cid);
                      }}
                    >
                      {n > 0 ? (
                        <span className="scene-listrow-badge">▤ {n}</span>
                      ) : (
                        <span className="scene-listrow-empty">빈 카드</span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            "생성 카드를 연결"
          )}
        </div>
      </div>
      {sel && showRenderBar && (
        <div className="scene-cardgen-bar" onMouseDown={(e) => e.stopPropagation()}>
          <button
            className="scene-cardgen-step"
            title="배치 줄이기"
            onClick={(e) => {
              e.stopPropagation();
              setCardBatch(card.id, cardBatch(card) - 1);
            }}
          >
            −
          </button>
          <span className="scene-cardgen-n" title="각 카드에서 생성할 장수(배치)">
            {cardBatch(card)}
          </span>
          <button
            className="scene-cardgen-step"
            title="배치 늘리기"
            onClick={(e) => {
              e.stopPropagation();
              setCardBatch(card.id, cardBatch(card) + 1);
            }}
          >
            +
          </button>
          <button
            className="scene-cardgen-go"
            title="연결된 comfy 를 먼저 실행하고, 체크된 생성 카드를 각자 생성"
            disabled={!renderCount}
            onClick={(e) => {
              e.stopPropagation();
              if (renderCount) void orchestrateRender(card.id, activeGcids);
            }}
          >
            Render ▶ {renderCount}
          </button>
        </div>
      )}
      <span className="scene-port in" title="생성 카드를 연결해 모음" />
      <span
        className="scene-port out"
        onMouseDown={(e) => onOutPortDown(e, card.id)}
        title="드래그해 미리보기(View)에 연결 — 담긴 생성물들을 재생"
      />
      <span
        className="scene-resize"
        onMouseDown={(e) => onResizeDown(e, card.id)}
        title="드래그해 크기 조절"
      />
    </>
  );
}
