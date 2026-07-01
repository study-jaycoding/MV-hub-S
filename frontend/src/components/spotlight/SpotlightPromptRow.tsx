import type {
  ClipboardEventHandler,
  CompositionEventHandler,
  DragEventHandler,
  FormEventHandler,
  KeyboardEventHandler,
  MouseEventHandler,
  RefObject,
} from "react";

interface Props {
  expanded: boolean;
  tagFilter: string | null;
  editorRef: RefObject<HTMLDivElement>;
  onToggleExpand: () => void;
  onClearTagFilter: MouseEventHandler<HTMLButtonElement>;
  onInput: FormEventHandler<HTMLDivElement>;
  onCaretMove: () => void;
  onKeyDown: KeyboardEventHandler<HTMLDivElement>;
  onPaste: ClipboardEventHandler<HTMLDivElement>;
  onCompositionStart: CompositionEventHandler<HTMLDivElement>;
  onCompositionEnd: CompositionEventHandler<HTMLDivElement>;
  onDragOver: DragEventHandler<HTMLDivElement>;
  onDrop: DragEventHandler<HTMLDivElement>;
  onDragLeave: DragEventHandler<HTMLDivElement>;
  onCopyPrompt: MouseEventHandler<HTMLButtonElement>;
}

export function SpotlightPromptRow({
  expanded,
  tagFilter,
  editorRef,
  onToggleExpand,
  onClearTagFilter,
  onInput,
  onCaretMove,
  onKeyDown,
  onPaste,
  onCompositionStart,
  onCompositionEnd,
  onDragOver,
  onDrop,
  onDragLeave,
  onCopyPrompt,
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
          <button onMouseDown={onClearTagFilter}>×</button>
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
        className="sl-copy-btn"
        title="프롬프트 전체 복사"
        aria-label="프롬프트 전체 복사"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onCopyPrompt}
      />
    </div>
  );
}
