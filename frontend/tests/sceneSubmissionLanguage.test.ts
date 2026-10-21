// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { setLang } from "../src/lib/i18n";
import { useSceneGenerationSubmission } from "../src/lib/useSceneGenerationSubmission";
import type { Scene } from "../src/lib/scenes";

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("../src/app/operationContext", () => ({
  captureSubmissionScope: () => ({ isCurrent: () => true }),
}));
vi.mock("../src/lib/modelPolicy", () => ({
  currentModelPolicy: () => ({ status: "ready" }),
}));
vi.mock("../src/lib/modelPolicyCore", () => ({ modelAllowed: (_: unknown, model: string) => model !== "blocked" }));
vi.mock("../src/lib/workspaceContext", () => ({ isGenerationWorkspaceReady: () => true }));
vi.mock("../src/lib/sceneGenerationInputs", () => ({
  buildSceneGenerationJobInput: (cardId: string) => cardId === "unresolved" ? null : ({
    cardId, model: cardId === "blocked" ? "blocked" : "nano", modelSource: "fallback", modelName: "Nano",
  }),
}));
vi.mock("../src/lib/sceneGenerationSubmission", async (original) => ({
  ...await original<typeof import("../src/lib/sceneGenerationSubmission")>(),
  executeSceneGenerationBatch: async () => ({
    successes: [{ cardId: "ok", result: { generation: { id: "gen", tags: [] } } }],
    buildFail: 1, submitFail: 1, submitUnknown: 1, applyFail: 1,
  }),
}));

afterEach(() => setLang("ko"));

it.each(["en", "ko"] as const)("keeps the entire scene partial-failure notice in %s", async (lang) => {
  setLang(lang);
  const flash = vi.fn();
  const scene = {
    id: "scene", edges: [],
    cards: ["ok", "build", "submit", "unknown", "blocked", "unresolved"].map(id => ({ id, kind: "generation", x: 0, y: 0 })),
  } as Scene;
  const actions = useSceneGenerationSubmission({
    activeScene: scene, workspaceContext: { scope: "personal", id: null, name: null },
    sceneWorkspaceBlock: null, batchCount: 1, armedFolder: null, armedAutoTags: new Set(),
    flushScenePending: vi.fn(),
    prepareCanvasGenerationBatch: vi.fn(async (_sceneId, cardIds) => cardIds.map(cardId => ({
      card_id: cardId, scene_id: "scene", generation_id: cardId, attempt_id: cardId,
    }))),
    confirmCanvasGeneration: vi.fn(), settleCanvasGeneration: vi.fn(), discardCanvasGeneration: vi.fn(),
    onRegenerate: vi.fn(), flash, reportPromptError: vi.fn(), mergeFacetTags: vi.fn(), reload: vi.fn(), bumpBoard: vi.fn(),
  });
  await actions.generateCards(scene.cards.map(card => card.id));
  const message = flash.mock.calls[0][0];
  if (lang === "en") {
    expect(message).not.toMatch(/[가-힣]/);
    for (const text of ["1 cards (1 images)", "Nano", "1 cards without a model", "1 cards with unavailable models excluded", "1 requests failed", "1 submissions failed", "Do not submit again", "recovery runs after restart"])
      expect(message).toContain(text);
  } else {
    expect(message).toContain("1개 카드에서 생성 시작(1장)");
    expect(message).toContain("모델 노드 없음 → 하단 모델(Nano) 4개");
    expect(message).toContain("모델 미확정 1개 · 쓸 수 없는 모델 제외 1개 · 요청 실패 1개 · 제출 실패 1장");
    expect(message).toContain("다시 제출하지 말고");
  }
});
