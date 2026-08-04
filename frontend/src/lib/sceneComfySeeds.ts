// Comfy 배치 복사본의 seed 변환. React·DOM·API에 의존하지 않는 순수 계산 모듈.

export const COMFY_SEED_MAX = 2_147_483_647;

type RandomSource = () => number;

export function randomComfySeed(random: RandomSource = Math.random): number {
  return Math.floor(random() * (COMFY_SEED_MAX + 1));
}

export function randomizeWorkflowSeeds(
  content: string,
  random: RandomSource = Math.random,
): string {
  try {
    const workflow = JSON.parse(content);
    if (!workflow || typeof workflow !== "object") return content;

    for (const node of Object.values(workflow)) {
      const inputs = (node as { inputs?: Record<string, unknown> })?.inputs;
      if (!inputs || typeof inputs !== "object") continue;
      for (const key of ["seed", "noise_seed"]) {
        if (typeof inputs[key] === "number") {
          inputs[key] = randomComfySeed(random);
        }
      }
    }
    return JSON.stringify(workflow);
  } catch {
    return content;
  }
}

export function randomizeExposedSeedParams(
  paramValues: Record<string, string | number | boolean>,
  random: RandomSource = Math.random,
): Record<string, string | number | boolean> {
  const randomized = { ...paramValues };
  for (const key of Object.keys(randomized)) {
    const field = key.split("|")[1];
    if (
      (field === "seed" || field === "noise_seed") &&
      typeof randomized[key] === "number"
    ) {
      randomized[key] = randomComfySeed(random);
    }
  }
  return randomized;
}
