// 공유 & 리뷰 탭의 폴더 카드(고른 폴더 바로 아래 폴더마다 건수·표지·대표) 받기.
//  · 문맥(계정·서버·프로젝트·폴더·공간)이 바뀌면 받던 응답도 받아 둔 카드도 버린다 — 남의 문맥의 카드를 잠깐이라도 그리지 않는다.
//  · reloadKey(목록이 새 첫 쪽을 적용할 때마다 오르는 값)가 바뀌면 다시 받는다 — 팀 목록의 통보·주기 조회와 같은 때에 따라간다.
//    대표만 바뀌면 생성물 목록 내용은 그대로라, 목록 배열이 바뀌었는지로는 알 수 없다.
//  · 옛 공유 서버(경로 없음)는 그 계정·서버 문맥에서만 '지원 안 함' 으로 기억한다 — 그때는 받아 둔 카드도 내놓지 않는다(낡은 묶음 화면이
//    [전체]로 돌아갈 길 없이 남는다). 다른 오류는 기억하지 않고, 받아 둔 카드도 그대로 둔다.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { FolderCards } from "../types";
import type { FolderCardsScope } from "./folderCards";
import { isRouteMissing } from "./http";

interface Options {
  scope: FolderCardsScope | null; // null = 받지 않는다
  authKey: string;
  reloadKey: number;
}

export function useFolderCards({ scope, authKey, reloadKey }: Options) {
  const projectId = scope?.projectId;
  const parent = scope?.parent;
  const workspaceId = scope?.workspaceId;
  const key = projectId === undefined ? null : JSON.stringify([authKey, projectId, parent, workspaceId ?? null]);
  const [loaded, setLoaded] = useState<{ key: string; cards: FolderCards } | null>(null);
  const [unsupportedFor, setUnsupportedFor] = useState<string | null>(null);
  const unsupported = unsupportedFor === authKey;
  const seqRef = useRef(0);
  // 지금 받는 중인 조회 — 뒤에 출발한 조회가 앞의 것을 대신하면 앞의 약속은 뒤의 것이 끝날 때 함께 풀린다.
  const inflightRef = useRef<Promise<void> | null>(null);

  // 끝나면 풀리는 약속을 돌려준다(대표를 저장한 쪽이 서버 값을 다시 읽은 뒤에 잠금을 풀 수 있게). 실패해도 던지지 않는다.
  //  약속은 '이 조회의 응답이 적용되거나, 이 조회를 대신한 더 나중 조회가 끝났을 때' 풀린다 — 버려진 응답이 돌아온 순간에 풀면
  //  아직 안 온 새 값 대신 옛 대표 표시로 다시 조작하게 된다.
  const load = useCallback((): Promise<void> => {
    const seq = ++seqRef.current; // 문맥이 바뀌거나 다시 받기 시작하면 앞선 응답은 버린다
    if (key === null || projectId === undefined || parent === undefined || unsupported) {
      inflightRef.current = null;
      return Promise.resolve();
    }
    const run = (async () => {
      try {
        const cards = await api.folderCards(projectId, parent, workspaceId);
        if (seq === seqRef.current) setLoaded({ key, cards });
      } catch (error) {
        if (seq === seqRef.current && isRouteMissing(error)) setUnsupportedFor(authKey);
      }
      // 이 조회가 버려졌으면(더 나중 조회가 출발) 그 조회가 끝날 때까지 — 응답이 적용된 뒤에 풀린다
      const latest = inflightRef.current;
      if (seq !== seqRef.current && latest) await latest;
    })();
    inflightRef.current = run;
    return run;
  }, [authKey, key, parent, projectId, unsupported, workspaceId]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  return { cards: !unsupported && loaded !== null && loaded.key === key ? loaded.cards : null, unsupported, reload: load };
}
