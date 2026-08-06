import { describe, expect, it, vi } from "vitest";
import {
  doneOutputsPatch,
  patchOwnedComfyRun,
  saveCompletedComfyResults,
  type SaveComfyOptions,
  type SaveComfyResult,
} from "../src/lib/useSceneComfyExecution";
import {
  executeSceneComfy,
  type SceneComfyConfigSnapshot,
  type SceneComfyRunInputSnapshot,
} from "../src/lib/sceneComfyExecutor";
import type { SceneCard } from "../src/lib/scenes";

const config: SceneComfyConfigSnapshot = {
  name: "시작 시 워크플로우",
  content: "workflow-at-start",
  paramValues: { prompt: "start" },
  params: [{ key: "prompt", label: "Prompt", type: "text" }],
};

const input = (id: string): SceneComfyRunInputSnapshot => ({
  media: [],
  drivenParamValues: { prompt: id },
  textParamKeys: ["prompt"],
  inputFingerprint: `input:${id}`,
  executedParamValues: { prompt: id },
});

const completed = (
  cardId: string,
  snapshot: SceneComfyRunInputSnapshot,
  isInputCurrent: () => boolean,
): {
  cardId: string;
  outputCount: number;
  options: SaveComfyOptions;
} => ({
  cardId,
  outputCount: 1,
  options: {
    silent: true,
    outputs: [{ kind: "image", url: `/${snapshot.executedParamValues.prompt}.png` }],
    configSnapshot: config,
    inputSnapshot: snapshot,
    isInputCurrent,
  },
});

