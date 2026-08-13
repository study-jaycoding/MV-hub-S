import type { CanvasGenerationAttempt, SceneCard } from "./scenes";
import { uid, variantIds } from "./scenes";

export interface CanvasGenerationTarget {
  sceneId: string;
  cardId: string;
}

export interface CanvasGenerationLink {
  attempt_id: string;
  generation_id: string;
  scene_id: string;
  card_id: string;
}

export interface ResolvedCanvasGenerationLink extends CanvasGenerationLink {
  request_status?: string;
}

const randomId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `mv_${uid()}_${uid()}`;
};

export function createCanvasGenerationLinks(
  target: CanvasGenerationTarget,
  count: number,
): CanvasGenerationLink[] {
  const safeCount = Math.max(1, Math.min(20, Math.trunc(count) || 1));
  return Array.from({ length: safeCount }, () => ({
    attempt_id: randomId(),
    generation_id: randomId(),
    scene_id: target.sceneId,
    card_id: target.cardId,
  }));
}

export function prepareCanvasGenerationLinks(
  cards: SceneCard[],
  links: CanvasGenerationLink[],
  createdAt = Date.now(),
): { cards: SceneCard[]; attachedCount: number } {
  const byCard = new Map<string, CanvasGenerationLink[]>();
  for (const link of links) {
    const items = byCard.get(link.card_id) || [];
    items.push(link);
    byCard.set(link.card_id, items);
  }
  let attachedCount = 0;
  const next = cards.map((card) => {
    const items = byCard.get(card.id);
    if (card.kind !== "generation" || !items?.length) return card;
    attachedCount++;
    const generationIds = variantIds(card);
    const pending = [...(card.pendingGenerationAttempts || [])];
    for (const link of items) {
      if (!generationIds.includes(link.generation_id)) generationIds.push(link.generation_id);
      if (!pending.some((item) => item.attemptId === link.attempt_id)) {
        pending.push({
          attemptId: link.attempt_id,
          generationId: link.generation_id,
          createdAt,
        });
      }
    }
    return {
      ...card,
      genId: items[0].generation_id,
      genIds: generationIds,
      pendingGenerationAttempts: pending,
      status: "pending" as const,
    };
  });
  return { cards: attachedCount ? next : cards, attachedCount };
}

export function settleCanvasGenerationAttempt(
  cards: SceneCard[],
  cardId: string,
  generationId: string,
): SceneCard[] {
  let changed = false;
  const next = cards.map((card) => {
    if (card.id !== cardId) return card;
    const wasAttached = variantIds(card).includes(generationId);
    const pending = (card.pendingGenerationAttempts || []).filter(
      (item) => item.generationId !== generationId,
    );
    const generationIds = variantIds(card);
    if (!generationIds.includes(generationId)) generationIds.push(generationId);
    if (
      pending.length === (card.pendingGenerationAttempts || []).length &&
      generationIds.length === variantIds(card).length
    ) {
      return card;
    }
    changed = true;
    return {
      ...card,
      // 요청 전 미리 붙인 배치 결과는 첫 장 대표 순서를 유지한다. 수동 복구처럼 새로 붙이는 경우만
      // 방금 고른 결과를 대표로 보여준다.
      genId: wasAttached ? card.genId || generationId : generationId,
      genIds: generationIds,
      pendingGenerationAttempts: pending.length ? pending : undefined,
      status: "pending" as const,
    };
  });
  return changed ? next : cards;
}

export function discardCanvasGenerationAttempt(
  cards: SceneCard[],
  cardId: string,
  generationId: string,
): SceneCard[] {
  let changed = false;
  const next = cards.map((card) => {
    if (card.id !== cardId) return card;
    const attempts = card.pendingGenerationAttempts || [];
    if (!attempts.some((attempt) => attempt.generationId === generationId)) return card;
    changed = true;
    const pending = attempts.filter((attempt) => attempt.generationId !== generationId);
    const generationIds = variantIds(card).filter((id) => id !== generationId);
    const representative = generationIds.includes(card.genId || "")
      ? card.genId
      : generationIds[generationIds.length - 1] || null;
    return {
      ...card,
      genId: representative,
      genIds: generationIds,
      pendingGenerationAttempts: pending.length ? pending : undefined,
      status: generationIds.length ? card.status : "empty",
    };
  });
  return changed ? next : cards;
}

export function reconcileCanvasGenerationAttempts(
  cards: SceneCard[],
  sceneId: string,
  resolvedLinks: ResolvedCanvasGenerationLink[],
  now = Date.now(),
  missingGraceMs = 120_000,
): { cards: SceneCard[]; recovered: number; discarded: number } {
  const resolved = new Map(resolvedLinks.map((link) => [link.attempt_id, link] as const));
  let recovered = 0;
  let discarded = 0;
  let changed = false;
  const next = cards.map((card) => {
    const attempts = card.pendingGenerationAttempts || [];
    if (!attempts.length) return card;
    const keep: CanvasGenerationAttempt[] = [];
    const discardIds = new Set<string>();
    for (const attempt of attempts) {
      const link = resolved.get(attempt.attemptId);
      const exact =
        link?.scene_id === sceneId &&
        link.card_id === card.id &&
        link.generation_id === attempt.generationId;
      if (exact) {
        recovered++;
        changed = true;
      } else if (now - attempt.createdAt >= missingGraceMs) {
        discarded++;
        discardIds.add(attempt.generationId);
        changed = true;
      } else {
        keep.push(attempt);
      }
    }
    if (keep.length === attempts.length) return card;
    const generationIds = variantIds(card).filter((id) => !discardIds.has(id));
    const representative = generationIds.includes(card.genId || "")
      ? card.genId
      : generationIds[generationIds.length - 1] || null;
    return {
      ...card,
      genId: representative,
      genIds: generationIds,
      pendingGenerationAttempts: keep.length ? keep : undefined,
      status: generationIds.length ? card.status : "empty",
    };
  });
  return { cards: changed ? next : cards, recovered, discarded };
}
