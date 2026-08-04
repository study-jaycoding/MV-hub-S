import { describe, expect, it } from "vitest";
import {
  COMFY_SEED_MAX,
  randomComfySeed,
  randomizeExposedSeedParams,
  randomizeWorkflowSeeds,
} from "../src/lib/sceneComfySeeds";

describe("sceneComfySeeds", () => {
  it("Comfy 허용 범위 안에서 seed를 만든다", () => {
    expect(randomComfySeed(() => 0)).toBe(0);
    expect(randomComfySeed(() => 1 - Number.EPSILON)).toBe(COMFY_SEED_MAX);
  });

  it("워크플로우의 숫자 seed/noise_seed만 바꾼다", () => {
    const source = JSON.stringify({
      a: { inputs: { seed: 10, noise_seed: 20, steps: 30 } },
      b: { inputs: { seed: "fixed", text: "prompt" } },
    });
    const values = [0.25, 0.5];
    const output = JSON.parse(randomizeWorkflowSeeds(source, () => values.shift() ?? 0));

    expect(output.a.inputs.seed).toBe(536_870_912);
    expect(output.a.inputs.noise_seed).toBe(1_073_741_824);
    expect(output.a.inputs.steps).toBe(30);
    expect(output.b.inputs.seed).toBe("fixed");
  });

  it("잘못된 JSON과 객체가 아닌 JSON은 원문을 보존한다", () => {
    expect(randomizeWorkflowSeeds("not-json", () => 0)).toBe("not-json");
    expect(randomizeWorkflowSeeds("42", () => 0)).toBe("42");
  });

  it("노출 파라미터 중 node|seed 숫자만 새 값으로 복사한다", () => {
    const source = {
      "1|seed": 1,
      "2|noise_seed": 2,
      "3|steps": 30,
      "4|seed": "fixed",
    };
    const output = randomizeExposedSeedParams(source, () => 0);

    expect(output).toEqual({
      "1|seed": 0,
      "2|noise_seed": 0,
      "3|steps": 30,
      "4|seed": "fixed",
    });
    expect(output).not.toBe(source);
  });
});
