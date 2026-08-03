// Comfy 노드 카드 본문 — SceneBoard 렌더 분할(R2, 최대 분기). 셸은 부모 소유, Fragment 만 반환.
//  ★파라미터 입력 포커스 주의: 모듈 최상단 선언(타입 안정) — 타이핑 중 리렌더에도 input 이 리마운트
//   되지 않아 포커스 유지. 저장은 setComfyParam(defer)→blur 시 flushPending 확정(기존 동작 그대로).
//  HistoryBoardNode(memo)는 GenerationCard 와 동일하게 hist 번들의 안정 참조를 개별로 풀어 전달.
import type React from "react";
import type { SceneCard, SceneEdge } from "../../../lib/scenes";
import { cardBatch, variantIds } from "../../../lib/scenes";
import type { Generation, PreviewTarget } from "../../../types";
import {
  comfyDeclaredKinds,
  comfyOutputMedia,
  comfyTextDriveKeys,
  incomingTextOf,
} from "../../../lib/sceneEdges";
import { gatherComfyMedia, hasTextConnection } from "../../../lib/sceneComfyInputs";
import { isComfyRunning } from "../../../lib/sceneComfyRunningStore";
import { hideBrokenImg, showLoadedImg } from "../../../lib/media";
import { HistoryBoardNode } from "../../history/HistoryBoardNode";
import { TagEditor } from "../../TagEditor";
import comfyLogo from "../../../assets/comfy-logo.svg";
import type { HistPass } from "./GenerationCard";

// 안정 참조 no-op — HistoryBoardNode(memo) 무효화 방지(코덱스 P2). GenerationCard 와 동일 원칙.
const NOOP = () => {};

