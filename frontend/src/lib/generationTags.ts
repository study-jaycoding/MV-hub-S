import type { Generation } from "../types";

export type GenerationTagField = "tags" | "auto_tags";

export function generationBulkIds(selected: Set<string>, focusId: string): Set<string> {
  return new Set([...selected, focusId]);
}

export function generationsByIds(gens: Generation[], ids: Set<string>): Generation[] {
  return gens.filter((g) => ids.has(g.id));
}

export function replaceGenerationTags(
  gens: Generation[],
  genId: string,
  field: GenerationTagField,
  names: string[],
): Generation[] {
  return gens.map((g) => (g.id === genId ? withGenerationTags(g, field, names) : g));
}

export function addGenerationTags(
  gens: Generation[],
  ids: Set<string>,
  field: GenerationTagField,
  names: string[],
): Generation[] {
  return gens.map((g) =>
    ids.has(g.id)
      ? withGenerationTags(g, field, Array.from(new Set([...generationTagValues(g, field), ...names])))
      : g,
  );
}

export function removeGenerationTags(
  gens: Generation[],
  ids: Set<string>,
  field: GenerationTagField,
  names: string[],
): Generation[] {
  const drop = new Set(names);
  return gens.map((g) =>
    ids.has(g.id)
      ? withGenerationTags(g, field, generationTagValues(g, field).filter((name) => !drop.has(name)))
      : g,
  );
}

function generationTagValues(g: Generation, field: GenerationTagField): string[] {
  return field === "auto_tags" ? g.auto_tags || [] : g.tags;
}

function withGenerationTags(g: Generation, field: GenerationTagField, names: string[]): Generation {
  if (field === "auto_tags") return { ...g, auto_tags: names };
  return { ...g, tags: names };
}
