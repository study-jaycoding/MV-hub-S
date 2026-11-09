// 리스트(동종 수집기) 카드 본문 — SceneBoard 렌더 분할(R2). 셸은 부모 소유, Fragment 만 반환(규칙은 OutputCard 참고).
//  순서변경(startReorder)이 쓰는 data-reorder / data-reid 속성은 반드시 보존한다.
import { ownEntry } from "../../../lib/ownEntry";
import type React from "react";
import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import type { SceneCard, SceneEdge } from "../../../lib/scenes";
import { variantIds } from "../../../lib/scenes";
import type { Generation, PreviewTarget } from "../../../types";
import { collectListInputs, collectRenderGenCardIds, effectiveTextOf } from "../../../lib/sceneEdges";
import { refMediaSrc, refMediaType, refThumbSrc } from "../../../lib/sceneMedia";
import { useEscapeClose } from "../../../lib/useEscapeClose";
import { useModalFocus } from "../../../lib/keyGate";
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
}) {
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
                      <span
                        className="scene-listrow-grip"
                        title="드래그 = 순서 바꾸기"
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
                    <span
                      className="scene-listrow-grip"
                      title="드래그 = 순서 바꾸기"
                      onMouseDown={(e) => startReorder(e, card.id, cid, "v")}
                      onClick={(e) => e.stopPropagation()}
                    >
                      ⠿
                    </span>
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
                    <span
                      className="scene-listrow-grip"
                      title="드래그 = 순서 바꾸기"
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
                      title={`${i + 1}번 · 생성물\n드래그 = 순서 바꾸기`}
                      onMouseDown={(e) => startReorder(e, card.id, cid, "h")}
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
                      "\n드래그 = 순서 바꾸기"
                    }
                    data-tip-tone={anyHeld || flagged ? "bad" : undefined}
                    onMouseDown={(e) => startReorder(e, card.id, cid, "h")}
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

// ── 크게 보기 창(Jay 2026-11-09 시안 A) — 리스트 더블클릭. 칸을 끌거나 Ctrl+방향키로 순서를 바꾼다.
//  저장은 노드 끌기와 같은 길(SceneBoard.reorderListToIndex → orderListItems)이라 창과 노드 순서가 어긋나지 않는다.
//  놓을 자리는 창이 자기 칸으로 센다 — 노드의 startReorder 는 리스트 단독 선택이 조건이고 선을 캔버스 층(창 아래)에 그린다.
const KIND_LABEL = { image: "이미지", video: "영상", audio: "오디오" } as const;
type WinItem = {
  id: string;
  src: string | null;
  kind: "image" | "video" | "audio";
  name: string;
  meta: string;
  count?: number;
  off?: "missing" | "held";
  preview?: PreviewTarget;
};

