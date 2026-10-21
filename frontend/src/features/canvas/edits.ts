import {
  sceneRefFingerprint, uid, variantIds,
  type SceneCard, type SceneCardKind, type SceneEdge, type SceneGroup,
  type SceneModelCfg, type SceneRef, type SceneSetFolder,
} from "../../lib/scenes";
import { canConnect, collectListInputs, resolvePortEdges, withCollectorOrder } from "../../lib/sceneEdges";
import { pruneGroups, reconcileRefs } from "../../lib/sceneDerive";
import { buildSelectedConnections } from "../../lib/sceneInteractions";
import type { Generation } from "../../types";
import { gatherCanvasReferences, withCanvasReferences } from "./references";

export interface CanvasSnapshot { cards: SceneCard[]; edges: SceneEdge[]; groups: SceneGroup[] }
export type CanvasEditCommand =
  | { type: "editCardPrompt"; cardId: string; prompt: string }
  | { type: "editNodeText"; cardId: string; text: string }
  | { type: "editSetTags"; cardId: string; tagsText: string }
  | { type: "setSetFolder"; cardId: string; folder?: SceneSetFolder }
  | { type: "setNodeColor"; cardId: string; color: string }
  | { type: "setNodeFontSize"; cardId: string; fontSize: number }
  | { type: "setCardBatch"; cardId: string; count: number }
  | { type: "saveModelConfig"; cardId: string; config: SceneModelCfg }
  | { type: "setCardReferences"; cardId: string; references: SceneRef[] }
  | { type: "synchronizeReferences" }
  | { type: "connectCards"; pairs: Array<[string, string]> }
  | { type: "disconnectEdges"; edgeIds: string[] }
  | { type: "connectSelectedCards"; cardIds: string[] }
  | { type: "createNode"; id: string; kind: SceneCardKind; position: { x: number; y: number } }
  | { type: "createConnectedGeneration"; id: string; position: { x: number; y: number }; sourceIds: string[] }
  | { type: "setInputChannel"; cardId: string; channel: string }
  | { type: "orderListItems"; listId: string; orderedIds: string[] }
  | { type: "toggleRenderItems"; renderId: string; clickedId: string; targetIds: string[] }
  | { type: "selectCardVariant"; cardId: string; generationId: string }
  | { type: "removeCardVariants"; cardId: string; removedIds: string[] }
  | { type: "createGroup"; id: string; cardIds: string[]; rect: SceneGroup["rect"] }
  | { type: "removeGroups"; groupIds: string[] }
  | { type: "renameGroup"; groupId: string; name: string }
  | { type: "toggleGroupsCollapsed"; groupIds: string[]; anchorId: string }
  | { type: "colorGroups"; groupIds: string[]; color?: string }
  | { type: "removeCards"; cardIds: string[] }
  | { type: "arrangeCards"; positions: Readonly<Record<string, { x: number; y: number }>> };

interface CanvasEdit {
  snapshot: CanvasSnapshot;
  policy: "user" | "deferred" | "derived";
}

const newCard = (id: string, kind: SceneCardKind, position: { x: number; y: number }): SceneCard => {
  const base = { id, ...position, kind };
  switch (kind) {
    case "text": case "output": return { ...base, text: "" };
    case "set": return { ...base, w: 160, h: 136, setCfg: { tagsText: "" } };
    case "head": return { ...base, text: "제목", color: "#e8c341", fontSize: 32 };
    case "comfy": return { ...base, w: 210, h: 190, comfyCfg: { status: "idle", paramExposed: [], paramValues: {}, params: [] } };
    case "reference": case "generation": return { ...base, kind: "generation", status: "empty", refs: [], genId: null };
    default: return base;
  }
};

