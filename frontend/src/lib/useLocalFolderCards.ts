// 폴더 카드를 목록에서 직접 묶을 때의 자료 — 지금 조회(자리 + 찾는 조건)의 목록을 **따로** 끝까지 받는다(lib/fetchAllGenerations).
//  본 목록 훅(useGenerationLibraryData)의 목록을 쓰지 않는다: 그 목록은 다시 받을 때마다 첫 쪽으로 줄고, 폴더 창에 빌려 주며, 자리 옮김의
//  잠금·먼저 그리기가 모두 '낱장 격자의 자료'를 전제로 한다(컷 카드 세션의 설계 검토 2026-10-13).
//  규칙 셋:
//   ① **끝까지 받은 결과만 내놓는다** — 부분 목록으로 묶으면 카드가 자리를 바꾸며 불어나 누르던 카드가 달라진다.
//   ② 같은 자리에서 조회만 바뀌어 새로 받는 동안은 **앞 결과를 그대로 쥔다**(fresh = 거짓) — 묶음이 풀려 낱장이 번쩍이지 않게.
//   ③ 자리(계정·서버·프로젝트·폴더·공간)가 바뀌면 버린다 — 남의 자리의 카드를 그리지 않는다.
//  받는 입구는 하나 — `request(intent)`(기다릴 수 있다, 83회차). 진입(조회가 바뀜·ready 가 섬)은 ensure, 같은 조회에서 **내용이 바뀌었다는 신호**
//  (본 목록 첫 쪽의 내용 서명(listSig)이 달라짐·서버 카드(base — 내용이 같으면 같은 객체다)가 새로 옴 — 그 조회에서 처음 본 값은 기준일 뿐)는
//  invalidate. 걸러 보는 컷 화면이 이 목록의 주인일 때는 App 이 주기 조회·창 복귀를 check(첫 쪽만 확인), 실제 변경을 invalidate 로 보낸다.
//   · ensure — 지금 조회의 답이 있으면 그것(reused), 받는 중이면 합류. 진입 effect 와 App 의 진입 요청이 500건을 두 번 보내지 않는다.
//   · check — 받는 중이면 합류(주기 조회가 받던 응답을 버리지 않는다). 아니면 **원본 첫 쪽**(공간 필터 전)과 서버 카드를 함께 받아, 둘 다 앞과 같으면
//     뒷쪽을 그대로 둔다. 하나라도 다르면 받은 첫 쪽을 다시 쓰고 나머지를 받는다. 답이 없거나 직전이 실패면 처음부터 끝까지.
//   · invalidate — 끝까지 다시 받는다. 받는 중이면 끝난 뒤 **한 번 더**(여럿이 와도 하나로) — 그 요구의 약속은 그 뒤 실행이 끝날 때 풀린다.
//  15초 주기 조회마다 끝까지 다시 받지 않는다(목록 한 쪽이 MB 단위다). 첫 쪽 밖의 것만 바뀌고 서버 카드도 그대로면 모른다(다음 변화까지 낡는다).
//  **한 번에 하나만 받는다** — 조건을 연달아 바꾸면 받던 것이 끝난 뒤 마지막 조회만 받는다(큰 요청이 쌓이지 않게, Codex 코드 리뷰). 조회가
//  바뀌면 받던 실행은 다음 쪽을 보내지 않고 응답도 적용하지 않는다(A → B → A 로 돌아와도 옛 A 의 것은 버린다 — 조회의 회차로 가린다).
//  공간 필터는 목록 훅처럼 받은 뒤 한 번 더 거른다. 폴더 경로는 묶는 쪽(lib/folderCardsLocal)이 글자 그대로 다시 본다.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GenQuery, Generation } from "../types";
import { fetchAllGenerations, fetchGenerationsPage } from "./fetchAllGenerations";
import type { FolderCardsScope } from "./folderCards";
import { matchesWorkspaceFilter } from "./libraryWorkspaceScope";
import { isStructurallyEqual } from "./stateReconciliation";