export function ComfyCard({
  card,
  sel,
  fill,
  width,
  runningLocal,
  laneDelta,
  getNodePreview,
  graph,
  hist,
  tagEdit,
  actions,
}: {
  card: SceneCard;
  sel: boolean;
  fill: boolean;
  width: number; // widthOf(card)
  runningLocal: boolean; // 부모 메모리 실행 집합(runningComfyIds)에 있는지
  laneDelta: (lane: "model" | "ref" | "text") => number;
  getNodePreview: (cardId: string) => (p: PreviewTarget) => void;
  graph: {
    cards: SceneCard[];
    cardsById: Map<string, SceneCard>;
    edges: SceneEdge[];
    refParents: Record<string, string[]>;
    genData: Record<string, Generation>;
  };
  hist: HistPass;
  tagEdit: {
    cardId: string | null; // tagEditCardId
    nodeGenId: string | null; // tagEditNodeGenId
    enabled: boolean; // onSetTags 존재
    hasAutoTags: boolean;
    autoTagOptions: string[];
    applyCardTags: (gen: Generation, next: string[]) => void;
    applyCardAutoTags: (gen: Generation, next: string[]) => void;
    close: () => void;
  };
  actions: {
    applyComfyApi: (cardId: string, name: string, content: string) => Promise<boolean>;
    pickComfyFile: (cardId: string) => void;
    setComfyModalId: (cardId: string | null) => void;
    refreshComfy: (cardId: string) => Promise<void>;
    setComfyParam: (cardId: string, key: string, value: string | number | boolean) => void;
    flushPending: () => void;
    runComfy: (cardId: string) => Promise<boolean>;
    setCardMenu: (cardId: string | null) => void;
    setCardBatch: (cardId: string, n: number) => void;
    onOutPortDown: (e: React.MouseEvent, cardId: string) => void;
    onResizeDown: (e: React.MouseEvent, cardId: string) => void;
  };
}) {
  const { cards, cardsById, edges, refParents, genData } = graph;
  // Comfy 노드 — ComfyUI 워크플로우를 얹어 단독 실행. 더블클릭=API 로드·파라미터 노출 모달.
  const cfg = card.comfyCfg;
  const st = cfg?.status;
  // 실행 중 판정 — 모듈 store(탭 전환 생존) 이거나 status 이거나 메모리 running 집합.
  //  배치/오케 경로는 status 를 persist 안 하므로 store(#2)·메모리로 유지된다.
  const isRunning = isComfyRunning(card.id) || runningLocal || st === "running";
  const params = cfg?.params || [];
  const values = cfg?.paramValues || {};
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  // 텍스트가 '연결'돼 있으면(내용 유무 무관) 노출된 text 파라미터 입력칸을 비활성화하고, 연결된
  //  텍스트(라이브)를 표시한다. 실행 시 그 값이 자동 주입된다(내가 텍스트 노드에 적으면 그대로 반영).
  // 이 워크플로가 받을 수 있는 '텍스트 입력' 필드(Text Multiline 등) — 연결 무관. model·resolution 등
  //  설정 파라미터는 문자열이어도 제외(실행/프롬프트와 동일 판정). 텍스트 입력 포트도 이게 있을 때만 표시.
  const textDriveTargets = comfyTextDriveKeys(params, cfg?.content);
  const hasTextParam = textDriveTargets.size > 0;
  // 텍스트가 '연결'되면 그 필드만 비활성+연결텍스트 표시. model·resolution 은 평소처럼 편집 가능.
  const drivenKeys = hasTextConnection(card.id, cardsById, edges, refParents)
    ? textDriveTargets
    : new Set<string>();
  const textDriven = drivenKeys.size > 0;
  const linkedText = textDriven ? incomingTextOf(card.id, cardsById, edges) : "";
  // 출력 포트 색 = 워크플로우가 선언한 출력 종류(resolveEdgeRole 과 동일 규칙): 미디어=파랑(ref),
  //  텍스트 전용=보라(text). 선언을 못 읽으면 런타임 출력으로 폴백.
  //  ★출력을 '내 작업' 생성물로 저장한 노드(genIds 보유)는 생성물색(lane 없음=기본, 생성카드와 동일).
  const odk = comfyDeclaredKinds(cfg?.content);
  const hasSavedGen = !!(card.genIds?.length || card.genId);
  const outLane = hasSavedGen
    ? ""
    : odk.media || odk.text
      ? odk.media ? "ref" : "text"
      : comfyOutputMedia(card).length > 0 ? "ref" : cfg?.outputs?.length ? "text" : "";
  return (
    <>
      <div className="scene-card-hd comfy scene-card-hd-float">Comfy</div>
      <div className="scene-card-inner scene-comfynode">
        {!cfg?.content ? (
          <div
            className="scene-comfynode-empty"
            onDragOver={(e) => e.preventDefault()}
            onDrop={async (e) => {
              const f = e.dataTransfer.files?.[0];
              // .json(워크플로)만 가로챈다 — 이미지·에셋 드롭은 보드로 흘려보내 레퍼런스 카드가 되게.
              if (!f || !/\.json$/i.test(f.name)) return;
              e.preventDefault();
              e.stopPropagation();
              await actions.applyComfyApi(card.id, f.name.replace(/\.json$/i, ""), await f.text());
            }}
          >
            <span>API를 넣어주세요</span>
            <small>.json 드롭 또는 아래 버튼</small>
            {/* API 넣기 전에는 파라미터가 없으므로 P(파라미터 선택) 버튼을 두지 않는다. */}
            {/* API 를 불러오면(로드된 상태) 그때 P 버튼이 나타나 파라미터를 고른다. */}
            <button
              className="scene-comfynode-act"
              title="ComfyUI Export(API) .json 불러오기"
              onMouseDown={stop}
              onClick={(e) => {
                e.stopPropagation();
                actions.pickComfyFile(card.id);
              }}
            >
              📂 불러오기
            </button>
          </div>
        ) : (
          <div
            className="scene-comfynode-body"
            // 로드된 노드에도 .json 을 드롭하면 다른 API 로 교체(재파싱 성공 시에만).
            onDragOver={(e) => e.preventDefault()}
            onDrop={async (e) => {
              const f = e.dataTransfer.files?.[0];
              // .json(워크플로)만 가로채 교체 — 이미지·에셋은 보드로 흘려보낸다.
              if (!f || !/\.json$/i.test(f.name)) return;
              e.preventDefault();
              e.stopPropagation();
              await actions.applyComfyApi(card.id, f.name.replace(/\.json$/i, ""), await f.text());
            }}
          >
            <div className="scene-comfynode-name" title={cfg.name || ""}>
              <span className="scene-comfynode-nametext">
                {cfg.name || "workflow"} · {cfg.nodeCount || 0}노드
              </span>
              <span className="scene-comfynode-actions">
                <button
                  className="scene-comfynode-act"
                  title="다른 API(.json)로 교체"
                  onMouseDown={stop}
                  onClick={(e) => {
                    e.stopPropagation();
                    actions.pickComfyFile(card.id);
                  }}
                >
                  API
                </button>
                <button
                  className="scene-comfynode-act"
                  title="파라미터 선택"
                  onMouseDown={stop}
                  onClick={(e) => {
                    e.stopPropagation();
                    actions.setComfyModalId(card.id);
                  }}
                >
                  P
                </button>
                <button
                  className="scene-comfynode-act"
                  title="현재 워크플로우 다시 읽기(노드수 갱신·상태 리셋)"
                  onMouseDown={stop}
                  onClick={(e) => {
                    e.stopPropagation();
                    void actions.refreshComfy(card.id);
                  }}
                >
                  ↻
                </button>
              </span>
            </div>
            {(() => {
              // 연결된 입력 미리 보기 — 타입별 개수(실행 시 슬롯에 자동 주입).
              const inp = gatherComfyMedia(card.id, cards, edges, genData);
              const ni = inp.filter((m) => m.type === "image").length;
              const nv = inp.filter((m) => m.type === "video").length;
              return ni || nv || textDriven ? (
                <div className="scene-comfynode-inputs">
                  입력 {ni ? `🖼×${ni}` : ""} {nv ? `🎬×${nv}` : ""}
                  {textDriven ? " 🔗text" : ""}
                </div>
              ) : null;
            })()}
            {(() => {
              // 실행 중이면 미디어 영역을 Comfy 로고로 덮어 '작업 중'을 보인다(이전 결과가 있어도 우선).
              //  하단 상태 웨이브와 별개로, 생성물이 뜨는 자리에 브랜드 로고를 크게 표시.
              if (isRunning)
                return (
                  <div className="scene-comfynode-outputs">
                    <div className="scene-comfynode-loading">
                      <img src={comfyLogo} alt="Comfy 작업 중" className="scene-comfynode-loading-logo" draggable={false} />
                    </div>
                  </div>
                );
              // 실행 결과 — 텍스트는 스크롤 박스(+복사). 이미지/영상은 '대표(card.genId)'를
              // 생성카드(HistoryBoardNode)로 보여준다. 대표는 팝업에서 고르거나(setCardVariant)
              // 실행 시 최신으로 갱신 → 대표 선택·색상이 카드에 그대로 반영된다.
              const outs =
                cfg.outputs ||
                (cfg.output?.url ? [{ kind: cfg.output.kind, url: cfg.output.url }] : []);
              const textOuts = outs.filter((o) => o.kind === "text");
              const repId = card.genId || card.genIds?.[card.genIds.length - 1] || null;
              const repGen = repId ? genData[repId] : undefined;
              // 대표 gen 미로드(실행 직후 등)면 현재 실행 미디어를 인라인으로 폴백 표시.
              const mediaFallback = repGen
                ? []
                : outs.filter((o) => (o.kind === "image" || o.kind === "video") && o.url);
              if (!textOuts.length && !repGen && !mediaFallback.length) return null;
              const outputNodeW = Math.max(96, width - 24);
              const outputNodeH = 150;
              return (
                <div className="scene-comfynode-outputs">
                  {textOuts.map((o, i) => (
                    <div key={"t" + i} className="scene-comfynode-outtext">
                      <button
                        className="scene-comfynode-copy"
                        title="복사"
                        onMouseDown={stop}
                        onClick={(e) => {
                          e.stopPropagation();
                          void navigator.clipboard?.writeText(o.text || "");
                        }}
                      >
                        ⧉
                      </button>
                      <div className="scene-comfynode-outtext-body">{o.text}</div>
                    </div>
                  ))}
                  {repGen ? (
                    <div className="scene-comfynode-genwrap">
                      <HistoryBoardNode
                        generation={repGen}
                        x={0}
                        y={0}
                        width={outputNodeW}
                        height={outputNodeH}
                        isRoot={false}
                        isSelected={sel}
                        onLine={false}
                        offLine={false}
                        fill={fill}
                        disabled={hist.disabledIds.has(repGen.id)}
                        typeFilter={hist.typeFilter}
                        colorFilter={hist.colorFilter}
                        tagFilter={hist.tagFilter}
                        sharedOnly={hist.sharedOnly}
                        commentOnly={hist.commentOnly}
                        finalOnly={hist.finalOnly}
                        folderSel={hist.folderSel}
                        sConfirm={hist.sConfirm?.id === repGen.id ? hist.sConfirm : null}
                        onSClick={hist.onSClick}
                        onSDouble={hist.onSDouble}
                        onSConfirmYes={hist.onSConfirmYes}
                        onSConfirmNo={hist.onSConfirmNo}
                        onPreview={getNodePreview(card.id)}
                        onInfo={hist.onInfo || NOOP}
                        onRegenerate={() => {
                          void actions.runComfy(card.id);
                        }}
                        onTag={hist.onTag}
                        onOpenComments={hist.onOpenComments}
                      />
                      {card.id === tagEdit.cardId && tagEdit.nodeGenId === repGen.id && tagEdit.enabled && (
                        <div
                          className="scene-tagpop scene-comfynode-tagpop"
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          <TagEditor
                            tags={repGen.tags}
                            onChange={(next) => tagEdit.applyCardTags(repGen, next)}
                            global={
                              tagEdit.hasAutoTags
                                ? {
                                    all: tagEdit.autoTagOptions,
                                    assigned: repGen.auto_tags ?? [],
                                    onChange: (next) => tagEdit.applyCardAutoTags(repGen, next),
                                  }
                                : null
                            }
                            onClose={tagEdit.close}
                          />
                        </div>
                      )}
                    </div>
                  ) : (
                    mediaFallback.map((o, i) => (
                      <div key={"m" + i} className="scene-comfynode-preview">
                        {o.kind === "video" ? (
                          <video src={o.url} muted loop playsInline preload="metadata" />
                        ) : (
                          <img src={o.url} alt="" draggable={false} onError={hideBrokenImg} onLoad={showLoadedImg} />
                        )}
                      </div>
                    ))
                  )}
                </div>
              );
            })()}
            {params.length > 0 && (
              <div className="scene-comfynode-params">
                {params.map((p) => {
                  const v = values[p.key];
                  return (
                    <div key={p.key} className="scene-comfynode-param">
                      <label title={p.label}>{p.label}</label>
                      {p.type === "bool" ? (
                        <input
                          type="checkbox"
                          checked={!!v}
                          onMouseDown={stop}
                          onChange={(e) => actions.setComfyParam(card.id, p.key, e.target.checked)}
                          onBlur={() => actions.flushPending()}
                        />
                      ) : p.choices && p.choices.length ? (
                        <select
                          value={String(v ?? "")}
                          onMouseDown={stop}
                          onChange={(e) => {
                            const orig = p.choices?.find((ch) => String(ch) === e.target.value);
                            actions.setComfyParam(card.id, p.key, orig ?? e.target.value);
                          }}
                          onBlur={() => actions.flushPending()}
                        >
                          {p.choices.map((ch) => (
                            <option key={String(ch)} value={String(ch)}>
                              {String(ch)}
                            </option>
                          ))}
                        </select>
                      ) : p.type === "number" ? (
                        <input
                          type="number"
                          value={v == null ? "" : (v as number)}
                          onMouseDown={stop}
                          onChange={(e) => actions.setComfyParam(card.id, p.key, Number(e.target.value))}
                          onBlur={() => actions.flushPending()}
                        />
                      ) : p.type === "text" && drivenKeys.has(p.key) ? (
                        // 텍스트가 연결됨 → 비활성 + 연결된 텍스트 표시(실행 시 이 값이 자동 주입).
                        <input
                          type="text"
                          className="driven"
                          value={linkedText}
                          placeholder="연결된 텍스트"
                          disabled
                          title="텍스트가 연결됨 — 연결한 텍스트 노드의 값이 자동 입력됩니다(연결을 끊으면 다시 편집 가능)"
                        />
                      ) : (
                        <input
                          type="text"
                          value={String(v ?? "")}
                          onMouseDown={stop}
                          onChange={(e) => actions.setComfyParam(card.id, p.key, e.target.value)}
                          onBlur={() => actions.flushPending()}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {/* 현재 상태 — 실행 중이면 생성카드와 같은 웨이브(생성중), 아니면 대기/완료/실패 텍스트. */}
            {isRunning ? (
              <div className="scene-comfynode-status s-running">
                <span className="gen-generating">
                  <span className="gen-wave" aria-hidden>
                    <span className="gen-wave-bar" />
                    <span className="gen-wave-bar" />
                    <span className="gen-wave-bar" />
                    <span className="gen-wave-bar" />
                    <span className="gen-wave-bar" />
                  </span>
                  <span className="gen-generating-label">생성중</span>
                </span>
              </div>
            ) : (
              <div className={"scene-comfynode-status s-" + (st || "idle")}>
                ● {st === "done" ? "완료" : st === "failed" ? "실패" : "대기"}
              </div>
            )}
            {st === "failed" && cfg.error && (
              <div className="scene-comfynode-errwrap">
                <button
                  className="scene-comfynode-copy"
                  title="에러 메시지 복사"
                  onMouseDown={stop}
                  onClick={(e) => {
                    e.stopPropagation();
                    void navigator.clipboard?.writeText(cfg.error || "");
                  }}
                >
                  ⧉
                </button>
                <div className="scene-comfynode-err" title={cfg.error}>
                  실패: {cfg.error}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      {/* 결과 배지 — 이 노드가 만든 생성물이 있으면 카드 위에 떠서 표시. 클릭=변형 팝업으로 모아보기. */}
      {variantIds(card).length > 0 && (
        <button
          className="scene-multi-badge scene-multi-badge-comfy"
          title={`이 노드의 생성 결과 ${variantIds(card).length}개 모두 보기`}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            actions.setCardMenu(card.id);
          }}
        >
          ▤ {variantIds(card).length}
        </button>
      )}
      {cfg?.content && sel && (
        // 실행 버튼 — 생성카드 Generate 처럼 카드 '밑'에 바로 표시(선택 시). 배치 N=여러 장 한 번에.
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
            disabled={isRunning}
            onClick={(e) => {
              e.stopPropagation();
              void actions.runComfy(card.id);
            }}
          >
            {isRunning ? "실행 중…" : "실행 ▶"}
          </button>
        </div>
      )}
      {/* 미디어 입력(레퍼런스/생성물 → LoadImage/LoadVideo)=ref 레인(중앙). 텍스트 파라미터가
          노출돼 있으면 아래(text 레인)에 텍스트 입력 포트(보라)도 추가 — 다른 카드와 같은 고정 간격. */}
      <span
        className={"scene-port in" + (hasTextParam ? " lane-ref" : "")}
        style={hasTextParam ? { top: `calc(50% + ${laneDelta("ref")}px)` } : undefined}
        title="레퍼런스·생성물·리스트 연결 → 타입별로 LoadImage/LoadVideo 에 자동 주입"
      />
      {hasTextParam && (
        <span
          className="scene-port in lane-text"
          style={{ top: `calc(50% + ${laneDelta("text")}px)` }}
          title="텍스트 연결 → 노출된 text 파라미터에 자동 입력(연결 중엔 입력칸 비활성)"
        />
      )}
      <span
        className={"scene-port out" + (outLane ? " lane-" + outLane : "")}
        onMouseDown={(e) => actions.onOutPortDown(e, card.id)}
        title={
          outLane === "text"
            ? "텍스트 출력 — 드래그해 연결"
            : outLane === "ref"
              ? "이미지·영상 출력 — 드래그해 연결"
              : "드래그해 다른 노드에 연결"
        }
      />
      <span
        className="scene-resize"
        onMouseDown={(e) => actions.onResizeDown(e, card.id)}
        title="드래그해 크기 조절"
      />
    </>
  );
}
