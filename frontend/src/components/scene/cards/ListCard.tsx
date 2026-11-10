// 리스트(동종 수집기) 카드 본문 — SceneBoard 렌더 분할(R2). 셸은 부모 소유, Fragment 만 반환(규칙은 OutputCard 참고).
//  순서변경(startReorder)이 쓰는 data-reorder / data-reid 속성은 반드시 보존한다.
import { ownEntry } from "../../../lib/ownEntry";
import type React from "react";
import type { CSSProperties } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SceneCard, SceneEdge } from "../../../lib/scenes";
import { variantIds } from "../../../lib/scenes";
import type { Generation, PreviewTarget } from "../../../types";
import { collectListInputs, collectRenderGenCardIds, effectiveTextOf } from "../../../lib/sceneEdges";
import { refThumbSrc } from "../../../lib/sceneMedia";
import { useEscapeClose } from "../../../lib/useEscapeClose";
import { isTopLayer, isTypingTarget, useModalFocus } from "../../../lib/keyGate";
import { refServerStatus } from "../../../lib/sceneAssetRelink";
import { hideBrokenImg, showLoadedImg, thumbOf } from "../../../lib/media";
import { copyText } from "../../../lib/flash";
import { CloudOffIcon, LinkOffIcon } from "../../common/ViewIcons";
import { CARD_W } from "../sceneColors";

// 격자 칸 번호 알약 색 = 종류(이미지 파랑·영상 라임·오디오 보라 — 레퍼런스 줄과 같은 규칙, Jay 2026-10-29)
const kindOf = (type?: string) => (type === "video" ? "video" : type === "audio" ? "audio" : "image");
// 오디오는 썸네일이 없다 — 에셋 창 오디오 카드와 같은 음표 타일
const audioTile = <div className="audio-tile"><span className="audio-glyph">🎵</span></div>;

