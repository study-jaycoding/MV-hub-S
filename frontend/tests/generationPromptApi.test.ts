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
