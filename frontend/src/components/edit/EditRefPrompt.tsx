import { useCallback, useEffect, useRef, useState } from "react";
import { insertRefToken, insertTextAtCaret, serialize, triggerInfo, wrapRefTokens } from "../../lib/promptEditor";
import { useEscapeClose } from "../../lib/useEscapeClose";

// 수정 창 지시문 칸 — 생성창처럼 @imageN 을 레퍼런스 칸 그 번호의 썸네일 알약으로 보이고(A), @ 를 치면 레퍼런스 칸 목록에서
//  골라 넣는다(B, Jay 2026-10-28). 칸에 없는 번호는 빨간 경고 알약(promptEditor 의 missing). 알약은 보기만 바꾼다 —
//  밖으로 내보내는 글은 textarea 때와 같은 '@image2' 글자다(serialize). refs 가 비면(이미지 수정) 알약·목록 없이 글만.
export interface EditPromptRef {
  token: string; // "@image1"
  kind: "image";
  name: string;
  thumb: string;
}

export function EditRefPrompt({ value, onChange, onSubmit, placeholder, ariaLabel, refs }: {
  value: string;
  onChange: (text: string) => void;
  onSubmit: () => void;
  placeholder: string;
  ariaLabel: string;
  refs: EditPromptRef[];
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const [pick, setPick] = useState<{ query: string; index: number } | null>(null);
  const active = refs.length > 0;
  // 알약 번호 → 썸네일. 칸에 없는 번호는 undefined(= 경고 알약), 있는데 그림이 없으면 "".
  const resolve = useCallback((kind: string, n: number) => {
    const hit = refs.find((r) => r.token === `@${kind}${n}`);
    return hit ? hit.thumb || "" : undefined;
  }, [refs]);
  const items = pick ? refs.filter((r) => r.token.slice(1).startsWith(pick.query) || r.name.toLowerCase().includes(pick.query)) : [];
  const markEmpty = (el: HTMLElement) => el.toggleAttribute("data-empty", !el.textContent?.trim());
  const sync = () => {
    const el = editorRef.current;
    if (!el) return;
    if (active && !composing.current) wrapRefTokens(el, resolve, { skipCaretNode: true });
    markEmpty(el);
    onChange(serialize(el).text);
    const t = active ? triggerInfo(el, "@") : null;
    setPick((prev) => (t ? { query: t.query.toLowerCase(), index: prev?.query === t.query.toLowerCase() ? prev.index : 0 } : null));
  };
  // 밖에서 값이 바뀌면(비우기 단추 등) 칸을 맞춘다 — 직접 친 글은 serialize 결과와 같아 건드리지 않는다.
  useEffect(() => {
    const el = editorRef.current;
    if (!el || serialize(el).text === value) return;
    el.textContent = value;
    if (active) wrapRefTokens(el, resolve);
    markEmpty(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  // 레퍼런스 칸이 바뀌면 알약의 썸네일·경고 상태를 다시 맞춘다(넣기·빼기로 번호가 생기거나 사라진다).
  useEffect(() => {
    const el = editorRef.current;
    if (el && active) wrapRefTokens(el, resolve);
  }, [active, resolve]);
  // 목록이 떠 있는 동안 Esc 는 목록만 닫는다(가장 위 겹 — 수정 창의 Esc 처리보다 먼저).
  useEscapeClose(() => setPick(null), items.length > 0, true, true);
  const choose = (r: EditPromptRef) => {
    const el = editorRef.current;
    if (!el) return;
    insertRefToken(el, r.token, r.kind, r.thumb);
    setPick(null);
    markEmpty(el);
    onChange(serialize(el).text);
  };
  return (
    <>
      <div
        ref={editorRef}
        className="sl-prompt"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        data-placeholder={placeholder}
        data-empty=""
        onInput={sync}
        onKeyUp={(e) => { if (!["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(e.key)) sync(); }}
        onClick={sync}
        onBlur={() => {
          setPick(null);
          const el = editorRef.current;
          if (el && active) wrapRefTokens(el, resolve); // 입력하다 남긴 토큰도 칸을 떠나면 알약으로
        }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; sync(); }}
        onPaste={(e) => {
          e.preventDefault(); // 서식 없는 글만 — 붙여 넣은 HTML 이 칸 안에 남지 않게
          insertTextAtCaret(e.currentTarget, e.clipboardData.getData("text/plain"));
          sync();
        }}
        onKeyDown={(e) => {
          // IME 조합 중 Enter(한글 마지막 글자 확정)는 제출이 아니다 — 미완성 프롬프트로 유료 생성이 시작된다(코덱스 BLOCK).
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (pick && items.length) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : items.length - 1;
              setPick({ ...pick, index: (pick.index + step) % items.length });
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              choose(items[Math.min(pick.index, items.length - 1)]);
              return;
            }
          }
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) { insertTextAtCaret(e.currentTarget, "\n"); sync(); } // 줄바꿈은 글자로(칸 안 <div> 가 생기지 않게)
            else onSubmit();
          }
        }}
      />
      {items.length > 0 && pick && (
        // 생성창 @ 고르기와 같은 창(.sl-mention) — 누르는 동안 칸의 초점·캐럿을 지킨다
        <div className="sl-mention pe-ref-pick" onMouseDown={(e) => e.preventDefault()}>
          <div className="sl-mention-head">
            레퍼런스 칸
            <span className="sl-mention-hint">↑↓ 이동 · Enter 선택 · Esc 닫기</span>
          </div>
          <div className="sl-mention-list">
            {items.map((r, i) => (
              <button key={r.token} type="button" className={"sl-mention-item" + (i === pick.index ? " on" : "")}
                onMouseEnter={() => setPick({ ...pick, index: i })} onClick={() => choose(r)}>
                {r.thumb ? <img className="pe-ref-pick-thumb" src={r.thumb} alt="" draggable={false} /> : <span className="pe-ref-pick-thumb" />}
                <span className="sl-mention-name">{r.token}</span>
                <span className="sl-mention-tags">{r.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
