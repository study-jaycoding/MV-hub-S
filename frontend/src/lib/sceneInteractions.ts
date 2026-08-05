import type { SceneCard, SceneEdge } from "./scenes";
import { canConnect } from "./sceneEdges";

export const SCENE_GRID = 22;

export const snapSceneGrid = (value: number, grid = SCENE_GRID) =>
  Math.round(value / grid) * grid;

export interface SceneClipboard {
  cards: SceneCard[];
  edges: SceneEdge[];
  inEdges: SceneEdge[];
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
