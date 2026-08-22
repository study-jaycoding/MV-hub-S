import { useRef } from "react";
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
  // 남의 코멘트가 붙는다(연타 시 순서 역전). 목록을 비우고 최신 path 응답만 반영한다.
  const openPathRef = useRef<string | null>(null);
  const openComments = (path: string) => {
    setCommentPath(path);
    setComments([]);
    openPathRef.current = path;
    api
      .assetComments(project, path)
      .then((c) => {
        if (openPathRef.current === path) setComments(c);
      })
      .catch(() => {
        if (openPathRef.current === path) setComments([]);
      });
    api
      .markCommentsRead(project, path)
      .then(reconcile)
      .catch(() => {});
  };

  const refreshComments = () => {
    if (!commentPath) return Promise.resolve();
    return api.assetComments(project, commentPath).then(setComments);
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
