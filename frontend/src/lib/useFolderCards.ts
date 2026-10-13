// 공유 & 리뷰 탭의 폴더 카드(고른 폴더 바로 아래 폴더마다 건수·표지·대표) 받기.
//  · 문맥(계정·서버·프로젝트·폴더·공간)이 바뀌면 받던 응답도 받아 둔 카드도 버린다 — 남의 문맥의 카드를 잠깐이라도 그리지 않는다.
//  · reloadKey(목록이 새 첫 쪽을 적용할 때마다 오르는 값)가 바뀌면 다시 받는다 — 팀 목록의 통보·주기 조회와 같은 때에 따라간다.
//    대표만 바뀌면 생성물 목록 내용은 그대로라, 목록 배열이 바뀌었는지로는 알 수 없다.
//  · **같은 문맥의 조회가 받는 중이면 새로 보내지 않고 그 조회에 얹는다**(끝난 뒤 한 번 더 받는다, 여러 요구를 하나로) — 주기
//    조회(15초)보다 응답이 느린 서버에서 조회가 꼬리를 물고 이어져 대표 저장의 잠금이 영영 안 풀리던 것(Codex 코드 검토 10-09).
//    얹을 때 받는 중인 응답은 **버리지 않는다** — 버리면 느린 서버에서 어느 응답도 적용되지 못한다. 대표를 저장한 뒤의 reload()
//    만 받는 중인 응답을 버린다(저장 전에 출발한 조회가 늦게 와서 방금 고른 대표를 지우지 않게).
//    문맥이 바뀐 조회는 얹지 않고 바로 보낸다(다른 폴더로 옮겨 갈 때 앞 조회를 기다리지 않게). 얹힌 요구는 그 조회에 속한다 —
//    옛 문맥의 조회가 끝나며 새 문맥의 요구를 가져가지 않는다.
//  · 새 응답이 받아 둔 것과 내용까지 같으면 같은 객체를 돌려준다 — 15초마다 카드·창(컷 정보·모아보기)이 새 객체를 받아 다시
//    조회·다시 그리던 것을 막는다.
//  · 옛 공유 서버(경로 없음)는 그 계정·서버 문맥에서만 '지원 안 함' 으로 기억한다 — 그때는 받아 둔 카드도 내놓지 않는다(낡은 묶음 화면이
//    [전체]로 돌아갈 길 없이 남는다). 다른 오류는 기억하지 않고, 받아 둔 카드도 그대로 둔다.
//  · loading = 지금 문맥의 카드가 아직 없고 그 문맥의 조회가 실패하지도 않은 동안 — 그동안 App 이 낱장 격자를 그리지 않는다(낱장이 한 번
//    보였다가 컷 카드로 바뀌던 깜빡임, Jay 2026-10-13 ③). 받아 둔 카드가 있는 문맥으로 돌아오면 바로 그 카드(다시 받기는 뒤에서). 실패하면
//    꺼진다(영영 빈 화면이 안 되게) — 그 실패 표식은 문맥을 떠나면 버린다: 남기면 실패한 폴더로 빠르게 되돌아올 때 첫 렌더부터 낱장이 선다
//    (Codex 설계 검토). 문맥이 바뀐 바로 그 렌더에서 버린다(렌더 중 setState = React 의 '이전 렌더 값 기억' 방식).
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

interface Pending {
  promise: Promise<void>;
  resolve: () => void;
}

interface Run {
  promise: Promise<void>; // 이 조회가 끝나면(응답 적용·버림·실패 모두) 풀린다
  key: string;
  pending: Pending | null; // 이 조회에 얹힌 요구 — 끝난 뒤 한 번 더 받아 그 응답이 적용되면 풀린다
}

