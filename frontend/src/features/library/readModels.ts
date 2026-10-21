import { getAccountNamespace, getConnectionKey } from "../../lib/accountScope";
import { GenerationReadModel, type GenerationField, type GenerationReadScope, type GenerationReadTicket } from "./readModel";
import type { Generation } from "../../types";

let context = "";
// Implicit cache readers follow the last explicit selection; event scope is owned by App.
let activeAuthKey = "";
const models = new Map<GenerationReadScope["authority"], GenerationReadModel>();

/** App account/server epochs invalidate outstanding reads as well as cached records. */
export function clearGenerationReadModels(): void {
  for (const model of models.values()) model.clear();
}

export function generationChangeScope() {
  return { serverOrigin: globalThis.location?.origin ?? "", accountNamespace: getAccountNamespace(), connectionKey: getConnectionKey() };
}

export function invalidateGenerationReadModels(ids?: readonly string[], fields?: readonly GenerationField[]): void {
  for (const model of models.values()) {
    if (ids === undefined) model.invalidateAll();
    else model.invalidate(ids, fields);
  }
}

export function getGenerationReadModel(authKey: string | undefined, authority: GenerationReadScope["authority"]): GenerationReadModel {
  const serverOrigin = globalThis.location?.origin ?? "";
  const accountNamespace = getAccountNamespace();
  const next = JSON.stringify([serverOrigin, accountNamespace, authKey ?? activeAuthKey]);
  if (context !== next) {
    // Scope selection happens during render; retire old reads without notifying mounted React views here.
    for (const model of models.values()) model.clear(false);
    models.clear();
    context = next;
  }
  if (authKey !== undefined) activeAuthKey = authKey;
  let model = models.get(authority);
  if (!model) {
    model = new GenerationReadModel({ serverOrigin, accountNamespace, authority });
    models.set(authority, model);
  }
  return model;
}

export function storeGenerationRows(model: GenerationReadModel, rows: Generation[], ticket: GenerationReadTicket): Generation[] {
  if (!model.isCurrent(ticket)) return [];
  model.store(Object.fromEntries(rows.map(row => [row.id, row])), ticket);
  return rows.flatMap(row => {
    const current = model.read(row.id);
    return current ? [current] : [];
  });
}
