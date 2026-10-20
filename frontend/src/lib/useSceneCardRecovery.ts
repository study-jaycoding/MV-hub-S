import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Generation } from "../types";
import type { Scene, SceneCard } from "./scenes";
import { detachedCandidates, readLocalCanvasState, type CardHistoryCursor, type CardHistoryLink, type DetachedCandidate } from "./canvasDetached";
import { reviveCardGenerations } from "./sceneCardLinks";
import { flashMsg } from "./flash";
import type { CanvasComfyCommand } from "../features/canvas/api";
import type { SceneGenDataApi } from "./useSceneGenData";

interface Options {
  sceneId: string;
  cardsRef: MutableRefObject<SceneCard[]>;
  genDataRef: SceneGenDataApi["genDataRef"];
  setGenData: SceneGenDataApi["setGenData"];
  commitDocument: (command: CanvasComfyCommand) => boolean;
  isDocumentCurrent: () => boolean;
  flushPendingRef: MutableRefObject<() => void>;
  onCanvasRecoveryCandidates?: () => Promise<Generation[]>;
  onCanvasRecoveryClaim?: (
    generationId: string,
    sceneId: string,
    cardId: string,
  ) => Promise<void>;
  // 지난 카드 소속 — 서버의 (생성물, 씬, 카드) 기록. '지금 붙어 있나'는 이쪽이 로컬로 판정한다.
  //  scope="scene" 은 이 캔버스만(인덱스를 타 즉시), "other" 는 다른 캔버스(눌렀을 때만).
  //  한 쪽씩 준다 — 거른 뒤 모자라면 next 커서로 이어 읽는다.
  onCanvasCardHistory?: (
    sceneId: string,
    scope: "scene" | "other",
    cursor: CardHistoryCursor | null,
  ) => Promise<{ links: CardHistoryLink[]; next: CardHistoryCursor | null }>;
  // 판정에 쓸 로컬 씬 목록. null 이면 못 읽은 것(= 판정 금지, 안내만).
  readLocalScenes?: () => Scene[] | null;
  // 떨어진 생성물을 화면에 보여주려면 본문이 필요하다 — 살아남은 것만 일괄 조회.
  onLoadGenerations?: (ids: string[]) => Promise<Record<string, Generation>>;
}

export const RECOVERY_PAGE = 12; // 아래 칸 한 번에 보여줄 개수

