import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import type { Generation, History } from "../src/types";

function okResponse(result: unknown): Pick<Response, "ok" | "json"> {
  return { ok: true, json: vi.fn().mockResolvedValue(result) };
}

function legacyGeneration(id: string): Generation {
  return {
    id,
    prompt: JSON.stringify([{ t: "text", v: `legacy ${id}` }]),
    display_prompt: null,
  } as Generation;
}

afterEach(() => vi.unstubAllGlobals());

describe("generation prompt API compatibility boundary", () => {
  it("normalizes generation list and batch items", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse([legacyGeneration("list")]))
      .mockResolvedValueOnce(
        okResponse({ items: { batch: legacyGeneration("batch") }, materials: {}, missing: [] }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const listed = await api.listGenerations({ tab: "my" });
    const batch = await api.getGenerationsBatch(["batch"]);

    expect(listed[0].prompt).toBe("legacy list");
    expect(batch.items.batch.prompt).toBe("legacy batch");
  });

  // 42회차 — leanPrompt 는 lean_prompt=1 을 붙이고(요청할 때만), 빈 글로 온 프롬프트를 다른 데서 채우지 않는다
  it("adds lean_prompt=1 only when asked and keeps a blanked prompt blank", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse([{ id: "a", prompt: "", display_prompt: "" } as Generation]))
      .mockResolvedValueOnce(okResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const lean = await api.listGenerations({ tab: "team" }, null, 500, { leanPrompt: true });
    await api.listGenerations({ tab: "team" });

    expect(String(fetchMock.mock.calls[0][0])).toContain("&lean_prompt=1");
    expect(String(fetchMock.mock.calls[1][0])).not.toContain("lean_prompt");
    expect([lean[0].prompt, lean[0].display_prompt]).toEqual(["", ""]);
  });

  it("normalizes every generation nested in a history response", async () => {
    const target = legacyGeneration("target");
    const history = {
      ancestors: [legacyGeneration("ancestor")],
      materials: [legacyGeneration("material")],
      target,
      children: [legacyGeneration("child")],
      used_by: [legacyGeneration("used")],
      siblings: [legacyGeneration("sibling")],
    } as History;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(history)));

    const normalized = await api.history("target");

    expect([
      normalized.ancestors[0].prompt,
      normalized.materials[0].prompt,
      normalized.target.prompt,
      normalized.children[0].prompt,
      normalized.used_by[0].prompt,
      normalized.siblings[0].prompt,
    ]).toEqual([
      "legacy ancestor",
      "legacy material",
      "legacy target",
      "legacy child",
      "legacy used",
      "legacy sibling",
    ]);
  });

  it("normalizes generation nodes in the canvas history graph", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        okResponse({
          focus_id: "node",
          root_ids: ["node"],
          nodes: [legacyGeneration("node")],
          edges: [],
        }),
      ),
    );

    const graph = await api.historyTree("node");

    expect(graph.nodes[0].prompt).toBe("legacy node");
  });
});
