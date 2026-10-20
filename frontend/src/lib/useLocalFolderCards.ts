// 폴더 카드를 목록에서 직접 묶을 때의 자료 — 지금 조회(자리 + 찾는 조건)의 목록을 **따로** 끝까지 받는다(lib/fetchAllGenerations).
//  본 목록 훅(useGenerationLibraryData)의 목록을 쓰지 않는다: 그 목록은 다시 받을 때마다 첫 쪽으로 줄고, 폴더 창에 빌려 주며, 자리 옮김의
//  잠금·먼저 그리기가 모두 '낱장 격자의 자료'를 전제로 한다(컷 카드 세션의 설계 검토 2026-10-13).
//  규칙 셋:
//   ① **끝까지 받은 결과만 내놓는다** — 부분 목록으로 묶으면 카드가 자리를 바꾸며 불어나 누르던 카드가 달라진다.
//   ② 같은 자리에서 조회만 바뀌어 새로 받는 동안은 **앞 결과를 그대로 쥔다**(fresh = 거짓) — 묶음이 풀려 낱장이 번쩍이지 않게.
//   ③ 자리(계정·서버·프로젝트·폴더·공간)가 바뀌면 버린다 — 남의 자리의 카드를 그리지 않는다.
//  다시 받는 때: 조회가 바뀌었을 때, 그리고 같은 조회에서 **내용이 바뀌었다는 신호**가 왔을 때 — 본 목록 첫 쪽의 내용 서명(listSig)이 달라졌거나
//  서버 카드(base — 내용이 같으면 같은 객체다)가 새로 왔을 때. 그 조회에서 처음 본 값은 기준일 뿐이다(그 조회는 이미 받고 있다).
//  태그 조건에 영향을 주는 저장 완료는 첫 쪽 밖의 변경도 다시 받는다. 내용이 같은 15초 주기 조회마다 전량 받지는 않는다.
//  **한 번에 하나만 받는다** — 조건을 연달아 바꾸면 받던 것이 끝난 뒤 마지막 조회만 받는다(큰 요청이 쌓이지 않게, Codex 코드 리뷰).
//  공간 필터는 목록 훅처럼 받은 뒤 한 번 더 거른다. 폴더 경로는 묶는 쪽(lib/folderCardsLocal)이 글자 그대로 다시 본다.
import { useEffect, useRef, useState } from "react";
import type { GenQuery, Generation } from "../types";
import { fetchAllGenerations } from "./fetchAllGenerations";
import type { FolderCardsScope } from "./folderCards";
import { matchesWorkspaceFilter } from "./libraryWorkspaceScope";
import { APP_EVENTS } from "./appEvents";
import { generationChangeReceiver, generationChangeScope, readGenerationChange } from "../features/library/api";

interface Options {
  place: FolderCardsScope | null; // 묶을 자리 — null 이면 받지 않는다(쥐고 있던 것도 내놓지 않는다)
  query: GenQuery; // 지금 조회(자리 + 찾는 조건)
  authKey: string;
  listSig: string | null; // 본 목록 첫 쪽의 내용 서명 — 그 목록이 **지금 조회의 것**일 때만, 아니면 null(창·사본·옛 조회)
  base: object | null; // 그 자리의 서버 카드(내용이 같으면 같은 객체) — 없으면 null
  // 거짓이면 새로 받기를 **미룬다**(쥔 결과는 그대로 내놓는다). 옛 서버 채우기는 본 목록의 첫 쪽이 온 뒤에 출발시킨다 — 자리를 옮긴 직후
  //  화면을 세우는 응답(본 목록 첫 쪽)과 큰 요청이 겹치지 않게. 걸러 보기는 본 내용이라 바로 받는다(늘 참).
  ready?: boolean;
}

interface Result {
  placeKey: string;
  queryKey: string;
  gens: Generation[];
  truncated: boolean;
  tagRevision: number;
}

