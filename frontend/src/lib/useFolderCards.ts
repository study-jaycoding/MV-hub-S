// 공유 & 리뷰 탭의 폴더 카드(고른 폴더 바로 아래 폴더마다 건수·표지·대표) 받기.
//  · 문맥(계정·서버·프로젝트·폴더·공간)이 바뀌면 받던 응답도 받아 둔 카드도 버린다 — 남의 문맥의 카드를 잠깐이라도 그리지 않는다.
//  · reloadKey(목록이 **같은 조회를 다시 받을 때마다** 오르는 값)가 바뀌면 다시 받는다 — 팀 목록의 통보·주기 조회와 같은 때에 따라간다.
//    대표만 바뀌면 생성물 목록 내용은 그대로라, 목록 배열이 바뀌었는지로는 알 수 없다.
//    조회가 바뀌어(폴더 이동·찾는 조건·폴더 창) 받은 첫 쪽까지 따라가면 폴더를 옮길 때마다 같은 묶음 조회가 두 번 나간다(자리 변경으로 한 번,
//    목록 도착으로 또 한 번) — App 은 `useSameQueryRevision` 으로 '같은 조회를 다시 받았을 때'만 오르는 값을 넘긴다(Codex 코드 리뷰 10-13).
//  · **같은 문맥의 조회가 받는 중이면 새로 보내지 않고 그 조회에 얹는다**(끝난 뒤 한 번 더 받는다, 여러 요구를 하나로) — 주기
//    조회(15초)보다 응답이 느린 서버에서 조회가 꼬리를 물고 이어져 대표 저장의 잠금이 영영 안 풀리던 것(Codex 코드 검토 10-09).
//    얹을 때 받는 중인 응답은 **버리지 않는다** — 버리면 느린 서버에서 어느 응답도 적용되지 못한다. 대표를 저장한 뒤의 reload()
//    만 받는 중인 응답을 버린다(저장 전에 출발한 조회가 늦게 와서 방금 고른 대표를 지우지 않게).
//    문맥이 바뀐 조회는 얹지 않고 바로 보낸다(다른 폴더로 옮겨 갈 때 앞 조회를 기다리지 않게). 얹힌 요구는 그 조회에 속한다 —
//    옛 문맥의 조회가 끝나며 새 문맥의 요구를 가져가지 않는다.
//  · 새 응답이 받아 둔 것과 내용까지 같으면 같은 객체를 돌려준다 — 15초마다 카드·창(컷 정보·모아보기)이 새 객체를 받아 다시
//    조회·다시 그리던 것을 막는다.
//  · 옛 공유 서버(경로 없음)는 그 계정·서버 문맥에서만 '지원 안 함' 으로 기억한다 — 그때는 받아 둔 카드도 내놓지 않는다(낡은 묶음 화면이
//    [전체]로 돌아갈 길 없이 남는다). 다른 오류는 기억하지 않고, 받아 둔 카드도 그대로 둔다. 그 기억은 **5분에 한 번 다시 물어본다** —
//    앱을 먼저 올리고 서버를 나중에 갱신해도 열린 화면의 묶음 보기가 돌아오게(문맥에 서버 버전이 없다 — Codex 코드 리뷰 10-13).
//  · loading = 지금 문맥의 카드가 아직 없고 그 문맥의 조회가 실패하지도 않은 동안 — 그동안 App 이 낱장 격자를 그리지 않는다(낱장이 한 번
//    보였다가 컷 카드로 바뀌던 깜빡임, Jay 2026-10-13 ③). 받아 둔 카드가 있는 문맥으로 돌아오면 바로 그 카드(다시 받기는 뒤에서). 실패하면
//    꺼진다(영영 빈 화면이 안 되게) — 그 실패 표식은 문맥을 떠나면 버린다: 남기면 실패한 폴더로 빠르게 되돌아올 때 첫 렌더부터 낱장이 선다
//    (Codex 설계 검토). 문맥이 바뀐 바로 그 렌더에서 버린다(렌더 중 setState = React 의 '이전 렌더 값 기억' 방식).
//  · **받아 둔 카드는 문맥마다 기억한다**(Jay 2026-10-13 "아직 폴더 이동할 때 딜레이") — 다시 온 폴더는 응답을 기다리지 않고 받아 둔 것부터
//    그리고, 뒤에서 다시 받아 바꾼다(남의 문맥의 카드는 여전히 그리지 않는다 — 키에 계정·서버·프로젝트·폴더·공간이 다 들어 있다).
//    하위 폴더가 없다고 알려 준 카드(`subfolders` 0)는 **그 폴더의 답(빈 묶음)을 미리 적어 둔다** — 에피소드에서 컷으로 들어갈 때 물어볼 것이
//    없다. 그 뒤 하위 폴더가 생겼다고 알려 오면 미리 적은 답은 지운다. 기억은 모듈 하나를 두 훅(하위 묶음·들어간 폴더의 부모)이 같이 쓴다.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { FolderCards } from "../types";
import type { FolderCardsScope } from "./folderCards";
import { isRouteMissing } from "./http";
import { timedLibraryRequest } from "./libraryRequestTimeout";

