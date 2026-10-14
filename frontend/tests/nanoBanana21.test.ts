// Nano Banana 2.1(2026-10-14 추가) — 고를 수 있고, 새 옵션이 맞는 칸과 이름으로 뜬다.
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { ALLOWED, inferModelType } from "../src/lib/useModels";
import { spotlightParamLabel, spotlightValueLabel } from "../src/lib/spotlightPromptConfig";

afterEach(() => vi.unstubAllGlobals());

describe("Nano Banana 2.1", () => {
  it("is an image model listed after Nano Banana 2, which stays the default", () => {
    expect(ALLOWED.image.slice(0, 2)).toEqual(["nano_banana_flash", "nano_banana_2_1"]);
    expect(inferModelType("nano_banana_2_1")).toBe("image");
  });

  it("drops the CLI's |null so the new options draw as ON/OFF and number fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      job_set_type: "nano_banana_2_1", type: "image", params: [
        { name: "enable_web_search", type: "boolean|null", default: null },
        { name: "seed", type: "integer|null", default: null },
        { name: "background", type: "string|null", enum: ["auto", "opaque"] },
        { name: "resolution", type: "string", default: "1k", enum: ["1k", "2k", "4k"] },
      ],
    }))));
    const r = await api.modelParams("nano_banana_2_1");
    expect(r.params.map((p) => p.type)).toEqual(["boolean", "integer", "string", "string"]);
  });

  it("names the new options and does not call thinking 'high' 고화질", () => {
    expect(spotlightParamLabel("thinking_level")).toBe("생각 수준");
    expect(spotlightParamLabel("enable_web_search")).toBe("웹 검색");
    expect(spotlightValueLabel("high", "thinking_level")).toBe("깊게(high)");
    expect(spotlightValueLabel("high", "bitrate_mode")).toBe("고화질(high)");
    expect(spotlightValueLabel("high")).toBe("고화질(high)");
  });
});