export function ListWindow({
  listId,
  cardsById,
  resolvedEdges,
  genData,
  workspaceId,
  onMove,
  onPreview,
  onUndo,
  onRedo,
  onClose,
}: {
  listId: string;
  cardsById: Map<string, SceneCard>;
  resolvedEdges: SceneEdge[];
  genData: Record<string, Generation>;
  workspaceId: string;
  onMove: (cid: string, insertIndex: number) => void; // insertIndex = 지금 순서 기준 0..n(reorderListToIndex 와 같은 뜻)
  onPreview: (cid: string, p: PreviewTarget) => void;
  // 창이 떠 있는 동안 캔버스 단축키는 쉰다(keyGate) — 되돌리기는 창이 직접 캔버스의 것을 부른다(Jay 11-09 "Ctrl+Z 안 되나")
  onUndo: () => void;
  onRedo: () => void;
  onClose: () => void;
}) {
  const winRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragEnd = useRef<(() => void) | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; bar: { x: number; y: number; w: number; h: number } | null } | null>(null);
  useEscapeClose(onClose);
  useModalFocus(winRef);
  useEffect(() => {
    winRef.current?.focus({ preventScroll: true }); // 열자마자 Ctrl+Z·Ctrl+방향키가 창에 오게
    return () => dragEnd.current?.(); // 끄는 중에 닫혀도 창 밖 리스너가 남지 않게
  }, []);

  const li = collectListInputs(listId, cardsById, resolvedEdges);
  const rows = li.kind === "text";
  const ids = li.kind === "reference" ? li.referenceCardIds : li.kind === "generation" || rows ? li.sourceIds : [];
  const lk = li.kind === "reference" || li.kind === "text" || li.kind === "generation" ? li.kind : "empty";

  const itemOf = (cid: string): WinItem => {
    const c = cardsById.get(cid);
    if (rows) return { id: cid, src: null, kind: "image", name: effectiveTextOf(cid, cardsById, resolvedEdges).trim() || "(빈 텍스트)", meta: "" };
    if (c?.kind === "reference") {
      const refs = c.refs || [];
      const first = refs[0];
      const st = first ? refServerStatus(workspaceId, first) : undefined;
      const off = st === "missing" || st === "held" ? st : undefined;
      const kind = kindOf(first?.type);
      const url = first && !off ? refMediaSrc(first) : undefined;
      return {
        id: cid,
        src: first ? refThumbSrc(first) ?? null : null,
        kind,
        name: first?.name || "레퍼런스",
        meta: KIND_LABEL[kind] + (refs.length > 1 ? ` ${refs.length}장` : ""),
        count: refs.length,
        off,
        preview: url && first ? { url, type: refMediaType(first), name: first.name || "레퍼런스" } : undefined,
      };
    }
    if (c?.kind === "list" || c?.kind === "render") {
      const nested = c.kind === "list" ? collectListInputs(c.id, cardsById, resolvedEdges) : null;
      const n = nested ? (nested.kind === "generation" ? nested.generationCardIds.length : 0) : collectRenderGenCardIds(c.id, cardsById, resolvedEdges).length;
      return { id: cid, src: null, kind: "image", name: `${c.kind === "render" ? "렌더" : "리스트"} ${n}`, meta: "중첩 소스" };
    }
    const gid = c?.genId || (c ? variantIds(c)[0] : undefined);
    const gen = gid ? ownEntry(genData, gid) : undefined;
    const a = gen?.assets?.[0];
    const kind = kindOf(a?.type);
    return {
      id: cid,
      src: gen ? thumbOf(gen, 512) : null,
      kind,
      name: gen?.prompt?.slice(0, 60) || (gid ? "생성물" : "빈 카드"),
      meta: "생성물 · " + KIND_LABEL[kind],
      preview: a && gid ? { url: a.file_path, type: a.type, name: gen?.prompt?.slice(0, 50) || "결과", genId: gid } : undefined,
    };
  };

  // 포인터 자리 → 놓을 자리(0..n)와 표시 막대. 격자 = 가장 가까운 칸의 왼쪽/오른쪽(노드의 가로 썸네일과 같은 규칙), 줄 = 위/아래.
  const insertAt = (cx: number, cy: number) => {
    const body = bodyRef.current;
    const els = Array.from(body?.querySelectorAll<HTMLElement>("[data-wid]") ?? []);
    if (!body || !els.length) return null;
    let idx = els.length;
    if (rows) {
      for (let i = 0; i < els.length; i++) {
        const r = els[i].getBoundingClientRect();
        if (cy < r.top + r.height / 2) { idx = i; break; }
      }
    } else {
      let best = 0, bestD = Infinity, after = false;
      els.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const d = Math.hypot(cx - (r.left + r.width / 2), cy - (r.top + r.height / 2));
        if (d < bestD) { bestD = d; best = i; after = cx > r.left + r.width / 2; }
      });
      idx = after ? best + 1 : best;
    }
    const box = body.getBoundingClientRect();
    const end = idx >= els.length;
    const r = els[end ? els.length - 1 : idx].getBoundingClientRect();
    const top = body.scrollTop - box.top;
    const bar = rows
      ? { x: r.left - box.left, y: (end ? r.bottom + 4 : r.top - 7) + top, w: r.width, h: 3 }
      : { x: (end ? r.right + 7 : r.left - 11) - box.left, y: r.top + top, w: 4, h: r.height };
    return { idx, bar };
  };

  const onTileDown = (e: React.MouseEvent, cid: string) => {
    if (e.button !== 0) return;
    e.preventDefault(); // 그림 끌기·글자 긁기 막기 — 초점은 창에 둔다(Ctrl+방향키)
    winRef.current?.focus({ preventScroll: true });
    setPicked(cid);
    const sx = e.clientX, sy = e.clientY;
    let moved = false, at = -1;
    const move = (ev: MouseEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) <= 4) return; // 그냥 누르기·두 번 누르기는 끌기가 아니다
      moved = true;
      const hit = insertAt(ev.clientX, ev.clientY);
      at = hit ? hit.idx : -1;
      setDrag({ id: cid, x: ev.clientX, y: ev.clientY, bar: hit?.bar ?? null });
    };
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("blur", stop);
      dragEnd.current = null;
      setDrag(null);
    };
    const up = () => {
      stop();
      if (moved && at >= 0) onMove(cid, at); // 제자리면 reorderListToIndex 가 아무것도 안 한다
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("blur", stop); // 창 밖으로 초점이 나가면 순서는 그대로, 표시만 정리
    dragEnd.current = stop;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // 캔버스와 같은 키(lib/sceneKeyboard): Ctrl+Z 되돌리기, Ctrl+Shift+Z 다시 하기. 끄는 중에는 순서가 바뀌는 중이라 쉰다.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (!dragEnd.current) (e.shiftKey ? onRedo : onUndo)();
      return;
    }
    if (!e.ctrlKey || e.altKey || !picked) return; // Alt+←/→ 는 브라우저의 뒤로/앞으로
    const back = e.key === "ArrowLeft" || (rows && e.key === "ArrowUp");
    const fwd = e.key === "ArrowRight" || (rows && e.key === "ArrowDown");
    const i = ids.indexOf(picked);
    if ((!back && !fwd) || i < 0) return;
    e.preventDefault();
    if (back && i > 0) onMove(picked, i - 1);
    if (fwd && i < ids.length - 1) onMove(picked, i + 2);
  };

  const items = ids.map(itemOf);
  const ghost = drag ? items.find((it) => it.id === drag.id) : undefined;
  const title = li.kind === "reference" ? "레퍼런스" : li.kind === "text" ? "텍스트" : "생성물";
  return (
    <div className="scene-listwin-backdrop" onMouseDown={onClose}>
      <div
        ref={winRef}
        className={"scene-listwin lk-" + lk}
        role="dialog"
        aria-label={`리스트 · ${title} ${ids.length}개`}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="scene-listwin-hd">
          <span className="scene-listwin-chip">리스트</span>
          <b>{title} {ids.length}개</b>
          <span className="scene-listwin-sp" />
          <span className="scene-listwin-tip">끌어서 순서 바꾸기</span>
          <button type="button" className="scene-listwin-x" title="닫기" aria-label="닫기" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div ref={bodyRef} className={"scene-listwin-body" + (rows ? " rows" : "")}>
          {items.length === 0 ? (
            <div className="scene-listwin-empty">연결된 항목이 없습니다</div>
          ) : (
            items.map((it, i) => (
              <div
                key={it.id}
                data-wid={it.id}
                className={"scene-listwin-item" + (picked === it.id ? " picked" : "") + (drag?.id === it.id ? " from" : "")}
                title={it.preview ? "끌기 = 순서 바꾸기\n더블클릭 = 크게 보기" : "끌기 = 순서 바꾸기"}
                onMouseDown={(e) => onTileDown(e, it.id)}
                onDoubleClick={() => it.preview && onPreview(it.id, it.preview)}
              >
                {rows ? (
                  <>
                    <span className="scene-listwin-n">{i + 1}</span>
                    <span className="scene-listwin-text">{it.name}</span>
                  </>
                ) : (
                  <>
                    <div className="scene-listwin-media">
                      {it.off ? (
                        <span className="scene-listwin-off">{it.off === "held" ? <LinkOffIcon /> : <CloudOffIcon />}</span>
                      ) : it.kind === "audio" ? (
                        audioTile
                      ) : it.src ? (
                        <img src={it.src} alt="" draggable={false} onError={hideBrokenImg} onLoad={showLoadedImg} />
                      ) : null}
                      {it.kind === "video" && !it.off && <span className="scene-listwin-play">▶ 영상</span>}
                      {(it.count ?? 0) > 1 && <span className="scene-listwin-cnt">{it.count}장</span>}
                    </div>
                    <span className={`scene-listwin-n k-${it.kind}`}>{i + 1}</span>
                    <div className="scene-listwin-name">{it.name}</div>
                    <div className="scene-listwin-meta">{it.meta}</div>
                  </>
                )}
              </div>
            ))
          )}
          {drag?.bar && (
            <span className="scene-listwin-bar" style={{ left: drag.bar.x, top: drag.bar.y, width: drag.bar.w, height: drag.bar.h }} />
          )}
        </div>
        <div className="scene-listwin-ft">
          <span>끌어서 순서 바꾸기</span>
          <span><kbd>Ctrl</kbd> + <kbd>{rows ? "↑↓" : "←→"}</kbd> 고른 칸 한 칸씩</span>
          <span><kbd>Ctrl</kbd> + <kbd>Z</kbd> 되돌리기</span>
          {!rows && <span>더블클릭 = 크게 보기</span>}
          <span><kbd>Esc</kbd> 닫기</span>
          <span className="scene-listwin-ok">바뀐 순서는 노드에 바로 반영</span>
        </div>
      </div>
      {drag && ghost && (
        <div className={"scene-listwin-ghost" + (rows ? " rows" : "")} style={{ left: drag.x, top: drag.y }}>
          {rows ? ghost.name : ghost.src && !ghost.off ? <img src={ghost.src} alt="" /> : <span>{ghost.name}</span>}
        </div>
      )}
    </div>
  );
}