const remembered = new Map<string, FolderCards>();
const REMEMBER_MAX = 400; // 에피소드 하나가 컷 수십 개의 답을 미리 적는다 — 넘치면 가장 오래 안 쓴 것부터 버린다
function remember(key: string, cards: FolderCards): void {
  remembered.delete(key);
  remembered.set(key, cards);
  if (remembered.size > REMEMBER_MAX) remembered.delete(remembered.keys().next().value as string);
}
/** 시험용 — 모듈에 든 기억을 비운다. */
export function forgetFolderCards(): void {
  remembered.clear();
  warming.clear();
}
const UNSUPPORTED_RETRY_MS = 5 * 60_000; // 옛 서버로 기억한 문맥을 다시 물어보는 간격

// 들어가기 직전의 미리 받기(Jay 10-16 2A — 에피소드로 들어갈 때 빈 칸). 두 번 클릭의 둘째 누름·[열기] 누름에서 그 폴더의 묶음을 미리 묻는다.
//  들어간 훅의 **첫 조회가 그 요청을 이어받는다** — 같은 묶음을 두 번 묻지 않는다(Codex 검토 10-16). 대표 저장 뒤의 다시 받기(discard)는
//  이어받지 않는다(저장 전에 출발한 미리 받기가 방금 고른 대표를 덮지 않게). 들어가지 않으면 응답이 온 뒤 WARM_MS 지나 버린다.
//  받는 중인 요청은 버리지 않는다 — 느린 서버에서 다시 눌러도 같은 묶음을 두 번 묻지 않게(Codex 10-16 P2). 걸린 요청을 기다리는 것은
//  훅이 스스로 물었을 때와 같다 — 둘 다 목록과 같은 제한 시간(30초)에 실제로 끊는다(83회차: 걸러 보는 컷 화면의 갱신이 이 응답을 기다린다).
const WARM_MS = 3000;
type Warm = { promise: Promise<FolderCards>; done?: number };
const warming = new Map<string, Warm>();
const stale = (warm: Warm, now: number) => warm.done !== undefined && now - warm.done > WARM_MS;
const askCards = (projectId: string, parent: string, workspaceId?: string) =>
  timedLibraryRequest((signal) => api.folderCards(projectId, parent, workspaceId, signal));
export function prefetchFolderCards(authKey: string, scope: FolderCardsScope): void {
  const key = JSON.stringify([authKey, scope.projectId, scope.parent, scope.workspaceId ?? null]);
  const now = Date.now();
  for (const [old, warm] of warming) if (stale(warm, now)) warming.delete(old);
  if (warming.has(key)) return; // 이미 묻는 중 — 빠른 두 번 클릭·[열기] 연타
  const warm: Warm = { promise: askCards(scope.projectId, scope.parent, scope.workspaceId) };
  warm.promise.then(
    () => { warm.done = Date.now(); },
    () => { if (warming.get(key) === warm) warming.delete(key); }, // 실패는 이어받지 않는다 — 들어간 훅이 새로 묻는다
  );
  warming.set(key, warm);
}
function takeWarm(key: string): Promise<FolderCards> | null {
  const warm = warming.get(key);
  if (!warm) return null;
  warming.delete(key); // 한 번만 이어받는다 — 그 뒤의 다시 받기는 새로 묻는다
  return stale(warm, Date.now()) ? null : warm.promise;
}

