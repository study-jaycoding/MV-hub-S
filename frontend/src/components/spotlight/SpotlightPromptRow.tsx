import type {
  ClipboardEventHandler,
  CompositionEventHandler,
  DragEventHandler,
  FormEventHandler,
  KeyboardEventHandler,
  MouseEventHandler,
  RefObject,
} from "react";
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
}: Props) {
  return (
    <div className={"sl-prompt-row" + (tagFilter ? " tag-active" : "")}>
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
        contentEditable
        suppressContentEditableWarning
        data-placeholder={
          expanded
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
    </div>
  );
}
