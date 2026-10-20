import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { rewindSceneMove } from "../../lib/sceneInteractions";
import type { SceneCard, SceneEdge, SceneGroup } from "../../lib/scenes";
import type { SceneSnap } from "../../lib/sceneUndoStore";
import type { useSceneHistory } from "../../lib/useSceneHistory";

type Point = { x: number; y: number };
export type CanvasGestureRect = Point & { w: number; h: number };
export interface CanvasGroupFrame { id: string; frame: CanvasGestureRect }

export interface CanvasMoveHandle {
  preview(geometry: {
    positions?: Readonly<Record<string, Point>>;
    rects?: Readonly<Record<string, CanvasGestureRect>>;
  }): boolean;
  finish(drop?: { startFrames?: readonly CanvasGroupFrame[]; ejected?: ReadonlySet<string> }): void;
  cancel(): void;
  rebase(): void;
}
export interface CanvasCardResizeHandle {
  preview(size: { w: number; h: number }): boolean;
  finish(): void;
  cancel(): void;
  rebase(): void;
}
export interface CanvasGroupResizeHandle {
  preview(rect: CanvasGestureRect): boolean;
  finish(drop?: { containedIds?: readonly string[] }): void;
  cancel(): void;
  rebase(observedFrame?: CanvasGestureRect): void;
}
export interface CanvasGestures {
  beginCardMove(cardIds: readonly string[], wholeGroupIds: readonly string[]): CanvasMoveHandle;
  beginGroupMove(cardIds: readonly string[], groupIds: readonly string[]): CanvasMoveHandle;
  beginCardResize(cardId: string): CanvasCardResizeHandle;
  beginGroupResize(groupId: string, observedFrame: CanvasGestureRect): CanvasGroupResizeHandle;
}

export interface CanvasGestureActive { token: object; finish: () => void }
interface GestureOptions {
  cardsRef: MutableRefObject<SceneCard[]>;
  edgesRef: MutableRefObject<SceneEdge[]>;
  groupsRef: MutableRefObject<SceneGroup[]>;
  setCards: Dispatch<SetStateAction<SceneCard[]>>;
  setGroups: Dispatch<SetStateAction<SceneGroup[]>>;
  history: Pick<ReturnType<typeof useSceneHistory>, "beginGesture" | "endGesture" | "persist">;
  current: () => boolean;
  withGenerationRefs: (cards: SceneCard[], edges: SceneEdge[]) => SceneCard[];
  cardSize: (card: SceneCard) => { w: number; h: number };
  activeRef: MutableRefObject<CanvasGestureActive | null>;
}

const sameRect = (a: SceneGroup["rect"], b: SceneGroup["rect"]) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
const finitePoint = (point: Point) => Number.isFinite(point.x) && Number.isFinite(point.y);
const finiteSize = (size: { w: number; h: number }) =>
  Number.isFinite(size.w) && Number.isFinite(size.h) && size.w > 0 && size.h > 0;
const inactive = { preview: () => false, finish: () => {}, cancel: () => {}, rebase: () => {} };

