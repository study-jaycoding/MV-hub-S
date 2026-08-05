import { describe, expect, it } from "vitest";
import { applyGenerationColor, nextGenerationSelectionColor } from "../src/lib/generationColorState";
import type { Generation } from "../src/types";

function generation(id: string, color: string | null): Generation {
  return { id, color } as Generation;
}

describe("generation color optimistic state", () => {
  it("uses the immediately updated state for a rapid same-color toggle", () => {
    const ids = ["g1"];
    let generations = [generation("g1", null)];

    const first = nextGenerationSelectionColor(generations, ids, "#ff0000");
    generations = applyGenerationColor(generations, ids, first);
    const second = nextGenerationSelectionColor(generations, ids, "#ff0000");
    generations = applyGenerationColor(generations, ids, second);

    expect(first).toBe("#ff0000");
    expect(second).toBeNull();
    expect(generations[0].color).toBeNull();
  });

  it("changes only selected generations", () => {
    const generations = [generation("g1", null), generation("g2", "#00ff00")];
    const updated = applyGenerationColor(generations, ["g1"], "#ff0000");

    expect(updated[0].color).toBe("#ff0000");
    expect(updated[1]).toBe(generations[1]);
  });
});
