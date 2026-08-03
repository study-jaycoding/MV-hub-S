// 리스트(동종 수집기) 카드 본문 — SceneBoard 렌더 분할(R2). 셸은 부모 소유, Fragment 만 반환(규칙은 OutputCard 참고).
//  순서변경(startReorder)이 쓰는 data-reorder / data-reid 속성은 반드시 보존한다.
import type React from "react";
import type { CSSProperties } from "react";
import type { SceneCard, SceneEdge } from "../../../lib/scenes";
import { variantIds } from "../../../lib/scenes";
import type { Generation, PreviewTarget } from "../../../types";
import { collectListInputs, collectRenderGenCardIds, effectiveTextOf } from "../../../lib/sceneEdges";
import { refThumbSrc } from "../../../lib/sceneMedia";
import { hideBrokenImg, showLoadedImg, thumbOf } from "../../../lib/media";
import { CARD_W } from "../sceneColors";

export function ListCard({
  card,
  cardsById,
  resolvedEdges,
  genData,
  disabledIds,
  rowSel,
  reorderFrom,
  cardWidth,
  toggleRowSel,
  startReorder,
  getNodePreview,
  setCardMenu,
  addListAsReference,
  onOutPortDown,
  onResizeDown,
}: {
  card: SceneCard;
  cardsById: Map<string, SceneCard>;
  resolvedEdges: SceneEdge[];
  genData: Record<string, Generation>;
  disabledIds: Set<string>;
  rowSel: { listId: string; cids: Set<string> };
  reorderFrom: string | null;
  cardWidth: number; // widthOf(card) — 부모 계산(head 폭 측정 ref 의존이라 값으로 받음)
  toggleRowSel: (listId: string, cid: string, additive: boolean) => void;
  startReorder: (e: React.MouseEvent, listId: string, cid: string, axis: "v" | "h") => void;
  getNodePreview: (cardId: string) => (p: PreviewTarget) => void;
  setCardMenu: (cardId: string | null) => void;
  addListAsReference: (generationCardIds: string[]) => void;
  onOutPortDown: (e: React.MouseEvent, cardId: string) => void;
  onResizeDown: (e: React.MouseEvent, cardId: string) => void;
}) {
  // 동종 수집기 — 생성카드들(→View 재생) 또는 텍스트들(→합친 텍스트). input(무선)은 실제 소스로 해석.
  const li = collectListInputs(card.id, cardsById, resolvedEdges);
  const label =
    li.kind === "generation"
      ? `생성물 ${li.generationCardIds.length}개`
      : li.kind === "text"
        ? `텍스트 ${li.sourceIds.length}개`
        : li.kind === "reference"
          ? `레퍼런스 ${li.sourceIds.length}개`
          : li.kind === "mixed"
            ? "⚠ 혼합 입력(사용 불가)"
            : li.kind === "invalid"
              ? "⚠ 잘못된 입력"
              : "생성/텍스트/레퍼런스 카드를 연결";
  // 리스트 카드를 늘리면 레퍼런스 썸네일도 비례해 커진다 — 최소=기본(42px), 최대=레퍼런스
  //  카드 2/3 의 1.5배(≈152px = 레퍼런스 카드 크기). 카드가 클수록 번호·장수 배지 글씨도
  //  비례해 커져 잘 보이게 한다.
  const listThumbPx = Math.max(
    42,
    Math.min(Math.round(((CARD_W * 2) / 3) * 1.5), Math.round((cardWidth / CARD_W) * 42)),
  );
  const listThumbBadgeFs = Math.max(8, Math.min(30, Math.round((listThumbPx * 8) / 42)));
  const listThumbsStyle: CSSProperties = {
    gridTemplateColumns: `repeat(auto-fill, ${listThumbPx}px)`,
  };
  (listThumbsStyle as Record<string, string | number>)["--lt-badge-fs"] = `${listThumbBadgeFs}px`;
  return (
    <>
      <div className="scene-card-hd list scene-card-hd-float">리스트</div>
      <div className="scene-card-inner scene-listnode">
        <div className="scene-listnode-body">
          {li.kind === "generation" ? (
            // 생성물 — 텍스트처럼 한 행씩(그립+작은 썸네일+라벨), 왼쪽 그립(⠿)을 잡아 드래그로 순서 변경.
            <div className="scene-listrows" data-reorder>
              {li.sourceIds.map((cid) => {
                const gc = cardsById.get(cid);
                // 중첩 소스(list·render) — 묶음 행으로 표시(내부 생성물 개수). 소비 시에만 펼쳐진다.
                if (gc?.kind === "list" || gc?.kind === "render") {
                  const nestedCount =
                    gc.kind === "list"
                      ? (() => {
                          const nested = collectListInputs(gc.id, cardsById, resolvedEdges);
                          return nested.kind === "generation" ? nested.generationCardIds.length : 0;
                        })()
                      : collectRenderGenCardIds(gc.id, cardsById, resolvedEdges).length;
                  const brsel = rowSel.listId === card.id && rowSel.cids.has(cid);
                  return (
                    <div
                      key={cid}
                      className={"scene-listrow" + (brsel ? " selrow" : "") + (reorderFrom === cid ? " reordering" : "")}
                      data-reid={cid}
                      title="중첩 소스 — 내부 생성물을 펼쳐 사용"
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
                      <span className="scene-listrow-count">
                        <span className="scene-listrow-badge">
                          {gc.kind === "render" ? "렌더" : "리스트"} {nestedCount}
                        </span>
                      </span>
                    </div>
                  );
                }
                const gid = gc?.genId || (gc ? variantIds(gc)[0] : undefined);
                const gen = gid ? genData[gid] : undefined;
                const src = gen ? thumbOf(gen, 128) : null;
                const n = gc ? variantIds(gc).length : 0; // 이 카드에 생성된 결과 수
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
          ) : li.kind === "text" ? (
            // 텍스트들 — 각 텍스트를 한 행(카드)으로, 왼쪽 그립(⠿)을 잡아 드래그로 순서 변경.
            <div className="scene-listrows" data-reorder>
              {li.sourceIds.map((cid) => {
                // comfy(프롬프트)·text 카드 모두 유효 텍스트를 effectiveTextOf 로 — comfy 는 출력없으면 입력 프롬프트.
                const txt = effectiveTextOf(cid, cardsById, resolvedEdges).trim();
                return (
                  <div
                    key={cid}
                    className={"scene-listrow" + (reorderFrom === cid ? " reordering" : "")}
                    data-reid={cid}
                  >
                    <span
                      className="scene-listrow-grip"
                      title="드래그해 순서 변경"
                      onMouseDown={(e) => startReorder(e, card.id, cid, "v")}
                      onClick={(e) => e.stopPropagation()}
                    >
                      ⠿
                    </span>
                    <span className="scene-listrow-text">{txt || "(빈 텍스트)"}</span>
                  </div>
                );
              })}
            </div>
          ) : li.kind === "reference" ? (
            // 레퍼런스 카드들 — 카드마다 대표 썸네일(첫 장)+장수 배지, 드래그해 순서 변경.
            //  썸네일·배지 크기는 리스트 카드 크기에 비례(listThumbsStyle: 그리드 열폭 + 배지 글씨).
            <div className="scene-listthumbs" data-reorder style={listThumbsStyle}>
              {li.sourceIds.map((cid, i) => {
                const rc = cardsById.get(cid);
                const refs = rc?.refs || [];
                const src = refs[0] ? refThumbSrc(refs[0]) : null;
                return (
                  <div
                    key={cid}
                    className={"scene-listthumb" + (reorderFrom === cid ? " reordering" : "")}
                    data-reid={cid}
                    title={`${i + 1}번 (레퍼런스 ${refs.length}장) — 드래그해 순서 변경`}
                    onMouseDown={(e) => startReorder(e, card.id, cid, "h")}
                  >
                    {src ? (
                      <img src={src} alt="" draggable={false} onError={hideBrokenImg} onLoad={showLoadedImg} />
                    ) : (
                      <span className="scene-listthumb-ph" />
                    )}
                    <span className="scene-listthumb-n">{i + 1}</span>
                    {refs.length > 1 && (
                      <span className="scene-listthumb-cnt">{refs.length}</span>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            label
          )}
        </div>
      </div>
      {li.kind === "text" && (
        <button
          className="scene-copy-btn"
          title="합친 텍스트 복사"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            void navigator.clipboard?.writeText(li.text);
          }}
        >
          ⧉
        </button>
      )}
      {li.kind === "generation" && li.generationCardIds.length > 0 && (
        <button
          className="scene-copy-btn"
          title="모든 생성물을 레퍼런스로 사용"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            addListAsReference(li.generationCardIds);
          }}
        >
          @
        </button>
      )}
      <span className="scene-port in" title="생성/텍스트/레퍼런스 카드를 연결해 모음" />
      <span
        className="scene-port out"
        onMouseDown={(e) => onOutPortDown(e, card.id)}
        title="드래그해 View(재생) 또는 생성 카드에 연결"
      />
      <span
        className="scene-resize"
        onMouseDown={(e) => onResizeDown(e, card.id)}
        title="드래그해 크기 조절"
      />
    </>
  );
}
