import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { configureOperationContext } from "../src/app/operationContext";
import { setAccountScope } from "../src/lib/accountScope";
import { setApiPause, setAuthToken } from "../src/lib/http";
import type { Generation } from "../src/types";
import { GenerationReadModel } from "../src/features/library/readModel";

const row = (revision = 7) => ({ id: "same", prompt: "synthetic", shared: true, is_final: false, is_held: false, share_revision: revision } as Generation);
const response = (body: unknown) => new Response(JSON.stringify(body));
const configure = (key: string) => configureOperationContext({ key, serverOrigin: "http://synthetic.invalid", authority: "local", ready: true });
beforeEach(() => { setApiPause(null); setAuthToken(null); setAccountScope("synthetic-a"); configure("a"); });
afterEach(() => { vi.unstubAllGlobals(); setApiPause(null); setAuthToken(null); });

it.each(["unpublish", "finalize", "unfinalize", "hold", "unhold"] as const)("%s uses the displayed team revision", async (action) => {
  const fetch = vi.fn().mockResolvedValueOnce(response([row()])).mockResolvedValue(response(row(8)));
  vi.stubGlobal("fetch", fetch);
  const [generation] = await api.listGenerations({ tab: "team" });
  const model = new GenerationReadModel({ serverOrigin: "http://synthetic.invalid", accountNamespace: "synthetic-a", authority: "team" });
  model.store({ [generation.id]: generation }, model.beginRead());
  await api[action](generation.id, { ...model.read(generation.id)! });
  const url = new URL(fetch.mock.calls[1][0], "http://localhost");
  expect(url.searchParams.get("expected_revision")).toBe("7");
  if (action === "unfinalize") expect(url.searchParams.get("restore_held")).toBe("1");
});

it("keeps local mirror counters separate, including a matching ID and revision", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response([row()])).mockResolvedValueOnce(response([row()])).mockResolvedValue(response(row(8)));
  vi.stubGlobal("fetch", fetch);
  await api.listGenerations({ tab: "team" });
  const [local] = await api.listGenerations({ tab: "my" });
  await api.finalize(local.id, local);
  expect(new URL(fetch.mock.calls[2][0], "http://localhost").searchParams.has("expected_revision")).toBe(false);
});

it("binds team reads before awaiting the response and rejects account/server ABA before writing", async () => {
  let resolve!: (response: Response) => void;
  const fetch = vi.fn().mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }));
  vi.stubGlobal("fetch", fetch);
  const pending = api.listGenerations({ tab: "team" });
  configure("b"); configure("a");
  resolve(response([row()]));
  const [stale] = await pending;
  await expect(api.finalize(stale.id, stale)).rejects.toMatchObject({ status: 409 });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each(["team", "my"] as const)("preserves %s read scope even when legacy revision is absent", async (tab) => {
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(response([{ ...row(), share_revision: null }])));
  vi.stubGlobal("fetch", fetch);
  const [stale] = await api.listGenerations({ tab });
  configure("b"); configure("a");
  await expect(api.finalize(stale.id, stale)).rejects.toMatchObject({ status: 409 });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("uses team batch provenance and carries the confirmed remote revision into a following command", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response({ authority: "team", items: { same: row() }, materials: {}, missing: [] }))
    .mockResolvedValueOnce(response({ ...row(99), remote_share_revision: 8 })).mockResolvedValue(response(row()));
  vi.stubGlobal("fetch", fetch);
  const batch = await api.getGenerationsBatch(["same"], undefined, { authority: "team" });
  const held = await api.hold("same", batch.items.same);
  await api.unhold("same", { ...held });
  expect(new URL(fetch.mock.calls[1][0], "http://localhost").searchParams.get("expected_revision")).toBe("7");
  expect(new URL(fetch.mock.calls[2][0], "http://localhost").searchParams.get("expected_revision")).toBe("8");
});

it("never promotes an ambiguous lookup counter to a team revision", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response({ items: { same: row() }, materials: {}, missing: [] })).mockResolvedValue(response(row()));
  vi.stubGlobal("fetch", fetch);
  const batch = await api.getGenerationsBatch(["same"]);
  await api.unpublish("same", batch.items.same);
  expect(new URL(fetch.mock.calls[1][0], "http://localhost").searchParams.has("expected_revision")).toBe(false);
});

it("keeps unchanged read-model records stable across equivalent reads in one session", async () => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(response([row()]))));
  const model = new GenerationReadModel({ serverOrigin: "http://synthetic.invalid", accountNamespace: "synthetic-a", authority: "team" });
  const [first] = await api.listGenerations({ tab: "team" });
  model.store({ same: first }, model.beginRead());
  const stored = model.read("same");
  const [second] = await api.listGenerations({ tab: "team" });
  model.store({ same: second }, model.beginRead());
  expect(model.read("same")).toBe(stored);
});

it.each(["held", "unshared", "shared"] as const)("atomic final-to-%s uses the original team snapshot", async (state) => {
  const fetch = vi.fn().mockResolvedValueOnce(response([{ ...row(), is_final: true }])).mockResolvedValue(response(row()));
  vi.stubGlobal("fetch", fetch);
  const [generation] = await api.listGenerations({ tab: "team" });
  await api.setReviewState(generation, state);
  expect(new URL(fetch.mock.calls[1][0], "http://localhost").searchParams.get("expected_revision")).toBe("7");
});


it.each(["unpublish", "finalize", "unfinalize", "hold", "unhold"] as const)("%s preserves a rejected revision condition without an unconditional retry", async (action) => {
  const fetch = vi.fn().mockResolvedValueOnce(response([row()]))
    .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "share_revision_precondition_unsupported" }), { status: 409 }))
    .mockResolvedValue(response(row(8)));
  vi.stubGlobal("fetch", fetch);
  const [generation] = await api.listGenerations({ tab: "team" });
  await expect(api[action](generation.id, generation)).rejects.toMatchObject({ status: 409 });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(new URL(fetch.mock.calls[1][0], "http://localhost").searchParams.get("expected_revision")).toBe("7");
});
