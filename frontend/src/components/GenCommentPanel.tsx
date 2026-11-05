// 생성본 코멘트 스레드 패널.
// 저장/수정/삭제 API 는 생성본 전용으로 유지하고, 패널 UI 는 에셋 코멘트와 공통 컴포넌트를 사용한다.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import { APP_EVENTS } from "../lib/appEvents";
import { flashMsg } from "../lib/flash";
import { previewTargetFromGenerations } from "../lib/generationGrid";
import { API_PAUSED_MESSAGE, ApiPausedError, isHttpStatus } from "../lib/http";
import { makeStore } from "../lib/storage";
import { useFloatingPanel } from "../lib/useFloatingPanel";
import type { CommentDrawingMeta, CommentDrawingView, GenComment } from "../types";
import { CommentPanel } from "./common/CommentPanel";
import { renderStrokes, type DrawItem } from "./edit/drawing/strokes";

interface Props {
  genId: string;
  label: string;
  myId: string;
  syncTick: number;
  onClose: () => void;
  onChanged: () => void;
  // 코멘트 그림 창 오른쪽 '지난 코멘트'로 끼워 쓴다(떠 있는 창의 자리·크기를 건드리지 않는다)
  embedded?: boolean;
  // 이미지 그림 칸의 바탕(생성물 썸네일) — 없으면 어두운 바탕에 획만
  drawingBg?: string | null;
  // 그림을 눌렀을 때 — 없으면 크게 보기에서 원본 위에 겹쳐 본다
  onOpenDrawing?: (view: CommentDrawingView) => void;
}

const GEN_LS = makeStore("ch.gen.");

// ── 코멘트 그림 보기(설계 크게보기_코멘트그림 §3.1-4·§10 C5) ─────────────────────────────
//  획·영상 미리보기는 그림마다 따로 받고 브라우저 캐시·저장소에 두지 않는다(no-store). 다른 그림으로 넘어간 뒤의 늦은 답은 버리고,
//  401·403·404·410 이면 그 그림을 화면에서 걷는다(권한이 없어졌거나 지워졌다).
export const secLabel = (sec: number | null | undefined) => `${(sec ?? 0).toFixed(2)}초`;

type DrawingState = { status: "loading" } | { status: "gone" } | { status: "error" } | { status: "ok"; items: DrawItem[]; thumbUrl: string | null };

export function useCommentDrawing(commentId: string, meta: CommentDrawingMeta): DrawingState {
  const [state, setState] = useState<DrawingState>({ status: "loading" });
  useEffect(() => {
    const abort = new AbortController();
    let thumbUrl: string | null = null;
    setState({ status: "loading" });
    (async () => {
      const body = await api.commentDrawing(commentId, meta.id, { signal: abort.signal });
      if (meta.kind === "video" && meta.has_thumb) {
        try {
          thumbUrl = URL.createObjectURL(await api.commentDrawingThumb(commentId, meta.id, { signal: abort.signal }));
        } catch (error) {
          if (abort.signal.aborted) throw error;
          thumbUrl = null; // 미리보기를 못 받으면 획만(정상 계약 C6)
        }
      }
      if (abort.signal.aborted) return;
      setState({ status: "ok", items: (body.strokes?.items ?? []) as DrawItem[], thumbUrl });
    })().catch((error) => {
      if (abort.signal.aborted) return;
      setState(isHttpStatus(error, 401, 403, 404, 410) ? { status: "gone" } : { status: "error" });
    });
    return () => {
      abort.abort();
      if (thumbUrl) URL.revokeObjectURL(thumbUrl);
    };
  }, [commentId, meta.id, meta.content_hash, meta.kind, meta.has_thumb]);
  return state;
}

/** 획을 좌표계(width×height) 비율 그대로의 캔버스에 그린다 — 캔버스 해상도는 maxPx 로 줄인다(작은 칸에 원본 크기 캔버스를 두지 않게). */
export function StrokesCanvas({ items, width, height, maxPx = 320, className }: {
  items: DrawItem[]; width: number; height: number; maxPx?: number; className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !width || !height) return;
    const scale = Math.min(1, maxPx / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    renderStrokes(ctx, items, scale);
  }, [items, width, height, maxPx]);
  return <canvas ref={ref} className={className} aria-hidden="true" />;
}

