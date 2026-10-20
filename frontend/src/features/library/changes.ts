import type { GenerationReadScope } from "./readModel";

export type GenerationChangedField = "tags" | "auto_tags" | "color" | "status";
export interface GenerationChange {
  version: 1;
  id: string;
  scope: Pick<GenerationReadScope, "serverOrigin" | "accountNamespace"> & { connectionKey: string };
  resourceIds: string[];
  changedFields?: GenerationChangedField[];
  affectsMembership: boolean;
  source: "local" | "dom" | "bc" | "ws";
}
const FIELDS = new Set(["tags", "auto_tags", "color", "status"]);

export function generationChangeMatchesScope(change: GenerationChange, scope: GenerationChange["scope"]): boolean {
  return change.scope.serverOrigin === scope.serverOrigin && change.scope.accountNamespace === scope.accountNamespace
    && change.scope.connectionKey === scope.connectionKey;
}

export function readGenerationChange(value: unknown): GenerationChange | null {
  if (!value || typeof value !== "object") return null;
  const change = value as Partial<GenerationChange>;
  if (change.version !== 1 || typeof change.id !== "string" || !change.id
    || !change.scope || typeof change.scope.serverOrigin !== "string" || typeof change.scope.accountNamespace !== "string"
    || typeof change.scope.connectionKey !== "string" || typeof change.affectsMembership !== "boolean"
    || !["local", "dom", "bc", "ws"].includes(change.source ?? "")
    || !Array.isArray(change.resourceIds) || ![...change.resourceIds].every(id => typeof id === "string" && !!id.trim())
    || (change.changedFields !== undefined && (!Array.isArray(change.changedFields)
      || ![...change.changedFields].every(field => FIELDS.has(field))))) return null;
  return { ...change, resourceIds: [...new Set(change.resourceIds)],
    changedFields: change.changedFields === undefined ? undefined : [...new Set(change.changedFields)] } as GenerationChange;
}

/** Each subscriber deduplicates independently; old/unknown payloads retain broad reconciliation. */
export function generationChangeReceiver() {
  const seen = new Set<string>();
  let scopeKey = "";
  return (value: unknown, scope: GenerationChange["scope"]): "ignore" | "none" | "fields" | "broad" => {
    const change = readGenerationChange(value);
    if (!change) return "broad";
    const key = JSON.stringify([scope.serverOrigin, scope.accountNamespace, scope.connectionKey]);
    if (key !== scopeKey) { seen.clear(); scopeKey = key; }
    if (!generationChangeMatchesScope(change, scope) || seen.has(change.id)) return "ignore";
    seen.add(change.id);
    if (seen.size > 256) seen.delete(seen.values().next().value!);
    if (change.affectsMembership || change.changedFields === undefined) return "broad";
    return change.resourceIds.length && change.changedFields.length ? "fields" : "none";
  };
}
