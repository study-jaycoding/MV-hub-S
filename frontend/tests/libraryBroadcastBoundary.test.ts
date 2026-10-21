// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from "vitest";

class Channel {
  static all: Channel[] = [];
  static sent: unknown[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(readonly name: string) { Channel.all.push(this); }
  postMessage(data: unknown) { Channel.sent.push(data); for (const channel of Channel.all) if (channel !== this) channel.onmessage?.({ data }); }
  close() { Channel.all = Channel.all.filter(channel => channel !== this); }
}
beforeEach(() => {
  vi.resetModules(); localStorage.clear(); sessionStorage.clear();
  Channel.all = []; Channel.sent = []; vi.stubGlobal("BroadcastChannel", Channel);
});
afterEach(() => vi.unstubAllGlobals());

it("[R4-6] a window with no open read model receives configured connection changes", async () => {
  const { configureOperationContext } = await import("../src/app/operationContext");
  const { generationChangeScope, getGenerationReadModel } = await import("../src/features/library/readModels");
  const { onLibraryChanged } = await import("../src/lib/libraryBroadcast");
  configureOperationContext({ key: "connection-A", serverOrigin: location.origin, authority: "local", ready: true });
  expect(generationChangeScope().connectionKey).toBe("connection-A");
  const changed = vi.fn(), off = onLibraryChanged(changed), peer = new Channel("ch-generations");
  const send = (connectionKey: string, id: string) => peer.postMessage({ tab: "peer", change: {
    version: 1, id, scope: { ...generationChangeScope(), connectionKey }, resourceIds: [], affectsMembership: true, source: "bc",
  } });
  try {
    send("connection-A", "a"); expect(changed).toHaveBeenCalledTimes(1);
    getGenerationReadModel("view-specific-cache-key", "local");
    expect(generationChangeScope().connectionKey).toBe("connection-A");
    configureOperationContext({ key: "connection-B", serverOrigin: location.origin, authority: "local", ready: true });
    send("connection-A", "stale-a"); expect(changed).toHaveBeenCalledTimes(1);
    send("connection-B", "b"); expect(changed).toHaveBeenCalledTimes(2);
  } finally { off(); peer.close(); }
});

it("receives a peer tag change once as the same narrow DOM signal without broad subscribers", async () => {
  const { onLibraryChanged } = await import("../src/lib/libraryBroadcast");
  const { getGenerationReadModel, generationChangeScope } = await import("../src/features/library/readModels");
  const { APP_EVENTS } = await import("../src/lib/appEvents");
  const model = getGenerationReadModel("account-a", "local");
  const invalidate = vi.spyOn(model, "invalidate");
  const broad = vi.fn(), tags = vi.fn(), local = vi.fn();
  const off = onLibraryChanged(broad, tags);
  window.addEventListener(APP_EVENTS.generationTagsSettled, local);
  const other = new Channel("ch-generations");
  const change = { version: 1, id: "peer-tags", scope: generationChangeScope(), resourceIds: ["same"],
    changedFields: ["tags", "auto_tags"], affectsMembership: false, source: "local" };
  other.postMessage({ tab: "peer", event: APP_EVENTS.generationTagsSettled, change });
  other.postMessage({ tab: "peer", event: APP_EVENTS.generationTagsSettled, change });
  expect(tags).toHaveBeenCalledTimes(1); expect(broad).not.toHaveBeenCalled();
  expect(local).toHaveBeenCalledTimes(1);
  expect(invalidate).toHaveBeenCalledWith(["same"], ["tags", "auto_tags"]);
  expect(local.mock.calls[0][0].detail).toEqual({ ids: ["same"], fields: ["tags", "auto_tags"], change });
  for (const altered of [
    { ...change, id: "foreign-account", scope: { ...change.scope, accountNamespace: "other" } },
    { ...change, id: "foreign-server", scope: { ...change.scope, serverOrigin: "https://other.invalid" } },
    { ...change, id: "empty", resourceIds: [] },
  ]) other.postMessage({ tab: "peer", event: APP_EVENTS.generationTagsSettled, change: altered });
  expect(tags).toHaveBeenCalledTimes(1); expect(broad).not.toHaveBeenCalled();
  off(); other.close(); window.removeEventListener(APP_EVENTS.generationTagsSettled, local);
});

it("delivers local DOM once and rejects own BC echoes, duplicate and foreign-account messages", async () => {
  const { postLibraryChanged, onLibraryChanged } = await import("../src/lib/libraryBroadcast");
  const { getGenerationReadModel } = await import("../src/features/library/readModels");
  const model = getGenerationReadModel("account-a", "local"), read = model.beginRead();
  const received = vi.fn(), local = vi.fn(); const off = onLibraryChanged(received);
  window.addEventListener("ch:library-changed", local);
  postLibraryChanged({ projectId: "project" });
  expect(local).toHaveBeenCalledTimes(1); expect(received).not.toHaveBeenCalled();
  expect(model.isCurrent(read)).toBe(false);
  const sent = Channel.sent[0] as { change: Record<string, unknown> };
  const other = new Channel("ch-generations");
  const change = { ...sent.change, id: "remote-one", source: "bc" };
  other.postMessage({ tab: "other", change }); other.postMessage({ tab: "other", change });
  expect(received).toHaveBeenCalledTimes(1);
  other.postMessage({ tab: "other", change: { ...change, id: "foreign", scope: { accountNamespace: "b", connectionKey: "account-b", serverOrigin: location.origin } } });
  expect(received).toHaveBeenCalledTimes(1);
  other.postMessage({ tab: "other", change: { ...change, id: "empty", resourceIds: [], changedFields: ["tags"], affectsMembership: false } });
  expect(received).toHaveBeenCalledTimes(1);
  other.postMessage({}); other.postMessage({ change: { version: 999 } });
  expect(received).toHaveBeenCalledTimes(3);
  off(); other.close(); window.removeEventListener("ch:library-changed", local);
});

it("scoped old-account DOM notifications cannot invalidate the current model", async () => {
  const { dispatchAppEvent, APP_EVENTS } = await import("../src/lib/appEvents");
  const { getGenerationReadModel, generationChangeScope } = await import("../src/features/library/readModels");
  const { configureOperationContext } = await import("../src/app/operationContext");
  configureOperationContext({ key: "a", serverOrigin: location.origin, authority: "local", ready: true });
  getGenerationReadModel("a", "local"); const old = generationChangeScope();
  configureOperationContext({ key: "b", serverOrigin: location.origin, authority: "local", ready: true });
  const model = getGenerationReadModel("b", "local"), read = model.beginRead();
  const listener = vi.fn(); window.addEventListener(APP_EVENTS.generationTagsSettled, listener);
  dispatchAppEvent(APP_EVENTS.generationTagsSettled, { ids: ["same"], fields: ["tags"], change: {
    version: 1, id: "old", scope: old, resourceIds: ["same"], changedFields: ["tags"], affectsMembership: false, source: "local",
  } });
  expect(listener).not.toHaveBeenCalled(); expect(model.isCurrent(read)).toBe(true);
  window.removeEventListener(APP_EVENTS.generationTagsSettled, listener);
});
