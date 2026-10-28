import { Fragment, useEffect, useRef, useState } from "react";
import type {
  ClipboardEventHandler,
  CompositionEventHandler,
  DragEventHandler,
  FormEventHandler,
  KeyboardEventHandler,
  MouseEventHandler,
  RefObject,
} from "react";
import { AUDIO_TAG_GROUPS } from "../../lib/spotlightPromptConfig";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { CopyIcon, EraserIcon } from "../common/ViewIcons";

interface Props {
  expanded: boolean;
  tagFilter: string | null;
  editorRef: RefObject<HTMLDivElement>;
  onToggleExpand: () => void;
  onClearTagFilter: () => void;
  onInput: FormEventHandler<HTMLDivElement>;
  onBlur?: () => void;
  onCaretMove: () => void;
  onKeyDown: KeyboardEventHandler<HTMLDivElement>;
  onPaste: ClipboardEventHandler<HTMLDivElement>;
  onCompositionStart: CompositionEventHandler<HTMLDivElement>;
  onCompositionEnd: CompositionEventHandler<HTMLDivElement>;
  onDragOver: DragEventHandler<HTMLDivElement>;
  onDrop: DragEventHandler<HTMLDivElement>;
  onDragLeave: DragEventHandler<HTMLDivElement>;
  onCopyPrompt: MouseEventHandler<HTMLButtonElement>;
  onClearPrompt: MouseEventHandler<HTMLButtonElement>; // 프롬프트만 비우기(레퍼런스는 그대로 — Jay 2026-10-22)
  /** 내레이션 대본처럼 글을 그대로 읽는 모델 — 안내 문구와 글자 수/한도를 바꿔 보인다. */
  script?: { count: number; max?: number } | null; // max 없음 = 엔진을 아직 안 골라 한도를 모름
  /** 모든 모델의 글자 수(오디오처럼 보인다). 자리는 늘 비워 둬 모델을 바꿔도 칸 높이가 튀지 않는다. */
  charCount?: number | null;
  /** 글을 받지 않는 일(보이스 체인지·번역) — 입력을 막고 이 안내만 보인다. 써 둔 글은 지우지 않고 보내지도 않는다. */
  notice?: string | null;
  /** 태그를 읽는 모델(ElevenLabs v4) — [+ Tag] 단추와 태그 창을 보이고, 고른 태그를 커서 자리에 넣는다. 없으면 단추 없음. */
  onAudioTag?: ((tag: string) => void) | null;
}

