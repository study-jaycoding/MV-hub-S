import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { api } from "../../api";
import { flashMsg } from "../../lib/flash";
import type { AssetComment } from "../../types";

interface Params {
  project: string;
  commentPath: string | null;
  setCommentPath: Dispatch<SetStateAction<string | null>>;
  setComments: Dispatch<SetStateAction<AssetComment[]>>;
  reconcile: () => Promise<void>;
}

export function useAssetCommentActions({
  project,
  commentPath,
  setCommentPath,
  setComments,
  reconcile,
}: Params) {
  // 마지막으로 연 파일 — 파일을 연달아 열면 이전 파일 응답이 늦게 도착해 새 제목 아래
  // 남의 코멘트가 붙는다(연타 시 순서 역전). 목록을 비우고 최신 대상의 응답만 반영한다.
  // 대상은 **프로젝트와 경로**다(조작 규칙 40) — 경로만 보면, 프로젝트를 바꿔 같은 상대경로의 파일을 열었을 때 앞 프로젝트의
  // 늦은 응답이 통과한다. 그 코멘트를 고치거나 지우면 앞 프로젝트의 코멘트 id 로 요청이 나간다.
  const openTargetRef = useRef<string | null>(null);
  const targetOf = (path: string) => JSON.stringify([project, path]);
  // 프로젝트를 바꾸면 열려 있던 코멘트 패널을 닫는다 — 열어 둔 채면 앞 프로젝트 파일의 코멘트가 보이는 채로 남고,
  // 거기에 쓴 새 코멘트는 새 프로젝트의 같은 경로에 달렸다(경로는 그대로고 프로젝트만 바뀐 요청이 나간다).
  const shownProjectRef = useRef(project);
  useEffect(() => {
    if (shownProjectRef.current === project) return;
    shownProjectRef.current = project;
    openTargetRef.current = null;
    setCommentPath(null);
    setComments([]);
  }, [project, setCommentPath, setComments]);
  const openComments = (path: string) => {
    const target = targetOf(path);
    setCommentPath(path);
    setComments([]);
    openTargetRef.current = target;
    api
      .assetComments(project, path)
      .then((c) => {
        if (openTargetRef.current === target) setComments(c);
      })
      .catch(() => {
        if (openTargetRef.current === target) setComments([]);
      });
    api
      .markCommentsRead(project, path)
      .then(reconcile)
      .catch(() => {});
  };

  // 전송/수정/삭제 후 재조회. 호출 시점 파일(commentPath)을 고정해 두고, 응답이 왔을 때
  // 열려 있는 파일이 그 사이 바뀌었으면 버린다 — 새 제목 아래 옛 파일 코멘트가 붙는 것 방지.
  // (여기엔 WS 로 덮어써 주는 자가 회복 경로가 없어 한 번 어긋나면 그대로 남는다.)
  const refreshComments = () => {
    if (!commentPath) return Promise.resolve();
    const target = targetOf(commentPath);
    return api.assetComments(project, commentPath).then((c) => {
      if (openTargetRef.current === target) setComments(c);
    });
  };

  const sendComment = (text: string, parentId: string | null | undefined, isPrivate: boolean) => {
    const trimmed = text.trim();
    if (!commentPath || !trimmed) return;
    api
      .addAssetComment(project, commentPath, trimmed, parentId, isPrivate)
      .then(refreshComments)
      .then(reconcile)
      .catch(() => flashMsg("코멘트 전송 실패 — 다시 시도하세요"));
  };

  const editComment = (id: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    api.editAssetComment(id, trimmed).then(refreshComments).catch((error) => alert(String(error)));
  };

  const delComment = (id: string) => {
    if (!window.confirm("이 코멘트를 삭제할까요?")) return;
    api
      .deleteAssetComment(id)
      .then(refreshComments)
      .then(reconcile)
      .catch((error) => alert(String(error)));
  };

  return { openComments, refreshComments, sendComment, editComment, delComment };
}