export function useSceneCardRecovery({ sceneId, cardsRef, genDataRef, setGenData, commitDocument, isDocumentCurrent, flushPendingRef,
  onCanvasRecoveryCandidates, onCanvasRecoveryClaim, onCanvasCardHistory, readLocalScenes, onLoadGenerations }: Options) {
  const liveSceneId = useRef(sceneId);
  liveSceneId.current = sceneId;
  const [canvasRecovery, setCanvasRecovery] = useState<{
    cardId: string;
    items: Generation[]; // 아래 칸 '카드 생성물 담기' — 카드 기록이 원래 없는 것
    detachedLinks: CardHistoryLink[]; // 서버가 준 지난 소속 원재료(다른 캔버스를 누르면 덧붙는다)
    detached: DetachedCandidate[]; // 위 칸 '카드 생성물 복구' — 카드에 있었다가 떨어진 것(가까운 순)
    detachedGens: Record<string, Generation>; // 위 칸 본문(일괄 조회 결과)
    detachedStatus: "ok" | "unreadable"; // unreadable = 로컬 씬을 못 읽어 판정 불가
    // ★칸마다 따로 기다린다 — 한쪽이 느리다고 다른 칸까지 붙잡아 두지 않는다(코덱스 P1).
    loadingItems: boolean;
    loadingDetached: boolean;
    otherScenes: "idle" | "loading" | "done"; // 다른 캔버스까지 찾았나(누를 때만 읽는다)
    // 쪽 상한에서 멈췄을 때의 이어 읽기 기준. null 이면 그 범위는 끝까지 봤다.
    // ★버리면 오래된 복구 대상에 영영 못 닿는다(코덱스 재리뷰 P1) — '더 찾기'가 여기서 잇는다.
    detachedNext: { scope: "scene" | "other"; cursor: CardHistoryCursor } | null;
    detachedShown: number; // 위 칸에 지금 보여주는 개수('더 보기'로 늘어난다)
    detachedTotal: number; // 이미 받아 둔 재료로 판정된 전체 후보 수(표시분 + 남은 것)
    detachedExpanding: boolean; // '더 보기'로 받아 둔 재료의 본문을 더 받는 중 — 단추가 그대로라 또 눌렸다(28회차, Jay 결정): 잠그고 글을 바꾼다
    claimingId: string | null;
    error: string | null;
    query: string; // 아래 칸 검색어
    shown: number; // 아래 칸 표시 개수('더 보기'로 증가)
  } | null>(null);
  const DETACHED_SHOWN = 30; // 위 칸에 본문까지 받아올 상한(가까운 순 앞쪽만)
  const DETACHED_MAX_PAGES = 5; // 이어 읽기 상한 — 여기까지 봐도 못 채우면 멈춘다

  // 창을 연 횟수. 응답이 자기 창의 것인지 대조한다 — 같은 카드에서 닫았다 다시 열면
  // cardId 만으로는 옛 응답을 못 가려내 새 창을 덮는다(코덱스 리뷰 P1).
  const recoverySeqRef = useRef(0);
  useEffect(() => () => { recoverySeqRef.current += 1; }, [sceneId]);
  // 이 렌더의 문서 판정을 붙잡는다. 다음 렌더의 판정으로 늦은 작업을 새 문서에 재연결하지 않는다.
  const currentRecovery = (cardId: string, seq: number) => seq === recoverySeqRef.current
    && liveSceneId.current === sceneId && isDocumentCurrent()
    && cardsRef.current.some(card => card.id === cardId);

  // 위 칸(떨어진 것)을 만든다. 서버는 '있었던 자리'만 알고 '지금 붙었나'는 모르므로
  // 로컬 씬 목록으로 거르고(canvasDetached), 살아남은 것만 본문을 일괄 조회한다.
  const buildDetached = async (
    cardId: string,
    links: CardHistoryLink[],
    shown: number,
    isCurrent: () => boolean,
  ): Promise<{
    detached: DetachedCandidate[];
    detachedGens: Record<string, Generation>;
    detachedStatus: "ok" | "unreadable";
    detachedTotal: number;
  }> => {
    const empty = {
      detached: [],
      detachedGens: {},
      detachedStatus: "ok" as const,
      detachedTotal: 0,
    };
    if (!isCurrent() || !onLoadGenerations || !readLocalScenes) return empty;
    const scenes = readLocalScenes();
    const local = readLocalCanvasState(scenes, scenes !== null);
    const result = detachedCandidates(links, local, { sceneId: sceneId, cardId });
    if (result.status !== "ok" || !result.items.length) {
      return { ...empty, detachedStatus: result.status };
    }
    // ★표시 개수는 늘어난다 — 늘 앞 30개로 자르면 이어 읽어도 31번째를 영영 못 고른다
    //  (코덱스 최종 확인 P1). 본문은 보여줄 것만 받는다.
    const head = result.items.slice(0, shown);
    if (!isCurrent()) return empty;
    const detachedGens = await onLoadGenerations(head.map((item) => item.generationId));
    if (!isCurrent()) return empty;
    // 본문을 못 받은 것(다른 설치본에만 있는 생성물)은 보여줄 게 없으므로 뺀다.
    return {
      detached: head.filter((item) => detachedGens[item.generationId]),
      detachedGens,
      detachedStatus: "ok",
      detachedTotal: result.items.length,
    };
  };

  // 지난 소속을 한 쪽씩 받아 이어 읽는다. **상한으로 끊으면 안 된다** — 최신 소속이 전부
  // 붙어 있는 사람에게는 오래된 복구 대상이 영영 안 보인다(코덱스 리뷰 P1). 거른 결과가
  // 화면 분량을 채울 때까지, 또는 서버가 더 없다고 할 때까지 다음 쪽을 청한다.
  const fetchDetachedLinks = async (
    cardId: string,
    scope: "scene" | "other",
    seed: CardHistoryLink[],
    isCurrent: () => boolean,
    from: CardHistoryCursor | null = null,
    want: number = DETACHED_SHOWN,
  ): Promise<{ links: CardHistoryLink[]; next: CardHistoryCursor | null } | null> => {
    if (!isCurrent()) return null;
    if (!onCanvasCardHistory) return { links: seed, next: null };
    // ★밀린 저장을 먼저 확정한다 — 방금 붙인 결과가 아직 메모리에만 있으면 '떨어진 것'으로 보인다.
    flushPendingRef.current();
    let links = seed;
    let cursor: CardHistoryCursor | null = from;
    for (let page = 0; page < DETACHED_MAX_PAGES; page++) {
      if (!isCurrent()) return null;
      const result = await onCanvasCardHistory(sceneId, scope, cursor);
      if (!isCurrent()) return null;
      links = links.concat(result.links);
      if (!result.next) return { links, next: null }; // 서버가 끝이라고 한다
      cursor = result.next;
      const scenes = readLocalScenes?.() ?? null;
      const local = readLocalCanvasState(scenes, scenes !== null);
      const built = detachedCandidates(links, local, { sceneId: sceneId, cardId });
      if (built.status !== "ok" || built.items.length >= want) break;
    }
    // 쪽 상한에서 멈췄다 — 어디까지 봤는지 남겨 '더 찾기'가 이어 갈 수 있게 한다.
    return { links, next: cursor };
  };

  // 위 칸을 더 찾는다. 두 가지를 겸한다.
  //  · 쪽 상한에서 멈췄으면(detachedNext) 그 자리에서 **이어 읽는다**
  //  · 이 캔버스를 끝까지 봤으면 **다른 캔버스**로 범위를 넓힌다(훑어야 해서 누를 때만)
  const loadMoreDetached = async () => {
    const target = canvasRecovery;
    if (!target || !onCanvasCardHistory) return;
    const { cardId } = target;
    const shown = target.detachedShown + DETACHED_SHOWN;
    const mySeq = recoverySeqRef.current;
    const isCurrent = () => currentRecovery(cardId, mySeq);
    if (!isCurrent()) return;
    const patch = (next: Partial<NonNullable<typeof canvasRecovery>>) =>
      setCanvasRecovery((current) =>
        current?.cardId === cardId && isCurrent()
          ? { ...current, ...next }
          : current,
      );
    // ① 이미 받아 둔 재료에 아직 안 보여준 후보가 남아 있으면 그것부터 편다(목록 조회는 없지만 본문(onLoadGenerations)은 받아 온다 —
    //  그동안 단추를 잠그고 '불러오는 중'으로 보인다. 전엔 단추가 그대로라 또 눌려 같은 본문을 두 번 받았다).
    if (target.detachedTotal > target.detachedShown) {
      patch({ detachedExpanding: true }); // 응답 전의 다시 누름은 단추의 disabled 가 막는다(핸들러 가드는 두지 않는다 — 12회차)
      try {
        const part = await buildDetached(cardId, target.detachedLinks, shown, isCurrent);
        patch({ ...part, detachedShown: shown, detachedExpanding: false });
      } catch {
        patch({ detachedExpanding: false });
      }
      return;
    }
    // ② 다 폈으면 더 읽어 온다 — 멈춘 자리부터, 없으면 다른 캔버스로 범위를 넓힌다.
    const resume = target.detachedNext;
    const scope = resume ? resume.scope : "other";
    patch({ otherScenes: "loading" });
    try {
      const page = await fetchDetachedLinks(
        cardId,
        scope,
        target.detachedLinks,
        isCurrent,
        resume?.cursor ?? null,
        shown,
      );
      if (!page || !isCurrent()) return;
      const part = await buildDetached(cardId, page.links, shown, isCurrent);
      patch({
        detachedLinks: page.links,
        ...part,
        detachedShown: shown,
        detachedNext: page.next ? { scope, cursor: page.next } : null,
        // 이 캔버스를 이어 읽은 것이면 다른 캔버스는 아직 안 본 것이다.
        otherScenes: page.next ? "idle" : scope === "other" ? "done" : "idle",
      });
    } catch {
      patch({ otherScenes: "idle" });
    }
  };

  const openCanvasRecovery = (cardId: string) => {
    if (!onCanvasRecoveryCandidates || !currentRecovery(cardId, recoverySeqRef.current)) return;
    // 창은 즉시 띄운다. 두 칸은 서로 독립이라 각자 도착하는 대로 채운다 —
    // 한쪽을 기다리느라 다른 칸까지 빈 채로 두지 않는다(코덱스 배포 전 점검 P1).
    setCanvasRecovery({
      cardId,
      items: [],
      detachedLinks: [],
      detached: [],
      detachedGens: {},
      detachedStatus: "ok",
      loadingItems: true,
      loadingDetached: true,
      otherScenes: "idle",
      detachedNext: null,
      detachedShown: DETACHED_SHOWN,
      detachedTotal: 0,
      detachedExpanding: false,
      claimingId: null,
      error: null,
      query: "",
      shown: RECOVERY_PAGE,
    });
    // 이 열기의 순번. 응답마다 대조해 옛 창의 답이 새 창을 덮지 못하게 한다.
    const mySeq = ++recoverySeqRef.current;
    const isCurrent = () => currentRecovery(cardId, mySeq);
    const patch = (next: Partial<NonNullable<typeof canvasRecovery>>) =>
      setCanvasRecovery((current) =>
        current?.cardId === cardId && isCurrent()
          ? { ...current, ...next }
          : current,
      );

    // 아래 칸 — 아직 어디에도 안 담긴 것
    void onCanvasRecoveryCandidates()
      .then((items) => patch({ items, loadingItems: false }))
      .catch((error) => patch({ loadingItems: false, error: String(error) }));

    // 위 칸 — 이 캔버스에서 떨어진 것(인덱스를 타는 범위만 먼저)
    if (!onCanvasCardHistory) {
      patch({ loadingDetached: false });
      return;
    }
    void fetchDetachedLinks(cardId, "scene", [], isCurrent)
      .then(async (page) => {
        if (!page || !isCurrent()) return;
        const part = await buildDetached(cardId, page.links, DETACHED_SHOWN, isCurrent);
        patch({
          detachedLinks: page.links,
          ...part,
          detachedNext: page.next ? { scope: "scene", cursor: page.next } : null,
          loadingDetached: false,
        });
      })
      .catch(() => patch({ loadingDetached: false }));
  };
  // 고른 생성물을 이 카드에 붙인다. attach 가 서버 기록을 맡고(경로는 호출부가 정한다),
  // 여기서는 카드 반영·정렬·undo 전이만 공통으로 처리한다.
  const attachToCard = async (
    generation: Generation,
    attach: (target: { cardId: string }) => Promise<void>,
  ) => {
    const target = canvasRecovery;
    if (!target) return;
    const mySeq = recoverySeqRef.current;
    if (!currentRecovery(target.cardId, mySeq)) return;
    setCanvasRecovery({ ...target, claimingId: generation.id, error: null });
    try {
      await attach({ cardId: target.cardId });
      if (mySeq !== recoverySeqRef.current || liveSceneId.current !== sceneId || !isDocumentCurrent()) return;
      // ★반영 직전에 대상 카드를 다시 본다(코덱스 P1). 창을 연 사이 카드가 사라졌을 수도,
      //  서버 소속 병합이 같은 생성물을 이미 넣었을 수도 있다. 전이 메타에는 **이번에 내가
      //  실제로 더한 것**만 실어야 한다 — 아니면 undo 가 원래 있던 소속까지 '뺐음'으로 보낸다.
      const beforeCard = cardsRef.current.find((card) => card.id === target.cardId);
      if (!beforeCard) {
        setCanvasRecovery((current) =>
          current
            ? { ...current, claimingId: null, error: "대상 카드가 사라졌습니다. 창을 닫고 다시 여세요." }
            : current,
        );
        return;
      }
      const createdAtById = Object.fromEntries(Object.entries(genDataRef.current).map(([id, data]) => [id, data.created_at || ""]));
      createdAtById[generation.id] = generation.created_at || "";
      // await 이전 렌더의 commit: 새 문서 세대/계정으로 도착한 결과는 세션이 거절한다.
      if (!commitDocument({ type: "recoverCardGeneration", cardId: target.cardId,
        generationId: generation.id, createdAtById,
      })) return;
      setGenData((previous) => ({ ...previous, [generation.id]: generation }));
      setCanvasRecovery(null);
      flashMsg("생성물을 이 카드에 붙였습니다.");
    } catch (error) {
      if (!currentRecovery(target.cardId, mySeq)) return;
      setCanvasRecovery((current) =>
        current
          ? { ...current, claimingId: null, error: String(error) }
          : current,
      );
    }
  };
  // 아래 칸(어디에도 안 담긴 것) — 서버가 요청표·소속표에 이 카드를 처음으로 새겨 준다.
  const claimCanvasRecovery = (generation: Generation) =>
    attachToCard(generation, ({ cardId }) => {
      if (!onCanvasRecoveryClaim) return Promise.resolve();
      return onCanvasRecoveryClaim(generation.id, sceneId, cardId);
    });
  // 위 칸(떨어진 것) — 이미 지난 소속이 있으므로 '사용자 의도'로 되살린다.
  //  ★요청표의 원래 씬·카드는 건드리지 않는다. 덮어쓰면 그 요청의 재시도가 다른 요청으로
  //   판정되고, 클라의 pending attempt 검사도 어긋난다(코덱스 P1). 소속만 추가한다.
  //  ★reviveCardGenerations 가 네트워크보다 먼저 의도를 영속시켜, 그 사이 도착한 병합이
  //   방금 살린 것을 도로 지우지 않는다. undo 부활이 쓰는 바로 그 경로다.
  const claimDetachedGeneration = (generation: Generation) =>
    attachToCard(generation, ({ cardId }) => {
      reviveCardGenerations(sceneId, cardId, [generation.id]);
      return Promise.resolve();
    });
  return { canvasRecovery, setCanvasRecovery, openCanvasRecovery, loadMoreDetached, claimCanvasRecovery, claimDetachedGeneration };
}
