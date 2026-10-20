// Scene remount cache: server fields belong to the scoped read model; local colors and immutable lineage stay separate.
import type { Generation } from "../types";
import type { GenerationReadModel, GenerationReadTicket } from "../features/library/api";
import { getGenerationReadModel } from "../features/library/api";

const CAP = 3000;
const projections = new WeakMap<GenerationReadModel, {
  parents: Map<string, string[]>;
  colors: Map<string, string | null>;
}>();
const current = () => getGenerationReadModel(undefined, "lookup");
function projection(model: GenerationReadModel) {
  let cache = projections.get(model);
  if (!cache) {
    cache = { parents: new Map(), colors: new Map() };
    projections.set(model, cache);
    const held = cache;
    model.subscribe(change => { if (!change.ids.length) { held.parents.clear(); held.colors.clear(); } });
  }
  return cache;
}
function boundedSet<T>(map: Map<string, T>, id: string, value: T): void {
  map.delete(id); map.set(id, value);
  while (map.size > CAP) map.delete(map.keys().next().value!);
}

export function putGen(g: Generation, requestedId = g.id, model = current(), ticket = model.beginRead(), keepLocalColor = false): Generation | undefined {
  const keys = [...new Set([g.id, requestedId])];
  model.store(Object.fromEntries(keys.map(id => [id, g])), ticket);
  if (model.isCurrent(ticket) && !keepLocalColor) for (const id of keys) projection(model).colors.delete(id);
  return hydrateGen([requestedId], model)[requestedId];
}
export function putGenColor(g: Generation, requestedId: string, model = current()): void {
  for (const id of new Set([g.id, requestedId])) boundedSet(projection(model).colors, id, g.color ?? null);
}
export function putParents(id: string, parents: string[], model = current()): void {
  boundedSet(projection(model).parents, id, parents);
}
export function markGenMissing(id: string, missing: boolean, model = current(), ticket?: GenerationReadTicket): void {
  if (!missing) return; // A successful putGen clears the read model's missing state.
  model.markMissing([id], ticket ?? model.beginRead());
  projection(model).colors.delete(id);
}
export function hydrateGen(ids: string[], model = current()): Record<string, Generation> {
  const rows = model.snapshot(ids);
  const colors = projection(model).colors;
  return Object.fromEntries(Object.entries(rows).map(([id, row]) => [id,
    colors.has(id) ? { ...row, color: colors.get(id)! } : row,
  ]));
}
export function hydrateParents(ids: string[], model = current()): Record<string, string[]> {
  const parents = projection(model).parents;
  return Object.fromEntries(ids.flatMap(id => parents.has(id) ? [[id, parents.get(id)!]] : []));
}
export function hydrateMissing(ids: string[], model = current()): Set<string> {
  return new Set(ids.filter(id => model.isMissing(id)));
}
