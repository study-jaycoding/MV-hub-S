// 텍스트 노드 카드 본문 — SceneBoard 렌더 분할(R2). 셸은 부모 소유, Fragment 만 반환(규칙은 OutputCard 참고).
//  ★포커스·캐럿 주의: 이 컴포넌트는 모듈 최상단 선언(타입 안정) — 편집 중 리렌더에도 textarea 가
//   리마운트되지 않아 포커스가 유지된다. 캐럿 위치는 부모 소유 caretPosRef(노드별)로 복원.
import { ownEntry } from "../../../lib/ownEntry";
import type React from "react";
import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import type { SceneCard, SceneEdge } from "../../../lib/scenes";
import { variantIds } from "../../../lib/scenes";
import type { Generation } from "../../../types";
import { collectListInputs, effectiveTextOf } from "../../../lib/sceneEdges";
import { refThumbSrc } from "../../../lib/sceneMedia";
import { hideBrokenImg, showLoadedImg, thumbOf } from "../../../lib/media";
import { copyText } from "../../../lib/flash";

// textarea 안 index 글자의 자리(textarea 왼쪽 위 기준, 스크롤 반영) — 같은 글꼴·폭의 숨긴 복제 칸에 그 앞까지의 글을 넣어 잰다.
//  레이아웃 px 라 캔버스 확대·축소와 무관하다(목록도 같은 카드 안에 그려 함께 커지고 작아진다).
const MIRROR_PROPS = [
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "fontFamily", "fontSize", "fontWeight",
  "fontStyle", "letterSpacing", "lineHeight", "wordSpacing", "tabSize", "wordBreak", "overflowWrap",
] as const;
function caretPoint(ta: HTMLTextAreaElement, index: number) {
  const cs = getComputedStyle(ta);
  const div = document.createElement("div");
  for (const p of MIRROR_PROPS) div.style[p] = cs[p];
  Object.assign(div.style, {
    position: "absolute", visibility: "hidden", left: "0", top: "0", whiteSpace: "pre-wrap", boxSizing: "content-box",
    // 폭은 글이 실제로 줄바꿈되는 폭(스크롤 막대 제외) — clientWidth 는 안쪽 여백을 포함한다
    width: `${ta.clientWidth - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0")}px`,
  });
  div.textContent = ta.value.slice(0, index);
  const mark = document.createElement("span");
  mark.textContent = "@";
  div.appendChild(mark);
  ta.parentElement?.appendChild(div);
  const at = { left: mark.offsetLeft, top: mark.offsetTop - ta.scrollTop, height: mark.offsetHeight };
  div.remove();
  return at;
}

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
  // @ 고르기 목록의 항목(번호 = 알약과 같은 번호)
  const mentionRefs: { label: string; kind: "image" | "video" | "audio"; thumb?: string; name: string }[] = [];
  const addRef = (type: string | undefined, thumb?: string, name = "") => {
    const t = type === "video" ? "video" : type === "audio" ? "audio" : "image";
    counters[t] = (counters[t] || 0) + 1;
    const label = `@${t}${counters[t]}`;
    thumbByLabel.set(label, thumb);
    mentionRefs.push({ label, kind: t, thumb, name });
  };
  const addGenRef = (gc?: SceneCard) => {
    const gid = gc?.genId || (gc ? variantIds(gc)[0] : undefined);
    const gen = gid ? ownEntry(genData, gid) : undefined;
    const type = gen?.assets?.[0]?.type;
    // 이름은 생성 카드 레퍼런스와 같은 규칙(features/canvas/references.ts)
    const name = gen?.source_name || (gid ? `${type === "video" ? "vid" : "img"}-${gid.slice(0, 8)}` : "");
    addRef(type, gen ? thumbOf(gen, 128) || undefined : undefined, name);
  };
  for (const s of refSrcs) {
    if (s.kind === "reference")
      (s.refs || []).forEach((r) => addRef(r.type, refThumbSrc(r), r.name || ""));
    else if (s.kind === "generation") addGenRef(s);
    else if (s.kind === "list") {
      // 리스트로 묶은 레퍼런스/생성물을 순서대로 펼쳐 @image1/@image2… 로 매핑.
      const li = collectListInputs(s.id, cardsById, resolvedEdges);
      if (li.kind === "reference")
        for (const cid of li.referenceCardIds) {
          const item = cardsById.get(cid);
          // 레퍼런스 + 생성물로 섞인 리스트(2026-10-22) — 생성물 항목은 그 결과물(그 카드의 refs 는 그 카드의 입력)
          if (item?.kind === "reference") (item.refs || []).forEach((r) => addRef(r.type, refThumbSrc(r), r.name || ""));
          else addGenRef(item);
        }
      else if (li.kind === "generation")
        for (const cid of li.generationCardIds) addGenRef(cardsById.get(cid));
    }
  }
  // 텍스트를 토큰 기준으로 쪼개, 토큰은 인라인 알약(썸네일)으로, 나머지는 그대로.
  //  @image1 형식 + comfy 프롬프트의 <<<image1>>> 형식 둘 다 인식 → 같은 레퍼런스로 매핑.
  //  시작·끝 이미지(@simage2·@eimage2)는 이미지 2번의 썸네일로 — 역할 해석은 생성 때 seedanceTokenRoles 가 이 글 그대로 읽는다.
  const renderInline = (text: string) => {
    const re = /@(simage|eimage|image|video|audio)(\d+)|<<<(simage|eimage|image|video|audio)(\d+)>>>/gi;
    const out: React.ReactNode[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    let k = 0;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const label = m[0];
      const word = (m[1] || m[3] || "").toLowerCase();
      const kind = word === "simage" ? "start" : word === "eimage" ? "end" : word;
      const key = `@${kind === "start" || kind === "end" ? "image" : word}${m[2] || m[4] || ""}`;
      if (thumbByLabel.has(key)) {
        // 연결된 레퍼런스가 있는 토큰만 알약(썸네일). 없으면 그냥 텍스트로 둔다.
        const thumb = thumbByLabel.get(key);
        out.push(
          <span className={`scene-inlinetok k-${kind}`} key={`t${k++}`} title={label}>
            {kind === "audio" ? (
              <span className="scene-inlinetok-ph tok-audio">🎵</span>
            ) : thumb ? (
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

  // @ 고르기(Jay 2026-10-29) — 편집 중 @ 를 치면 이 노드에 이어진 레퍼런스를 친 자리 바로 위에(위 자리가 모자라면 그 줄 아래).
  //  고르면 '@image2 ' 를 그 자리에 넣는다. 시작·끝(@simage·@eimage)은 목록에 없다.
  const taRef = useRef<HTMLTextAreaElement>(null);
  const pickRef = useRef<HTMLDivElement>(null);
  const caretAfterRef = useRef<number | null>(null); // 고른 뒤 캐럿 자리 — 새 글이 그려진 다음 놓는다
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [pickAt, setPickAt] = useState(0);
  const [pickPos, setPickPos] = useState<{ left: number; top: number; line: number; below: boolean } | null>(null);
  const dismissedRef = useRef<number | null>(null); // Esc 로 닫은 @ 자리 — 그 @ 를 지우거나 캐럿이 그 앞으로 가기 전엔 다시 열지 않는다
  // 글·캐럿이 바뀔 때마다 부른다. 키를 누를 때도(React 의 select 이벤트) 불리므로, @ 자리·친 글자가 같으면 아무것도 바꾸지 않는다
  //  (그래야 ↑↓ 로 고른 줄이 맨 위로 되돌아가지 않는다).
  const detectMention = (el: HTMLTextAreaElement) => {
    const pos = el.selectionStart ?? 0;
    const dismissed = dismissedRef.current;
    if (dismissed != null && (el.value.charAt(dismissed) !== "@" || pos <= dismissed)) dismissedRef.current = null;
    // @ 앞은 글 처음이거나 단어 글자가 아님(foo@image 같은 메일 주소는 아님) · @ 뒤는 영문·숫자만
    const m = el.selectionEnd === pos ? /(?:^|[^\w@])@(\w*)$/.exec(el.value.slice(0, pos)) : null;
    const found = m ? { start: pos - m[1].length - 1, query: m[1].toLowerCase() } : null;
    const next = found && found.start !== dismissedRef.current ? found : null;
    if (next?.start === mention?.start && next?.query === mention?.query) return;
    setMention(next);
    setPickAt(0);
  };
  const picks = mention
    ? mentionRefs.filter((r) => !mention.query || r.label.slice(1).includes(mention.query) || r.name.toLowerCase().includes(mention.query))
    : [];
  const showPick = editing && !!mention && (picks.length > 0 || mentionRefs.length === 0);
  const at = Math.min(pickAt, Math.max(0, picks.length - 1));
  const mentionStart = mention?.start ?? -1;
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!showPick || !ta || mentionStart < 0) { setPickPos(null); return; }
    const p = caretPoint(ta, mentionStart);
    setPickPos({ left: ta.offsetLeft + p.left, top: ta.offsetTop + p.top, line: p.height, below: false });
  }, [showPick, mentionStart, card.text]);
  // 위 자리가 모자라면(보드 위 끝을 넘으면) 그 줄 아래로 뒤집는다
  useLayoutEffect(() => {
    const el = pickRef.current;
    if (!el || !pickPos || pickPos.below) return;
    const limit = (el.closest(".scene-board") ?? document.documentElement).getBoundingClientRect().top;
    if (el.getBoundingClientRect().top < limit) setPickPos({ ...pickPos, below: true });
  }, [pickPos]);
  useLayoutEffect(() => {
    const c = caretAfterRef.current;
    if (c == null || !taRef.current) return;
    caretAfterRef.current = null;
    taRef.current.setSelectionRange(c, c);
  }, [card.text]);
  // 목록이 떠 있는 동안 카드를 연결 끝 점 층 위로(InputChannelPicker 와 같은 표시 — scene.css)
  useEffect(() => {
    const cardEl = taRef.current?.closest(".scene-card");
    if (!showPick || !cardEl) return;
    cardEl.setAttribute("data-pop-open", "");
    return () => cardEl.removeAttribute("data-pop-open");
  }, [showPick]);
  const choosePick = (label: string) => {
    const ta = taRef.current;
    if (!ta || !mention) return;
    const end = ta.selectionStart ?? mention.start + 1 + mention.query.length;
    const next = ta.value.slice(0, mention.start) + label + " " + ta.value.slice(end);
    caretAfterRef.current = mention.start + label.length + 1;
    caretPosRef.current.set(card.id, caretAfterRef.current);
    setMention(null);
    setNodeText(card.id, next);
  };
  return (
    <>
      {/* 본문(보기=토큰 인라인 알약, 더블클릭 시 편집 textarea). 연결로 들어온 텍스트도 여기 그대로
          나타나며, 더블클릭하면 그 텍스트가 편집 본문으로 채택돼 바로 수정·사용된다. */}
      <div className="scene-card-hd text scene-card-hd-float">텍스트</div>
      <div className="scene-card-inner">
        {editing ? (
          <textarea
            ref={taRef}
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
            onSelect={(e) => {
              caretPosRef.current.set(card.id, e.currentTarget.selectionStart ?? 0); // 편집 중 캐럿 위치 기억
              detectMention(e.currentTarget);
            }}
            onBlur={() => { setMention(null); setEditTextId(null); flushPending(); }} // 편집 끝나면 밀린 저장 확정
            onChange={(e) => {
              setNodeText(card.id, e.target.value);
              detectMention(e.currentTarget);
            }}
            onKeyDown={(e) => {
              if (showPick && picks.length) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  e.stopPropagation();
                  setPickAt((at + (e.key === "ArrowDown" ? 1 : picks.length - 1)) % picks.length);
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  e.stopPropagation();
                  choosePick(picks[at].label);
                  return;
                }
              }
              // Esc = 편집 끝(제목 카드와 같다 — 전엔 다른 곳을 눌러야만 끝났다). 같은 Esc 가 보드의 선택까지 풀지 않게 여기서 멈춘다.
              //  @ 목록이 떠 있으면 목록만 닫는다.
              if (e.key !== "Escape") return;
              e.stopPropagation();
              if (showPick) {
                dismissedRef.current = mention?.start ?? null;
                setMention(null);
                return;
              }
              e.currentTarget.blur();
            }}
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
      {showPick && (
        // 생성창 @ 목록과 같은 모양(.sl-mention) — 누르는 동안 편집칸 초점을 지키고, 카드 끌기로 번지지 않게
        <div
          ref={pickRef}
          className="sl-mention scene-textmention"
          style={
            !pickPos
              ? { visibility: "hidden" }
              : pickPos.below
                ? { left: pickPos.left, top: pickPos.top + pickPos.line + 4 }
                : { left: pickPos.left, top: pickPos.top - 4, transform: "translateY(-100%)" }
          }
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          <div className="sl-mention-head">
            레퍼런스 (@image1)
            <span className="sl-mention-hint">↑↓ · Enter · Esc</span>
          </div>
          <div className="sl-mention-list">
            {picks.length ? (
              picks.map((r, i) => (
                <button
                  key={r.label}
                  type="button"
                  className={"sl-mention-item" + (i === at ? " on" : "")}
                  onMouseEnter={() => setPickAt(i)}
                  onClick={() => choosePick(r.label)}
                >
                  {r.thumb ? (
                    <img src={r.thumb} alt="" draggable={false} onError={hideBrokenImg} onLoad={showLoadedImg} />
                  ) : (
                    <span className="sl-mention-ph">{r.kind === "audio" ? "🎵" : "🖼"}</span>
                  )}
                  <span className={"sl-mention-name sl-tok sl-mention-tok sl-tok-" + r.kind}>{r.label}</span>
                  <span className="sl-mention-tags">{r.name}</span>
                </button>
              ))
            ) : (
              <div className="sl-mention-empty">이 텍스트 노드에 이어진 레퍼런스가 없습니다</div>
            )}
          </div>
        </div>
      )}
      <button
        className="scene-copy-btn"
        title="텍스트 전체 복사(연결 입력 + 편집 텍스트)"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          void copyText(
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