function DrawingChip({ commentId, meta, bg, onOpen }: {
  commentId: string; meta: CommentDrawingMeta; bg: string | null | undefined; onOpen: (meta: CommentDrawingMeta) => void;
}) {
  const state = useCommentDrawing(commentId, meta);
  if (state.status === "gone") return null;
  const back = meta.kind === "video" ? (state.status === "ok" ? state.thumbUrl : null) : bg;
  return (
    <button type="button" className="cmt-att" title={meta.kind === "video" ? `${secLabel(meta.time_sec)} — 눌러서 크게 보기` : "눌러서 크게 보기"}
      onClick={(e) => { e.stopPropagation(); onOpen(meta); }}>
      {back && <img src={back} alt="" draggable={false} />}
      {state.status === "ok" && <StrokesCanvas items={state.items} width={meta.width} height={meta.height} />}
      {state.status === "error" && <span className="cmt-att-err">불러오지 못함</span>}
      {meta.kind === "video" && <span className="cmt-att-f">{secLabel(meta.time_sec)}</span>}
    </button>
  );
}

/** 코멘트 글 아래 그림 줄 — 붙은 순서대로. */
export function CommentDrawingStrip({ comment, bg, onOpen }: {
  comment: GenComment; bg: string | null | undefined; onOpen: (meta: CommentDrawingMeta) => void;
}) {
  const drawings = comment.drawings ?? [];
  if (!drawings.length) return null;
  return (
    <div className="cmt-atts">
      {[...drawings].sort((a, b) => a.idx - b.idx).map((meta) => (
        <DrawingChip key={meta.id} commentId={comment.id} meta={meta} bg={bg} onOpen={onOpen} />
      ))}
    </div>
  );
}

/** 크게 보기에서 겹쳐 본다 — 그 생성물을 보고 있는 크게 보기가 받고(preventDefault), 없으면 크게 보기를 그림과 함께 연다. */
export function openDrawingInPreview(view: CommentDrawingView): void {
  const event = new CustomEvent(APP_EVENTS.commentDrawingView, { detail: view, cancelable: true });
  if (!window.dispatchEvent(event)) return;
  api
    .getGeneration(view.genId)
    .then((gen) => {
      const target = previewTargetFromGenerations([gen], gen);
      if (!target) throw new Error("no media");
      window.dispatchEvent(new CustomEvent(APP_EVENTS.commentDrawingOpen, { detail: { ...target, drawing: view } }));
    })
    .catch(() => flashMsg("크게 보기를 열지 못했습니다 — 생성물을 찾지 못했습니다"));
}

