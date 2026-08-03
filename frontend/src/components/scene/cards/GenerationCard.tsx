// 생성 카드 본문 — SceneBoard 렌더 분할(R2, catch-all else 분기). 셸은 부모 소유, Fragment 만 반환.
//  HistoryBoardNode 는 memo 컴포넌트라 그 props 는 원래 값(안정 참조)을 hist 번들로 받아 '개별로' 풀어
//  전달한다 — 번들 객체 자체는 매 렌더 새로 만들어져도 HBN 이 받는 각 prop 참조는 이전과 동일해 memo 유지.
import type React from "react";
import type { SceneCard, SceneEdgeRole } from "../../../lib/scenes";
import { cardBatch, variantIds } from "../../../lib/scenes";
import type { Generation, InfoTarget, PreviewTarget } from "../../../types";
import { generationStatusLabelFor } from "../../../lib/generationDisplay";
import { HistoryBoardNode } from "../../history/HistoryBoardNode";
import { TagEditor } from "../../TagEditor";
import higgsfieldLogo from "../../../assets/higgsfield-logo.svg";

// HistoryBoardNode 전달분 — SceneBoard 의 안정 참조들(필터·핸들러). 새 값 도입 금지(참조 그대로 통과).
type HistPass = {
  disabledIds: Set<string>;
  typeFilter: React.ComponentProps<typeof HistoryBoardNode>["typeFilter"];
  colorFilter: React.ComponentProps<typeof HistoryBoardNode>["colorFilter"];
  tagFilter: React.ComponentProps<typeof HistoryBoardNode>["tagFilter"];
  sharedOnly: React.ComponentProps<typeof HistoryBoardNode>["sharedOnly"];
  commentOnly: React.ComponentProps<typeof HistoryBoardNode>["commentOnly"];
  finalOnly: React.ComponentProps<typeof HistoryBoardNode>["finalOnly"];
  folderSel: React.ComponentProps<typeof HistoryBoardNode>["folderSel"];
  sConfirm: { id: string; kind: "share" | "final" } | null;
  onSClick: React.ComponentProps<typeof HistoryBoardNode>["onSClick"];
  onSDouble: React.ComponentProps<typeof HistoryBoardNode>["onSDouble"];
  onSConfirmYes: React.ComponentProps<typeof HistoryBoardNode>["onSConfirmYes"];
  onSConfirmNo: React.ComponentProps<typeof HistoryBoardNode>["onSConfirmNo"];
  onInfo?: (t: InfoTarget) => void;
  onRegenerate?: (gen: Generation) => void;
  onTag?: React.ComponentProps<typeof HistoryBoardNode>["onTag"];
  onOpenComments?: React.ComponentProps<typeof HistoryBoardNode>["onOpenComments"];
};

