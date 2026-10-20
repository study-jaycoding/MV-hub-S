// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ current: true, save: vi.fn(async () => true) }));
vi.mock("../src/app/operationContext", () => ({
  captureSubmissionScope: () => ({ isCurrent: () => mocks.current }),
  OperationContextChangedError: class extends Error { constructor() { super("context changed"); } },
}));
vi.mock("../src/lib/http", () => ({ authFormHeaders: () => ({}), throwHttpError: async () => { throw new Error("HTTP failure"); } }));
vi.mock("../src/lib/downloadDir", () => ({ saveToDownloadDir: mocks.save }));
import { downloadGenerationBundle, IncompleteGenerationBundle } from "../src/lib/generationBundle";
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); mocks.current = true; });
it("does not silently download incomplete reference bundles", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: { missing: [{ id: "ref" }] } }), { status: 409 })));
  await expect(downloadGenerationBundle("generation")).rejects.toBeInstanceOf(IncompleteGenerationBundle);
  expect(mocks.save).not.toHaveBeenCalled();
});
it("requires an explicit second call for incomplete downloads", async () => {
  const fetch = vi.fn(async () => new Response(new Blob(["zip"])));
  vi.stubGlobal("fetch", fetch);
  await downloadGenerationBundle("generation", true);
  expect(fetch.mock.calls[0][0]).toContain("allow_incomplete=true");
  expect(mocks.save).toHaveBeenCalledWith("generation-generation-incomplete.zip", expect.any(Blob), expect.any(Function));
});
it("does not save bytes delivered after account or server changes", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { mocks.current = false; return new Response(new Blob(["zip"])); }));
  await expect(downloadGenerationBundle("generation")).rejects.toThrow("context changed");
  expect(mocks.save).not.toHaveBeenCalled();
});