export function GenCommentPanel({
  genId,
  label,
  myId,
  syncTick,
  onClose,
  onChanged,
  embedded = false,
  drawingBg,
  onOpenDrawing = openDrawingInPreview,
}: Props) {
  const [comments, setComments] = useState<GenComment[]>([]);
  const { pos, size, panelRef, onHeadMouseDown } = useFloatingPanel(
    GEN_LS,
    "cmtPos",
    "cmtSize",
    !embedded,
  );

  // 패널은 카드가 바뀌어도 remount 되지 않으므로(아래 ★ 주석) 이전 카드의 늦은 응답이 지금 카드
  // 코멘트를 덮어쓸 수 있다 → 마지막 요청만 화면에 반영한다. 전송/수정/삭제 후 refresh 도 같은 가드.
  const seqRef = useRef(0);
  // 지금 화면에 떠 있는 카드. 전송/수정/삭제 응답이 늦게 도착한 뒤 시작되는 refresh 는
  // 호출 시점(genId)을 그대로 들고 있으므로, 그 사이 카드가 바뀌었으면 아예 조회하지 않는다
  // (조회했다면 seq 를 올려 새 카드 응답을 이기고 새 제목 아래 옛 코멘트를 붙인다).
  const genIdRef = useRef(genId);
  genIdRef.current = genId;
  const refresh = useCallback(() => {
    if (genIdRef.current !== genId) return Promise.resolve();
    const my = ++seqRef.current;
    const cached = api.genCommentsCached(genId);
    if (cached) setComments(cached);
    return api
      .genComments(genId)
      .then((c) => {
        if (my === seqRef.current) setComments(c);
      })
      // 실패하면 보이던 것을 둔다(조작 규칙 41) — 전엔 비워서, 코멘트를 저장한 뒤의 다시 읽기가 실패하면 "아직 코멘트가 없습니다"가 됐다.
      //  앞 카드의 코멘트가 남을 일은 없다: 카드가 바뀌는 순간 아래에서 걷는다.
      .catch(() => {});
  }, [genId]);

  useLayoutEffect(() => {
    // 카드가 바뀌면 앞 카드의 코멘트를 바로 걷는다(캐시가 있으면 refresh 가 그것을 넣는다) — 전엔 응답이 올 때까지 새 제목 아래 앞 카드의
    //  코멘트가 보였고, 거기에 단 답글은 새 카드에 앞 카드의 부모 id 로 나갔다. 그리기 전에 걷는다 — 그린 뒤로 밀리면 그 한 박자가 남는다(조작 규칙 46).
    setComments([]);
    refresh();
    // 패널을 열어도 자동 전체 읽음 처리하지 않는다. 새 코멘트는 클릭 확인 때 seen 처리한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genId]);

  useEffect(() => {
    if (syncTick) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncTick]);

  const confirmSeen = (c: GenComment) => {
    if (!c.unread) return;
    setComments((prev) => prev.map((x) => (x.id === c.id ? { ...x, unread: false } : x)));
    api
      .markGenCommentSeen(c.id)
      .then(onChanged)
      .catch(() =>
        setComments((prev) => prev.map((x) => (x.id === c.id ? { ...x, unread: true } : x))),
      );
  };

  // 저장됐는지를 돌려준다(조작 규칙 41) — 패널은 저장된 뒤에야 입력을 비운다. 전엔 보내자마자 비워, 실패하면 쓴 글이 사라졌다.
  //  저장은 됐는데 그 뒤의 다시 읽기가 실패한 것은 '저장 실패'가 아니다(글은 올라갔다 — 목록은 다음 조회에 맞는다).
  const sendComment = (text: string, parentId: string | null | undefined, isPrivate: boolean): Promise<boolean> => {
    const t = text.trim();
    if (!t) return Promise.resolve(false);
    return api.addGenComment(genId, t, parentId, isPrivate).then(
      () => {
        void refresh().then(onChanged);
        return true;
      },
      (error) => {
        // 멈춤(다른 탭 로그아웃 — 4B)은 다시 해도 안 된다 — 멈춤을 알린다(64회차 실측). 글은 칸에 남는다.
        flashMsg(error instanceof ApiPausedError ? API_PAUSED_MESSAGE : "코멘트 전송 실패 — 다시 시도하세요");
        return false;
      },
    );
  };

  const editComment = (id: string, text: string): Promise<boolean> => {
    const t = text.trim();
    if (!t) return Promise.resolve(false);
    return api.editGenComment(id, t).then(
      () => {
        void refresh();
        return true;
      },
      (e) => {
        alert(String(e));
        return false;
      },
    );
  };

  const delComment = (id: string) => {
    if (!window.confirm("이 코멘트를 삭제할까요?")) return;
    api.deleteGenComment(id).then(refresh).then(onChanged).catch((e) => alert(String(e)));
  };

  return (
    // ★ key={genId} 를 두지 않는다 — 카드 전환 시 패널을 remount 하면 useFloatingPanel 의
    //   ResizeObserver 가 떨어져 나가는 엘리먼트에서 크기 0 으로 fire 해 저장 크기가 초기화된다.
    //   remount 없이도 comments 는 genId 변경 시 재조회되고(위 useEffect), 크기/위치가 유지된다.
    // 끼워 쓰기는 떠 있는 창의 ref 를 쓰지 않는다 — 그 크기 관찰이 끼운 칸의 크기를 떠 있는 창의 저장 크기로 덮는다.
    <CommentPanel
      comments={comments}
      label={label}
      myId={myId}
      panelRef={embedded ? null : panelRef}
      pos={pos}
      size={size}
      onHeadMouseDown={onHeadMouseDown}
      onClose={onClose}
      onSend={sendComment}
      onEdit={editComment}
      onDelete={delComment}
      onSeen={confirmSeen}
      targetKey={genId}
      embedded={embedded}
      renderExtra={(c) => (
        <CommentDrawingStrip
          comment={c}
          bg={drawingBg}
          onOpen={(drawing) => onOpenDrawing({ genId, commentId: c.id, drawing, author: c.author_name })}
        />
      )}
    />
  );
}