describe("Comfy 결과 보존 정산", () => {
  it("입력이 실행 뒤 바뀌어도 저장하고, 현재 카드 연결 가드는 false로 남긴다", async () => {
    let liveCards = [
      {
        id: "comfy",
        kind: "comfy",
        x: 0,
        y: 0,
        comfyCfg: { content: "workflow-at-start", paramValues: { prompt: "old" } },
      },
    ] as SceneCard[];
    const execution = await executeSceneComfy(
      {
        cardId: "comfy",
        cards: liveCards,
        edges: [],
        genData: {},
        refParents: {},
        varySeed: false,
        getLiveCards: () => liveCards,
      },
      {
        run: vi.fn().mockImplementation(async () => {
          liveCards = [
            {
              ...liveCards[0],
              comfyCfg: { content: "workflow-after-edit", paramValues: { prompt: "new" } },
            },
          ];
          return { outputs: [{ kind: "image", url: "/old.png" }], prompt_id: "old" };
        }),
      },
    );
    const save = vi.fn(async (_cardId: string, opts?: SaveComfyOptions): Promise<SaveComfyResult> => {
      expect(opts?.inputSnapshot).toBe(execution.inputSnapshot);
      expect(opts?.isInputCurrent?.()).toBe(false);
      return { saved: 1, failed: 0 };
    });

    const result = await saveCompletedComfyResults(
      [completed("comfy", execution.inputSnapshot, () => !execution.superseded)],
      save,
    );

    expect(execution.superseded).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ saved: 1, failed: 0 });
  });

  it("실행 중 씬을 전환해도 저장은 한 번 수행하고 어느 씬 카드도 연결하지 않는다", async () => {
    const firstScene = [{ id: "comfy", kind: "comfy", x: 0, y: 0, comfyCfg: { outputs: [] } }] as SceneCard[];
    const secondScene = [{ id: "comfy", kind: "comfy", x: 0, y: 0, comfyCfg: { outputs: [] } }] as SceneCard[];
    const save = vi.fn(async (_cardId: string, opts?: SaveComfyOptions): Promise<SaveComfyResult> => {
      // SceneBoard의 POST-save 연결 조건과 같은 의미: 현재성 false면 어떤 카드도 갱신하지 않는다.
      if (opts?.isInputCurrent?.()) firstScene[0].comfyCfg!.outputs = opts.outputs;
      if (opts?.isInputCurrent?.()) secondScene[0].comfyCfg!.outputs = opts.outputs;
      return { saved: 1, failed: 0 };
    });

    await saveCompletedComfyResults([completed("comfy", input("scene-a"), () => false)], save);

    expect(save).toHaveBeenCalledTimes(1);
    expect(firstScene[0].comfyCfg?.outputs).toEqual([]);
    expect(secondScene[0].comfyCfg?.outputs).toEqual([]);
  });

  it("중단된 배치도 이미 원격 완료된 각 결과를 자기 입력 스냅샷으로 저장하며 한 건 실패해도 계속한다", async () => {
    const first = input("copy-1");
    const second = input("copy-2");
    const third = input("copy-3");
    const seen: SceneComfyRunInputSnapshot[] = [];
    const save = vi.fn(async (_cardId: string, opts?: SaveComfyOptions): Promise<SaveComfyResult> => {
      seen.push(opts!.inputSnapshot!);
      if (opts?.inputSnapshot === second) throw new Error("save failed");
      return { saved: 1, failed: 0 };
    });

    const result = await saveCompletedComfyResults(
      [
        completed("comfy", first, () => false),
        completed("comfy", second, () => false),
        completed("comfy", third, () => false),
      ],
      save,
    );

    expect(seen).toEqual([first, second, third]);
    expect(result).toEqual({ saved: 2, failed: 1 });
  });

  it("이전 runId는 새 실행의 running·failed·done 상태를 바꾸지 못한다", () => {
    const cards = [
      {
        id: "comfy",
        kind: "comfy",
        x: 0,
        y: 0,
        comfyCfg: { runId: 2, status: "running", error: null },
      },
    ] as SceneCard[];

    const staleIdle = patchOwnedComfyRun(cards, "comfy", 1, { status: "idle" });
    const staleFailed = patchOwnedComfyRun(cards, "comfy", 1, { status: "failed", error: "old" });
    const staleDone = patchOwnedComfyRun(cards, "comfy", 1, { status: "done" });
    const currentDone = patchOwnedComfyRun(cards, "comfy", 2, { status: "done", error: null });

    expect(staleIdle).toBe(cards);
    expect(staleFailed).toBe(cards);
    expect(staleDone).toBe(cards);
    expect(currentDone[0].comfyCfg).toMatchObject({ runId: 2, status: "done", error: null });
  });
});


describe("doneOutputsPatch — 저장 실패 시에도 결과가 카드에서 사라지지 않는다", () => {
  const media = [{ kind: "image" as const, url: "/run.png" }];

  it("저장 attach 가 이미 카드 outputs 를 갱신했으면 덮어쓰지 않는다(마킹 보존)", () => {
    const current = [{ kind: "image" as const, url: "/run.png", saved_generation_id: "g1" }];
    expect(doneOutputsPatch(current, media)).toEqual({});
  });

  it("저장 API 실패로 attach 가 안 됐으면 실행 결과를 done 패치에 포함한다", () => {
    const current = [{ kind: "image" as const, url: "/old.png" }];
    expect(doneOutputsPatch(current, media)).toEqual({ outputs: media, output: null });
  });

  it("URL 일부만 겹치면(다중 출력 부분 attach) 전체 결과를 패치해 새 출력 누락을 막는다", () => {
    const multi = [
      { kind: "image" as const, url: "/run.png" },
      { kind: "video" as const, url: "/run.mp4" },
    ];
    const current = [{ kind: "image" as const, url: "/run.png", saved_generation_id: "g1" }];
    expect(doneOutputsPatch(current, multi)).toEqual({ outputs: multi, output: null });
  });

  it("텍스트 전용 출력은 attach 대상이 아니므로 항상 패치한다", () => {
    const textOnly = [{ kind: "text" as const, text: "hello" }];
    expect(doneOutputsPatch([], textOnly)).toEqual({ outputs: textOnly, output: null });
  });
});
