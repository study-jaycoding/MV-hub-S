import type { SceneCard, SceneEdge, SceneRef } from "./scenes";
import { canConnect } from "./sceneEdges";

export const SCENE_GRID = 22;

export const snapSceneGrid = (value: number, grid = SCENE_GRID) =>
  Math.round(value / grid) * grid;

interface ResizeSceneCardOptions {
  cards: SceneCard[];
  cardId: string;
  startSize: { w: number; h: number };
  clientDelta: { x: number; y: number };
  zoom: number;
  minSize: { w: number; h: number };
  grid?: number;
}

export function resizeSceneCard({
  cards,
  cardId,
  startSize,
  clientDelta,
  zoom,
  minSize,
  grid = SCENE_GRID,
}: ResizeSceneCardOptions): {
  cards: SceneCard[];
  size: { w: number; h: number };
  changed: boolean;
} {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const size = {
    w: Math.max(minSize.w, snapSceneGrid(startSize.w + clientDelta.x / safeZoom, grid)),
    h: Math.max(minSize.h, snapSceneGrid(startSize.h + clientDelta.y / safeZoom, grid)),
  };
  const current = cards.find((card) => card.id === cardId);
  if (!current) return { cards, size, changed: false };

  const currentWidth = current.w ?? startSize.w;
  const currentHeight = current.h ?? startSize.h;
  if (currentWidth === size.w && currentHeight === size.h) {
    return { cards, size, changed: false };
  }

  return {
    cards: cards.map((card) =>
      card.id === cardId ? { ...card, w: size.w, h: size.h } : card,
    ),
    size,
    changed: true,
  };
}

export interface SceneClipboard {
  cards: SceneCard[];
  edges: SceneEdge[];
  inEdges: SceneEdge[];
}

export type ScenePasteIntent = "image" | "nodes" | "none";

export function scenePasteIntent(
  imageKey: string | null,
  lastImageKey: string | null,
  nodeCount: number,
): ScenePasteIntent {
  const hasNodes = nodeCount > 0;
  if (imageKey && (imageKey !== lastImageKey || !hasNodes)) return "image";
  if (hasNodes) return "nodes";
  return "none";
}

interface AppendSceneReferenceCardsOptions {
  cards: SceneCard[];
  edges: SceneEdge[];
  refs: SceneRef[];
  center: { x: number; y: number };
  connectToGenerationIds?: readonly string[];
  makeId: () => string;
  cardWidth: number;
  cardHeight: number;
  gap?: number;
  grid?: number;
}

export interface AppendedSceneReferenceCards {
  cards: SceneCard[];
  edges: SceneEdge[];
  createdCards: SceneCard[];
  connectedTargetIds: string[];
}

