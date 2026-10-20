// 생성 위치의 저장 확정·결과 연결·재시작 복구를 소유한다. 제출 정책과 화면 배선은 호출자에 남긴다.
import { useCallback, useEffect, useMemo, type Dispatch, type SetStateAction } from "react";
import { api } from "../api";
import { canvasTarget, type CanvasDocumentPort } from "../features/canvas/api";
import { getAccountNamespace } from "./accountScope";
import type { Generation } from "../types";
import { subscribeSceneSaveState, listPersistedScenes, listScenes, type Scene } from "./scenes";
import {
  createCanvasGenerationLinks,
  type CanvasGenerationLink, type CanvasGenerationTarget,
} from "./canvasGenerationRecovery";
import { seedPending } from "./sceneRecentDoneStore";

interface Args {
  authReady: boolean;
  scenes: Scene[];
  canvasDocument: CanvasDocumentPort;
  setGens: Dispatch<SetStateAction<Generation[]>>;
}

export function useCanvasGenerationLinks({ authReady, scenes, canvasDocument, setGens }: Args) {
  // 생성 표식이 **저장소 확정본**에 실제로 들어 있는가. 확정 Promise 가 true 여도, 그사이 대상 카드가
  // 지워졌거나 뒤 연산이 표식을 덮었을 수 있다 — 필요한 표식의 존재를 직접 본다(Codex).
  const canvasMarksPersisted = (sceneId: string, links: CanvasGenerationLink[]): boolean => {
    const cards = listPersistedScenes(null).find((scene) => scene.id === sceneId)?.cards || [];
    return links.every((link) =>
      (cards.find((card) => card.id === link.card_id)?.pendingGenerationAttempts || []).some(
        (attempt) => attempt.attemptId === link.attempt_id,
      ),
    );
  };
  const prepareCanvasGenerationBatch = useCallback(async (
    sceneId: string,
    cardIds: string[],
    fixedLinks?: CanvasGenerationLink[],
  ): Promise<CanvasGenerationLink[]> => {
    if (fixedLinks && (fixedLinks.length !== cardIds.length || fixedLinks.some((link, index) => link.scene_id !== sceneId || link.card_id !== cardIds[index]))) return [];
    const links = fixedLinks ?? cardIds.flatMap((cardId) =>
      createCanvasGenerationLinks({ sceneId, cardId }, 1),
    );
    const target = canvasTarget(sceneId);
    if (!canvasDocument.snapshot(target)?.cards.some(card => card.kind === "generation" && cardIds.includes(card.id))) return [];
    // ★표식이 **저장소에 확정된 뒤에만** 링크를 준다. 화면 값에는 그 틱에 들어가지만 저장소 확정은
    //  뒤따르므로, 그것을 기다리지 않고 생성 요청을 보내면 그 사이 앱이 닫혔을 때 결과가 어느 카드
    //  것인지 복구할 수 없다(적대 리뷰 r2 P1). 호출부는 links 수가 batch 와 다르면 제출을 멈추고
    //  사용자에게 알린다(useSpotlightSubmit).
    const { queued: applied, confirmed } = canvasDocument.commit(target, { type: "reserveGeneration", links, createdAt: Date.now() });
    if (!applied) return [];
    const durable = (await confirmed) && canvasMarksPersisted(sceneId, links);
    if (!durable) {
      // 확정 못 함 — **내 표식만** 걷어낸다. 남겨 두면 저장소가 나중에 다시 시도해 확정하고, 보내지도
      // 않은 생성의 표식이 유령으로 살아난다.
      const dropMarks = (): boolean => {
        if (!canvasDocument.snapshot(target)) return true;
        return links.every(link => canvasDocument.commit(target, { type: "discardGeneration", cardId: link.card_id, generationId: link.generation_id }).queued);
      };
      if (!dropMarks()) {
        // 밀린 편집이 상한에 닿아 걷어내기조차 받지 못했다(저장소가 오래 막힘) — 저장이 풀리면 다시 걷어낸다.
        // 그냥 두면 앞서 접수된 표식만 뒤늦게 확정된다(Codex 코드 리뷰 P2. 2분 뒤 복구가 치우기는 한다).
        const off = subscribeSceneSaveState((failed) => {
          if (failed) return;
          off();
          dropMarks();
        });
      }
      return [];
    }
    seedPending(links.map((link) => link.generation_id));
    return links;
  }, [canvasDocument]);
  const prepareCanvasGeneration = useCallback((
    target: CanvasGenerationTarget,
    count: number,
  ): Promise<CanvasGenerationLink[]> => prepareCanvasGenerationBatch(
    target.sceneId,
    Array.from({ length: Math.max(1, Math.trunc(count) || 1) }, () => target.cardId),
  ), [prepareCanvasGenerationBatch]);

  const settleCanvasGeneration = useCallback((
    link: Pick<CanvasGenerationLink, "scene_id" | "card_id">,
    generation: Generation,
  ) => {
    // 서버 성공은 카드 저장과 별개다. 연결 실패는 호출자가 반영 실패로 집계해 재제출을 막는다.
    setGens((previous) =>
      previous.some((item) => item.id === generation.id)
        ? previous
        : [generation, ...previous],
    );
    seedPending([generation.id]);
    const receipt = canvasDocument.commit(canvasTarget(link.scene_id), { type: "settleGeneration", cardId: link.card_id, generationId: generation.id });
    if (!receipt.queued && listScenes(null).some(scene => scene.id === link.scene_id)) throw new Error("캔버스 생성 결과를 저장하지 못했습니다.");
  }, [canvasDocument, setGens]);
  const discardCanvasGeneration = useCallback((link: CanvasGenerationLink) => {
    canvasDocument.commit(canvasTarget(link.scene_id), { type: "discardGeneration", cardId: link.card_id, generationId: link.generation_id });
  }, [canvasDocument]);

  // 응답 전에 앱을 닫은 생성 시도를 재시작 시 복구한다. 서버 연결표 + 미리 정한 generation id를
  // 함께 확인하고, 서버에 도달하지 않은 표식만 2분 뒤 제거한다.
  const canvasAttemptSig = useMemo(
    () => scenes.flatMap((scene) =>
      scene.cards.flatMap((card) =>
        (card.pendingGenerationAttempts || []).map(
          (attempt) => `${scene.id}:${card.id}:${attempt.attemptId}:${attempt.generationId}:${attempt.createdAt}`,
        ),
      ),
    ).join("|"),
    [scenes],
  );
  useEffect(() => {
    if (!authReady || !canvasAttemptSig) return;
    let alive = true;
    const accountNamespace = getAccountNamespace();
    let timer: number | undefined;
    const recover = async () => {
      const current = listScenes(null);
      const attempts = current.flatMap((scene) =>
        scene.cards.flatMap((card) =>
          (card.pendingGenerationAttempts || []).map((attempt) => ({ scene, card, attempt })),
        ),
      );
      if (!attempts.length) return;
      // 숨은 창에선 서버를 찌르지 않는다(앱의 다른 폴러와 같은 규칙 — useSceneGenData·
      // useSyncStatus 참고). ★탭이 아니라 '창이 보이는가'로만 쉰다: 이건 표시용 조회가 아니라
      // 생성 시도 이어붙이기라 캔버스 탭 밖에서도 돌아야 한다.
      // 체인이 끊기지 않게 다음 차례는 그대로 예약하고, 복귀 시엔 아래 리스너가 즉시 당겨온다.
      if (document.visibilityState === "hidden") {
        if (alive) timer = window.setTimeout(recover, 2500);
        return;
      }
      try {
        const [resolved, batch] = await Promise.all([
          api.resolveCanvasGenerationLinks(attempts.map(({ attempt }) => attempt.attemptId)),
          api.getGenerationsBatch(attempts.map(({ attempt }) => attempt.generationId)),
        ]);
        if (!alive || accountNamespace !== getAccountNamespace()) return;
        const existing = new Set(Object.keys(batch.items));
        if (existing.size) {
          setGens((previous) => {
            const known = new Set(previous.map((item) => item.id));
            const fresh = Object.values(batch.items).filter((item) => !known.has(item.id));
            return fresh.length ? [...fresh, ...previous] : previous;
          });
        }
        const resolvedAttemptIds = new Set(resolved.links.map((link) => link.attempt_id));
        const orphanLinks = attempts
          .filter(({ attempt }) =>
            existing.has(attempt.generationId) && !resolvedAttemptIds.has(attempt.attemptId),
          )
          .map(({ scene, card, attempt }) => ({
            attempt_id: attempt.attemptId,
            generation_id: attempt.generationId,
            scene_id: scene.id,
            card_id: card.id,
          }));
        const repaired = orphanLinks.length
          ? await api.repairCanvasGenerationLinks(orphanLinks)
          : { links: [] };
        if (!alive || accountNamespace !== getAccountNamespace()) return;
        const recoveryLinks = [...resolved.links, ...repaired.links];
        for (const scene of listScenes(null)) {
          canvasDocument.commit({ accountNamespace, sceneId: scene.id }, { type: "reconcileGenerations", links: recoveryLinks, now: Date.now() });
        }
      } catch {
        // 백엔드가 아직 시작 중이거나 일시 끊김이면 표식을 그대로 두고 다음 주기에 재확인한다.
      }
      if (alive) timer = window.setTimeout(recover, 2500);
    };
    void recover();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (timer) clearTimeout(timer);
      void recover(); // 복귀 즉시 1회 — 숨어 있는 동안 끝난 생성이 바로 카드에 붙는다
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [authReady, canvasAttemptSig, canvasDocument, setGens]);
  const confirmCanvasGeneration = useCallback((links: readonly CanvasGenerationLink[]): boolean => {
    const sceneIds = new Set(links.map(link => link.scene_id));
    return links.length > 0 && [...sceneIds].every(sceneId =>
      canvasMarksPersisted(sceneId, links.filter(link => link.scene_id === sceneId)));
  }, []);
  return { prepareCanvasGenerationBatch, prepareCanvasGeneration, confirmCanvasGeneration, settleCanvasGeneration, discardCanvasGeneration };
}