/** 걸러진 목록에 바라는 것 — 위 머리말의 ensure·check·invalidate. */
export type LocalCardsIntent = "ensure" | "check" | "invalidate";
/** 한 요구의 결과 — applied = 이 요구를 채운 응답을 그 조회에 적용했다(확인해 보니 그대로인 것 포함) · reused = 쥔 답을 그대로 냈다(새로 받지 않음) ·
 *  failed = 받지 못했다(쥔 답은 그대로 — 같이 받은 서버 카드만 실패해도) · obsolete = 조회가 바뀌어 버렸다(또는 미뤘다). 약속이 풀린 것 자체는 성공이 아니다. */
export interface LocalCardsOutcome {
  status: "applied" | "reused" | "failed" | "obsolete";
  key: string | null; // 어느 조회 **회차**의 결과인가(조회 + 회차 — contextKey() 와 견준다. A → B → A 로 돌아온 A 는 다른 회차다, Codex fix8 P2)
}
/** 같은 실행에서 서버 카드도 다시 받는 입구(lib/useFolderCards 의 refresh) — status "applied" 일 때만 그 카드를 믿는다. */
export type RefreshFolderCards = () => Promise<{ status: string; cards: object | null }>;

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
}
// 마지막으로 적용한 답 — 회차·원본 첫 쪽(check 의 비교 기준)·채운 요구 번호. 비교 기준과 완성 결과는 실행이 끝까지 성공했을 때 함께 바뀐다.
interface Held { epoch: number; first: Generation[]; version: number }
interface Flight { epoch: number; promise: Promise<LocalCardsOutcome> }
interface Follow { epoch: number; cards?: RefreshFolderCards; promise: Promise<LocalCardsOutcome>; resolve: (outcome: LocalCardsOutcome) => void }

const contextOf = (queryKey: string | null, epoch: number) => (queryKey === null ? null : JSON.stringify([queryKey, epoch]));
const obsolete = (key: string | null): LocalCardsOutcome => ({ status: "obsolete", key });

