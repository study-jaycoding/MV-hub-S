// 텍스트 노드 카드 본문 — SceneBoard 렌더 분할(R2). 셸은 부모 소유, Fragment 만 반환(규칙은 OutputCard 참고).
//  ★포커스·캐럿 주의: 이 컴포넌트는 모듈 최상단 선언(타입 안정) — 편집 중 리렌더에도 textarea 가
//   리마운트되지 않아 포커스가 유지된다. 캐럿 위치는 부모 소유 caretPosRef(노드별)로 복원.
import type React from "react";
import type { MutableRefObject } from "react";
import type { SceneCard, SceneEdge } from "../../../lib/scenes";
import { variantIds } from "../../../lib/scenes";
import type { Generation } from "../../../types";
import { collectListInputs, effectiveTextOf } from "../../../lib/sceneEdges";
import { refThumbSrc } from "../../../lib/sceneMedia";
import { hideBrokenImg, showLoadedImg, thumbOf } from "../../../lib/media";

export function TextCard({
  card,
  cardsById,
  resolvedEdges,
  genData,
  editing,
  caretPosRef,
  setEditTextId,
  setSelected,
  setNodeText,
  flushPending,
  onOutPortDown,
  onResizeDown,
}: {
  card: SceneCard;
  cardsById: Map<string, SceneCard>;
  resolvedEdges: SceneEdge[];
  genData: Record<string, Generation>;
  editing: boolean;
  caretPosRef: MutableRefObject<Map<string, number>>;
  setEditTextId: (id: string | null) => void;
  setSelected: (ids: Set<string>) => void;
  setNodeText: (cardId: string, text: string) => void;
  flushPending: () => void;
  onOutPortDown: (e: React.MouseEvent, cardId: string) => void;
  onResizeDown: (e: React.MouseEvent, cardId: string) => void;
}) {
  // 연결된 레퍼런스(레퍼런스 카드 refs + 생성물)를 순서대로 @image1/@video1... 에 매핑. input 은 실제 소스로 해석.
  const refSrcs = resolvedEdges
    .filter((e) => e.to === card.id)
    .map((e) => cardsById.get(e.from))
    .filter((c): c is SceneCard => !!c)
    .sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x));
  const counters: Record<string, number> = {};
  const thumbByLabel = new Map<string, string | undefined>();
  const addRef = (type: string | undefined, thumb?: string) => {
    const t = type === "video" ? "video" : type === "audio" ? "audio" : "image";
    counters[t] = (counters[t] || 0) + 1;
    thumbByLabel.set(`@${t}${counters[t]}`, thumb);
  };
  const addGenRef = (gc?: SceneCard) => {
    const gid = gc?.genId || (gc ? variantIds(gc)[0] : undefined);
    const gen = gid ? genData[gid] : undefined;
    addRef(gen?.assets?.[0]?.type, gen ? thumbOf(gen, 128) || undefined : undefined);
  };
  for (const s of refSrcs) {
    if (s.kind === "reference")
      (s.refs || []).forEach((r) => addRef(r.type, refThumbSrc(r)));
    else if (s.kind === "generation") addGenRef(s);
    else if (s.kind === "list") {
      // 리스트로 묶은 레퍼런스/생성물을 순서대로 펼쳐 @image1/@image2… 로 매핑.
      const li = collectListInputs(s.id, cardsById, resolvedEdges);
      if (li.kind === "reference")
        for (const cid of li.referenceCardIds)
          (cardsById.get(cid)?.refs || []).forEach((r) => addRef(r.type, refThumbSrc(r)));
      else if (li.kind === "generation")
        for (const cid of li.generationCardIds) addGenRef(cardsById.get(cid));
    }
  }
  // 텍스트를 토큰 기준으로 쪼개, 토큰은 인라인 알약(썸네일)으로, 나머지는 그대로.
  //  @image1 형식 + comfy 프롬프트의 <<<image1>>> 형식 둘 다 인식 → 같은 레퍼런스로 매핑.
  const renderInline = (text: string) => {
    const re = /@(image|video|audio)(\d+)|<<<(image|video|audio)(\d+)>>>/gi;
    const out: React.ReactNode[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    let k = 0;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const label = m[0];
      const key = `@${(m[1] || m[3] || "").toLowerCase()}${m[2] || m[4] || ""}`;
      if (thumbByLabel.has(key)) {
        // 연결된 레퍼런스가 있는 토큰만 알약(썸네일). 없으면 그냥 텍스트로 둔다.
        const thumb = thumbByLabel.get(key);
        out.push(
          <span className="scene-inlinetok" key={`t${k++}`} title={label}>
            {thumb ? (
              <img src={thumb} alt="" draggable={false} onError={hideBrokenImg} onLoad={showLoadedImg} />
            ) : (
              <span className="scene-inlinetok-ph" />
            )}
            {label}
          </span>,
        );
      } else {
        out.push(label); // 연결 안 됨 → 그냥 @image1 텍스트
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  };
  // 연결된 텍스트 소스(comfy 텍스트 출력·다른 텍스트 노드·텍스트 리스트)의 텍스트.
  const incomingText = refSrcs
    .map((s) => effectiveTextOf(s.id, cardsById, resolvedEdges))
    .filter((t) => t.trim())
    .join("\n");
  // 표시/사용 텍스트 = 내가 편집한 자기 텍스트 우선, 없으면 들어온 텍스트를 그대로(내가 적은 것처럼).
  const shownText = (card.text || "").trim() ? card.text || "" : incomingText;
  return (
    <>
      {/* 본문(보기=토큰 인라인 알약, 더블클릭 시 편집 textarea). 연결로 들어온 텍스트도 여기 그대로
          나타나며, 더블클릭하면 그 텍스트가 편집 본문으로 채택돼 바로 수정·사용된다. */}
      <div className="scene-card-hd text scene-card-hd-float">텍스트</div>
      <div className="scene-card-inner">
        {editing ? (
          <textarea
            className="scene-textnode"
            value={card.text || ""}
            placeholder="텍스트 입력..."
            spellCheck={false}
            autoFocus
            onMouseDown={(e) => e.stopPropagation()}
            onFocus={(e) => {
              // 편집 진입 캐럿: 이전 편집 위치가 있으면 그곳, 없으면 맨 끝(autoFocus 기본값 offset 0 방지).
              const len = e.currentTarget.value.length;
              const saved = caretPosRef.current.get(card.id);
              const pos = saved != null ? Math.min(saved, len) : len;
              e.currentTarget.setSelectionRange(pos, pos);
            }}
            onSelect={(e) => caretPosRef.current.set(card.id, e.currentTarget.selectionStart ?? 0)} // 편집 중 캐럿 위치 기억
            onBlur={() => { setEditTextId(null); flushPending(); }} // 편집 끝나면 밀린 저장 확정
            onChange={(e) => setNodeText(card.id, e.target.value)}
          />
        ) : (
          <div
            className="scene-textview-inline"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setSelected(new Set([card.id]));
              // 자기 텍스트가 비어있고 들어온 텍스트가 있으면, 그걸 편집 본문으로 채택(한 번).
              if (!(card.text || "").trim() && incomingText.trim())
                setNodeText(card.id, incomingText);
              setEditTextId(card.id); // 더블클릭 = 편집 전환(단일 클릭/드래그는 카드 이동)
            }}
          >
            {shownText ? (
              renderInline(shownText)
            ) : (
              <span className="scene-textnode-ph2">텍스트 입력...</span>
            )}
          </div>
        )}
      </div>
      <button
        className="scene-copy-btn"
        title="텍스트 전체 복사(연결 입력 + 편집 텍스트)"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          void navigator.clipboard?.writeText(
            effectiveTextOf(card.id, cardsById, resolvedEdges),
          );
        }}
      >
        ⧉
      </button>
      <span
        className="scene-port in"
        title="레퍼런스(→@토큰) + 텍스트(comfy 결과·텍스트 노드) 연결"
      />
      <span
        className="scene-port out"
        onMouseDown={(e) => onOutPortDown(e, card.id)}
        title="드래그해 생성 카드 텍스트 입력에 연결(보라)"
      />
      <span
        className="scene-resize"
        onMouseDown={(e) => onResizeDown(e, card.id)}
        title="드래그해 크기 조절"
      />
    </>
  );
}