export function SpotlightPromptRow({
  expanded,
  tagFilter,
  editorRef,
  onToggleExpand,
  onClearTagFilter,
  onInput,
  onBlur,
  onCaretMove,
  onKeyDown,
  onPaste,
  onCompositionStart,
  onCompositionEnd,
  onDragOver,
  onDrop,
  onDragLeave,
  onCopyPrompt,
  onClearPrompt,
  script = null,
  charCount = null,
  notice = null,
  onAudioTag = null,
}: Props) {
  const chars = notice ? null : script ?? (charCount == null ? null : { count: charCount, max: undefined });
  const rowRef = useRef<HTMLDivElement>(null);
  const [tagsOpen, setTagsOpen] = useState(false);
  const showTags = !!onAudioTag;
  useEffect(() => { if (!showTags) setTagsOpen(false); }, [showTags]);
  useEscapeClose(() => setTagsOpen(false), showTags && tagsOpen);
  // 이 줄 밖을 누르면 닫는다 — 글 칸을 누르는 건 커서 옮기기라 열어 둔다(여러 자리에 연달아 넣기).
  useEffect(() => {
    if (!tagsOpen) return;
    const down = (event: PointerEvent) => {
      if (!rowRef.current?.contains(event.target as Node)) setTagsOpen(false);
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [tagsOpen]);
  return (
    <div ref={rowRef} className={"sl-prompt-row counted" + (tagFilter ? " tag-active" : "") + (notice ? " notice" : "") + (showTags ? " atags" : "")}>
      <button
        className={"sl-expand-btn" + (expanded ? " on" : "")}
        title={expanded ? "레퍼런스 트레이 접기" : "레퍼런스 트레이 펼치기 (에셋 드래그)"}
        onClick={onToggleExpand}
      >
        {expanded ? "−" : "+"}
      </button>
      {tagFilter && (
        <span className="sl-tag-badge" title="태그 필터 (Esc 또는 × 로 해제)">
          #{tagFilter}
          {/* mousedown 에서 푼다(preventDefault — 편집칸의 초점을 빼앗지 않게). Tab 으로 닿았으면 Enter·Space 로도(조작 규칙 51). */}
          <button
            title="태그 필터 해제"
            onMouseDown={(e) => {
              e.preventDefault();
              onClearTagFilter();
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              onClearTagFilter();
            }}
          >
            ×
          </button>
        </span>
      )}
      <div
        ref={editorRef}
        className="sl-prompt"
        contentEditable={!notice}
        suppressContentEditableWarning
        aria-disabled={notice ? true : undefined}
        title={notice || undefined}
        data-placeholder={
          notice
            ? notice
            : script
            ? "Write the exact words to be spoken"
            : expanded
              ? "Describe the scene you imagine"
              : "Describe the scene you imagine --- @Source, #Tag"
        }
        onInput={onInput}
        onBlur={onBlur}
        onKeyUp={onCaretMove}
        onClick={onCaretMove}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragLeave={onDragLeave}
      />
      {chars && (
        <span className={"sl-char-count" + (chars.max && chars.count > chars.max ? " over" : "")}>
          {chars.count.toLocaleString()}{chars.max ? ` / ${chars.max.toLocaleString()}` : ""}자
        </span>
      )}
      <button
        type="button"
        className="sl-prompt-clear"
        title="프롬프트 비우기"
        aria-label="프롬프트 비우기"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClearPrompt}
      >
        <EraserIcon />
      </button>
      <button
        type="button"
        className="sl-copy-btn"
        title="프롬프트 전체 복사"
        aria-label="프롬프트 전체 복사"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onCopyPrompt}
      >
        <CopyIcon />
      </button>
      {showTags && (
        <button
          type="button"
          className={"sl-atag-btn" + (tagsOpen ? " on" : "")}
          title="오디오 태그 넣기 — 대본에 [sighing] 처럼 들어갑니다"
          aria-expanded={tagsOpen}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setTagsOpen((v) => !v)}
        >
          + Tag
        </button>
      )}
      {showTags && tagsOpen && (
        // 누르는 동안 글 칸의 초점·커서를 지킨다 — 태그는 그 커서 자리에 들어가고 창은 열린 채(연달아 넣기).
        <div className="sl-atag-pop" role="dialog" aria-label="Audio tags" onMouseDown={(e) => e.preventDefault()}>
          <div className="sl-atag-head">
            <span>Audio tags</span>
            <span className="sl-atag-hint">누르면 커서 자리에 들어갑니다</span>
          </div>
          <div className="sl-atag-body">
            {AUDIO_TAG_GROUPS.map(([group, tags]) => (
              <div key={group}>
                <div className="sl-dd-title">{group}</div>
                <div className="sl-atag-pills">
                  {tags.map((tag) => (
                    <button key={tag} type="button" className="sl-atag-pill" onClick={() => onAudioTag?.(tag)}>
                      [{tag}]
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** `[` 를 치면 뜨는 오디오 태그 목록(v4) — @·# 고르기와 같은 창. 누르는 동안 입력칸 초점을 지킨다. */
export function AudioTagList({
  items,
  activeIndex,
  onHoverIndex,
  onSelect,
}: {
  items: { group: string; tag: string }[];
  activeIndex: number;
  onHoverIndex: (index: number) => void;
  onSelect: (tag: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector(".sl-mention-item.on")?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);
  return (
    <div className="sl-mention sl-atag-list" onMouseDown={(e) => e.preventDefault()}>
      <div className="sl-mention-head">
        Audio tags ([)
        <span className="sl-mention-hint">↑↓ 이동 · Enter 선택 · Esc 닫기</span>
      </div>
      <div className="sl-mention-list" ref={listRef}>
        {items.map((item, index) => (
          <Fragment key={item.group + ":" + item.tag}>
            {item.group !== items[index - 1]?.group && <div className="sl-mention-sub">{item.group}</div>}
            <button
              type="button"
              className={"sl-mention-item" + (index === activeIndex ? " on" : "")}
              onMouseEnter={() => onHoverIndex(index)}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(item.tag);
              }}
            >
              <span className="sl-mention-name">[{item.tag}]</span>
            </button>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
