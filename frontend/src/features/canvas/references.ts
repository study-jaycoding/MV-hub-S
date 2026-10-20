import type { Generation } from "../../types";
import { assetIdentity } from "../../shared/contracts/assets";
import { ownEntry } from "../../lib/ownEntry";
import { reconcileRefs } from "../../lib/sceneDerive";
import { collectListInputs, collectRenderGenCardIds, resolvePortEdges } from "../../lib/sceneEdges";
import { variantIds, type SceneCard, type SceneEdge, type SceneRef } from "../../lib/scenes";

export function gatherCanvasReferences(
  cardId: string,
  cards: readonly SceneCard[],
  edges: SceneEdge[],
  generations: Readonly<Record<string, Generation>>,
): SceneRef[] {
  const byId = new Map(cards.map(card => [card.id, card] as const));
  const resolved = resolvePortEdges(byId, edges);
  const sources = resolved.filter(edge => edge.to === cardId).map(edge => byId.get(edge.from))
    .filter((card): card is SceneCard => !!card &&
      (card.kind === "reference" || card.kind === "generation" || card.kind === "list" || card.kind === "render"))
    .sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x);
  const refs: SceneRef[] = [];
  const seen = new Set<string>();
  const tagged = (items: SceneRef[]) => items.map(ref => ({ ...ref, from_card: true as const }));
  const addGeneration = (card?: SceneCard) => {
    const id = card?.genId || (card ? variantIds(card)[0] : undefined);
    const generation = id ? ownEntry(generations, id) : undefined;
    const asset = generation?.assets?.[0];
    if (!id || !asset || seen.has(id)) return;
    seen.add(id);
    refs.push(...tagged([{
      ...assetIdentity(asset),
      file_path: asset.asset_content_id ? asset.file_path : asset.source_url || asset.file_path,
      type: asset.type,
      name: generation?.source_name || `${asset.type === "video" ? "vid" : "img"}-${id.slice(0, 8)}`,
      thumb: asset.thumbnail_path || asset.file_path,
      source_gen_id: id,
    }]));
  };
  for (const source of sources) {
    if (source.kind === "reference" && source.refs) refs.push(...tagged(source.refs));
    else if (source.kind === "generation") addGeneration(source);
    else if (source.kind === "list") {
      const inputs = collectListInputs(source.id, byId, resolved);
      if (inputs.kind === "reference") {
        for (const id of inputs.referenceCardIds) {
          const card = byId.get(id);
          if (card?.refs) refs.push(...tagged(card.refs));
        }
      } else if (inputs.kind === "generation") {
        for (const id of inputs.generationCardIds) addGeneration(byId.get(id));
      }
    } else if (source.kind === "render") {
      for (const id of collectRenderGenCardIds(source.id, byId, resolved)) addGeneration(byId.get(id));
    }
  }
  return refs;
}

export function withCanvasReferences(
  cards: SceneCard[], edges: SceneEdge[], generations: Readonly<Record<string, Generation>>,
): SceneCard[] {
  return cards.map(card => card.kind === "generation"
    ? { ...card, refs: reconcileRefs(card.refs || [], gatherCanvasReferences(card.id, cards, edges, generations)) }
    : card);
}
