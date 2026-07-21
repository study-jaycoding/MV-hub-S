import { useMemo, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, RefObject } from "react";
import { buildCommentTree } from "../../lib/commentTree";
import { fmtWhen } from "../../lib/format";

// 코멘트 본문 글씨 크기(px) — 사용자별 localStorage 저장, 패널마다 공통 적용.
const FS_KEY = "ch.cmt.fontPx";
const FS_MIN = 11;
const FS_MAX = 24;
const FS_DEF = 13;
function loadFontPx(): number {
  const v = Number(localStorage.getItem(FS_KEY));
  return v >= FS_MIN && v <= FS_MAX ? v : FS_DEF;
}

export interface CommentPanelItem {
  id: string;
  author: string;
  author_name: string | null;
  text: string;
  created_at: string;
  parent_id: string | null;
  unread?: boolean;
}

export function CommentPanel<T extends CommentPanelItem>({
  comments,
  label,
  myId,
  panelRef,
  pos,
  size,
  fallbackPos = { x: 240, y: 160 },
  onHeadMouseDown,
  onClose,
  onSend,
  onEdit,
  onDelete,
  onSeen,
  muteOwn,
  onToggleMuteOwn,
}: {
  comments: T[];
  label: string;
  myId: string;
  panelRef: RefObject<HTMLDivElement>;
  pos: { x: number; y: number } | null;
  size?: { w: number; h: number } | null;
  fallbackPos?: { x: number; y: number };
  onHeadMouseDown: (e: ReactMouseEvent, fallback?: { x: number; y: number }) => void;
  onClose: () => void;
  onSend: (text: string, parentId?: string | null) => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onSeen?: (comment: T) => void;
  muteOwn?: boolean;
  onToggleMuteOwn?: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [fontPx, setFontPx] = useState<number>(loadFontPx);
  const setFs = (px: number) => {
    const n = Math.max(FS_MIN, Math.min(FS_MAX, px));
    setFontPx(n);
    try {
      localStorage.setItem(FS_KEY, String(n));
    } catch {
      /* localStorage 불가 환경 무시 */
    }
  };
  const { byParent, byId, roots, descendantsOf } = useMemo(
    () => buildCommentTree(comments),
    [comments],
  );

  const submitComment = (text: string, parentId?: string | null) => {
    setReplyingId(null);
    onSend(text, parentId);
  };

  const submitEdit = (id: string, text: string) => {
    setEditingId(null);
    onEdit(id, text);
  };

  const renderRow = (c: T, isReply: boolean, replyToName: string | null) => {
    const mine = c.author === myId;
    const lockedByReply = (byParent[c.id] || []).some((ch) => ch.author !== myId);
    return (
      <div
        key={c.id}
        className={"cmt-item" + (isReply ? " reply" : "") + (c.unread ? " unread" : "")}
        title={c.unread ? "클릭해 확인 (새 코멘트)" : undefined}
        onClick={
          c.unread && onSeen
            ? (e) => {
                if ((e.target as HTMLElement).closest("button, input, form")) return;
                onSeen(c);
              }
            : undefined
        }
      >
        <div className="cmt-meta">
          {c.unread && <span className="cmt-new">NEW</span>}
          <span className="cmt-author">{c.author_name || "팀원"}</span>
          {replyToName && <span className="cmt-replyto">↳ {replyToName}</span>}
          <span className="cmt-when">{fmtWhen(c.created_at)}</span>
          <div className="cmt-acts">
            <button onClick={() => { setReplyingId(c.id); setEditingId(null); }}>답글</button>
            {mine && !lockedByReply && (
              <>
                <button onClick={() => { setEditingId(c.id); setReplyingId(null); }}>수정</button>
                <button onClick={() => onDelete(c.id)}>삭제</button>
              </>
            )}
            {mine && lockedByReply && (
              <span className="cmt-lock" title="답글이 달려 수정·삭제 불가">🔒</span>
            )}
          </div>
        </div>

        {editingId === c.id ? (
          <form
            className="cmt-mini"
            onSubmit={(e) => {
              e.preventDefault();
              const el = e.currentTarget.elements.namedItem("e") as HTMLInputElement;
              submitEdit(c.id, el.value);
            }}
          >
            <input
              name="e"
              defaultValue={c.text}
              autoFocus
              onKeyDown={(e) => { if (e.key === "Escape") setEditingId(null); }}
            />
            <button type="submit">저장</button>
          </form>
        ) : (
          <div className="cmt-text">{c.text}</div>
        )}

        {replyingId === c.id && (
          <form
            className="cmt-mini"
            onSubmit={(e) => {
              e.preventDefault();
              const el = e.currentTarget.elements.namedItem("r") as HTMLInputElement;
              submitComment(el.value, c.id);
              el.value = "";
            }}
          >
            <input
              name="r"
              placeholder="답글 작성 ⏎"
              autoFocus
              onKeyDown={(e) => { if (e.key === "Escape") setReplyingId(null); }}
            />
            <button type="submit">답글</button>
          </form>
        )}
      </div>
    );
  };

  const renderThread = (root: T) => (
    <div key={root.id} className="cmt-group">
      {renderRow(root, false, null)}
      {descendantsOf(root.id).map((d) => {
        const parent = d.parent_id ? byId[d.parent_id] : undefined;
        const toName =
          parent && d.parent_id !== root.id ? `${parent.author_name || "팀원"}` : null;
        return renderRow(d, true, toName);
      })}
    </div>
  );

  return (
    <div
      className="cmt-panel"
      ref={panelRef}
      style={
        {
          left: (pos || fallbackPos).x,
          top: (pos || fallbackPos).y,
          width: size?.w,
          height: size?.h,
          "--cmt-fs": `${fontPx}px`,
        } as CSSProperties
      }
    >
      <div className="cmt-head" onMouseDown={(e) => onHeadMouseDown(e, fallbackPos)}>
        <span className="cmt-title">
          💬 코멘트 <span className="muted">({comments.length})</span>
        </span>
        <span className="cmt-file">{label}</span>
        <div className="cmt-fs" onMouseDown={(e) => e.stopPropagation()}>
          <button title="글씨 작게" onClick={() => setFs(fontPx - 1)} disabled={fontPx <= FS_MIN}>
            A−
          </button>
          <button title="글씨 크게" onClick={() => setFs(fontPx + 1)} disabled={fontPx >= FS_MAX}>
            A+
          </button>
        </div>
        <button className="cmt-x" onMouseDown={(e) => e.stopPropagation()} onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="cmt-thread">
        {comments.length === 0 && <div className="cmt-empty">아직 코멘트가 없습니다.</div>}
        {roots.map((root) => renderThread(root))}
      </div>

      <form
        className="cmt-input"
        onSubmit={(e) => {
          e.preventDefault();
          const el = e.currentTarget.elements.namedItem("c") as HTMLInputElement;
          submitComment(el.value);
          el.value = "";
        }}
      >
        <input name="c" autoComplete="off" placeholder="코멘트 작성 ⏎" autoFocus />
        <button type="submit">전송</button>
      </form>

      {onToggleMuteOwn && (
        <label className="cmt-opt">
          <input type="checkbox" checked={!!muteOwn} onChange={onToggleMuteOwn} />
          내가 작성한 코멘트 알림 끄기
        </label>
      )}
    </div>
  );
}