/** 목록이 **같은 조회를 다시 받았을 때만** 오르는 값(주기 조회·통보·내 조작 뒤의 다시 받기) — 폴더 카드를 다시 받는 신호.
 *  조회가 바뀐 뒤의 첫 revision 은 그 조회의 첫 답이지 변경 통보가 아니다(빠르게 여러 번 옮겨도 목록 훅은 마지막 조회의 첫 쪽만 적용한다). */
export function useSameQueryRevision(queryKey: string, revision: number): number {
  const [seen, setSeen] = useState({ queryKey, revision, first: true, count: 0 });
  if (seen.queryKey !== queryKey || seen.revision !== revision) {
    const first = seen.queryKey !== queryKey || seen.first;
    const bumped = seen.revision !== revision;
    // 렌더 중 setState = React 의 '이전 렌더 값 기억' 방식(이 렌더는 버리고 새 값으로 바로 다시 그린다)
    setSeen({ queryKey, revision, first: bumped ? false : first, count: seen.count + (bumped && !first ? 1 : 0) });
  }
  return seen.count;
}

interface Options {
  scope: FolderCardsScope | null; // null = 받지 않는다
  authKey: string;
  reloadKey: number;
}

/** 한 번 받기의 결과 — applied = 지금 문맥의 응답을 적용했다(cards = 그 카드) · failed = 받지 못했다(옛 서버 포함 — 받아 둔 카드는 그대로)
 *  · obsolete = 더 새 조회·문맥에 버려졌다 · none = 받을 것이 없었다(범위 없음·옛 서버로 기억한 동안). 걸러 보는 컷 화면의 갱신은 applied 만 성공으로 친다. */
export interface FolderCardsOutcome {
  status: "applied" | "failed" | "obsolete" | "none";
  cards: FolderCards | null;
}
const OBSOLETE: FolderCardsOutcome = { status: "obsolete", cards: null };
const NONE: FolderCardsOutcome = { status: "none", cards: null };

interface Pending {
  promise: Promise<FolderCardsOutcome>;
  resolve: (outcome: FolderCardsOutcome) => void;
}

interface Run {
  promise: Promise<FolderCardsOutcome>; // 이 조회가 끝나면(응답 적용·버림·실패 모두) 풀린다
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
  const unsupportedAtRef = useRef(0); // 옛 서버라고 마지막으로 확인한 때
  const seqRef = useRef(0);
  // 최신 인자 — 얹힌 뒤 늦게 출발하는 조회가 그때의 문맥으로 받게.
  const argsRef = useRef({ key, projectId, parent, workspaceId, authKey, unsupported });
  argsRef.current = { key, projectId, parent, workspaceId, authKey, unsupported };
  const runningRef = useRef<Run | null>(null);

  // 돌려주는 값: FolderCardsOutcome(위) — 실패를 삼킨 뒤에도 '적용했다'로 답하지 않는다(83회차 — 컷 화면의 갱신이 이 결과를 기다린다).
  const fetchOnce = useCallback(async (): Promise<FolderCardsOutcome> => {
    const seq = ++seqRef.current; // 문맥이 바뀌거나 다시 받기 시작하면 앞선 응답은 버린다
    const { key: nowKey, projectId: pid, parent: dir, workspaceId: ws, authKey: auth, unsupported: off } = argsRef.current;
    if (nowKey === null || pid === undefined || dir === undefined) return NONE;
    if (off && Date.now() - unsupportedAtRef.current < UNSUPPORTED_RETRY_MS) return NONE; // 옛 서버 — 가끔만 다시 물어본다
    try {
      const fresh = await (takeWarm(nowKey) ?? askCards(pid, dir, ws)); // 미리 받은 요청이 있으면 이어받는다
      if (seq !== seqRef.current) return OBSOLETE;
      if (off) setUnsupportedFor(null); // 서버가 갱신됐다
      const kept = remembered.get(nowKey);
      // 내용이 같다 — 같은 객체를 돌려줘 아래가 다시 그리지 않게
      const cards = kept !== undefined && JSON.stringify(kept) === JSON.stringify(fresh) ? kept : fresh;
      remember(nowKey, cards);
      for (const folder of cards.folders) {
        const child = JSON.stringify([auth, pid, folder.path, ws ?? null]);
        if (folder.subfolders === 0) {
          if (!remembered.has(child)) remember(child, { parent: folder.path, own_count: folder.count, folders: [] });
        } else if (remembered.get(child)?.folders.length === 0) {
          remembered.delete(child); // 하위 폴더가 생겼다(또는 옛 서버라 모른다) — 미리 적은 '빈 묶음'을 믿지 않는다
        }
      }
      setLoaded((previous) => (previous !== null && previous.key === nowKey && previous.cards === cards ? previous : { key: nowKey, cards }));
      return { status: "applied", cards };
    } catch (error) {
      if (seq !== seqRef.current) return OBSOLETE;
      if (off || isRouteMissing(error)) unsupportedAtRef.current = Date.now(); // 다시 물어본 것이 실패해도 다음 물음은 그 간격 뒤
      if (isRouteMissing(error)) setUnsupportedFor(auth);
      else setFailedKey(nowKey);
      return { status: "failed", cards: null };
    }
  }, []);

