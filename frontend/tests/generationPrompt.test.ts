import { describe, expect, it } from "vitest";
import {
  decodeLegacySerializedPrompt,
  normalizeGenerationPromptCompatibility,
} from "../src/lib/generationPrompt";
import type { Generation } from "../src/types";

describe("generation prompt compatibility", () => {
  it("keeps a normal text prompt unchanged", () => {
    expect(decodeLegacySerializedPrompt("a cat on the beach")).toBe("a cat on the beach");
  });

  it("decodes the legacy all-text PromptPart array found in copied production data", () => {
    const raw = JSON.stringify([
      { t: "text", v: "<<<image1>>>" },
      { t: "text", v: ", " },
      { t: "text", v: "<<<image2>>> 가 한팀이다." },
    ]);

    expect(decodeLegacySerializedPrompt(raw)).toBe("<<<image1>>>, <<<image2>>> 가 한팀이다.");
  });

  it("restores a legacy inline chip as its readable source name", () => {
    const raw = JSON.stringify([
      { t: "text", v: "use " },
      { t: "chip", ref: { name: "hero", file_path: "asset:x", type: "image" } },
      { t: "text", v: " here" },
    ]);

    expect(decodeLegacySerializedPrompt(raw)).toBe("use @hero here");
  });

  it("does not reinterpret ordinary or partially damaged JSON arrays", () => {
    const ordinary = '[{"role":"user","content":"hello"}]';
    const mixed = '[{"t":"text","v":"hello"},{"unexpected":true}]';

    expect(decodeLegacySerializedPrompt(ordinary)).toBe(ordinary);
    expect(decodeLegacySerializedPrompt(mixed)).toBe(mixed);
    expect(decodeLegacySerializedPrompt("[]")).toBe("[]");
  });

  it("normalizes only legacy fields at the API boundary and preserves normal object identity", () => {
    const normal = { prompt: "normal", display_prompt: null } as Generation;
    const legacy = {
      prompt: JSON.stringify([{ t: "text", v: "legacy" }]),
      display_prompt: JSON.stringify([{ t: "text", v: "visible" }]),
    } as Generation;

    expect(normalizeGenerationPromptCompatibility(normal)).toBe(normal);
    expect(normalizeGenerationPromptCompatibility(legacy)).toMatchObject({
      prompt: "legacy",
      display_prompt: "visible",
    });
  });
});
