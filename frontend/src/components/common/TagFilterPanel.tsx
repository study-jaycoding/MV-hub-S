import type { MouseEvent as ReactMouseEvent, Ref } from "react";

interface Props {
  tags: string[];
  activeTags: Set<string>;
  panelRef: Ref<HTMLDivElement>;
  pos: { x: number; y: number } | null;
  size?: { w: number; h: number } | null;
  onHeadMouseDown: (e: ReactMouseEvent, fallback?: { x: number; y: number }) => void;
  onClear: () => void;
  onSelectTag: (tag: string, additive: boolean) => void;
  onDeleteTag: (tag: string) => void;
  deleteTitle?: string;
  emptyText?: string;
}

const FALLBACK_POS = { x: 180, y: 150 };

export function TagFilterPanel({
  tags,
  activeTags,
  panelRef,
  pos,
  size,
  onHeadMouseDown,
  onClear,
  onSelectTag,
  onDeleteTag,
  deleteTitle = "이 태그를 모든 생성본에서 삭제",
  emptyText = "등록된 태그가 없습니다.",
}: Props) {
  const panelPos = pos || FALLBACK_POS;

  return (
    <div
      className="tag-panel"
      ref={panelRef}
      style={{
        left: panelPos.x,
        top: panelPos.y,
        width: size?.w,
        height: size?.h,
      }}
    >
      <div className="tag-panel-head" onMouseDown={onHeadMouseDown}>
        <span>
          등록된 태그 <span className="muted">({tags.length})</span>
        </span>
        {activeTags.size > 0 && (
          <button
            className="tag-panel-clear"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onClear}
          >
            필터 해제
          </button>
        )}
      </div>
      <div className="tag-panel-list">
        {tags.length === 0 && <div className="tag-panel-empty">{emptyText}</div>}
        {tags.map((tag) => (
          <span key={tag} className={"tag-pill" + (activeTags.has(tag) ? " on" : "")}>
            <button
              className="tag-pill-name"
              title="클릭=이 태그만 · Shift/Ctrl+클릭=다중 선택"
              onClick={(e) => onSelectTag(tag, e.shiftKey || e.ctrlKey || e.metaKey)}
            >
              #{tag}
            </button>
            <button className="tag-pill-x" title={deleteTitle} onClick={() => onDeleteTag(tag)}>
              ✕
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
