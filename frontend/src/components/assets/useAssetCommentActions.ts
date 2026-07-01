import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { api } from "../../api";
import { flashMsg } from "../../lib/flash";
import type { AssetComment } from "../../types";

interface Params {
  project: string;
  commentPath: string | null;
  muteOwnRef: MutableRefObject<boolean>;
  setCommentPath: Dispatch<SetStateAction<string | null>>;
  setComments: Dispatch<SetStateAction<AssetComment[]>>;
  reconcile: () => Promise<void>;
}

export function useAssetCommentActions({
  project,
  commentPath,
  muteOwnRef,
  setCommentPath,
  setComments,
  reconcile,
}: Params) {
  const openComments = (path: string) => {
    setCommentPath(path);
    api
      .assetComments(project, path)
      .then(setComments)
      .catch(() => setComments([]));
    api
      .markCommentsRead(project, path)
      .then(reconcile)
      .catch(() => {});
  };

  const refreshComments = () => {
    if (!commentPath) return Promise.resolve();
    return api.assetComments(project, commentPath).then(setComments);
  };

  const sendComment = (text: string, parentId?: string | null) => {
    const trimmed = text.trim();
    if (!commentPath || !trimmed) return;
    api
      .addAssetComment(project, commentPath, trimmed, parentId, muteOwnRef.current)
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
