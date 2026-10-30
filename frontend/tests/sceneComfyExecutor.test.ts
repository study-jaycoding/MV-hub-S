// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeSceneComfy,
  isSceneComfyConfigCurrent,
  SceneComfyRunSupersededError,
} from "../src/lib/sceneComfyExecutor";
import type { SceneCard, SceneEdge } from "../src/lib/scenes";
import { saveScenes, listPersistedScenes, updateScene, type Scene } from "../src/lib/scenes";
import { createCanvasDocumentPort } from "../src/features/canvas/session";
import { delaySceneStoreWritesForTest, failSceneStoreWritesForTest, settleSceneStoreForTest, writeSceneStoreAsOtherWindowForTest } from "../src/lib/sceneStore";
import { getAccountNamespace, setAccountScope } from "../src/lib/accountScope";
import { setHubFeatures } from "../src/lib/hubFeatures";
import { comfySceneFingerprints } from "../src/lib/sceneComfyInputs";

afterEach(async () => {
  failSceneStoreWritesForTest(false); delaySceneStoreWritesForTest(0); await settleSceneStoreForTest();
  setHubFeatures([]); setAccountScope("");
});

describe("영속 Comfy 제출", () => {
  async function fixture() {
    setHubFeatures(["comfy_canvas_runs_v1"]);
    const scene: Scene = { id: "s", name: "s", cards: [comfyCard()], edges: [], created_at: 1 };
    saveScenes(null, [scene]); await settleSceneStoreForTest();
    const document = createCanvasDocumentPort({ flushPending: () => {} });
    const run = vi.fn(async () => ({ outputs: [], prompt_id: "p" }));
    const origin = vi.fn(async () => ({ hub_id: "h", device_id: "d" }));
    const options = { cardId: "comfy", cards: scene.cards, edges: [], genData: {}, refParents: {}, varySeed: false,
      canvas: { sceneId: "s", runGroupId: crypto.randomUUID(), copyIndex: 0, document } };
    return { scene, document, run, origin, options };
  }
  it("콜백과 예약 저장이 확정되기 전에는 /run을 보내지 않는다", async () => {
    const f = await fixture();
    let release!: () => void;
    const onRunPrepared = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = executeSceneComfy({ ...f.options, onRunPrepared }, { run: f.run, origin: f.origin });
    expect(f.run).not.toHaveBeenCalled(); expect(f.origin).not.toHaveBeenCalled();
    delaySceneStoreWritesForTest(40); release();
    await vi.waitFor(() => expect(f.origin).toHaveBeenCalledOnce());
    expect(f.run).not.toHaveBeenCalled();
    const result = await pending;
    expect(result.serverManaged).toBe(true);
    const submitted = f.run.mock.calls[0] as unknown as Parameters<typeof import("../src/lib/comfyApi").comfyApi.run>;
    const mark = listPersistedScenes(null)[0].comfyRuns![0];
    expect(mark.localState).toBe("submitted");
    expect(submitted[4]?.canvas_run).toMatchObject({ attempt_id: mark.attemptId, run_group_id: mark.runGroupId,
      group_seq: mark.groupSeq, copy_index: 0, scene_id: "s", card_id: "comfy", config_fp: mark.configFp, input_fp: mark.inputFp });
  });
  it.each(["input", "account", "window"])("콜백 대기 중 %s 변경은 예약·제출을 막는다", async changed => {
    const f = await fixture(); let current = true; let release!: () => void;
    const pending = executeSceneComfy({ ...f.options, isRunCurrent: () => current,
      onRunPrepared: () => new Promise<void>(resolve => { release = resolve; }) }, { run: f.run, origin: f.origin });
    const rejected = expect(pending).rejects.toBeInstanceOf(SceneComfyRunSupersededError);
    if (changed === "input") f.scene.cards[0].comfyCfg!.paramValues = { prompt: "edited" };
    else if (changed === "account") setAccountScope("different");
    else current = false;
    release(); await rejected;
    expect(f.run).not.toHaveBeenCalled(); expect(f.origin).not.toHaveBeenCalled();
  });
  it("예약 연산은 큐에 들어갔지만 다른 창이 이겼으면 /run은 없다", async () => {
    const f = await fixture(); delaySceneStoreWritesForTest(30);
    const pending = executeSceneComfy(f.options, { run: f.run, origin: f.origin });
    const rejected = expect(pending).rejects.toMatchObject({ status: "conflict" });
    await vi.waitFor(() => expect(f.origin).toHaveBeenCalled());
    writeSceneStoreAsOtherWindowForTest(all => {
      all[`${getAccountNamespace()}::_none`] = [{ ...f.scene,
        comfyRuns: [{ version: 1, attemptId: "other", runGroupId: "other", groupSeq: 1, copyIndex: 0, cardId: "comfy",
          originHubId: "h", originDeviceId: "d", localState: "submitted", ...comfySceneFingerprints(f.scene, "comfy")! }],
        comfyCardRuns: { comfy: { groupId: "other", groupSeq: 1 } } }];
    });
    await rejected; expect(f.run).not.toHaveBeenCalled();
  });
  it.each(["storage_failed", "missing-owner"])("%s이면 성공 모양의 예약에도 제출하지 않는다", async reason => {
    const f = await fixture();
    if (reason === "storage_failed") failSceneStoreWritesForTest(true);
    else {
      const read = f.document.snapshot;
      f.document.snapshot = (target, persisted) => persisted ? { ...f.scene, comfyRuns: [] } : read(target, persisted);
    }
    await expect(executeSceneComfy(f.options, { run: f.run, origin: f.origin })).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
  });
  it("옛 허브에서는 원본 조회·예약 없이 예전 /run 인자를 유지한다", async () => {
    const f = await fixture(); setHubFeatures([]);
    const reserve = vi.spyOn(f.document, "reserveComfyAttempt");
    await executeSceneComfy({ ...f.options, canvas: undefined }, { run: f.run, origin: f.origin });
    expect(reserve).not.toHaveBeenCalled(); expect(f.origin).not.toHaveBeenCalled();
    expect(f.run).toHaveBeenCalledExactlyOnceWith("workflow", { prompt: "hello" }, []);
  });
  it("예약 후 확정 문서의 입력이 바뀌면 attempt가 남아 있어도 제출하지 않는다", async () => {
    const f = await fixture();
    const reserve = f.document.reserveComfyAttempt;
    f.document.reserveComfyAttempt = async (...args) => {
      const reserved = await reserve(...args);
      updateScene(null, "s", { cards: [comfyCard({ comfyCfg: { content: "changed" } })] });
      await settleSceneStoreForTest();
      return reserved;
    };
    await expect(executeSceneComfy(f.options, { run: f.run, origin: f.origin })).rejects.toBeInstanceOf(SceneComfyRunSupersededError);
    expect(f.run).not.toHaveBeenCalled();
  });
});

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
      { type: "image", name: "image1.png", blob, source_url: "/input.png", source_gen_id: undefined, role: "@Image1" },
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
