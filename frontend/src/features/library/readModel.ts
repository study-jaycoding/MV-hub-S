import type { Generation } from "../../types";
import { isStructurallyEqual } from "../../lib/stateReconciliation";

export type GenerationField = keyof Generation;
export interface GenerationReadScope {
  readonly serverOrigin: string;
  readonly accountNamespace: string;
  // Lookup IDs are API aliases, not proof that a local/team row has the same identity.
  readonly authority: "local" | "team" | "lookup" | "trash";
}
export interface GenerationReadTicket {
  readonly owner: symbol;
  readonly epoch: number;
  readonly sequence: number;
  readonly fields?: readonly GenerationField[];
}
interface Entry {
  value?: Generation;
  versions: Map<GenerationField, number>;
  stale: Set<GenerationField>;
  identityVersion: number;
  missing: boolean;
}
export interface GenerationReadChange {
  readonly ids: readonly string[];
  readonly fields?: readonly GenerationField[];
}

/** Owns server record fields. Query membership, local edits and Undo stay outside. */
export class GenerationReadModel {
  readonly scope: Readonly<GenerationReadScope>;
  private readonly owner = Symbol("generation-read-model");
  private epoch = 0;
  private sequence = 0;
  private retiredBefore = 0;
  private readonly entries = new Map<string, Entry>();
  // shortcut: watermarks live until clear(); prune when read tickets gain a completion lifecycle.
  private readonly evictedVersions = new Map<string, number>();
  private readonly listeners = new Set<(change: GenerationReadChange) => void>();

  constructor(scope: GenerationReadScope, private readonly capacity = 3000) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Invalid generation cache capacity");
    this.scope = Object.freeze({ ...scope });
  }

  beginRead(fields?: readonly GenerationField[]): GenerationReadTicket {
    return Object.freeze({ owner: this.owner, epoch: this.epoch, sequence: ++this.sequence,
      fields: fields === undefined ? undefined : Object.freeze([...new Set(fields)]) });
  }

  read(id: string): Generation | undefined {
    return this.entries.get(id)?.value;
  }

  snapshot(ids: readonly string[]): Record<string, Generation> {
    return Object.fromEntries(ids.flatMap(id => {
      const value = this.read(id);
      return value ? [[id, value]] : [];
    }));
  }

  isMissing(id: string): boolean {
    return this.entries.get(id)?.missing ?? false;
  }

  isFresh(id: string, fields?: readonly GenerationField[]): boolean {
    const entry = this.entries.get(id);
    return !!entry?.value && (fields === undefined ? !entry.stale.size : fields.every(field => !entry.stale.has(field)));
  }

  isCurrent(ticket: GenerationReadTicket): boolean {
    return ticket.owner === this.owner && ticket.epoch === this.epoch && ticket.sequence >= this.retiredBefore;
  }

  captureSession(): () => boolean {
    const epoch = this.epoch;
    return () => this.epoch === epoch;
  }

  invalidateAll(): void {
    this.invalidate([...this.entries.keys()]);
    this.retiredBefore = this.sequence;
  }

  store(items: Readonly<Record<string, Generation>>, ticket: GenerationReadTicket): string[] {
    if (!this.isCurrent(ticket) || ticket.fields?.length === 0) return [];
    const accepted: string[] = [];
    const changed: string[] = [];
    for (const [id, fresh] of Object.entries(items)) {
      if (!id || !fresh || typeof fresh.id !== "string" || !fresh.id) continue;
      if (ticket.sequence < (this.evictedVersions.get(id) ?? 0)) continue;
      let entry = this.entries.get(id);
      // A field patch cannot establish identity or restore a record confirmed missing.
      if (ticket.fields && (!entry?.value || entry.missing || entry.value.id !== fresh.id)) continue;
      if (entry && ticket.sequence < entry.identityVersion) continue;
      if (entry?.value && entry.value.id !== fresh.id) {
        // Only an explicitly newer API resolution may retarget an alias.
        const newest = Math.max(entry.identityVersion, ...entry.versions.values());
        if (ticket.sequence < newest) continue;
        entry = undefined;
      }
      if (!entry) entry = { versions: new Map(), stale: new Set(), identityVersion: 0, missing: false };
      if (!entry.value && [...entry.versions.values()].some(version => version > ticket.sequence)) continue;
      const fields = ticket.fields ?? [...new Set([...Object.keys(entry.value ?? {}), ...Object.keys(fresh)])] as GenerationField[];
      const next = { ...(entry.value ?? fresh) };
      for (const field of fields) {
        if (field === "id" || ticket.sequence < (entry.versions.get(field) ?? 0)) continue;
        if (Object.prototype.hasOwnProperty.call(fresh, field)) Object.assign(next, { [field]: fresh[field] });
        else if (ticket.fields) continue;
        else Reflect.deleteProperty(next, field);
        entry.versions.set(field, ticket.sequence);
        entry.stale.delete(field);
      }
      const was = entry.value;
      entry.value = was && isStructurallyEqual(was, next) ? was : next;
      if (!was) entry.identityVersion = ticket.sequence;
      entry.missing = false;
      this.evictedVersions.delete(id);
      this.entries.delete(id);
      this.entries.set(id, entry);
      accepted.push(id);
      if (entry.value !== was) changed.push(id);
      this.trim();
    }
    if (changed.length) this.notify({ ids: changed, fields: ticket.fields });
    return accepted;
  }

  markMissing(ids: readonly string[], ticket: GenerationReadTicket): void {
    if (!this.isCurrent(ticket)) return;
    const changed: string[] = [];
    for (const id of ids) {
      if (ticket.sequence < (this.evictedVersions.get(id) ?? 0)) continue;
      const previous = this.entries.get(id);
      const newest = previous ? Math.max(previous.identityVersion, ...previous.versions.values()) : 0;
      if (ticket.sequence < newest) continue;
      this.entries.set(id, { versions: new Map(), stale: new Set(), identityVersion: ticket.sequence, missing: true });
      this.evictedVersions.delete(id);
      changed.push(id);
      this.trim();
    }
    if (changed.length) this.notify({ ids: changed });
  }

  invalidate(ids: readonly string[], fields?: readonly GenerationField[]): void {
    const sequence = ++this.sequence;
    for (const id of ids) {
      const entry: Entry = this.entries.get(id) ?? { versions: new Map(), stale: new Set(), identityVersion: this.evictedVersions.get(id) ?? 0, missing: false };
      const staleFields = fields ?? Object.keys(entry.value ?? {}) as GenerationField[];
      for (const field of staleFields) { entry.versions.set(field, sequence); entry.stale.add(field); }
      if (fields === undefined) entry.identityVersion = sequence;
      this.entries.delete(id);
      this.entries.set(id, entry);
      this.evictedVersions.delete(id);
      this.trim();
    }
  }

  subscribe(listener: (change: GenerationReadChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  clear(notify = true): void {
    this.epoch++;
    this.entries.clear();
    this.evictedVersions.clear();
    if (notify) this.notify({ ids: [] });
  }

  private notify(change: GenerationReadChange): void {
    for (const listener of [...this.listeners]) if (this.listeners.has(listener)) listener(change);
  }

  private trim(): void {
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        const entry = this.entries.get(oldest)!;
        // Retain only this ID's watermark; unrelated in-flight reads remain valid.
        this.evictedVersions.set(oldest, Math.max(entry.identityVersion, ...entry.versions.values()));
        this.entries.delete(oldest);
      }
    }
  }
}
