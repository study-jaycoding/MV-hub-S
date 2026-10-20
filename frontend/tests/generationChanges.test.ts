import { expect, it } from "vitest";
import { generationChangeReceiver, readGenerationChange, type GenerationChange } from "../src/features/library/changes";

const scope = { serverOrigin: "http://hub", accountNamespace: "a", connectionKey: "server-a" };
const change = (patch: Partial<GenerationChange> = {}): GenerationChange => ({
  version: 1, id: "one", scope, resourceIds: ["id"], changedFields: ["tags"], affectsMembership: false, source: "local", ...patch,
});
it("classifies fields, membership, valid empty IDs and malformed/legacy signals", () => {
  const receive = generationChangeReceiver();
  expect(receive(change(), scope)).toBe("fields");
  expect(receive(change({ id: "empty", resourceIds: [] }), scope)).toBe("none");
  expect(receive(change({ id: "member", resourceIds: [], affectsMembership: true }), scope)).toBe("broad");
  expect(receive({ version: 999 }, scope)).toBe("broad");
  expect(receive(undefined, scope)).toBe("broad");
});
it("isolates account/server scopes and deduplicates independently per subscriber", () => {
  const a = generationChangeReceiver(), b = generationChangeReceiver();
  expect(a(change({ scope: { ...scope, accountNamespace: "b" } }), scope)).toBe("ignore");
  expect(a(change({ scope: { ...scope, connectionKey: "server-b" } }), scope)).toBe("ignore");
  expect(a(change(), scope)).toBe("fields");
  expect(a(change(), scope)).toBe("ignore");
  expect(b(change(), scope)).toBe("fields");
});
it("validates sparse arrays, fields and source at the transport boundary", () => {
  expect(readGenerationChange(change({ resourceIds: new Array(2) }))).toBeNull();
  expect(readGenerationChange({ ...change(), changedFields: ["unknown"] })).toBeNull();
  expect(readGenerationChange({ ...change(), source: "unknown" })).toBeNull();
  expect(readGenerationChange(change({ resourceIds: ["a", "a"] }))?.resourceIds).toEqual(["a"]);
});
