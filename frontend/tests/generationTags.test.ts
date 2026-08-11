import { describe, expect, it } from "vitest";
import {
  addGenerationTags,
  generationBulkIds,
  removeGenerationTags,
  replaceGenerationTags,
  uniqueTagNames,
} from "../src/lib/generationTags";
import type { Generation } from "../src/types";

function generation(id: string, tags: string[] = [], autoTags: string[] = []): Generation {
  return { id, tags, auto_tags: autoTags } as Generation;
}

describe("generation optimistic tag state", () => {
  it("preserves rapid add then remove order", () => {
    const ids = new Set(["g1"]);
    let generations = [generation("g1", ["old"])];

    generations = addGenerationTags(generations, ids, "tags", ["new"]);
    generations = removeGenerationTags(generations, ids, "tags", ["old"]);

    expect(generations[0].tags).toEqual(["new"]);
  });

  it("updates normal and auto tags independently", () => {
    let generations = [generation("g1", ["normal"], ["auto-old"])];
    generations = replaceGenerationTags(generations, "g1", "auto_tags", ["auto-new"]);

    expect(generations[0].tags).toEqual(["normal"]);
    expect(generations[0].auto_tags).toEqual(["auto-new"]);
  });

  it("includes the focused generation in a bulk action once", () => {
    expect([...generationBulkIds(new Set(["g1", "g2"]), "g2")]).toEqual(["g1", "g2"]);
  });

  it("배치 응답에서 반복된 등록 태그를 한 번만 남긴다", () => {
    expect(uniqueTagNames(["test2, #15", "test1", "test2, #15", "test1", " "])).toEqual([
      "test2, #15",
      "test1",
    ]);
  });
});
