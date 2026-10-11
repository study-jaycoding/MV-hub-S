// 생성본 코멘트 스레드 패널.
// 저장/수정/삭제 API 는 생성본 전용으로 유지하고, 패널 UI 는 에셋 코멘트와 공통 컴포넌트를 사용한다.
import { useCallback, useEffect, useRef, useState } from "react";
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

  useEffect(() => {
    // 카드가 바뀌면 앞 카드의 코멘트를 바로 걷는다(캐시가 있으면 refresh 가 그것을 넣는다) — 전엔 응답이 올 때까지 새 제목 아래 앞 카드의
    //  코멘트가 보였고, 거기에 단 답글은 새 카드에 앞 카드의 부모 id 로 나갔다.
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
      () => {
        flashMsg("코멘트 전송 실패 — 다시 시도하세요");
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
    <CommentPanel
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
      targetKey={genId}
    />
  );
}
