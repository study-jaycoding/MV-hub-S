// 생성본 코멘트 스레드 패널.
// 저장/수정/삭제 API 는 생성본 전용으로 유지하고, 패널 UI 는 에셋 코멘트와 공통 컴포넌트를 사용한다.
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { flashMsg } from "../lib/flash";
import { makeStore } from "../lib/storage";
import { useFloatingPanel } from "../lib/useFloatingPanel";
import type { GenComment } from "../types";
import { CommentPanel } from "./common/CommentPanel";

interface Props {
  genId: string;
  label: string;
  myId: string;
  syncTick: number;
  onClose: () => void;
  onChanged: () => void;
}

const GEN_LS = makeStore("ch.gen.");

export function GenCommentPanel({
  genId,
  label,
  myId,
  syncTick,
  onClose,
  onChanged,
}: Props) {
  const [comments, setComments] = useState<GenComment[]>([]);
  const { pos, size, panelRef, onHeadMouseDown } = useFloatingPanel(
    GEN_LS,
    "cmtPos",
    "cmtSize",
    true,
  );

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

  const sendComment = (text: string, parentId?: string | null) => {
    const t = text.trim();
    if (!t) return;
    api
      .addGenComment(genId, t, parentId)
      .then(refresh)
      .then(onChanged)
      .catch(() => flashMsg("코멘트 전송 실패 — 다시 시도하세요"));
  };

  const editComment = (id: string, text: string) => {
    const t = text.trim();
    if (!t) return;
    api.editGenComment(id, t).then(refresh).catch((e) => alert(String(e)));
  };

  const delComment = (id: string) => {
    if (!window.confirm("이 코멘트를 삭제할까요?")) return;
    api.deleteGenComment(id).then(refresh).then(onChanged).catch((e) => alert(String(e)));
  };

  return (
    <CommentPanel
      key={genId}
      comments={comments}
      label={label}
      myId={myId}
      panelRef={panelRef}
      pos={pos}
      size={size}
      onHeadMouseDown={onHeadMouseDown}
      onClose={onClose}
      onSend={sendComment}
      onEdit={editComment}
      onDelete={delComment}
      onSeen={confirmSeen}
    />
  );
}
