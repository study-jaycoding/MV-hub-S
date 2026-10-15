import { useLayoutEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { api } from "../../api";
import { flashMsg } from "../../lib/flash";
import { API_PAUSED_MESSAGE, ApiPausedError } from "../../lib/http";
import type { AssetComment } from "../../types";

interface Params {
  project: string;
  commentPath: string | null;
  setCommentPath: Dispatch<SetStateAction<string | null>>;
  setComments: Dispatch<SetStateAction<AssetComment[]>>;
  reconcile: () => Promise<void>;
  // 다른 파일의 코멘트로 옮겨도 되나 — 창은 파일마다 다시 그려져 쓰던 글이 사라진다(Jay 결정 5A). 거짓이면 옮기지 않는다.
  canLeaveComment?: () => boolean;
}

export function useAssetCommentActions({
  project,
  commentPath,
  setCommentPath,
  setComments,
  reconcile,
  canLeaveComment,
}: Params) {
  // 마지막으로 연 파일 — 파일을 연달아 열면 이전 파일 응답이 늦게 도착해 새 제목 아래
  // 남의 코멘트가 붙는다(연타 시 순서 역전). 목록을 비우고 최신 대상의 응답만 반영한다.
  // 대상은 **프로젝트와 경로**다(조작 규칙 40) — 경로만 보면, 프로젝트를 바꿔 같은 상대경로의 파일을 열었을 때 앞 프로젝트의
  // 늦은 응답이 통과한다. 그 코멘트를 고치거나 지우면 앞 프로젝트의 코멘트 id 로 요청이 나간다.
  const openTargetRef = useRef<string | null>(null);
  const targetOf = (path: string) => JSON.stringify([project, path]);
  // 프로젝트를 바꾸면 열려 있던 코멘트 패널을 닫는다 — 열어 둔 채면 앞 프로젝트 파일의 코멘트가 보이는 채로 남고,
  // 거기에 쓴 새 코멘트는 새 프로젝트의 같은 경로에 달렸다(경로는 그대로고 프로젝트만 바뀐 요청이 나간다).
  // 그리기 전에 닫는다(useLayoutEffect — 조작 규칙 45): 그린 뒤에 닫으면 새 프로젝트는 그려졌는데 패널은 아직 앞 프로젝트의 파일을 쥔
  // 한 박자가 생기고, 그때의 전송이 새 프로젝트의 같은 경로로 나갔다(Codex 코드 리뷰).
  const shownProjectRef = useRef(project);
  useLayoutEffect(() => {
    if (shownProjectRef.current === project) return;
    shownProjectRef.current = project;
    openTargetRef.current = null;
    setCommentPath(null);
    setComments([]);
  }, [project, setCommentPath, setComments]);
  const openComments = (path: string) => {
    if (commentPath && path !== commentPath && canLeaveComment && !canLeaveComment()) return;
    const target = targetOf(path);
    setCommentPath(path);
    setComments([]);
    openTargetRef.current = target;
    api
      .assetComments(project, path)
      .then((c) => {
        if (openTargetRef.current === target) setComments(c);
      })
      // 실패해도 비우지 않는다(조작 규칙 41) — 열 때 이미 비웠다. 여기서 또 비우면, 닫았다 같은 파일을 다시 열어 받은 코멘트를
      //  앞서 연 조회의 늦은 실패가 지운다(대상이 같아 위의 가드를 지난다 — Codex 코드 리뷰).
      .catch(() => {});
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

  // 저장됐는지를 돌려준다(조작 규칙 41) — 패널은 저장된 뒤에야 입력을 비운다. 저장은 됐는데 그 뒤의 다시 읽기가 실패한 것은
  // '저장 실패'가 아니다.
  const sendComment = (text: string, parentId: string | null | undefined, isPrivate: boolean): Promise<boolean> => {
    const trimmed = text.trim();
    if (!commentPath || !trimmed) return Promise.resolve(false);
    return api.addAssetComment(project, commentPath, trimmed, parentId, isPrivate).then(
      () => {
        void refreshComments().then(reconcile).catch(() => {});
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
    const trimmed = text.trim();
    if (!trimmed) return Promise.resolve(false);
    return api.editAssetComment(id, trimmed).then(
      () => {
        void refreshComments().catch(() => {});
        return true;
      },
      (error) => {
        alert(String(error));
        return false;
      },
    );
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