/** 레퍼런스 카드 배치와 선택 생성카드 연결을 DOM/API 없이 계산한다. */
export function appendSceneReferenceCards({
  cards,
  edges,
  refs,
  center,
  connectToGenerationIds,
  makeId,
  cardWidth,
  cardHeight,
  gap = 20,
  grid = SCENE_GRID,
}: AppendSceneReferenceCardsOptions): AppendedSceneReferenceCards {
  if (!refs.length) {
    return { cards, edges, createdCards: [], connectedTargetIds: [] };
  }

  const requestedTargets = connectToGenerationIds || [];
  const singleTarget =
    requestedTargets.length === 1
      ? cards.find(
          (card) => card.id === requestedTargets[0] && card.kind === "generation",
        )
      : undefined;
  let centerX = center.x;
  let centerY = center.y;
  if (singleTarget) {
    const inputCount = edges.filter((edge) => edge.to === singleTarget.id).length;
    centerX = singleTarget.x - (cardWidth + 40) + cardWidth / 2;
    centerY = singleTarget.y + cardHeight / 2 + inputCount * (cardHeight + gap);
  }

  const step = cardWidth + gap;
  const startX = centerX - cardWidth / 2 - ((refs.length - 1) * step) / 2;
  const createdCards: SceneCard[] = refs.map((ref, index) => ({
    id: makeId(),
    kind: "reference",
    x: snapSceneGrid(startX + index * step, grid),
    y: snapSceneGrid(centerY - cardHeight / 2, grid),
    refs: [ref],
  }));
  const nextCards = [...cards, ...createdCards];
  const connectedTargetIds = requestedTargets.filter((targetId) =>
    nextCards.some((card) => card.id === targetId && card.kind === "generation"),
  );
  if (!connectedTargetIds.length) {
    return {
      cards: nextCards,
      edges,
      createdCards,
      connectedTargetIds,
    };
  }

  const seen = new Set(edges.map((edge) => `${edge.from}>${edge.to}`));
  const additions: SceneEdge[] = [];
  for (const card of createdCards) {
    for (const targetId of connectedTargetIds) {
      const key = `${card.id}>${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      additions.push({ id: makeId(), from: card.id, to: targetId });
    }
  }

  return {
    cards: nextCards,
    edges: additions.length ? [...edges, ...additions] : edges,
    createdCards,
    connectedTargetIds,
  };
}

export function partitionSceneDropFiles<T extends { name: string }>(files: readonly T[]): {
  sceneFile: T | null;
  mediaFiles: T[];
} {
  const sceneFiles = files.filter((file) => /\.json$/i.test(file.name));
  const mediaFiles = files.filter((file) => !/\.json$/i.test(file.name));
  return {
    sceneFile: mediaFiles.length === 0 ? sceneFiles[0] ?? null : null,
    mediaFiles,
  };
}

export function moveCardsFromOrigins(
  cards: SceneCard[],
  origins: Readonly<Record<string, { x: number; y: number }>>,
  anchorId: string,
  anchor: { x: number; y: number },
  dx: number,
  dy: number,
  grid = SCENE_GRID,
): { cards: SceneCard[]; dx: number; dy: number; changed: boolean } {
  const snappedDx = snapSceneGrid(anchor.x + dx, grid) - anchor.x;
  const snappedDy = snapSceneGrid(anchor.y + dy, grid) - anchor.y;
  const currentAnchor = cards.find((card) => card.id === anchorId);
  const changed =
    !currentAnchor ||
    currentAnchor.x !== anchor.x + snappedDx ||
    currentAnchor.y !== anchor.y + snappedDy;

  if (!changed) return { cards, dx: snappedDx, dy: snappedDy, changed: false };

  return {
    cards: cards.map((card) =>
      origins[card.id]
        ? {
            ...card,
            x: origins[card.id].x + snappedDx,
            y: origins[card.id].y + snappedDy,
          }
        : card,
    ),
    dx: snappedDx,
    dy: snappedDy,
    changed: true,
  };
}

interface ScenePoint {
  x: number;
  y: number;
}

interface SceneRect extends ScenePoint {
  w: number;
  h: number;
}

export function updateSceneEjectedCards(
  current: Set<string>,
  memberFrames: ReadonlyMap<string, SceneRect>,
  cardCenters: ReadonlyMap<string, ScenePoint>,
  speed: number,
  ejectSpeed: number,
): { ejected: Set<string>; changed: boolean } {
  let ejected = current;
  let changed = false;
  for (const [cardId, frame] of memberFrames) {
    const center = cardCenters.get(cardId);
    if (!center) continue;
    const outside =
      center.x < frame.x ||
      center.x > frame.x + frame.w ||
      center.y < frame.y ||
      center.y > frame.y + frame.h;
    if (ejected.has(cardId)) {
      if (!outside) {
        if (!changed) ejected = new Set(current);
        ejected.delete(cardId);
        changed = true;
      }
    } else if (outside && speed > ejectSpeed) {
      if (!changed) ejected = new Set(current);
      ejected.add(cardId);
      changed = true;
    }
  }
  return { ejected, changed };
}

export function buildSelectedConnections(
  cards: SceneCard[],
  edges: SceneEdge[],
  selectedIds: Iterable<string>,
  makeId: () => string,
): SceneEdge[] {
  const picked = [...selectedIds]
    .map((id) => cards.find((card) => card.id === id))
    .filter((card): card is SceneCard => !!card)
    .sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
  if (picked.length < 2) return [];

  const byId = new Map(cards.map((card) => [card.id, card] as const));
  const existing = new Set(edges.map((edge) => `${edge.from}>${edge.to}`));
  const additions: SceneEdge[] = [];

  for (let index = 0; index < picked.length - 1; index++) {
    const left = picked[index];
    const right = picked[index + 1];
    let from = left;
    let to = right;

    if (!canConnect(left, right, byId, edges)) {
      if (!canConnect(right, left, byId, edges)) continue;
      from = right;
      to = left;
    }

    const key = `${from.id}>${to.id}`;
    if (existing.has(key)) continue;
    existing.add(key);
    additions.push({ id: makeId(), from: from.id, to: to.id });
  }

  return additions;
}

export function copySceneSelection(
  cards: SceneCard[],
  edges: SceneEdge[],
  selectedIds: Iterable<string>,
): SceneClipboard {
  const selected = new Set(selectedIds);
  return {
    cards: cards.filter((card) => selected.has(card.id)).map((card) => ({ ...card })),
    edges: edges
      .filter((edge) => selected.has(edge.from) && selected.has(edge.to))
      .map((edge) => ({ ...edge })),
    inEdges: edges
      .filter((edge) => !selected.has(edge.from) && selected.has(edge.to))
      .map((edge) => ({ ...edge })),
  };
}

export function pasteSceneClipboard(
  currentCards: SceneCard[],
  currentEdges: SceneEdge[],
  clipboard: SceneClipboard,
  makeId: () => string,
  grid = SCENE_GRID,
): {
  cards: SceneCard[];
  edges: SceneEdge[];
  pastedCardIds: Set<string>;
  nextClipboard: SceneClipboard;
  shift: number;
} {
  const baseOffset = grid * 2;
  let shift = baseOffset;
  for (let step = 1; step <= 20; step++) {
    shift = baseOffset * step;
    const fullyOverlaps = clipboard.cards.some((copied) =>
      currentCards.some(
        (current) =>
          Math.abs(copied.x + shift - current.x) < grid &&
          Math.abs(copied.y + shift - current.y) < grid,
      ),
    );
    if (!fullyOverlaps) break;
  }

  const idMap = new Map<string, string>();
  const pastedCards = clipboard.cards.map((card) => {
    const id = makeId();
    idMap.set(card.id, id);
    return { ...card, id, x: card.x + shift, y: card.y + shift };
  });
  const remappedCards = pastedCards.map((card) =>
    card.kind === "input" && card.channel && idMap.has(card.channel)
      ? { ...card, channel: idMap.get(card.channel) }
      : card,
  );
  const internalEdges = clipboard.edges.map((edge) => ({
    ...edge,
    id: makeId(),
    from: idMap.get(edge.from)!,
    to: idMap.get(edge.to)!,
  }));
  const currentIds = new Set(currentCards.map((card) => card.id));
  const sharedInputEdges = clipboard.inEdges
    .filter((edge) => currentIds.has(edge.from) && idMap.has(edge.to))
    .map((edge) => ({ ...edge, id: makeId(), to: idMap.get(edge.to)! }));

  return {
    cards: [...currentCards, ...remappedCards],
    edges: [...currentEdges, ...internalEdges, ...sharedInputEdges],
    pastedCardIds: new Set(remappedCards.map((card) => card.id)),
    nextClipboard: {
      ...clipboard,
      cards: clipboard.cards.map((card) => ({
        ...card,
        x: card.x + shift,
        y: card.y + shift,
      })),
    },
    shift,
  };
}
