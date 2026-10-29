// 텍스트 노드 카드 본문 — SceneBoard 렌더 분할(R2). 셸은 부모 소유, Fragment 만 반환(규칙은 OutputCard 참고).
//  ★포커스·캐럿 주의: 이 컴포넌트는 모듈 최상단 선언(타입 안정) — 편집 중 리렌더에도 편집칸이
//   리마운트되지 않아 포커스가 유지된다. 캐럿 위치는 부모 소유 caretPosRef(노드별, 글자 위치)로 복원.
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
import { insertTextAtCaret } from "../../../lib/promptEditor";
import {
  TEXT_TOKEN_SRC,
  buildTextTokenPill,
  caretMention,
  caretTextOffset,
  editorText,
  placeCaretAtTextOffset,
  textTokenInfo,
  wrapTextTokens,
} from "../../../lib/textNodeTokens";

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
  // 텍스트를 토큰 기준으로 쪼개, 토큰은 인라인 알약(썸네일)으로, 나머지는 그대로(토큰 판정은 편집칸과 같은 lib/textNodeTokens).
  //  시작·끝 이미지(@simage2·@eimage2)는 이미지 2번의 썸네일로 — 역할 해석은 생성 때 seedanceTokenRoles 가 이 글 그대로 읽는다.
  const renderInline = (text: string) => {
    const re = new RegExp(TEXT_TOKEN_SRC, "gi");
    const out: React.ReactNode[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    let k = 0;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const { label, kind, key } = textTokenInfo(m);
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

  // ── 편집칸(Jay 2026-10-29) — 쓰는 중에도 이어진 번호는 알약(lib/textNodeTokens: 원래 글자를 알약 안에 그대로 둬 저장 글은 친 그대로).
  //  치는 중인 토큰(캐럿이 걸친 것)은 글자로 두고 캐럿이 떠나면 알약 · 알약을 누르면 글자로 풀려 번호를 고친다.
  const editRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const markEmpty = (el: HTMLElement) => el.toggleAttribute("data-empty", !editorText(el));
  // 밖에서 글이 바뀌면(처음 열 때·되돌리기·들어온 글 채택) 칸을 맞춘다 — 직접 친 글은 꺼낸 글과 같아 건드리지 않는다.
  useLayoutEffect(() => {
    const el = editRef.current;
    if (!el) return;
    const value = card.text || "";
    if (editorText(el) !== value) {
      el.textContent = value;
      wrapTextTokens(el, thumbByLabel, false);
    }
    markEmpty(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, card.text]);
  // 편집 진입 — 초점과 캐럿(이전 편집 위치가 있으면 그곳, 없으면 맨 끝)
  useLayoutEffect(() => {
    const el = editRef.current;
    if (!editing || !el) return;
    el.focus();
    const len = editorText(el).length;
    const saved = caretPosRef.current.get(card.id);
    placeCaretAtTextOffset(el, saved != null ? Math.min(saved, len) : len);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // @ 고르기 — 편집 중 @ 를 치면 이 노드에 이어진 레퍼런스를 친 자리 바로 위에(위 자리가 모자라면 그 줄 아래).
  //  고르면 그 번호 알약 + 띄어쓰기를 그 자리에 넣는다. 시작·끝(@simage·@eimage)은 목록에 없다.
  const pickRef = useRef<HTMLDivElement>(null);
  const mentionNodeRef = useRef<Text | null>(null); // @ 가 든 글 조각(편집칸 DOM)
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [pickAt, setPickAt] = useState(0);
  const [pickPos, setPickPos] = useState<{ left: number; top: number; line: number; below: boolean } | null>(null);
  // Esc 로 닫은 @ — 그 @ 를 지우거나 캐럿이 그 앞으로 가기 전엔 다시 열지 않는다
  const dismissedRef = useRef<{ node: Text; start: number } | null>(null);
  // 글·캐럿이 바뀔 때마다 부른다. @ 자리·친 글자가 같으면 아무것도 바꾸지 않는다(↑↓ 로 고른 줄이 맨 위로 되돌아가지 않게).
  const detectMention = (el: HTMLElement) => {
    const found = caretMention(el);
    const d = dismissedRef.current;
    if (d && (!found || found.node !== d.node || d.node.data.charAt(d.start) !== "@" || found.start !== d.start)) dismissedRef.current = null;
    const next = found && !(dismissedRef.current && found.start === dismissedRef.current.start) ? found : null;
    const same = next && mention && next.node === mentionNodeRef.current && next.start === mention.start && next.query === mention.query;
    if (same || (!next && !mention)) return;
    mentionNodeRef.current = next?.node ?? null;
    setMention(next ? { start: next.start, query: next.query } : null);
    setPickAt(0);
  };
  const picks = mention
    ? mentionRefs.filter((r) => !mention.query || r.label.slice(1).includes(mention.query) || r.name.toLowerCase().includes(mention.query))
    : [];
  const showPick = editing && !!mention && (picks.length > 0 || mentionRefs.length === 0);
  const at = Math.min(pickAt, Math.max(0, picks.length - 1));
  const mentionStart = mention?.start ?? -1;
  // @ 글자의 자리 — 화면에 그려진 자리를 재서 카드 기준(레이아웃 px)으로. 캔버스 배율로 나눠 목록도 카드와 함께 커지고 작아진다.
  useLayoutEffect(() => {
    const el = editRef.current;
    const node = mentionNodeRef.current;
    const cardEl = el?.closest<HTMLElement>(".scene-card");
    if (!showPick || !el || !node || !cardEl || mentionStart < 0) { setPickPos(null); return; }
    const r = document.createRange();
    r.setStart(node, Math.min(mentionStart, node.length));
    r.setEnd(node, Math.min(mentionStart + 1, node.length));
    const rect = typeof r.getBoundingClientRect === "function" ? r.getBoundingClientRect() : null;
    const box = cardEl.getBoundingClientRect();
    const scale = cardEl.offsetWidth ? box.width / cardEl.offsetWidth : 1;
    if (!rect || !scale) { setPickPos({ left: 8, top: 8, line: 16, below: false }); return; }
    setPickPos({ left: (rect.left - box.left) / scale, top: (rect.top - box.top) / scale, line: rect.height / scale, below: false });
  }, [showPick, mentionStart, card.text]);
  // 위 자리가 모자라면(보드 위 끝을 넘으면) 그 줄 아래로 뒤집는다
  useLayoutEffect(() => {
    const el = pickRef.current;
    if (!el || !pickPos || pickPos.below) return;
    const limit = (el.closest(".scene-board") ?? document.documentElement).getBoundingClientRect().top;
    if (el.getBoundingClientRect().top < limit) setPickPos({ ...pickPos, below: true });
  }, [pickPos]);
  // 쓰는 동안(큰 편집 창·@ 목록이 카드 밖으로 뜬다) 카드를 다른 카드·연결 끝 점 층 위로(InputChannelPicker 와 같은 표시 — scene.css)
  useEffect(() => {
    const cardEl = editRef.current?.closest(".scene-card");
    if (!editing || !cardEl) return;
    cardEl.setAttribute("data-pop-open", "");
    return () => cardEl.removeAttribute("data-pop-open");
  }, [editing]);

  // 칸이 바뀐 뒤 — 알약 감싸기(조합 중이 아니면, 치는 중인 토큰은 글자로) · 글 저장 · 캐럿 기억 · @ 감지
  const syncEditor = () => {
    const el = editRef.current;
    if (!el) return;
    if (!composingRef.current) wrapTextTokens(el, thumbByLabel, true);
    markEmpty(el);
    const value = editorText(el);
    if (value !== (card.text || "")) setNodeText(card.id, value);
    const off = caretTextOffset(el);
    if (off != null) caretPosRef.current.set(card.id, off);
    detectMention(el);
  };
  const choosePick = (label: string) => {
    const el = editRef.current;
    const node = mentionNodeRef.current;
    if (!el || !node || !mention || !el.contains(node)) return;
    const end = Math.min(node.length, mention.start + 1 + mention.query.length);
    const tail = node.splitText(mention.start); // "@query…" 부터 떼어 낸다
    tail.deleteData(0, end - mention.start);
    const info = textTokenInfo(new RegExp(TEXT_TOKEN_SRC, "i").exec(label)!);
    const space = document.createTextNode(" ");
    node.after(buildTextTokenPill(info, thumbByLabel.get(info.key)), space);
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(space, 1);
    r.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(r);
    mentionNodeRef.current = null;
    setMention(null);
    syncEditor();
  };
  return (
    <>
      {/* 본문(보기=토큰 인라인 알약, 더블클릭 시 그 위에 큰 편집 창 — 쓰는 중에도 알약). 연결로 들어온 텍스트도 여기 그대로
          나타나며, 더블클릭하면 그 텍스트가 편집 본문으로 채택돼 바로 수정·사용된다. */}
      <div className="scene-card-hd text scene-card-hd-float">텍스트</div>
      <div className="scene-card-inner">
        <div
          className={"scene-textview-inline" + (editing ? " is-editing" : "")}
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
      </div>
      {editing && (
        // 큰 편집 창(Jay 2026-10-29 시안 B) — 쓰는 동안 노드 위에 노드 폭의 1.6배로 떠서 쓴다(그 아래 보기는 흐리게). 노드 크기·연결선은 그대로.
        //  ★보기 칸과 다른 요소다 — 같은 div 를 다시 쓰면 편집칸에 손으로 넣은 글·알약(React 밖)이 남은 채 보기 내용이 덧붙어
        //   글이 두 번 보였다(Jay 2026-10-29 화면).
        <div className="scene-textfloat" onMouseDown={(e) => e.stopPropagation()}>
          <div
            ref={editRef}
            className="scene-textnode scene-textedit"
            contentEditable
            suppressContentEditableWarning
            tabIndex={0}
            role="textbox"
            aria-multiline="true"
            aria-label="텍스트"
            data-placeholder="텍스트 입력..."
            spellCheck={false}
            onMouseDown={(e) => e.stopPropagation()}
            onInput={syncEditor}
            onKeyUp={(e) => { if (!(showPick && ["ArrowUp", "ArrowDown", "Enter", "Tab"].includes(e.key))) syncEditor(); }}
            onClick={(e) => {
              // 알약을 누르면 글자로 풀어 번호를 고친다(캐럿이 떠나면 다시 알약 — 생성창 프롬프트와 같다)
              const pill = (e.target as HTMLElement).closest?.("[data-tok]");
              if (pill && editRef.current?.contains(pill)) {
                const text = document.createTextNode(editorText(pill));
                pill.replaceWith(text);
                const r = document.createRange();
                r.setStart(text, text.length);
                r.collapse(true);
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(r);
              }
              syncEditor();
            }}
            onBlur={() => {
              const el = editRef.current;
              if (el) wrapTextTokens(el, thumbByLabel, false); // 치다 남긴 토큰도 칸을 떠나면 알약
              setMention(null);
              setEditTextId(null);
              flushPending(); // 편집 끝나면 밀린 저장 확정
            }}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; syncEditor(); }}
            onPaste={(e) => {
              e.preventDefault(); // 서식 없는 글만 — 붙여 넣은 HTML 이 칸 안에 남지 않게
              insertTextAtCaret(e.currentTarget, e.clipboardData.getData("text/plain"));
              syncEditor();
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return; // 한글 조합 중 Enter 는 글자 확정
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
              if (e.key === "Enter") {
                e.preventDefault(); // 줄바꿈은 글자로(칸 안에 <div> 가 생기지 않게)
                insertTextAtCaret(e.currentTarget, "\n");
                syncEditor();
                return;
              }
              // Esc = 편집 끝(제목 카드와 같다 — 전엔 다른 곳을 눌러야만 끝났다). 같은 Esc 가 보드의 선택까지 풀지 않게 여기서 멈춘다.
              //  @ 목록이 떠 있으면 목록만 닫는다.
              if (e.key !== "Escape") return;
              e.stopPropagation();
              if (showPick) {
                const node = mentionNodeRef.current;
                dismissedRef.current = node && mention ? { node, start: mention.start } : null;
                setMention(null);
                return;
              }
              e.currentTarget.blur();
            }}
          />
        </div>
      )}
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