export function useLocalFolderCards({ place, query, authKey, listSig, base, ready = true }: Options) {
  const placeKey = place ? JSON.stringify([authKey, place.projectId, place.parent, place.workspaceId ?? null]) : null;
  const queryKey = placeKey === null ? null : JSON.stringify([placeKey, query]);
  const [result, setResult] = useState<Result | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const queryRef = useRef(query);
  queryRef.current = query;
  const [tagRevision, setTagRevision] = useState(0);
  const [receiveTags] = useState(generationChangeReceiver);
  useEffect(() => {
    if (queryKey === null) return;
    const settled = (event: Event) => {
      const change = readGenerationChange((event as CustomEvent<{ change?: unknown }>).detail?.change);
      if (!change || change.scope.connectionKey !== authKey || receiveTags(change, generationChangeScope()) !== "fields") return;
      const asked = queryRef.current;
      const affectsQuery = change.changedFields?.some(field =>
        field === "tags" ? !!(asked.tag || asked.tags?.length || asked.search?.trim())
          : field === "auto_tags" && !!asked.auto_tags?.length);
      if (!affectsQuery) return;
      setFailedKey(null);
      setTagRevision((revision) => revision + 1);
    };
    window.addEventListener(APP_EVENTS.generationTagsSettled, settled);
    return () => window.removeEventListener(APP_EVENTS.generationTagsSettled, settled);
  }, [queryKey, authKey, receiveTags]);

  // 같은 조회에서 내용이 바뀌었다는 신호 — 그 조회에서 처음 본 값(null 이 아닌 첫 값)은 기준이다.
  const seenRef = useRef<{ key: string; sig: string | null; base: object | null } | null>(null);
  const [changed, setChanged] = useState(0);
  useEffect(() => {
    if (queryKey === null) return;
    const seen = seenRef.current !== null && seenRef.current.key === queryKey ? seenRef.current : { key: queryKey, sig: null, base: null };
    let moved = false;
    if (listSig !== null) {
      if (seen.sig !== null && seen.sig !== listSig) moved = true;
      seen.sig = listSig;
    }
    if (base !== null) {
      if (seen.base !== null && seen.base !== base) moved = true;
      seen.base = base;
    }
    seenRef.current = seen;
    if (moved) setChanged((n) => n + 1);
  }, [queryKey, listSig, base]);

  const laneRef = useRef<Promise<unknown>>(Promise.resolve()); // 한 번에 하나 — 앞 요청이 끝난 뒤에 출발한다
  const doneRef = useRef<string | null>(null); // 끝까지 받은 '조회 + 신호' — ready 만 들락날락할 때 다시 받지 않는다
  // 조회를 떠나면 지운다 — 건너뛰기는 **같은 조회에 머문 채** ready 만 바뀔 때의 것이다. 남기면 A → B → A 로 돌아왔을 때 다시 받지 않아
  //  옛 집계가 지금 것처럼 남는다(Codex 코드 리뷰).
  useEffect(() => () => {
    doneRef.current = null;
  }, [queryKey]);
  useEffect(() => {
    if (placeKey === null || queryKey === null || !ready) return;
    const runKey = `${changed}:${tagRevision}#${queryKey}`;
    if (doneRef.current === runKey) return;
    let alive = true;
    const run = laneRef.current.then(() => {
      if (!alive) return null; // 기다리는 사이 조회가 또 바뀌었다 — 보내지 않는다
      const asked = queryRef.current;
      // 묶기는 프롬프트를 읽지 않는다 — 빈 글로 받는다(42회차: 500건 한 쪽 12.3MB 의 86% 가 프롬프트 두 칸 · lib/folderCardsLocal)
      return fetchAllGenerations(asked, () => alive, { leanPrompt: true }).then((got) => got && { asked, got });
    });
    laneRef.current = run.catch(() => null);
    run.then((done) => {
      if (!alive || !done) return;
      doneRef.current = runKey;
      setResult({
        placeKey, queryKey, tagRevision, gens: done.got.gens.filter((g) => matchesWorkspaceFilter(g, done.asked)), truncated: done.got.truncated,
      });
      setFailedKey(null);
    }).catch(() => {
      if (alive) setFailedKey(queryKey); // 실패 — 쥐고 있던 앞 결과는 그대로 둔다(부르는 쪽이 failed 로 알린다)
    });
    return () => {
      alive = false;
    };
  }, [placeKey, queryKey, changed, tagRevision, ready]);

  const held = result !== null && result.placeKey === placeKey ? result : null;
  const fresh = held !== null && held.queryKey === queryKey && held.tagRevision === tagRevision;
  const failed = queryKey !== null && failedKey === queryKey;
  return {
    gens: held?.gens ?? null, // 끝까지 받은 목록(같은 자리의 앞 조회 것일 수 있다 — fresh 로 가린다)
    fresh, // 지금 조회의 것인가
    truncated: held?.truncated ?? false, // 상한에서 잘렸다 — '최근 N건 기준'
    loading: queryKey !== null && !fresh && !failed, // 지금 조회의 답을 아직 모른다
    failed, // 지금 조회를 받지 못했다(쥐고 있는 것은 앞 조회의 것이거나 없다)
  };
}
