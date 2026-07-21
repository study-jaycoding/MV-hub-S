import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  Ref,
} from "react";
import { useMemo, useState } from "react";
import { loadJSON, saveJSON } from "../../lib/storage";

// 태그 글씨 크기(px) — 사용자별 localStorage 저장, 모든 태그창 공통 적용.
const FS_KEY = "ch.tag.fontPx";
const FS_MIN = 10;
const FS_MAX = 20;
const FS_DEF = 12;
function loadFontPx(): number {
  const v = loadJSON<number>(FS_KEY);
  return typeof v === "number" && v >= FS_MIN && v <= FS_MAX ? v : FS_DEF;
}

interface Props {
  tags: string[];
  activeTags: Set<string>;
  panelRef: Ref<HTMLDivElement>;
  pos: { x: number; y: number } | null;
  size?: { w: number; h: number } | null;
  onHeadMouseDown: (e: ReactMouseEvent, fallback?: { x: number; y: number }) => void;
  onClear: () => void;
  onClose?: () => void;
  onSelectTag: (tag: string, additive: boolean) => void;
  onDeleteTag: (tag: string) => void;
  deleteTitle?: string;
  emptyText?: string;
  // 있으면: 태그를 드래그해 순서 변경 가능 + 그 순서를 이 localStorage 키에 저장(브라우저 한정).
  orderKey?: string;
}

const FALLBACK_POS = { x: 180, y: 150 };

// 저장된 순서(order)를 현재 태그 목록에 적용. 저장 안 된 태그는 원래(알파벳) 순서로 뒤에 붙인다.
// (Array.sort 는 최신 브라우저에서 안정 정렬 → 미지정 태그끼리는 들어온 순서 유지)
function applyOrder(tags: string[], order: string[]): string[] {
  if (!order.length) return tags;
  const pos = new Map(order.map((name, i) => [name, i]));
  return [...tags].sort((a, b) => (pos.get(a) ?? Infinity) - (pos.get(b) ?? Infinity));
}

export function TagFilterPanel({
  tags,
  activeTags,
  panelRef,
  pos,
  size,
  onHeadMouseDown,
  onClear,
  onClose,
  onSelectTag,
  onDeleteTag,
  deleteTitle = "이 태그를 모든 생성본에서 삭제",
  emptyText = "등록된 태그가 없습니다.",
  orderKey,
}: Props) {
  const panelPos = pos || FALLBACK_POS;

  // 사용자가 정한 순서(브라우저 localStorage). 없으면 빈 배열 → 원래(알파벳) 순서 그대로.
  const [order, setOrder] = useState<string[]>(() =>
    orderKey ? loadJSON<string[]>(orderKey) || [] : [],
  );
  const orderedTags = useMemo(() => (orderKey ? applyOrder(tags, order) : tags), [tags, order, orderKey]);

  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const dropAt = (toIdx: number) => {
    const from = dragIdx;
    setDragIdx(null);
    setOverIdx(null);
    if (from === null || from === toIdx) return;
    const next = orderedTags.slice();
    const [moved] = next.splice(from, 1);
    next.splice(toIdx, 0, moved);
    setOrder(next); // 현재 보이는 태그 전체를 명시적 순서로 저장(새 태그는 다음에 뒤로 붙음)
    if (orderKey) saveJSON(orderKey, next);
  };
  const draggable = !!orderKey;

  const [fontPx, setFontPx] = useState<number>(loadFontPx);
  const setFs = (px: number) => {
    const n = Math.max(FS_MIN, Math.min(FS_MAX, px));
    setFontPx(n);
    saveJSON(FS_KEY, n);
  };

  return (
    <div
      className="tag-panel"
      ref={panelRef}
      style={
        {
          left: panelPos.x,
          top: panelPos.y,
          width: size?.w,
          height: size?.h,
          "--tag-fs": `${fontPx}px`,
        } as CSSProperties
      }
    >
      <div className="tag-panel-head" onMouseDown={onHeadMouseDown}>
        <span className="tag-panel-title">
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
        <div className="tag-fs" onMouseDown={(e) => e.stopPropagation()}>
          <button title="글씨 작게" onClick={() => setFs(fontPx - 1)} disabled={fontPx <= FS_MIN}>
            A−
          </button>
          <button title="글씨 크게" onClick={() => setFs(fontPx + 1)} disabled={fontPx >= FS_MAX}>
            A+
          </button>
        </div>
        {onClose && (
          <button
            className="tag-panel-close"
            title="닫기"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onClose}
          >
            ✕
          </button>
        )}
      </div>
      <div className="tag-panel-list">
        {orderedTags.length === 0 && <div className="tag-panel-empty">{emptyText}</div>}
        {orderedTags.map((tag, index) => (
          <span
            key={tag}
            className={
              "tag-pill" +
              (activeTags.has(tag) ? " on" : "") +
              (draggable ? " draggable" : "") +
              (dragIdx === index ? " dragging" : "") +
              (overIdx === index && dragIdx !== null && dragIdx !== index ? " drop-over" : "")
            }
            draggable={draggable}
            onDragStart={
              draggable
                ? (e: ReactDragEvent) => {
                    setDragIdx(index);
                    e.dataTransfer.effectAllowed = "move";
                  }
                : undefined
            }
            onDragOver={
              draggable
                ? (e: ReactDragEvent) => {
                    if (dragIdx === null) return;
                    e.preventDefault();
                    if (overIdx !== index) setOverIdx(index);
                  }
                : undefined
            }
            onDrop={
              draggable
                ? (e: ReactDragEvent) => {
                    e.preventDefault();
                    dropAt(index);
                  }
                : undefined
            }
            onDragEnd={
              draggable
                ? () => {
                    setDragIdx(null);
                    setOverIdx(null);
                  }
                : undefined
            }
          >
            <button
              className="tag-pill-name"
              title="클릭=이 태그만 · Shift/Ctrl+클릭=다중 선택 · 드래그=순서 변경"
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
