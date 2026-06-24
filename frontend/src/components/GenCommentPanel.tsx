// 생성본 코멘트 스레드 패널(공유, 에셋 파트와 별개로 동작).
// 글·답글(parent_id) · 작성자/시각 · 내 글만 수정·삭제(남이 답글 달면 잠김).
// 팀 공유 시 다른 팀원이 보고 답글을 달 수 있는 정보(데이터 모델은 공유 백엔드 전제 — Phase 5).
// 에셋의 .cmt-* 패널과 같은 CSS·상호작용이되 gen_id 키 + 전용 api 를 쓴다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { buildCommentTree } from "../lib/commentTree";
import { flashMsg } from "../lib/flash";
import { fmtWhen } from "../lib/format";
import { loadJSON } from "../lib/storage";
import type { GenComment } from "../types";

interface Props {
  genId: string;
  label: string; // 헤더 표시용(프롬프트 일부 등)
  myId: string; // 내 신원(로그인 계정 creator_uid, 단독이면 'me') — 내 코멘트 판별용
  syncTick: number; // WS 'synced' 카운터 — 바뀌면 스레드를 다시 불러온다(새 글·삭제 실시간 반영)
  onClose: () => void;
  onChanged: () => void; // 글 작성/읽음/수정/삭제 후 → 그리드 C 뱃지 갱신용 reload
}