// 현재 문서에 명령의 필드만 적용한다. 저장/Undo 정책은 화면에서 선택할 수 없다.
export function applyCanvasEdit(
  current: CanvasSnapshot,
  command: CanvasEditCommand,
  generations: Readonly<Record<string, Generation>>,
): CanvasEdit | null {
  let { cards, edges, groups } = current;
  let policy: CanvasEdit["policy"] = "user";
  const withRefs = (value: SceneCard[], links = edges) => withCanvasReferences(value, links, generations);
  const references = (cardId: string, value = cards, links = edges) => gatherCanvasReferences(cardId, value, links, generations);
  const patchCard = (cardId: string, patch: (card: SceneCard) => SceneCard) => {
    if (!cards.some(card => card.id === cardId)) return false;
    cards = cards.map(card => card.id === cardId ? patch(card) : card);
    return true;
  };
  switch (command.type) {
    case "editCardPrompt":
      if (!patchCard(command.cardId, card => ({ ...card, prompt: command.prompt }))) return null;
      policy = "deferred"; break;
    case "editNodeText":
      if (!patchCard(command.cardId, card => ({ ...card, text: command.text }))) return null;
      policy = "deferred"; break;
    case "editSetTags":
      if (!patchCard(command.cardId, card => ({ ...card, setCfg: { ...(card.setCfg || {}), tagsText: command.tagsText } }))) return null;
      policy = "deferred"; break;
    case "setSetFolder":
      if (!patchCard(command.cardId, card => ({ ...card, setCfg: { ...(card.setCfg || {}), folder: command.folder } }))) return null;
      break;
    case "setNodeColor":
      if (!patchCard(command.cardId, card => ({ ...card, color: command.color }))) return null;
      break;
    case "setNodeFontSize":
      if (!patchCard(command.cardId, card => ({ ...card, fontSize: Math.max(12, Math.min(200, Math.round(command.fontSize))) }))) return null;
      break;
    case "setCardBatch":
      if (!patchCard(command.cardId, card => ({ ...card, batchCount: Math.max(1, Math.min(4, command.count)) }))) return null;
      break;
    case "saveModelConfig":
      if (!patchCard(command.cardId, card => ({ ...card, modelCfg: command.config }))) return null;
      break;
    case "setCardReferences": {
      const card = cards.find(item => item.id === command.cardId);
      if (!card || card.kind !== "generation") return null;
      const refs = reconcileRefs(command.references, references(card.id));
      if (sceneRefFingerprint(card.refs || []) !== sceneRefFingerprint(refs))
        patchCard(card.id, item => ({ ...item, refs }));
      break;
    }
    case "synchronizeReferences": {
      const next = withRefs(cards);
      if (!cards.some((card, index) => card.kind === "generation" &&
        sceneRefFingerprint(card.refs || []) !== sceneRefFingerprint(next[index].refs || []))) return null;
      cards = next; policy = "derived"; break;
    }
    case "connectCards": {
      const seen = new Set(edges.map(edge => `${edge.from}>${edge.to}`));
      const additions: SceneEdge[] = [];
      const byId = new Map(cards.map(card => [card.id, card]));
      for (const [from, to] of command.pairs) {
        const key = `${from}>${to}`;
        const source = byId.get(from), target = byId.get(to);
        if (seen.has(key) || !source || !target || !canConnect(source, target, byId, [...edges, ...additions])) continue;
        seen.add(key); additions.push({ id: uid(), from, to });
      }
      if (!additions.length) return null;
      edges = [...edges, ...withCollectorOrder(edges, additions, byId)];
      cards = withRefs(cards); break;
    }
    case "disconnectEdges": {
      const removed = new Set(command.edgeIds);
      const next = edges.filter(edge => !removed.has(edge.id));
      if (next.length === edges.length) return null;
      edges = next; cards = withRefs(cards); break;
    }
    case "connectSelectedCards": {
      const additions = buildSelectedConnections(cards, edges, new Set(command.cardIds), uid);
      if (!additions.length) return null;
      edges = [...edges, ...withCollectorOrder(edges, additions, new Map(cards.map(card => [card.id, card])))];
      cards = withRefs(cards); break;
    }
    case "createNode":
    case "createConnectedGeneration": {
      if (cards.some(card => card.id === command.id)) return null;
      const card = newCard(command.id, command.type === "createNode" ? command.kind : "generation", command.position);
      if (command.type === "createConnectedGeneration") {
        const byId = new Map(cards.map(item => [item.id, item]));
        const sources = new Set(command.sourceIds);
        const additions = cards.filter(item => sources.has(item.id) && canConnect(item, card, byId, edges))
          .map(item => ({ id: uid(), from: item.id, to: card.id }));
        edges = [...edges, ...additions];
      }
      cards = withRefs([...cards, card]); break;
    }
    case "setInputChannel":
      if (!patchCard(command.cardId, card => ({ ...card, channel: command.channel || undefined }))) return null;
      cards = withRefs(cards); break;
    case "orderListItems": {
      const byId = new Map(cards.map(card => [card.id, card]));
      const referenceList = collectListInputs(command.listId, byId, resolvePortEdges(byId, edges)).kind === "reference";
      if (referenceList) patchCard(command.listId, card => ({ ...card, listOrder: command.orderedIds }));
      else edges = edges.map(edge => {
        const index = command.orderedIds.indexOf(edge.from);
        return edge.to === command.listId && index >= 0 ? { ...edge, order: index } : edge;
      });
      cards = withRefs(cards);
      if (referenceList) {
        const nextById = new Map(cards.map(card => [card.id, card]));
        const targets = new Set(resolvePortEdges(nextById, edges)
          .filter(edge => edge.from === command.listId && nextById.get(edge.to)?.kind === "generation").map(edge => edge.to));
        cards = cards.map(card => {
          if (card.kind !== "generation" || !targets.has(card.id)) return card;
          const ordered = references(card.id);
          const keys = new Set(ordered.map(ref => `${ref.file_path}#${ref.source_gen_id || ""}`));
          return { ...card, refs: [...ordered, ...(card.refs || []).filter(ref => !keys.has(`${ref.file_path}#${ref.source_gen_id || ""}`))] };
        });
      }
      break;
    }
    case "toggleRenderItems": {
      const existing = new Set(cards.map(card => card.id));
      if (!patchCard(command.renderId, card => {
        const unchecked = new Set(card.unchecked || []);
        const uncheck = !unchecked.has(command.clickedId);
        for (const id of command.targetIds) if (existing.has(id)) uncheck ? unchecked.add(id) : unchecked.delete(id);
        return { ...card, unchecked: [...unchecked] };
      })) return null;
      break;
    }
    case "selectCardVariant":
      if (!patchCard(command.cardId, card => ({ ...card, genId: command.generationId }))) return null;
      policy = "derived"; break;
    case "removeCardVariants": {
      const removed = new Set(command.removedIds);
      if (!removed.size || !patchCard(command.cardId, card => {
        const genIds = variantIds(card).filter(id => !removed.has(id));
        const genId = card.genId && !removed.has(card.genId) ? card.genId : genIds[0] ?? null;
        return { ...card, genIds, genId, status: genIds.length ? card.status : "empty" };
      })) return null;
      policy = "derived"; break;
    }
    case "createGroup": {
      const existing = new Set(cards.map(card => card.id));
      const ids = [...new Set(command.cardIds)].filter(id => existing.has(id));
      if (!ids.length || groups.some(group => group.id === command.id)) return null;
      groups = pruneGroups(groups, new Set(ids), existing);
      groups = [...groups, { id: command.id, name: `그룹 ${groups.length + 1}`, cardIds: ids, rect: command.rect }];
      break;
    }
    case "removeGroups": {
      const ids = new Set(command.groupIds); groups = groups.filter(group => !ids.has(group.id)); break;
    }
    case "renameGroup":
      groups = groups.map(group => group.id === command.groupId ? { ...group, name: command.name } : group); break;
    case "toggleGroupsCollapsed": {
      const collapsed = !groups.find(group => group.id === command.anchorId)?.collapsed;
      const ids = new Set(command.groupIds);
      groups = groups.map(group => ids.has(group.id) ? { ...group, collapsed } : group); break;
    }
    case "colorGroups": {
      const ids = new Set(command.groupIds);
      groups = groups.map(group => ids.has(group.id) ? { ...group, color: command.color || undefined } : group); break;
    }
    case "removeCards": {
      if (!command.cardIds.length) return null;
      const ids = new Set(command.cardIds);
      edges = edges.filter(edge => !ids.has(edge.from) && !ids.has(edge.to));
      cards = withRefs(cards.filter(card => !ids.has(card.id)).map(card =>
        card.kind === "input" && card.channel && ids.has(card.channel) ? { ...card, channel: undefined } : card));
      groups = pruneGroups(groups, ids, new Set(cards.map(card => card.id))); break;
    }
    case "arrangeCards":
      cards = withRefs(cards.map(card => command.positions[card.id] ? { ...card, ...command.positions[card.id] } : card)); break;
  }
  return { snapshot: { cards, edges, groups }, policy };
}
