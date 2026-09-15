import { variantIds, type Scene, type SceneCard } from "./scenes";

export interface ResolveSceneSelectionTarget {
  sceneId: string;
  generationId: string;
  generationIds?: string[];
  selectedCount?: number;
  truncated?: boolean;
  nonce: number;
  at: number;
  openPopup: boolean;
  followEnabled?: boolean; // App이 받은 당시 설정. 선택 해제의 openPopup=false와 구별한다.
}

export interface ResolveOpenPopup {
  sceneId: string;
  cardId: string;
}

/** 명시된 빈 배열은 선택 해제다. 이때 구형 단일 ID로 되돌리지 않는다. */
export function resolveSelectionGenerationIds(generationIds: unknown, generationId?: unknown): string[] {
  const values = Array.isArray(generationIds) ? generationIds : [generationId];
  return [...new Set(values.filter((id): id is string => typeof id === "string" && !!id.trim()))];
}

export function cardContainsGeneration(card: SceneCard, generationId: string | string[]): boolean {
  const targets = new Set(Array.isArray(generationId) ? generationId : [generationId]);
  return variantIds(card).some((id) => targets.has(id));
}

/** 현재 씬을 우선하고, 없으면 가장 최근에 만든 씬을 고른다. */
export function resolveSceneForGeneration(
  scenes: Scene[],
  activeSceneId: string | null,
  generationId: string | string[],
): Scene | null {
  const active = scenes.find((scene) => scene.id === activeSceneId);
  if (active?.cards.some((card) => cardContainsGeneration(card, generationId))) return active;
  return (
    [...scenes]
      .filter((scene) => scene.cards.some((card) => cardContainsGeneration(card, generationId)))
      .sort((left, right) => right.created_at - left.created_at || left.id.localeCompare(right.id))[0] ??
    null
  );
}

/** 열린 팝업 → 현재 대표인 카드 → 저장 순서의 첫 카드 순으로 결정한다. */
export function resolveCardForGeneration(
  cards: SceneCard[],
  openCardId: string | null,
  generationId: string | string[],
): SceneCard | null {
  const open = cards.find(
    (card) => card.id === openCardId && cardContainsGeneration(card, generationId),
  );
  if (open) return open;
  const matches = cards.filter((card) => cardContainsGeneration(card, generationId));
  const targets = new Set(Array.isArray(generationId) ? generationId : [generationId]);
  return matches.find((card) => !!card.genId && targets.has(card.genId)) ?? matches[0] ?? null;
}