export function GenCommentPanel({
  genId,
  label,
  myId,
  syncTick,
  onClose,
  onChanged,
}: Props) {
  const [comments, setComments] = useState<GenComment[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() =>
    loadJSON("ch.gen.cmtPos"),
  );
  const [size, setSize] = useState<{ w: number; h: number } | null>(() =>
    loadJSON("ch.gen.cmtSize"),
  );
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // 패널 위치·크기 영속
  useEffect(() => {
    if (pos) localStorage.setItem("ch.gen.cmtPos", JSON.stringify(pos));
  }, [pos]);
  useEffect(() => {
    if (size) localStorage.setItem("ch.gen.cmtSize", JSON.stringify(size));
  }, [size]);
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.offsetWidth, h: el.offsetHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // genId 바뀌면(다른 카드 열기) 스레드 로드 + 읽음 처리 → 뱃지 갱신.
  // 캐시(호버 prefetch)가 있으면 즉시 그려 체감 딜레이를 없애고, 서버 재요청으로 최신화.
  const refresh = useCallback(() => {
    const cached = api.genCommentsCached(genId);
    if (cached) setComments(cached);
    return api
      .genComments(genId)
      .then(setComments)
      .catch(() => {
        if (!cached) setComments([]);
      });
  }, [genId]);
  useEffect(() => {
    setEditingId(null);
    setReplyingId(null);
    refresh();
    // 패널을 열어도 자동 전체 읽음 처리하지 않는다 — 새 코멘트는 NEW 로 표시되고,
    // 사용자가 그 코멘트를 직접 클릭해 확인해야 seen 처리되어 카드 C 뱃지가 꺼진다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genId]);

  // WS 'synced'(다른 기기/팀원의 코멘트 추가·삭제) → 열린 스레드를 즉시 다시 불러온다.
  // 첫 마운트(syncTick=0)는 위 genId 효과가 이미 로드하므로 건너뛴다.
  useEffect(() => {
    if (syncTick) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncTick]);

  // NEW 코멘트 한 건 확인(클릭) → 그 행만 seen. 로컬 즉시 반영 + 그리드 뱃지 갱신.
  const confirmSeen = (c: GenComment) => {
    if (!c.unread) return;
    setComments((prev) => prev.map((x) => (x.id === c.id ? { ...x, unread: false } : x)));
    api
      .markGenCommentSeen(c.id)
      .then(onChanged)
      // 실패 시 롤백 — 서버는 미확인인데 화면만 읽음으로 두면 거짓(새로고침·타 PC 서 NEW 부활).
      .catch(() =>
        setComments((prev) => prev.map((x) => (x.id === c.id ? { ...x, unread: true } : x))),
      );
  };

  const sendComment = (text: string, parentId?: string | null) => {
    const t = text.trim();
    if (!t) return;
    setReplyingId(null);
    api
      .addGenComment(genId, t, parentId)
      .then(refresh)
      .then(onChanged)
      // 실패를 삼키면 사용자는 코멘트를 남겼다고 오인 → 명시적으로 알린다.
      .catch(() => flashMsg("코멘트 전송 실패 — 다시 시도하세요"));
  };
  const editComment = (id: string, text: string) => {
    const t = text.trim();
    if (!t) return;
    setEditingId(null);
    api.editGenComment(id, t).then(refresh).catch((e) => alert(String(e)));
  };
  const delComment = (id: string) => {
    if (!window.confirm("이 코멘트를 삭제할까요?")) return;
    api.deleteGenComment(id).then(refresh).then(onChanged).catch((e) => alert(String(e)));
  };

  // 드래그(헤더)
  const onDrag = useCallback((e: MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPos({ x: e.clientX - d.dx, y: e.clientY - d.dy });
  }, []);
  const onDragUp = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener("mousemove", onDrag);
    window.removeEventListener("mouseup", onDragUp);
  }, [onDrag]);
  const onHeadDown = (e: React.MouseEvent) => {
    const p = pos || { x: 240, y: 160 };
    dragRef.current = { dx: e.clientX - p.x, dy: e.clientY - p.y };
    window.addEventListener("mousemove", onDrag);
    window.addEventListener("mouseup", onDragUp);
  };

  // 코멘트 트리(부모 → 답글) — 계산은 공용 유틸, 변수명은 기존 그대로 받아 렌더 코드 무변경.
  const {
    byParent: cmtByParent,
    byId: cmtById,
    roots: cmtRoots,
    descendantsOf,
  } = useMemo(() => buildCommentTree(comments), [comments]);

  const renderRow = (c: GenComment, isReply: boolean, replyToName: string | null) => {
    const mine = c.author === myId;
    const lockedByReply = (cmtByParent[c.id] || []).some((ch) => ch.author !== myId);
    return (
      <div
        key={c.id}
        className={"cmt-item" + (isReply ? " reply" : "") + (c.unread ? " unread" : "")}
        title={c.unread ? "클릭해 확인 (새 코멘트)" : undefined}
        onClick={
          c.unread
            ? (e) => {
                // 답글/수정/삭제 버튼·입력은 그대로 동작, 그 외 영역 클릭 시 확인 처리.
                if ((e.target as HTMLElement).closest("button, input, form")) return;
                confirmSeen(c);
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
                <button onClick={() => delComment(c.id)}>삭제</button>
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
              editComment(c.id, el.value);
            }}
          >
            <input name="e" defaultValue={c.text} autoFocus
              onKeyDown={(e) => { if (e.key === "Escape") setEditingId(null); }} />
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
              sendComment(el.value, c.id);
              el.value = "";
            }}
          >
            <input name="r" placeholder="답글 작성 ⏎" autoFocus
              onKeyDown={(e) => { if (e.key === "Escape") setReplyingId(null); }} />
            <button type="submit">답글</button>
          </form>
        )}
      </div>
    );
  };

  const renderThread = (root: GenComment) => (
    <div key={root.id} className="cmt-group">
      {renderRow(root, false, null)}
      {descendantsOf(root.id).map((d) => {
        const parent = d.parent_id ? cmtById[d.parent_id] : undefined;
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
      style={{
        left: (pos || { x: 240, y: 160 }).x,
        top: (pos || { x: 240, y: 160 }).y,
        width: size?.w,
        height: size?.h,
      }}
    >
      <div className="cmt-head" onMouseDown={onHeadDown}>
        <span className="cmt-title">
          💬 코멘트 <span className="muted">({comments.length})</span>
        </span>
        <span className="cmt-file">{label}</span>
        <button className="cmt-x" onMouseDown={(e) => e.stopPropagation()} onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="cmt-thread">
        {comments.length === 0 && <div className="cmt-empty">아직 코멘트가 없습니다.</div>}
        {cmtRoots.map((root) => renderThread(root))}
      </div>

      <form
        className="cmt-input"
        onSubmit={(e) => {
          e.preventDefault();
          const el = e.currentTarget.elements.namedItem("c") as HTMLInputElement;
          sendComment(el.value);
          el.value = "";
        }}
      >
        <input name="c" autoComplete="off" placeholder="코멘트 작성 ⏎" autoFocus />
        <button type="submit">전송</button>
      </form>
    </div>
  );
}
