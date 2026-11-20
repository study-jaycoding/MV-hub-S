// @vitest-environment jsdom
// 캔버스 렌더·생성 제출: GPT Image 2.6 SVG 에 이미지 참조가 붙은 카드는 CLI 가 거절하니 제출 전에 건너뛰고 이유를 알린다(유료 제출 전 거름).
import { expect, it, vi } from "vitest";
import { SVG_REF_MESSAGE } from "../src/lib/svgReference";
import { useSceneGenerationSubmission } from "../src/lib/useSceneGenerationSubmission";
import type { Scene } from "../src/lib/scenes";

const executed: string[][] = [];
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("../src/app/operationContext", () => ({
  captureSubmissionScope: () => ({ isCurrent: () => true }),
}));
vi.mock("../src/lib/modelPolicy", () => ({ currentModelPolicy: () => ({ status: "ready" }) }));
vi.mock("../src/lib/modelPolicyCore", () => ({ modelAllowed: () => true }));
vi.mock("../src/lib/workspaceContext", () => ({ isGenerationWorkspaceReady: () => true }));
vi.mock("../src/lib/sceneGenerationInputs", () => {
  const image = (n: number) => ({ file_path: `https://example.test/${n}.png`, type: "image", role: "", name: "", thumb: "" });
  return {
    buildSceneGenerationJobInput: (cardId: string) => ({
      cardId, model: "gpt_image_2_6", modelSource: "node", modelName: "GPT Image 2.6", text: "x",
      // svgWithRef = SVG + 이미지 참조(막힘) · svgNoRef = SVG 인데 참조 없음(가능) · pngWithRef = png + 참조(가능)
      params: { output_format: cardId.startsWith("png") ? "png" : "svg" },
      refs: cardId.endsWith("NoRef") ? [] : [image(1)],
    }),
  };
});
vi.mock("../src/lib/sceneGenerationSubmission", async (original) => ({
  ...await original<typeof import("../src/lib/sceneGenerationSubmission")>(),
  executeSceneGenerationBatch: async (jobs: { cardId: string }[]) => {
    executed.push(jobs.map((job) => job.cardId));
    return { successes: [], buildFail: 0, submitFail: 0, submitUnknown: 0, applyFail: 0 };
  },
}));

function actionsFor(ids: string[], flash: ReturnType<typeof vi.fn>) {
  const scene = { id: "scene", edges: [], cards: ids.map((id) => ({ id, kind: "generation", x: 0, y: 0 })) } as Scene;
  const actions = useSceneGenerationSubmission({
    activeScene: scene, workspaceContext: { scope: "personal", id: null, name: null },
    sceneWorkspaceBlock: null, batchCount: 1, armedFolder: null, armedAutoTags: new Set(),
    flushScenePending: vi.fn(),
    prepareCanvasGenerationBatch: vi.fn(async (_sceneId: string, cardIds: string[]) => cardIds.map((cardId) => ({
      card_id: cardId, scene_id: "scene", generation_id: cardId, attempt_id: cardId,
    }))),
    confirmCanvasGeneration: vi.fn(), settleCanvasGeneration: vi.fn(), discardCanvasGeneration: vi.fn(),
    onRegenerate: vi.fn(), flash, reportPromptError: vi.fn(), mergeFacetTags: vi.fn(), reload: vi.fn(), bumpBoard: vi.fn(),
  } as never);
  return { scene, actions };
}

it("SVG + 참조 카드는 건너뛰고(이유 안내), 나머지는 그대로 제출한다", async () => {
  executed.length = 0;
  const flash = vi.fn();
  const { actions } = actionsFor(["svgWithRef", "svgNoRef", "pngWithRef"], flash);
  await actions.generateCards(["svgWithRef", "svgNoRef", "pngWithRef"]);
  expect(executed).toEqual([["svgNoRef", "pngWithRef"]]); // 막힌 카드는 제출 목록에 없다
  expect(flash.mock.calls.some(([message]) => String(message).includes(SVG_REF_MESSAGE) && String(message).includes("1개 카드는 건너뛰었습니다"))).toBe(true);
});

it("막힌 카드뿐이면 아무것도 제출하지 않고 이유만 알린다", async () => {
  executed.length = 0;
  const flash = vi.fn();
  const { actions } = actionsFor(["svgWithRef"], flash);
  await actions.generateCards(["svgWithRef"]);
  expect(executed).toEqual([]);
  expect(flash).toHaveBeenCalledWith(SVG_REF_MESSAGE);
});
