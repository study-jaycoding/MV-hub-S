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

    const execution = await executeSceneComfy(
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

    expect(execution).toMatchObject({
      outputs: [{ kind: "text", text: "ok" }],
      superseded: false,
      inputSnapshot: {
        drivenParamValues: { prompt: "hello" },
        executedParamValues: { prompt: "hello" },
      },
    });
    expect(getLiveCards).toHaveBeenCalledTimes(2); // API 직전 + 완료 후 입력 지문 재검사
    expect(getLiveEdges).toHaveBeenCalledTimes(2);
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

  it("미디어를 받는 동안 연결이 바뀌면 받은 파일로 API를 실행하지 않는다", async () => {
    const reference = {
      id: "reference",
      kind: "reference",
      x: 0,
      y: 0,
      refs: [{ file_path: "/input.png", type: "image", name: "input.png" }],
    } as SceneCard;
    const edges: SceneEdge[] = [{ id: "edge", from: "reference", to: "comfy", role: "ref" }];
    let liveEdges = edges;
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
          getLiveEdges: () => liveEdges,
        },
        {
          fetchMedia: vi.fn().mockImplementation(async () => {
            liveEdges = [];
            return new Blob(["image"]);
          }),
          run,
        },
      ),
    ).rejects.toBeInstanceOf(SceneComfyRunSupersededError);
    expect(run).not.toHaveBeenCalled();
  });

  it("API 실행 중 설정이 교체되어도 완료 결과와 실행 입력을 superseded로 반환한다", async () => {
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
    ).resolves.toMatchObject({
      outputs: [{ kind: "text", text: "old" }],
      superseded: true,
      inputSnapshot: {
        executedParamValues: { prompt: "hello" },
      },
    });
  });

  it("API 실행 중 연결 텍스트가 바뀌면 성공 결과를 superseded로 반환한다", async () => {
    const target = comfyCard({
      comfyCfg: {
        content: "workflow",
        paramValues: { "1|prompt": "manual" },
        params: [{ key: "1|prompt", label: "Prompt", type: "text" }],
      },
    });
    let liveCards = [
      { id: "text", kind: "text", x: 0, y: 0, text: "old" } as SceneCard,
      target,
    ];
    const edges: SceneEdge[] = [{ id: "text-edge", from: "text", to: "comfy", role: "text" }];
    const run = vi.fn().mockImplementation(async () => {
      liveCards = [{ ...liveCards[0], text: "new" }, target];
      return { outputs: [{ kind: "text", text: "old result" }], prompt_id: "stale-text" };
    });

    await expect(
      executeSceneComfy(
        {
          cardId: "comfy",
          cards: liveCards,
          edges,
          genData: {},
          refParents: {},
          varySeed: false,
          getLiveCards: () => liveCards,
        },
        { run },
      ),
    ).resolves.toMatchObject({
      outputs: [{ kind: "text", text: "old result" }],
      superseded: true,
      inputSnapshot: { executedParamValues: { "1|prompt": "old" } },
    });
    expect(run).toHaveBeenCalledWith("workflow", { "1|prompt": "old" }, []);
  });

  it("상류 pending 생성물의 URL만 실행 중 해소되어도 superseded로 처리하지 않는다", async () => {
    const source = {
      id: "generation",
      kind: "generation",
      x: 0,
      y: 0,
      genId: "pending-generation",
      genIds: ["pending-generation"],
    } as SceneCard;
    const cards = [source, comfyCard()];
    const edges: SceneEdge[] = [{ id: "edge", from: "generation", to: "comfy", role: "ref" }];
    let liveGenData = {};
    const run = vi.fn().mockImplementation(async () => {
      liveGenData = {
        "pending-generation": {
          id: "pending-generation",
          assets: [{ type: "image", file_path: "/resolved.png", source_url: "/resolved.png" }],
        },
      };
      return { outputs: [{ kind: "text", text: "ok" }], prompt_id: "resolved" };
    });

    const execution = await executeSceneComfy(
      {
        cardId: "comfy",
        cards,
        edges,
        genData: liveGenData,
        refParents: {},
        varySeed: false,
        getLiveGenData: () => liveGenData,
      },
      { run },
    );

    expect(execution.superseded).toBe(false);
    expect(execution.outputs).toEqual([{ kind: "text", text: "ok" }]);
    expect(execution.inputSnapshot.media).toEqual([]); // 실제 API 호출 당시에는 아직 pending 이었다.
  });

  it("API 실행 중 입력 엣지가 바뀌면 결과를 superseded로 반환해 카드 연결을 막는다", async () => {
    const reference = {
      id: "reference",
      kind: "reference",
      x: 0,
      y: 0,
      refs: [{ file_path: "/input.png", type: "image", name: "input.png" }],
    } as SceneCard;
    let liveEdges: SceneEdge[] = [{ id: "edge", from: "reference", to: "comfy", role: "ref" }];
    const run = vi.fn().mockImplementation(async () => {
      liveEdges = [];
      return { outputs: [{ kind: "image", url: "/old.png" }], prompt_id: "old-edge" };
    });

    const execution = await executeSceneComfy(
      {
        cardId: "comfy",
        cards: [reference, comfyCard()],
        edges: liveEdges,
        genData: {},
        refParents: {},
        varySeed: false,
        getLiveEdges: () => liveEdges,
      },
      { fetchMedia: vi.fn().mockResolvedValue(new Blob(["image"])), run },
    );

    expect(execution).toMatchObject({
      outputs: [{ kind: "image", url: "/old.png" }],
      superseded: true,
    });
  });

  it("API 실패 중 연결 입력이 바뀌면 옛 실패 대신 교체 오류로 처리한다", async () => {
    const target = comfyCard({
      comfyCfg: {
        content: "workflow",
        paramValues: { "1|prompt": "manual" },
        params: [{ key: "1|prompt", label: "Prompt", type: "text" }],
      },
    });
    let liveCards = [
      { id: "text", kind: "text", x: 0, y: 0, text: "old" } as SceneCard,
      target,
    ];
    const edges: SceneEdge[] = [{ id: "text-edge", from: "text", to: "comfy", role: "text" }];
    const run = vi.fn().mockImplementation(async () => {
      liveCards = [{ ...liveCards[0], text: "new" }, target];
      throw new Error("old run failed");
    });

    await expect(
      executeSceneComfy(
        {
          cardId: "comfy",
          cards: liveCards,
          edges,
          genData: {},
          refParents: {},
          varySeed: false,
          getLiveCards: () => liveCards,
        },
        { run },
      ),
    ).rejects.toBeInstanceOf(SceneComfyRunSupersededError);
  });

  it("배치 복사본은 전달된 시드 변환 결과로 실행한다", async () => {
    const run = vi.fn().mockResolvedValue({ outputs: [], prompt_id: "p3" });
    const randomizeContent = vi.fn().mockReturnValue("random-workflow");
    const randomizeParams = vi.fn().mockReturnValue({ prompt: "random" });
    let prepared: { executedParamValues: Record<string, string | number | boolean> } | undefined;

    await executeSceneComfy(
      {
        cardId: "comfy",
        cards: [comfyCard()],
        edges: [],
        genData: {},
        refParents: {},
        varySeed: true,
        onRunPrepared: (snapshot) => {
          prepared = snapshot;
        },
      },
      { run, randomizeContent, randomizeParams },
    );

    expect(randomizeContent).toHaveBeenCalledWith("workflow");
    expect(randomizeParams).toHaveBeenCalledWith({ prompt: "hello" });
    expect(run).toHaveBeenCalledWith("random-workflow", { prompt: "random" }, []);
    expect(prepared?.executedParamValues).toEqual({ prompt: "random" });
  });
});
