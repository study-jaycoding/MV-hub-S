import { useMemo, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, Ref } from "react";
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

// 비공개 작성 상태·같이 보기 — 패널 공통(에셋·생성), localStorage 로 유지.
//  같이 보기 기본 켬: 방금 쓴 비공개가 바로 안 보이면 "전송이 안 됐나?" 로 읽힌다.
const PRIV_KEY = "ch.cmt.private"; // 다음 코멘트를 비공개로 쓸지
const SHOW_KEY = "ch.cmt.showPrivate"; // 목록에 내 비공개를 섞어 보여줄지
const loadFlag = (key: string, def: boolean): boolean => {
  const v = localStorage.getItem(key);
  return v === null ? def : v === "1";
};
const saveFlag = (key: string, v: boolean) => {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {
    /* localStorage 불가 환경 무시 */
  }
};

export interface CommentPanelItem {
  id: string;
  author: string;
  author_name: string | null;
  text: string;
  created_at: string;
  parent_id: string | null;
  unread?: boolean;
  private?: boolean; // 비공개 — 팀 공유 스레드·발행·통계에는 안 보임(글씨색 구분)
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
}: {
  comments: T[];
  label: string;
  myId: string;
  panelRef: Ref<HTMLDivElement>; // useFloatingPanel 의 콜백 ref — 리마운트 감지용
  pos: { x: number; y: number } | null;
  size?: { w: number; h: number } | null;
  fallbackPos?: { x: number; y: number };
  onHeadMouseDown: (e: ReactMouseEvent, fallback?: { x: number; y: number }) => void;
  onClose: () => void;
  onSend: (text: string, parentId: string | null | undefined, isPrivate: boolean) => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onSeen?: (comment: T) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [fontPx, setFontPx] = useState<number>(loadFontPx);
  // 비공개로 쓰기 + 같이 보기(내 비공개를 목록에 섞어 표시) — 패널 공통 설정.
  const [writePrivate, setWritePrivate] = useState<boolean>(() => loadFlag(PRIV_KEY, false));
  const [showPrivate, setShowPrivate] = useState<boolean>(() => loadFlag(SHOW_KEY, true));
  const togglePrivate = () => setWritePrivate((v) => (saveFlag(PRIV_KEY, !v), !v));
  const toggleShow = () => setShowPrivate((v) => (saveFlag(SHOW_KEY, !v), !v));
  const setFs = (px: number) => {
    const n = Math.max(FS_MIN, Math.min(FS_MAX, px));
    setFontPx(n);
    try {
      localStorage.setItem(FS_KEY, String(n));
    } catch {
      /* localStorage 불가 환경 무시 */
    }
  };
  // 같이 보기 끔 = 팀이 보는 그대로(공유만). 켬 = 내 비공개를 시간순으로 섞어 표시.
  const visible = useMemo(
    () => (showPrivate ? comments : comments.filter((c) => !c.private)),
    [comments, showPrivate],
  );
  const { byId, roots, descendantsOf } = useMemo(
    () => buildCommentTree(visible),
    [visible],
  );
  // 수정·삭제 잠금 판정은 '같이 보기'로 숨긴 비공개 답글까지 포함한 전체 목록 기준 —
  // 표시 목록(visible)으로 판정하면 숨겨둔 내 비공개 답글이 있는 부모를 지울 수 있게 되고,
  // 공유 부모는 서버에서 지워지는데 비공개 답글은 로컬에 남아 부모 없는 고아가 된다(적대 리뷰 P2).
  const fullTree = useMemo(() => buildCommentTree(comments), [comments]);

  const submitComment = (text: string, parentId?: string | null) => {
    setReplyingId(null);
    // 비공개 코멘트에 단 답글은 무조건 비공개 — 공유로 나가면 팀에겐 부모 없는 답글이 된다.
    const parentPrivate = !!(parentId && byId[parentId]?.private);
    onSend(text, parentId, parentPrivate || writePrivate);
  };

  const submitEdit = (id: string, text: string) => {
    setEditingId(null);
    onEdit(id, text);
  };

  const renderRow = (c: T, isReply: boolean, replyToName: string | null) => {
    const mine = c.author === myId;
    // 깊은 후손까지 본다 — 중간 답글을 지워도 그 아래(남의 답글·내 비공개)가 고아가 되는 건 같다.
    const deepChildren = fullTree.descendantsOf(c.id);
    const lockedByReply = deepChildren.some((ch) => ch.author !== myId);
    // 공유 코멘트 아래 내 비공개 답글 — 부모만 서버에서 지워지면 비공개가 로컬 고아로 남는다.
    const lockedByPrivateChild = !c.private && deepChildren.some((ch) => ch.private);
    return (
      <div
        key={c.id}
        className={
          "cmt-item" +
          (isReply ? " reply" : "") +
          (c.unread ? " unread" : "") +
          (c.private ? " private" : "")
        }
        title={
          c.private
            ? "비공개 — 팀 공유 스레드·발행·통계에 표시되지 않음"
            : c.unread
              ? "클릭해 확인 (새 코멘트)"
              : undefined
        }
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
          {c.private && <span className="cmt-priv-tag">비공개</span>}
          <span className="cmt-author">{c.author_name || "팀원"}</span>
          {replyToName && <span className="cmt-replyto">↳ {replyToName}</span>}
          <span className="cmt-when">{fmtWhen(c.created_at)}</span>
          <div className="cmt-acts">
            <button onClick={() => { setReplyingId(c.id); setEditingId(null); }}>답글</button>
            {mine && !lockedByReply && (
              <>
                <button onClick={() => { setEditingId(c.id); setReplyingId(null); }}>수정</button>
                {!lockedByPrivateChild && (
                  <button onClick={() => onDelete(c.id)}>삭제</button>
                )}
              </>
            )}
            {mine && (lockedByReply || lockedByPrivateChild) && (
              <span
                className="cmt-lock"
                title={
                  lockedByReply
                    ? "답글이 달려 수정·삭제 불가"
                    : "비공개 답글이 달려 있어 삭제 불가 — 비공개 답글을 먼저 지우세요"
                }
              >
                🔒
              </span>
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
          💬 코멘트 <span className="muted">({visible.length})</span>
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
        {visible.length === 0 && <div className="cmt-empty">아직 코멘트가 없습니다.</div>}
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
        <input
          name="c"
          autoComplete="off"
          placeholder={writePrivate ? "비공개 코멘트 작성 ⏎ (팀에게 안 보임)" : "코멘트 작성 ⏎"}
          autoFocus
        />
        <button type="submit">전송</button>
      </form>

      <div className="cmt-opt">
        <label title="개인 기록으로 저장 — 팀 공유 스레드·발행·통계에 표시되지 않습니다">
          <input type="checkbox" checked={writePrivate} onChange={togglePrivate} />
          비공개 코멘트
        </label>
        <label title="끄면 팀이 보는 그대로(공유 코멘트만) 표시">
          <input type="checkbox" checked={showPrivate} onChange={toggleShow} />
          같이 보기
        </label>
      </div>
    </div>
  );
}