  // discard = 받는 중인 같은 문맥의 응답을 버린다(대표 저장 뒤). 아니면 그 응답은 적용하고 끝난 뒤 한 번 더 받는다.
  const request = useCallback((discard: boolean): Promise<FolderCardsOutcome> => {
    const running = runningRef.current;
    const nowKey = argsRef.current.key;
    // 저장 전에 출발한 미리 받기는 버린다 — 바로 보내는 조회도, 받는 중인 조회에 얹혀 끝난 뒤 보내는 조회도 이어받지 않게
    if (discard && nowKey !== null) warming.delete(nowKey);
    if (running && nowKey !== null && running.key === nowKey) {
      if (discard) seqRef.current += 1;
      if (!running.pending) {
        let resolve!: (outcome: FolderCardsOutcome) => void;
        const promise = new Promise<FolderCardsOutcome>((done) => { resolve = done; });
        running.pending = { promise, resolve };
      }
      return running.pending.promise;
    }
    const run: Run = { promise: Promise.resolve(NONE), key: nowKey ?? "", pending: null };
    run.promise = fetchOnce().then(async (outcome) => {
      if (runningRef.current === run) runningRef.current = null;
      const pending = run.pending;
      if (pending) {
        // 얹힌 요구 — 한 번 더 받는다. 그사이 다른 문맥의 조회가 이미 출발했으면 그 조회가 끝날 때 함께 풀린다(또 보내지 않는다).
        void (runningRef.current?.promise ?? request(false)).then(pending.resolve);
      }
      // 이 조회의 응답이 버려졌으면(문맥이 바뀌었다 돌아오는 등) 그 자리를 대신한 조회가 끝날 때까지 풀지 않는다 — 저장이 옛 값
      //  표시로 잠금을 풀지 않게(Codex 코드 검토 10-09 3차). 대신할 조회가 없으면(받을 것이 없어졌다) 그냥 푼다.
      if (outcome.status === "obsolete" && runningRef.current && runningRef.current !== run) return runningRef.current.promise;
      return outcome;
    });
    runningRef.current = run;
    return run.promise;
  }, [fetchOnce]);

  useEffect(() => {
    void request(false);
  }, [request, reloadKey, key, unsupported]);

  // 끝나면 풀리는 약속을 돌려준다(대표를 저장한 쪽이 서버 값을 다시 읽은 뒤에 잠금을 풀 수 있게). 실패해도 던지지 않는다.
  //  약속은 '이 요구 뒤에 출발한 조회의 응답이 적용됐을 때' 풀린다 — 받는 중이던 응답은 버린다.
  const reload = useCallback((): Promise<void> => request(true).then(() => undefined), [request]);
  // 걸러 보는 컷 화면의 갱신이 같은 실행에서 서버 카드도 다시 받는 입구 — 받는 중인 응답은 버리지 않고 끝난 뒤 한 번 더 받아(이 요구 뒤에
  //  출발한 조회) 그 결과를 돌려준다. 성공 여부는 결과의 status 로 — 약속이 풀린 것 자체는 성공이 아니다.
  const refresh = useCallback((): Promise<FolderCardsOutcome> => request(false), [request]);

  // 이 훅이 받은 것이 지금 문맥의 것이면 그것, 아니면 기억해 둔 것(다시 온 폴더·미리 적은 컷) — 조회는 위 effect 가 늘 다시 보낸다.
  const cards = unsupported || key === null ? null : loaded !== null && loaded.key === key ? loaded.cards : remembered.get(key) ?? null;
  return { cards, unsupported, loading: key !== null && !unsupported && cards === null && failedKey !== key, reload, refresh };
}