export function useFolderCards({ scope, authKey, reloadKey }: Options) {
  const projectId = scope?.projectId;
  const parent = scope?.parent;
  const workspaceId = scope?.workspaceId;
  const key = projectId === undefined ? null : JSON.stringify([authKey, projectId, parent, workspaceId ?? null]);
  const [loaded, setLoaded] = useState<{ key: string; cards: FolderCards } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null); // 조회가 실패한(옛 서버 아님) 문맥 — 떠나면 버린다
  const [seenKey, setSeenKey] = useState(key);
  if (seenKey !== key) {
    setSeenKey(key);
    setFailedKey(null);
  }
  const [unsupportedFor, setUnsupportedFor] = useState<string | null>(null);
  const unsupported = unsupportedFor === authKey;
  const seqRef = useRef(0);
  // 최신 인자 — 얹힌 뒤 늦게 출발하는 조회가 그때의 문맥으로 받게.
  const argsRef = useRef({ key, projectId, parent, workspaceId, authKey, unsupported });
  argsRef.current = { key, projectId, parent, workspaceId, authKey, unsupported };
  const runningRef = useRef<Run | null>(null);

  // 돌려주는 값: 응답을 적용했거나(또는 받을 것이 없거나) true, 더 새 조회·문맥에 버려졌으면 false.
  const fetchOnce = useCallback(async (): Promise<boolean> => {
    const seq = ++seqRef.current; // 문맥이 바뀌거나 다시 받기 시작하면 앞선 응답은 버린다
    const { key: nowKey, projectId: pid, parent: dir, workspaceId: ws, authKey: auth, unsupported: off } = argsRef.current;
    if (nowKey === null || pid === undefined || dir === undefined || off) return true;
    try {
      const cards = await api.folderCards(pid, dir, ws);
      if (seq !== seqRef.current) return false;
      setLoaded((previous) =>
        previous !== null && previous.key === nowKey && JSON.stringify(previous.cards) === JSON.stringify(cards)
          ? previous // 내용이 같다 — 같은 객체를 돌려줘 아래가 다시 그리지 않게
          : { key: nowKey, cards },
      );
    } catch (error) {
      if (seq !== seqRef.current) return false;
      if (isRouteMissing(error)) setUnsupportedFor(auth);
      else setFailedKey(nowKey);
    }
    return true;
  }, []);

  // discard = 받는 중인 같은 문맥의 응답을 버린다(대표 저장 뒤). 아니면 그 응답은 적용하고 끝난 뒤 한 번 더 받는다.
  const request = useCallback((discard: boolean): Promise<void> => {
    const running = runningRef.current;
    const nowKey = argsRef.current.key;
    if (running && nowKey !== null && running.key === nowKey) {
      if (discard) seqRef.current += 1;
      if (!running.pending) {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => { resolve = done; });
        running.pending = { promise, resolve };
      }
      return running.pending.promise;
    }
    const run: Run = { promise: Promise.resolve(), key: nowKey ?? "", pending: null };
    run.promise = fetchOnce().then(async (applied) => {
      if (runningRef.current === run) runningRef.current = null;
      const pending = run.pending;
      if (pending) {
        // 얹힌 요구 — 한 번 더 받는다. 그사이 다른 문맥의 조회가 이미 출발했으면 그 조회가 끝날 때 함께 풀린다(또 보내지 않는다).
        void (runningRef.current?.promise ?? request(false)).then(pending.resolve);
      }
      // 이 조회의 응답이 버려졌으면(문맥이 바뀌었다 돌아오는 등) 그 자리를 대신한 조회가 끝날 때까지 풀지 않는다 — 저장이 옛 값
      //  표시로 잠금을 풀지 않게(Codex 코드 검토 10-09 3차). 대신할 조회가 없으면(받을 것이 없어졌다) 그냥 푼다.
      if (!applied && runningRef.current && runningRef.current !== run) await runningRef.current.promise;
    });
    runningRef.current = run;
    return run.promise;
  }, [fetchOnce]);

  useEffect(() => {
    void request(false);
  }, [request, reloadKey, key, unsupported]);

  // 끝나면 풀리는 약속을 돌려준다(대표를 저장한 쪽이 서버 값을 다시 읽은 뒤에 잠금을 풀 수 있게). 실패해도 던지지 않는다.
  //  약속은 '이 요구 뒤에 출발한 조회의 응답이 적용됐을 때' 풀린다 — 받는 중이던 응답은 버린다.
  const reload = useCallback((): Promise<void> => request(true), [request]);

  const cards = !unsupported && loaded !== null && loaded.key === key ? loaded.cards : null;
  return { cards, unsupported, loading: key !== null && !unsupported && cards === null && failedKey !== key, reload };
}