export function useLocalFolderCards({ place, query, authKey, listSig, base, ready = true }: Options) {
  const placeKey = place ? JSON.stringify([authKey, place.projectId, place.parent, place.workspaceId ?? null]) : null;
  const queryKey = placeKey === null ? null : JSON.stringify([placeKey, query]);
  const [result, setResult] = useState<Result | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const argsRef = useRef({ placeKey, queryKey, query, ready });
  argsRef.current = { placeKey, queryKey, query, ready };
  // 조회의 회차 — 조회가 바뀔 때마다 오른다(커밋 뒤에 — 요청은 그 뒤의 effect·이벤트에서만 나간다). 받는 중인 실행·얹힌 요구는 회차로 가린다.
  const epochRef = useRef(0);
  useLayoutEffect(() => {
    epochRef.current += 1;
  }, [queryKey]);
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);
  const heldRef = useRef<Held | null>(null);
  const failedRef = useRef<string | null>(null);
  const wantRef = useRef({ epoch: 0, version: 0 }); // 이 회차에 들어온 '실제로 바뀌었다'의 수 — 채운 번호(held.version)보다 크면 다시 받아야 한다
  const wantOf = (epoch: number) => (wantRef.current.epoch === epoch ? wantRef.current.version : 0);
  const flightRef = useRef<Flight | null>(null); // 받는 중(또는 줄 선) 실행 — 같은 회차의 ensure·check 는 여기에 합류한다
  const followRef = useRef<Follow | null>(null); // 받는 동안 온 invalidate — 끝난 뒤 한 번 더
  const laneRef = useRef<Promise<unknown>>(Promise.resolve()); // 한 번에 하나 — 앞 실행이 끝난 뒤에 출발한다
  // 같은 조회에서 내용이 바뀌었다는 신호의 기준 — 그 조회에서 처음 본 값(null 이 아닌 첫 값). 실행이 같이 받은 서버 카드도 여기에 적는다.
  const seenRef = useRef<{ key: string; sig: string | null; base: object | null } | null>(null);

  const run = useCallback(async (
    queryKey: string, epoch: number, kind: "full" | "check", version: number, refreshCards?: RefreshFolderCards,
  ): Promise<LocalCardsOutcome> => {
    const alive = () => liveRef.current && epochRef.current === epoch;
    const key = contextOf(queryKey, epoch)!; // 결과에 싣는 것 — 조회 + 회차
    const { query: asked, placeKey: placeNow } = argsRef.current;
    if (!alive() || placeNow === null) return obsolete(key); // 기다리는 사이 조회가 또 바뀌었다 — 보내지 않는다
    const seenBase = seenRef.current?.key === queryKey ? seenRef.current.base : null; // 이 실행 전의 서버 카드 — check 의 비교 기준
    // 서버 카드도 같은 실행에서 — 첫 쪽과 함께 출발한다. 받은 카드는 곧바로 '본 것'으로 적는다: 그 카드가 화면에 오며 아래 감시가 같은 갱신을
    //  또 하나의 바뀜으로 읽지 않게(Codex FE-06). 대표 저장처럼 다른 길로 온 카드는 그 뒤에 와서 감시가 한 번 반영한다.
    const cards = refreshCards
      ? refreshCards().then((got) => {
          if (got.status === "applied" && got.cards && alive()) {
            if (seenRef.current?.key === queryKey) seenRef.current.base = got.cards;
            else seenRef.current = { key: queryKey, sig: null, base: got.cards };
          }
          return got;
        }, () => ({ status: "failed", cards: null }))
      : null;
    // 같이 받은 서버 카드까지 끝난 결과 — 그 사이 조회가 바뀌었으면(A → B → A 포함) 이 실행의 결과는 버린다(늦은 카드 응답이 적용으로 끝나지 않게, Codex fix8 P2)
    const settle = async (): Promise<LocalCardsOutcome> => {
      const got = await cards;
      if (!alive()) return obsolete(key);
      return { status: got === null || got.status === "applied" || got.status === "none" ? "applied" : "failed", key };
    };
    try {
      let firstPage: Generation[] | undefined;
      if (kind === "check") {
        // 묶기는 프롬프트를 읽지 않는다 — 빈 글로 받는다(42회차: 500건 한 쪽 12.3MB 의 86% 가 프롬프트 두 칸 · lib/folderCardsLocal)
        const page = await fetchGenerationsPage(asked, null, { leanPrompt: true });
        const got = await cards;
        if (!alive()) return obsolete(key);
        const held = heldRef.current;
        const sameBase = got === null || got.status !== "applied" || got.cards === seenBase; // 카드를 못 받았으면 첫 쪽으로만 가른다(결과는 failed)
        // 원본 첫 쪽의 행 전체를 견준다 — 묶음·표지가 읽는 칸(assets·공유 시각·작성자·삭제·프로젝트·모델·생성일·길이·정렬 시각…)이 빠지지 않게(Codex FE-08).
        //  확인하는 사이 온 invalidate 는 따로 얹혀 있다(끝난 뒤 한 번 더) — 여기서 키우지 않는다(같은 바뀜에 끝까지 두 번 받지 않게).
        if (held !== null && held.epoch === epoch && sameBase && isStructurallyEqual(page, held.first)) {
          return settle();
        }
        firstPage = page;
      }
      const done = await fetchAllGenerations(asked, alive, { leanPrompt: true, firstPage });
      if (!done || !alive()) return obsolete(key);
      heldRef.current = { epoch, first: done.first, version };
      failedRef.current = null;
      setResult({ placeKey: placeNow, queryKey, gens: done.gens.filter((g) => matchesWorkspaceFilter(g, asked)), truncated: done.truncated });
      setFailedKey(null);
      return settle();
    } catch {
      if (!alive()) return obsolete(key);
      failedRef.current = queryKey;
      setFailedKey(queryKey); // 실패 — 쥐고 있던 앞 결과는 그대로 둔다(부르는 쪽이 failed 로 알린다)
      return { status: "failed", key };
    }
  }, []);

  const start = useCallback((key: string, epoch: number, kind: "full" | "check", refreshCards?: RefreshFolderCards): Promise<LocalCardsOutcome> => {
    const version = wantOf(epoch);
    const flight: Flight = { epoch, promise: Promise.resolve(obsolete(key)) };
    flight.promise = laneRef.current.then(() => run(key, epoch, kind, version, refreshCards)).catch((): LocalCardsOutcome => ({ status: "failed", key: contextOf(key, epoch) })).then((outcome) => {
      if (flightRef.current === flight) flightRef.current = null;
      const follow = followRef.current;
      if (follow && follow.epoch === epoch) {
        followRef.current = null;
        // 받는 동안 온 '실제로 바뀌었다' — 끝난 뒤 한 번 더 끝까지(여럿이 와도 이 한 번). 조회가 바뀌었으면 버린다.
        if (liveRef.current && epochRef.current === epoch) void start(key, epoch, "full", follow.cards).then(follow.resolve);
        else follow.resolve(obsolete(contextOf(key, epoch)));
      }
      return outcome;
    });
    laneRef.current = flight.promise.catch(() => null);
    flightRef.current = flight;
    return flight.promise;
  }, [run]);

  // refreshCards = 같은 실행에서 서버 카드도 다시 받는다(걸러 보는 컷 화면의 갱신 — App). 진입·안쪽 신호는 넘기지 않는다(카드는 제 훅이 받는다).
  const request = useCallback((intent: LocalCardsIntent, refreshCards?: RefreshFolderCards): Promise<LocalCardsOutcome> => {
    const { queryKey: key, placeKey: placeNow, ready: can } = argsRef.current;
    const epoch = epochRef.current;
    const context = contextOf(key, epoch);
    if (key === null || placeNow === null) return Promise.resolve(obsolete(context));
    if (intent === "invalidate") {
      wantRef.current = { epoch, version: wantOf(epoch) + 1 };
    }
    if (!can) return Promise.resolve(obsolete(context)); // 미룬다 — ready 가 서면 진입(ensure)이 받는다(요구 번호는 남는다)
    const flight = flightRef.current;
    if (flight && flight.epoch === epoch) {
      if (intent !== "invalidate") return flight.promise; // 받는 중(또는 줄 선) 실행에 합류 — 받던 응답을 버리지 않는다
      const follow = followRef.current;
      if (follow && follow.epoch === epoch) {
        follow.cards ??= refreshCards;
        return follow.promise;
      }
      follow?.resolve(obsolete(context)); // 옛 회차의 것 — 그 실행이 끝날 때도 버렸을 것이다
      let resolve!: (outcome: LocalCardsOutcome) => void;
      const promise = new Promise<LocalCardsOutcome>((done) => { resolve = done; });
      followRef.current = { epoch, cards: refreshCards, promise, resolve };
      return promise;
    }
    const held = heldRef.current;
    const have = held !== null && held.epoch === epoch && held.version >= wantOf(epoch);
    if (intent === "ensure") {
      // 진입 — 서버 카드는 제 훅이 자리마다 받는다(여기서 또 받지 않는다)
      return have ? Promise.resolve({ status: "reused", key: context }) : start(key, epoch, "full");
    }
    return start(key, epoch, intent === "check" && have && failedRef.current !== key ? "check" : "full", refreshCards);
  }, [start]);

  // 지금 조회 회차 — 커밋 뒤(이 훅의 layout effect 가 회차를 올린 뒤)에 읽는다
  const contextKey = useCallback(() => contextOf(argsRef.current.queryKey, epochRef.current), []);

  // 진입 — 조회가 바뀌었거나 ready 가 섰다
  useEffect(() => {
    if (placeKey === null || queryKey === null || !ready) return;
    void request("ensure");
  }, [placeKey, queryKey, ready, request]);

  // 같은 조회에서 내용이 바뀌었다는 신호 — 그 조회에서 처음 본 값(null 이 아닌 첫 값)은 기준이다.
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
    if (moved) void request("invalidate");
  }, [queryKey, listSig, base, request]);

  const held = result !== null && result.placeKey === placeKey ? result : null;
  const fresh = held !== null && held.queryKey === queryKey;
  const failed = queryKey !== null && failedKey === queryKey;
  return {
    gens: held?.gens ?? null, // 끝까지 받은 목록(같은 자리의 앞 조회 것일 수 있다 — fresh 로 가린다)
    fresh, // 지금 조회의 것인가
    truncated: held?.truncated ?? false, // 상한에서 잘렸다 — '최근 N건 기준'
    loading: queryKey !== null && !fresh && !failed, // 지금 조회의 답을 아직 모른다
    failed, // 지금 조회를 받지 못했다(쥐고 있는 것은 앞 조회의 것이거나 없다)
    contextKey, // 지금 조회 회차(조회 + 회차) — request 결과의 key 와 견준다
    request, // 기다릴 수 있는 받기(위 머리말)
  };
}