export function GenerationCard({
  card,
  sel,
  g,
  showNode,
  waiting,
  genMissing,
  width,
  height,
  fill,
  selectedOnly,
  laneDelta,
  getNodePreview,
  hist,
  actions,
  tagEdit,
}: {
  card: SceneCard;
  sel: boolean;
  g: Generation | null;
  showNode: boolean;
  waiting: boolean; // 상류 comfy 실행 중 — '생성중(회색)' 최우선 표시
  genMissing: boolean; // 바인딩된 생성물이 외부에서 삭제됨(missingIds)
  width: number;
  height: number;
  fill: boolean;
  selectedOnly: boolean; // 이 카드 '하나만' 선택됨 — Generate 툴바 노출 조건
  laneDelta: (lane: "model" | "ref" | "text") => number;
  getNodePreview: (cardId: string) => (p: PreviewTarget) => void;
  hist: HistPass;
  actions: {
    setCardMenu: (cardId: string | null) => void;
    setCardBatch: (cardId: string, n: number) => void;
    orchestrateGenerate: (genId: string) => Promise<void>;
    showGenerateBar: boolean; // onGenerateCard prop 존재 여부
    onOutPortDown: (e: React.MouseEvent, cardId: string) => void;
    onResizeDown: (e: React.MouseEvent, cardId: string) => void;
  };
  tagEdit: {
    active: boolean; // 이 카드가 태그 편집 대상(onSetTags 존재 포함)
    hasAutoTags: boolean; // onSetAutoTags 존재 — 전역 태그 편집 허용
    autoTagOptions: string[];
    applyCardTags: (gen: Generation, next: string[]) => void;
    applyCardAutoTags: (gen: Generation, next: string[]) => void;
    close: () => void;
  };
}) {
  return (
    <>
      {waiting ? (
        // 상류 comfy 가 도는 중 — 완료 결과(HistoryBoardNode)보다 '생성중(회색)'을 최우선으로 덮어
        //  이 노드 전체가 생성 진행 중임을 바로 보인다(컨피 완료 → 실제 생성잡 → 아래 Generating).
        <div className="scene-card-inner">
          <div className="scene-card-genbody status-pending scene-genloading">
            <span className="gen-generating">
              <img src={higgsfieldLogo} alt="Higgsfield" className="scene-genloading-logo" draggable={false} />
            </span>
          </div>
        </div>
      ) : showNode && g ? (
        // 완료 결과 → 히스토리 카드(HistoryBoardNode) 그대로 — 캡션·오버레이(S/ⓘ/⠿/⤓/@/↻) 전부.
        <HistoryBoardNode
          generation={g}
          x={0}
          y={0}
          width={width}
          height={height}
          isRoot={false}
          isSelected={sel}
          onLine={false}
          offLine={false}
          fill={fill}
          disabled={hist.disabledIds.has(g.id)}
          typeFilter={hist.typeFilter}
          colorFilter={hist.colorFilter}
          tagFilter={hist.tagFilter}
          sharedOnly={hist.sharedOnly}
          commentOnly={hist.commentOnly}
          finalOnly={hist.finalOnly}
          folderSel={hist.folderSel}
          sConfirm={hist.sConfirm?.id === g.id ? hist.sConfirm : null}
          onSClick={hist.onSClick}
          onSDouble={hist.onSDouble}
          onSConfirmYes={hist.onSConfirmYes}
          onSConfirmNo={hist.onSConfirmNo}
          onPreview={getNodePreview(card.id)}
          onInfo={hist.onInfo || (() => {})}
          onRegenerate={hist.onRegenerate || (() => {})}
          onTag={hist.onTag}
          onOpenComments={hist.onOpenComments}
        />
      ) : (
        <div className="scene-card-inner">
          {card.genId ? (
            genMissing ? (
              // 외부에서 삭제(휴지통)된 생성물 — 무한 'Generating' 대신 명시.
              <div className="scene-card-genbody">삭제됨</div>
            ) : String(g?.status) === "failed" || String(g?.status) === "nsfw" || String(g?.status) === "error" ? (
              // 실패·NSFW 차단 — 라이브러리(My Work) 그리드와 동일한 경고 비주얼(빨강+⚠+라벨).
              //  생성 정보는 done 카드와 동일하게 '미들클릭'으로 연다(별도 ⓘ 배지 없음).
              (() => {
                const st = String(g?.status) === "error" ? "failed" : String(g?.status);
                return (
                  <div
                    className={"scene-card-genbody scene-genfail status-" + st}
                    title={g?.error || undefined}
                    onMouseDown={(e) => e.button === 1 && e.preventDefault()} // 휠클릭 자동스크롤 방지
                    onAuxClick={(e) => {
                      if (e.button === 1 && g && hist.onInfo) {
                        e.preventDefault();
                        hist.onInfo({ kind: "generation", gen: g, x: e.clientX, y: e.clientY });
                      }
                    }}
                  >
                    <span className="scene-genfail-label">
                      {generationStatusLabelFor(st, g?.error)}
                    </span>
                  </div>
                );
              })()
            ) : (
              // 생성중 — 힉스필드 로고만 크게 맥동(글씨 없음) · 배경 검정(scene-genloading).
              <div className={"scene-card-genbody scene-genloading status-" + String(g?.status || card.status || "pending")}>
                <span className="gen-generating">
                  <img src={higgsfieldLogo} alt="Higgsfield" className="scene-genloading-logo" draggable={false} />
                </span>
              </div>
            )
          ) : (
            <div className="scene-card-genbody">New</div>
          )}
        </div>
      )}
      {/* 다중 결과 배지 — 이 카드에서 만든 결과가 2개 이상이면. 클릭=팝업으로 모아보기 */}
      {variantIds(card).length > 1 && (
        <button
          className="scene-multi-badge"
          title={`이 카드의 생성 결과 ${variantIds(card).length}개 모두 보기`}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            actions.setCardMenu(card.id);
          }}
        >
          ▤ {variantIds(card).length}
        </button>
      )}
      {/* 3 입력 단자 — 위=모델(주황)·중간=레퍼런스(파랑)·아래=텍스트(보라). 연결 역할은
          소스 노드 종류로 자동 판정되어 해당 레인으로 라우팅된다. */}
      {(
        [
          ["model", "model", "모델 입력"],
          ["ref", "ref", "레퍼런스 입력"],
          ["text", "text", "텍스트 입력"],
        ] as [SceneEdgeRole, "model" | "ref" | "text", string][]
      ).map(([role, lane, tip]) => (
        <span
          key={role}
          className={"scene-port in lane-" + role}
          data-role={role}
          style={{ top: `calc(50% + ${laneDelta(lane)}px)` }}
          title={tip}
        />
      ))}
      <span
        className="scene-port out"
        onMouseDown={(e) => actions.onOutPortDown(e, card.id)}
        title="드래그해 다른 생성 카드에 연결"
      />
      <span
        className="scene-resize"
        onMouseDown={(e) => actions.onResizeDown(e, card.id)}
        title="드래그해 카드 크기 조절"
      />
      {/* 이 카드만 선택했을 때 카드 아래 Generate 툴바 — 연결된 모델·레퍼런스·텍스트로 바로 생성(하단 프롬프트 재사용). */}
      {selectedOnly && sel && actions.showGenerateBar && (
        <div className="scene-cardgen-bar" onMouseDown={(e) => e.stopPropagation()}>
          <button
            className="scene-cardgen-step"
            title="배치 줄이기"
            onClick={(e) => {
              e.stopPropagation();
              actions.setCardBatch(card.id, cardBatch(card) - 1);
            }}
          >
            −
          </button>
          <span className="scene-cardgen-n" title="한 번에 생성할 장수(배치)">
            {cardBatch(card)}
          </span>
          <button
            className="scene-cardgen-step"
            title="배치 늘리기"
            onClick={(e) => {
              e.stopPropagation();
              actions.setCardBatch(card.id, cardBatch(card) + 1);
            }}
          >
            +
          </button>
          <button
            className="scene-cardgen-go"
            title="연결된 comfy 가 있으면 먼저 실행하고, 모델·레퍼런스·텍스트로 생성"
            onClick={(e) => {
              e.stopPropagation();
              void actions.orchestrateGenerate(card.id);
            }}
          >
            Generate ✨
          </button>
        </div>
      )}
      {g && tagEdit.active && (
        <div className="scene-tagpop" onMouseDown={(e) => e.stopPropagation()}>
          <TagEditor
            tags={g.tags}
            onChange={(next) => tagEdit.applyCardTags(g, next)}
            global={
              tagEdit.hasAutoTags
                ? {
                    all: tagEdit.autoTagOptions,
                    assigned: g.auto_tags ?? [],
                    onChange: (next) => tagEdit.applyCardAutoTags(g, next),
                  }
                : null
            }
            onClose={tagEdit.close}
          />
        </div>
      )}
    </>
  );
}