export function ListCard({
  card,
  cardsById,
  resolvedEdges,
  genData,
  disabledIds,
  rowSel,
  reorderFrom,
  cardWidth,
  workspaceId,
  toggleRowSel,
  startReorder,
  getNodePreview,
  setCardMenu,
  addListAsReference,
  onOutPortDown,
  onResizeDown,
  reorderable = false,
}: {
  card: SceneCard;
  cardsById: Map<string, SceneCard>;
  resolvedEdges: SceneEdge[];
  genData: Record<string, Generation>;
  disabledIds: Set<string>;
  rowSel: { listId: string; cids: Set<string> };
  reorderFrom: string | null;
  cardWidth: number; // widthOf(card) — 부모 계산(head 폭 측정 ref 의존이라 값으로 받음)
  workspaceId: string; // 서버에 없는 레퍼런스 판정의 열쇠(캔버스 탭의 공간) — ReferenceCard 와 같은 값
  toggleRowSel: (listId: string, cid: string, additive: boolean) => void;
  startReorder: (e: React.MouseEvent, listId: string, cid: string, axis: "v" | "h") => void;
  getNodePreview: (cardId: string) => (p: PreviewTarget) => void;
  setCardMenu: (cardId: string | null) => void;
  addListAsReference: (generationCardIds: string[]) => void;
  onOutPortDown: (e: React.MouseEvent, cardId: string) => void;
  onResizeDown: (e: React.MouseEvent, cardId: string) => void;
  // 순서 바꾸기는 더블클릭 팝업에서만(Jay 2026-11-09). 캔버스 노드에서는 그립을 숨기고 썸네일을 눌러도 노드를 끈다.
  reorderable?: boolean;
}) {
  const moveTip = reorderable ? "\n드래그 = 순서 바꾸기" : "\n더블클릭 = 크게 보고 순서 바꾸기";
  // 동종 수집기 — 생성카드들(→View 재생) 또는 텍스트들(→합친 텍스트). input(무선)은 실제 소스로 해석.
  const li = collectListInputs(card.id, cardsById, resolvedEdges);
  const label =
    li.kind === "generation"
      ? `생성물 ${li.generationCardIds.length}개`
      : li.kind === "text"
        ? `텍스트 ${li.sourceIds.length}개`
        : li.kind === "reference"
          ? `레퍼런스 ${li.referenceCardIds.length}개`
          : li.kind === "mixed"
            ? "⚠ 혼합 입력(사용 불가)"
            : li.kind === "invalid"
              ? "⚠ 잘못된 입력"
              : (
                  <>
                    생성/텍스트/레퍼런스
                    <br />
                    노드 연결
                  </>
                ); // 두 줄 가운데(Jay 2026-10-30 — 전엔 한 줄이 아무 데서나 꺾였다)
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
                      {reorderable && (
                        <span
                          className="scene-listrow-grip"
                          title="드래그 = 순서 바꾸기"
                          onMouseDown={(e) => startReorder(e, card.id, cid, "v")}
                          onClick={(e) => e.stopPropagation()}
                        >
                          ⠿
                        </span>
                      )}
                      <span className="scene-listrow-count">
                        <span className="scene-listrow-badge">
                          {gc.kind === "render" ? "렌더" : "리스트"} {nestedCount}
                        </span>
                      </span>
                    </div>
                  );
                }
                const gid = gc?.genId || (gc ? variantIds(gc)[0] : undefined);
                const gen = gid ? ownEntry(genData, gid) : undefined;
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
                    {reorderable && (
                      <span
                        className="scene-listrow-grip"
                        title="드래그 = 순서 바꾸기"
                        onMouseDown={(e) => startReorder(e, card.id, cid, "v")}
                        onClick={(e) => e.stopPropagation()}
                      >
                        ⠿
                      </span>
                    )}
                    <span
                      className="scene-listrow-view"
                      title={gen?.assets?.[0] ? "클릭 = 크게 보기" : undefined}
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
                      title={n > 0 ? "클릭 = 이 카드의 생성 결과 모두 보기" : undefined}
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
                    {reorderable && (
                      <span
                        className="scene-listrow-grip"
                        title="드래그 = 순서 바꾸기"
                        onMouseDown={(e) => startReorder(e, card.id, cid, "v")}
                        onClick={(e) => e.stopPropagation()}
                      >
                        ⠿
                      </span>
                    )}
                    <span className="scene-listrow-text">{txt || "(빈 텍스트)"}</span>
                  </div>
                );
              })}
            </div>
          ) : li.kind === "reference" ? (
            // 레퍼런스 카드들 — 카드마다 대표 썸네일(첫 장)+장수 배지, 드래그해 순서 변경.
            //  썸네일·배지 크기는 리스트 카드 크기에 비례(listThumbsStyle: 그리드 열폭 + 배지 글씨).
            <div className="scene-listthumbs" data-reorder style={listThumbsStyle}>
              {li.referenceCardIds.map((cid, i) => {
                const rc = cardsById.get(cid);
                if (rc && rc.kind !== "reference") {
                  // 레퍼런스 + 생성물로 섞인 리스트의 생성물 항목(2026-10-22) — 그 결과물 한 장(장수 배지·서버 판정 없음)
                  const gid = rc.genId || variantIds(rc)[0];
                  const gen = gid ? ownEntry(genData, gid) : undefined;
                  const genSrc = gen ? thumbOf(gen, 128) : null;
                  const genKind = kindOf(gen?.assets?.[0]?.type);
                  return (
                    <div
                      key={cid}
                      className={"scene-listthumb" + (reorderFrom === cid ? " reordering" : "")}
                      data-reid={cid}
                      title={`${i + 1}번 · 생성물` + moveTip}
                      onMouseDown={reorderable ? (e) => startReorder(e, card.id, cid, "h") : undefined}
                    >
                      {genKind === "audio" ? (
                        audioTile
                      ) : genSrc ? (
                        <img src={genSrc} alt="" draggable={false} onError={hideBrokenImg} onLoad={showLoadedImg} />
                      ) : (
                        <span className="scene-listthumb-ph" />
                      )}
                      <span className={`scene-listthumb-n k-${genKind}`}>{i + 1}</span>
                    </div>
                  );
                }
                const refs = rc?.refs || [];
                const src = refs[0] ? refThumbSrc(refs[0]) : null;
                const refKind = kindOf(refs[0]?.type); // 대표(첫 장)의 종류
                // 서버에 없는 레퍼런스(Jay 2026-09-29) — 대표(첫 장)가 서버에 없으면 붉은 빗금 + 아이콘,
                //  그 밖에 서버에 없는 장이 있으면(이 PC 에만 등) 오른쪽 위 마크. 판정은 ReferenceCard 와 같은 가게.
                const first = refs[0] ? refServerStatus(workspaceId, refs[0]) : undefined;
                // 판정 못 끝냄(incomplete)은 표시하지 않는다 — 없는지 모른다
                const statuses = refs.map((r) => refServerStatus(workspaceId, r));
                const flagged = statuses.some((st) => st && st !== "incomplete");
                const anyHeld = statuses.includes("held");
                return (
                  <div
                    key={cid}
                    className={"scene-listthumb" + (reorderFrom === cid ? " reordering" : "")}
                    data-reid={cid}
                    title={
                      `${i + 1}번 · 레퍼런스 ${refs.length}장` +
                      (anyHeld ? "\n연결 안 된 레퍼런스 있음" : flagged ? "\n서버에 없는 레퍼런스 있음" : "") +
                      moveTip
                    }
                    data-tip-tone={anyHeld || flagged ? "bad" : undefined}
                    onMouseDown={reorderable ? (e) => startReorder(e, card.id, cid, "h") : undefined}
                  >
                    {first === "missing" || first === "held" ? (
                      <>
                        <span className="scene-listthumb-ph off-server" />
                        <span className="scene-ref-offmini">{first === "held" ? <LinkOffIcon /> : <CloudOffIcon />}</span>
                      </>
                    ) : refKind === "audio" ? (
                      audioTile
                    ) : src ? (
                      <img src={src} alt="" draggable={false} onError={hideBrokenImg} onLoad={showLoadedImg} />
                    ) : (
                      <span className="scene-listthumb-ph" />
                    )}
                    <span className={`scene-listthumb-n k-${refKind}`}>{i + 1}</span>
                    {refs.length > 1 && (
                      <span className="scene-listthumb-cnt">{refs.length}</span>
                    )}
                    {flagged && first !== "missing" && first !== "held" && (
                      <span
                        className="scene-ref-offmark"
                        role="img"
                        aria-label="서버에 없음"
                        title={
                          first === "local"
                            ? "이 PC 에만 있음\n서버에 없음 — 다른 사람에게는 안 보입니다"
                            : anyHeld
                              ? "이 카드의 레퍼런스\n연결 안 된 것이 있습니다"
                              : "이 카드의 레퍼런스\n서버에 없는 것이 있습니다"
                        }
                        data-tip-tone={first === "local" ? "warn" : "bad"}
                      >
                        {anyHeld && first !== "local" ? <LinkOffIcon /> : <CloudOffIcon />}
                      </span>
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
            void copyText(li.text);
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
      <span className="scene-port in" title={"리스트 입력\n생성·텍스트·레퍼런스 카드를 이어 모은다"} />
      <span
        className="scene-port out"
        onMouseDown={(e) => onOutPortDown(e, card.id)}
        title={"리스트 출력\n드래그 = View(재생)·생성 카드에 연결"}
      />
      <span
        className="scene-resize"
        onMouseDown={(e) => onResizeDown(e, card.id)}
        title="드래그 = 크기 조절"
      />
    </>
  );
}

// 크게 보기 격자의 열 수(Jay 2026-11-10 시안) — 노드와 같은 열, 5줄을 넘으면 열을 늘리되 5열까지(나머지는 줄로).
export function listPopCols(n: number, nodeCols: number): number {
  let cols = Math.max(1, Math.min(nodeCols, n));
  if (Math.ceil(n / cols) > 5) cols = Math.ceil(n / 5);
  return Math.min(cols, 5);
}

// 크게 보기 배율(Jay 2026-11-10 "지금 크게 보이는 부분을 고정 · 밑에 내려야 보이는 것도 모두 보이게"). 캔버스 줌과 상관없이
//  한 칸(item = 격자 칸 폭·행 높이, 레이아웃 px)을 화면에서 격자 104px·행 44px 로 고정. w×h = 모든 칸이 보이는 레이아웃 크기.
//  가용 폭 80%·높이 75% 를 넘으면 줄이고, 높이 때문에 격자 48px·행 32px 아래로 가야 하면 거기서 멈추고 보일 높이(h)를 잘라 스크롤.
//  item 을 못 재면 원래 크기(1)까지만.
export function listPopScale(o: { item: number; grid: boolean; w: number; h: number; availW: number; availH: number }): { k: number; h: number } {
  const kW = (o.availW * 0.8) / o.w, kH = (o.availH * 0.75) / o.h;
  if (!(Number.isFinite(o.item) && o.item > 0)) return { k: Math.min(1, kW, kH), h: o.h };
  const [lo, hi] = o.grid ? [48, 104] : [32, 44];
  const k = Math.min(hi / o.item, kW, kH);
  if (k * o.item < lo && kH < kW) {
    const k2 = Math.min(lo / o.item, kW); // 폭 상한은 스크롤로 못 풀어 그대로 지킨다
    return { k: k2, h: Math.min(o.h, (o.availH * 0.75) / k2) };
  }
  return { k, h: o.h };
}

// ── 크게 보기 팝업(Jay 2026-11-09 — "지금 보이는 노드 그대로, 그 자리에서 크게"). 속은 같은 ListCard 를 children 으로 그대로 그리고,
//  틀만 노드 가운데를 기준으로 배율을 키운다(배율 = listPopScale). 순서 끌기는 노드의 startReorder 그대로 —
//  칸 위치를 화면 좌표로 재므로 배율과 상관없고, 저장도 노드와 같은 orderListItems 다.
export function ListPopup({
  kindCls,
  w,
  h,
  at,
  onUndo,
  onRedo,
  onClose,
  children,
}: {
  kindCls: string; // 노드 틀과 같은 종류 클래스(scene-card-list lk-*)
  w: number; // 노드의 레이아웃 크기(캔버스 배율 전)
  h: number;
  at: { x: number; y: number }; // 노드 가운데의 화면 좌표
  // shortcut: 안 쓴다 — 11-10 부터 크기는 줌과 상관없이 고정(listPopScale). SceneBoard 를 다른 세션이 고치는 중이라 넘기는 쪽 정리는 다음에.
  shown?: number;
  // 팝업이 떠 있는 동안 캔버스 단축키는 쉰다(keyGate) — 되돌리기는 팝업이 직접 캔버스의 것을 부른다(Jay 11-09 "Ctrl+Z 안 되나")
  onUndo: () => void;
  onRedo: () => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const backRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // 두 단계로 잰다(Jay 2026-11-10 '칸에 맞춤'): ① 노드 그대로 그려 배치(격자 여부·열·한 칸)를 고르고 ② 그 배치로 틀을 내용 크기로 그려
  //  모든 칸이 보이는 전체 크기를 잰 뒤 배율·자리를 정한다. 다 정할 때까지 숨겨 둔다(둘 다 그리기 전 동기 갱신이라 깜박이지 않는다).
  const [fit, setFit] = useState<{ grid: boolean; cols: number; item: number } | null>(null);
  const fullRef = useRef<{ w: number; h: number } | null>(null); // ② 에서 잰 전체 크기 — 스크롤로 높이를 자른 뒤 다시 재지 않게
  const [box, setBox] = useState<{ left: number; top: number; k: number; w: number; h: number; scroll: boolean } | null>(null);
  const undoRef = useRef(onUndo);
  undoRef.current = onUndo;
  const redoRef = useRef(onRedo);
  redoRef.current = onRedo;
  const layer = useEscapeClose(onClose);
  useModalFocus(layerRef);
  // 막의 실제 자리를 재서 놓는다(fixed 의 기준이 늘 화면이라고 가정하지 않는다).
  //  shortcut: 브라우저 창 크기를 바꿔도 다시 재지 않는다 — 다시 열면 맞는다. 필요하면 resize 에 다시 재기.
  useLayoutEffect(() => {
    const b = backRef.current?.getBoundingClientRect();
    const card = cardRef.current;
    if (!b || !card) return;
    if (!fit) {
      // ① 한 칸 = 첫 항목(격자 칸·행 — 모두 같은 크기). offset 은 transform 전 레이아웃 크기다. 노드 열 수 = 첫 칸과 같은 줄의 칸 수.
      const first = card.querySelector<HTMLElement>("[data-reid]");
      const grid = !!first?.classList.contains("scene-listthumb");
      let cols = 1;
      if (first && grid) {
        const cells = Array.from(first.parentElement?.children ?? []).filter(
          (el): el is HTMLElement => el instanceof HTMLElement && el.hasAttribute("data-reid"),
        );
        cols = listPopCols(cells.length, cells.filter((el) => el.offsetTop === first.offsetTop).length);
      }
      setFit({ grid, cols, item: first ? (grid ? first.offsetWidth : first.offsetHeight) : 0 });
      return;
    }
    const M = 24, LABEL = 30, HINT = 34; // 위 이름표·아래 안내 자리
    const availW = b.width - 2 * M, availH = b.height - 2 * M - LABEL - HINT;
    if (availW <= 0 || availH <= 0) return; // 놓을 자리가 없으면 숨긴 채 둔다(음수 배율 방지)
    const full = fullRef.current ?? (fullRef.current = { w: card.offsetWidth, h: card.offsetHeight }); // ② 틀이 내용 크기일 때 잰다
    if (!(full.w > 0 && full.h > 0)) return;
    const s = listPopScale({ item: fit.item, grid: fit.grid, w: full.w, h: full.h, availW, availH });
    const sw = full.w * s.k, sh = s.h * s.k; // 자리는 실제로 보일 크기(스크롤이면 자른 높이)로
    const left = Math.min(Math.max(at.x - b.left - sw / 2, M), b.width - M - sw);
    const top = Math.min(Math.max(at.y - b.top - sh / 2, M + LABEL), b.height - M - HINT - sh);
    setBox({ left, top, k: s.k, w: full.w, h: s.h, scroll: s.h < full.h - 0.5 });
  }, [w, h, at.x, at.y, fit]);
  // 팝업 안 Ctrl+Z 로 항목이 늘거나 줄면(또는 종류가 바뀌면) 처음부터 다시 잰다 — 순서만 바뀐 것은 크기가 같아 그대로.
  const shapeRef = useRef("");
  useLayoutEffect(() => {
    const cells = cardRef.current?.querySelectorAll("[data-reid]");
    const shape = `${cells?.length ?? 0}:${!!cells?.[0]?.classList.contains("scene-listthumb")}`;
    if (shapeRef.current && shape !== shapeRef.current) {
      fullRef.current = null;
      setBox(null);
      setFit(null);
    }
    shapeRef.current = shape;
  });
  // ② 의 틀 — 격자는 정한 열(--lp-cols)로 폭·높이를 내용 크기에, 행은 노드 폭에 높이만 내용 크기에(scene.css .scene-listpop.fit).
  //  다 정한 뒤에는 잰 크기를 그대로 박아 두고, 너무 많으면 .scroll 로 높이를 잘라 노드처럼 스크롤.
  const cardStyle: CSSProperties = {
    width: box ? box.w : fit?.grid ? undefined : w,
    height: box ? box.h : fit ? undefined : h,
    transform: `scale(${box?.k ?? 1})`,
  };
  if (fit?.grid) Object.assign(cardStyle, { "--lp-cols": fit.cols, "--lp-tile": `${fit.item}px` });
  useEffect(() => {
    // 캔버스와 같은 키(lib/sceneKeyboard): Ctrl+Z 되돌리기, Ctrl+Shift+Z 다시 하기 — 초점과 상관없이 받는다(보드가 누름마다 초점을 가져간다)
    const onKey = (e: KeyboardEvent) => {
      if (!isTopLayer(layer) || isTypingTarget(e.target)) return; // 위에 크게 보기 등이 떠 있으면 그쪽 키
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      (e.shiftKey ? redoRef : undoRef).current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [layer]);
  return (
    <div
      ref={backRef}
      className="scene-listpop-backdrop"
      onMouseDown={(e) => {
        e.stopPropagation(); // 뒤 보드의 고르기·끌기로 번지지 않게
        onClose();
      }}
    >
      <div
        ref={layerRef}
        className="scene-listpop-layer"
        role="dialog"
        aria-label="리스트 크게 보기"
        tabIndex={-1}
        style={box ? { left: box.left, top: box.top, width: box.w * box.k, height: box.h * box.k } : { visibility: "hidden" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          ref={cardRef}
          className={"scene-card sel scene-listpop " + kindCls + (fit ? (fit.grid ? " fit grid" : " fit") : "") + (box?.scroll ? " scroll" : "")}
          style={cardStyle}
        >
          {children}
        </div>
        <button type="button" className="scene-listpop-x" title="닫기" aria-label="닫기" onClick={onClose}>
          <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
        <div className="scene-listpop-hint">
          끌어서 순서 바꾸기 · <kbd>Ctrl</kbd>+<kbd>Z</kbd> 되돌리기 · <kbd>Esc</kbd> 닫기
        </div>
      </div>
    </div>
  );
}