/** 문서·Undo 정책은 세션 안에 두고, UI에는 이 끌기의 기하만 바꿀 수 있는 손잡이를 준다. */
export function createCanvasGestures(options: GestureOptions): CanvasGestures {
  const { cardsRef, edgesRef, groupsRef, setCards, setGroups, history, activeRef } = options;
  const ready = () => {
    if (!options.current()) return false;
    activeRef.current?.finish();
    return options.current();
  };
  const owner = () => {
    const token = {};
    const current = () => options.current() && activeRef.current?.token === token;
    return {
      current,
      start(rewind: (snapshot: SceneSnap) => SceneSnap, finish: () => void) {
        activeRef.current = { token, finish };
        history.beginGesture(rewind);
      },
      end() {
        if (!current()) return;
        activeRef.current = null;
        history.endGesture();
      },
    };
  };
  const writeCards = (cards: SceneCard[]) => {
    if (cards === cardsRef.current) return;
    cardsRef.current = cards;
    setCards(cards);
  };
  const writeGroups = (groups: SceneGroup[]) => {
    if (groups === groupsRef.current) return;
    groupsRef.current = groups;
    setGroups(groups);
  };
  const persist = (discard = false, reconcile = false) => {
    if (reconcile) writeCards(options.withGenerationRefs(cardsRef.current, edgesRef.current));
    history.persist(cardsRef.current, edgesRef.current, groupsRef.current, discard ? { discard: true } : undefined);
  };

  const beginMove = (cardIds: readonly string[], groupIds: readonly string[], reassign: boolean): CanvasMoveHandle => {
    if (!options.current() || (!cardsRef.current.some((card) => cardIds.includes(card.id)) &&
      !groupsRef.current.some((group) => groupIds.includes(group.id) && group.rect))) return inactive;
    if (!ready()) return inactive;
    const targets = new Set(cardIds);
    const wholeGroups = new Set(groupIds);
    const origins: Record<string, Point> = Object.create(null);
    for (const card of cardsRef.current) if (targets.has(card.id)) origins[card.id] = { x: card.x, y: card.y };
    const originalRects = new Map(groupsRef.current
      .filter((group) => wholeGroups.has(group.id) && group.rect)
      .map((group) => [group.id, group.rect!] as const));
    const wholeMembers = new Set(groupsRef.current.filter((group) => wholeGroups.has(group.id)).flatMap((group) => group.cardIds));
    if (!Object.keys(origins).length && !originalRects.size) return inactive;
    const held = owner();
    let positions = { ...origins };
    let rects = Object.fromEntries(originalRects);
    let touched = false;
    const apply = (nextPositions: Readonly<Record<string, Point>>, nextRects: Readonly<Record<string, CanvasGestureRect>>) => {
      let changedCards = false, changedGroups = false;
      const cards = cardsRef.current.map((card) => {
        const point = nextPositions[card.id];
        if (!origins[card.id] || !point || (card.x === point.x && card.y === point.y)) return card;
        changedCards = true;
        return { ...card, x: point.x, y: point.y };
      });
      const groups = groupsRef.current.map((group) => {
        const rect = nextRects[group.id];
        if (!originalRects.has(group.id) || !rect || sameRect(group.rect, rect)) return group;
        changedGroups = true;
        return { ...group, rect };
      });
      if (changedCards) writeCards(cards);
      if (changedGroups) writeGroups(groups);
      return changedCards || changedGroups;
    };
    const reassignGroups = (frames: readonly CanvasGroupFrame[], ejected: ReadonlySet<string>) => {
      const liveFrames = frames.filter((frame) => !wholeGroups.has(frame.id) && groupsRef.current.some((group) => group.id === frame.id));
      if (!liveFrames.length) return;
      const next = groupsRef.current.map((group) => ({ ...group, cardIds: [...group.cardIds] }));
      let changed = false;
      for (const card of cardsRef.current) {
        if (!origins[card.id] || wholeMembers.has(card.id)) continue;
        const size = options.cardSize(card);
        const cx = card.x + size.w / 2, cy = card.y + size.h / 2;
        let hitId: string | null = null;
        for (const { id, frame } of liveFrames) {
          if (cx >= frame.x && cx <= frame.x + frame.w && cy >= frame.y && cy <= frame.y + frame.h) hitId = id;
        }
        const curId = next.find((group) => group.cardIds.includes(card.id))?.id ?? null;
        if (!ejected.has(card.id) && hitId === null) hitId = curId;
        if (ejected.has(card.id) && hitId === curId) hitId = null;
        if (hitId === curId) continue;
        for (const group of next) group.cardIds = group.cardIds.filter((id) => id !== card.id);
        if (hitId) next.find((group) => group.id === hitId)!.cardIds.push(card.id);
        changed = true;
      }
      if (changed) writeGroups(next.filter((group) => group.cardIds.length > 0));
    };
    const handle: CanvasMoveHandle = {
      preview(geometry) {
        if (!held.current()) return false;
        for (const [id, point] of Object.entries(geometry.positions ?? {})) {
          if (origins[id] && finitePoint(point)) positions[id] = { x: point.x, y: point.y };
        }
        for (const [id, rect] of Object.entries(geometry.rects ?? {})) {
          const original = originalRects.get(id);
          if (original && finitePoint(rect)) rects[id] = { ...original, x: rect.x, y: rect.y };
        }
        const changed = apply(positions, rects);
        touched = touched || changed || Object.keys(origins).some((id) => positions[id].x !== origins[id].x || positions[id].y !== origins[id].y)
          || [...originalRects].some(([id, rect]) => !sameRect(rect, rects[id]));
        return changed;
      },
      finish(drop = {}) {
        if (!held.current()) return;
        if (touched) {
          if (reassign) reassignGroups(drop.startFrames ?? [], drop.ejected ?? new Set());
          persist(false, true);
        }
        held.end();
      },
      cancel() {
        if (!held.current()) return;
        if (touched) {
          apply(origins, Object.fromEntries(originalRects));
          persist(true);
        }
        held.end();
      },
      rebase() {
        if (!held.current()) return;
        touched = apply(positions, rects) || touched;
      },
    };
    held.start((snapshot) => rewindSceneMove(snapshot, origins, originalRects), handle.finish);
    return handle;
  };

  return {
    beginCardMove: (cardIds, wholeGroupIds) => beginMove(cardIds, wholeGroupIds, true),
    beginGroupMove: (cardIds, groupIds) => beginMove(cardIds, groupIds, false),
    beginCardResize(cardId) {
      if (!options.current() || !cardsRef.current.some((item) => item.id === cardId)) return inactive;
      if (!ready()) return inactive;
      const card = cardsRef.current.find((item) => item.id === cardId);
      if (!card) return inactive;
      const held = owner();
      let written = { w: card.w, h: card.h };
      let last: { w: number; h: number } | null = null;
      const apply = (size: { w?: number; h?: number }) => {
        let changed = false;
        const cards = cardsRef.current.map((item) => {
          if (item.id !== cardId || (item.w === size.w && item.h === size.h)) return item;
          changed = true;
          return { ...item, w: size.w, h: size.h };
        });
        if (changed) writeCards(cards);
        return changed;
      };
      const handle: CanvasCardResizeHandle = {
        preview(size) {
          if (!held.current() || !finiteSize(size)) return false;
          last = { w: size.w, h: size.h };
          return apply(last);
        },
        finish() {
          if (!held.current()) return;
          if (last) persist();
          held.end();
        },
        cancel() {
          if (!held.current()) return;
          if (last) { apply(written); persist(true); }
          held.end();
        },
        rebase() {
          if (!held.current()) return;
          if (last) apply(last);
          else {
            const fresh = cardsRef.current.find((item) => item.id === cardId);
            if (fresh) written = { w: fresh.w, h: fresh.h };
          }
        },
      };
      held.start((snapshot) => ({ ...snapshot, cards: snapshot.cards.map((item) => item.id === cardId ? { ...item, ...written } : item) }), handle.finish);
      return handle;
    },
    beginGroupResize(groupId, observedFrame) {
      if (!options.current() || !groupsRef.current.some((item) => item.id === groupId) ||
        !finitePoint(observedFrame) || !finiteSize(observedFrame)) return inactive;
      if (!ready()) return inactive;
      const group = groupsRef.current.find((item) => item.id === groupId);
      if (!group || !finitePoint(observedFrame) || !finiteSize(observedFrame)) return inactive;
      const held = owner();
      let written = group.rect;
      let last = { ...observedFrame };
      let stretched = false;
      const apply = (rect: SceneGroup["rect"]) => {
        let changed = false;
        const groups = groupsRef.current.map((item) => {
          if (item.id !== groupId || sameRect(item.rect, rect)) return item;
          changed = true;
          return { ...item, rect };
        });
        if (changed) writeGroups(groups);
        return changed;
      };
      const handle: CanvasGroupResizeHandle = {
        preview(rect) {
          if (!held.current() || !finitePoint(rect) || !finiteSize(rect)) return false;
          last = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
          stretched = true;
          return apply(last);
        },
        finish(drop = {}) {
          if (!held.current()) return;
          if (groupsRef.current.some((item) => item.id === groupId)) {
            const liveIds = new Set(cardsRef.current.map((card) => card.id));
            const contained = new Set((drop.containedIds ?? cardsRef.current.filter((card) => {
              const size = options.cardSize(card);
              const cx = card.x + size.w / 2, cy = card.y + size.h / 2;
              return cx >= last.x && cx <= last.x + last.w && cy >= last.y && cy <= last.y + last.h;
            }).map((card) => card.id)).filter((id) => liveIds.has(id)));
            const previous = groupsRef.current;
            const groups = previous.map((item) => {
              if (item.id === groupId) return { ...item, rect: last, cardIds: [...new Set([...item.cardIds.filter((id) => liveIds.has(id)), ...contained])] };
              return { ...item, cardIds: item.cardIds.filter((id) => !contained.has(id)) };
            }).filter((item) => item.id === groupId || item.cardIds.length > 0);
            const changed = groups.length !== previous.length || groups.some((item, index) =>
              !sameRect(item.rect, previous[index].rect) || item.cardIds.length !== previous[index].cardIds.length || item.cardIds.some((id, at) => id !== previous[index].cardIds[at]));
            if (stretched || changed) { writeGroups(groups); persist(); }
          }
          held.end();
        },
        cancel() {
          if (!held.current()) return;
          if (stretched && groupsRef.current.some((item) => item.id === groupId)) { apply(written); persist(true); }
          held.end();
        },
        rebase(frame) {
          if (!held.current()) return;
          if (stretched) apply(last);
          else {
            const fresh = groupsRef.current.find((item) => item.id === groupId);
            written = fresh?.rect;
            const observed = frame ?? written;
            if (observed && finitePoint(observed) && finiteSize(observed)) last = { ...observed };
          }
        },
      };
      held.start((snapshot) => ({ ...snapshot, groups: snapshot.groups.map((item) => item.id === groupId ? { ...item, rect: written } : item) }), handle.finish);
      return handle;
    },
  };
}
