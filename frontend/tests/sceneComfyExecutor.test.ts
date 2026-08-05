import { describe, expect, it, vi } from "vitest";
import {
  executeSceneComfy,
  isSceneComfyConfigCurrent,
  SceneComfyRunSupersededError,
} from "../src/lib/sceneComfyExecutor";
import type { SceneCard, SceneEdge } from "../src/lib/scenes";

const comfyCard = (overrides: Partial<SceneCard> = {}): SceneCard =>
  ({
    id: "comfy",
    kind: "comfy",
    x: 100,
    y: 0,
    comfyCfg: { content: "workflow", paramValues: { prompt: "hello" } },
    ...overrides,
  }) as SceneCard;

describe("executeSceneComfy", () => {
  it("실행 입력과 무관한 상태 변경은 허용하고 워크플로·파라미터 교체만 감지한다", () => {
    const snapshot = { content: "workflow", paramValues: { prompt: "hello" } };

    expect(
      isSceneComfyConfigCurrent(
        [comfyCard({ comfyCfg: { ...snapshot, status: "running", outputs: [] } })],
        "comfy",
        snapshot,
      ),
    ).toBe(true);
    expect(
      isSceneComfyConfigCurrent(
        [comfyCard({ comfyCfg: { content: "new-workflow", paramValues: snapshot.paramValues } })],
        "comfy",
        snapshot,
      ),
    ).toBe(false);
    expect(
      isSceneComfyConfigCurrent(
        [comfyCard({ comfyCfg: { content: snapshot.content, paramValues: { prompt: "changed" } } })],
        "comfy",
        snapshot,
      ),
    ).toBe(false);
  });

  it("현재 워크플로우와 파라미터로 API를 실행하고 출력만 반환한다", async () => {
    const run = vi.fn().mockResolvedValue({ outputs: [{ kind: "text", text: "ok" }], prompt_id: "p1" });
    const cards = [comfyCard()];
    const getLiveCards = vi.fn().mockReturnValue(cards);
    const getLiveEdges = vi.fn().mockReturnValue([]);

    const outputs = await executeSceneComfy(
      {
        cardId: "comfy",
        cards,
        edges: [],
        genData: {},
        refParents: {},
        varySeed: false,
        getLiveCards,
        getLiveEdges,
      },
      { run },
    );

    expect(outputs).toEqual([{ kind: "text", text: "ok" }]);
    expect(getLiveCards).toHaveBeenCalledOnce();
    expect(getLiveEdges).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith("workflow", { prompt: "hello" }, []);
  });

  it("연결된 미디어를 모두 받은 뒤 API에 전달한다", async () => {
    const reference = {
      id: "reference",
      kind: "reference",
      x: 0,
      y: 0,
      refs: [{ file_path: "/input.png", name: "input.png" }],
    } as SceneCard;
    const edges: SceneEdge[] = [{ id: "edge", from: "reference", to: "comfy" }];
    const blob = new Blob(["image"]);
    const fetchMedia = vi.fn().mockResolvedValue(blob);
    const run = vi.fn().mockResolvedValue({ outputs: [], prompt_id: "p2" });

    await executeSceneComfy(
      {
        cardId: "comfy",
        cards: [reference, comfyCard()],
        edges,
        genData: {},
        refParents: {},
        varySeed: false,
      },
      { fetchMedia, run },
    );

    expect(fetchMedia).toHaveBeenCalledWith("/input.png", "image1.png");
    expect(run).toHaveBeenCalledWith("workflow", { prompt: "hello" }, [
      { type: "image", name: "image1.png", blob },
    ]);
  });

  it("입력 하나라도 받지 못하면 부분 입력으로 실행하지 않는다", async () => {
    const reference = {
      id: "reference",
      kind: "reference",
      x: 0,
      y: 0,
      refs: [{ file_path: "/missing.png", name: "missing.png" }],
    } as SceneCard;
    const edges: SceneEdge[] = [{ id: "edge", from: "reference", to: "comfy" }];
    const run = vi.fn();

    await expect(
      executeSceneComfy(
        {
          cardId: "comfy",
          cards: [reference, comfyCard()],
          edges,
          genData: {},
          refParents: {},
          varySeed: false,
        },
        { fetchMedia: vi.fn().mockResolvedValue(null), run },
      ),
    ).rejects.toThrow("입력을 불러오지 못했습니다: image1.png");
    expect(run).not.toHaveBeenCalled();
  });

  it("미디어를 받는 동안 실행 설정이 바뀌면 API 호출 전에 중단한다", async () => {
    const reference = {
      id: "reference",
      kind: "reference",
      x: 0,
      y: 0,
      refs: [{ file_path: "/input.png", name: "input.png" }],
    } as SceneCard;
    const edges: SceneEdge[] = [{ id: "edge", from: "reference", to: "comfy" }];
    let current = true;
    const run = vi.fn();

    await expect(
      executeSceneComfy(
        {
          cardId: "comfy",
          cards: [reference, comfyCard()],
          edges,
          genData: {},
          refParents: {},
          varySeed: false,
          isRunCurrent: () => current,
        },
        {
          fetchMedia: vi.fn().mockImplementation(async () => {
            current = false;
            return new Blob(["image"]);
          }),
          run,
        },
      ),
    ).rejects.toBeInstanceOf(SceneComfyRunSupersededError);
    expect(run).not.toHaveBeenCalled();
  });

  it("API 실행 중 설정이 교체되면 완료 결과를 반환하지 않는다", async () => {
    let current = true;
    const run = vi.fn().mockImplementation(async () => {
      current = false;
      return { outputs: [{ kind: "text", text: "old" }], prompt_id: "stale" };
    });

    await expect(
      executeSceneComfy(
        {
          cardId: "comfy",
          cards: [comfyCard()],
          edges: [],
          genData: {},
          refParents: {},
          varySeed: false,
          isRunCurrent: () => current,
        },
        { run },
      ),
    ).rejects.toBeInstanceOf(SceneComfyRunSupersededError);
  });

  it("배치 복사본은 전달된 시드 변환 결과로 실행한다", async () => {
    const run = vi.fn().mockResolvedValue({ outputs: [], prompt_id: "p3" });
    const randomizeContent = vi.fn().mockReturnValue("random-workflow");
    const randomizeParams = vi.fn().mockReturnValue({ prompt: "random" });

    await executeSceneComfy(
      {
        cardId: "comfy",
        cards: [comfyCard()],
        edges: [],
        genData: {},
        refParents: {},
        varySeed: true,
      },
      { run, randomizeContent, randomizeParams },
    );

    expect(randomizeContent).toHaveBeenCalledWith("workflow");
    expect(randomizeParams).toHaveBeenCalledWith({ prompt: "hello" });
    expect(run).toHaveBeenCalledWith("random-workflow", { prompt: "random" }, []);
  });
});
