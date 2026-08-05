import { describe, expect, it } from "vitest";
import {
  buildSceneGenerationJobInput,
  captureSceneGenerationInputSnapshot,
  isSceneGenerationInputSnapshotCurrent,
} from "../src/lib/sceneGenerationInputs";
import { resolvePortEdges } from "../src/lib/sceneEdges";
import type { SceneCard, SceneEdge } from "../src/lib/scenes";

const card = (
  id: string,
  kind: SceneCard["kind"],
  over: Partial<SceneCard> = {},
): SceneCard => ({ id, kind, x: 0, y: 0, ...over });
const byId = (cards: SceneCard[]) => new Map(cards.map((item) => [item.id, item] as const));
const edge = (id: string, from: string, to: string, order?: number): SceneEdge => ({
  id,
  from,
  to,
  order,
});
const saveImageWorkflow = JSON.stringify({ "1": { class_type: "SaveImage" } });
const saveTextWorkflow = JSON.stringify({ "1": { class_type: "SaveText" } });

describe("sceneGenerationInputs", () => {
  it("App과 실행 가드가 공유하는 모델·텍스트·레퍼런스 요청 재료를 조립한다", () => {
    const cards = [
      card("G", "generation", {
        prompt: "fallback prompt",
        refs: [{ file_path: "/manual.png", type: "image", name: "manual" }],
      }),
      card("M", "model", { modelCfg: { model: "nano", params: { quality: "high" } } }),
      card("C", "comfy", { comfyCfg: { content: saveImageWorkflow, name: "workflow" } }),
    ];
    const edges = [edge("e1", "M", "G"), edge("e2", "C", "G")];
    const job = buildSceneGenerationJobInput(
      "G",
      byId(cards),
      resolvePortEdges(byId(cards), edges),
      { C: [{ kind: "image", url: "/dynamic.png" }] },
    );

    expect(job).toMatchObject({
      cardId: "G",
      model: "nano",
      params: { quality: "high" },
      text: "fallback prompt",
    });
    expect(job?.refs.map((ref) => ref.file_path)).toEqual(["/manual.png", "/dynamic.png"]);
  });

  it("Comfy 런타임 출력·상태와 전체 위치 이동은 입력 변경으로 보지 않는다", () => {
    const cards = [
      card("G", "generation", {
        prompt: "prompt",
        refs: [
          {
            file_path: "/old-comfy.png",
            type: "image",
            source_gen_id: "saved-old",
            from_card: true,
          },
        ],
      }),
      card("M", "model", { modelCfg: { model: "nano" } }),
      card("C", "comfy", {
        genId: "saved-old",
        genIds: ["saved-old"],
        comfyCfg: {
          content: "{}", // 커스텀 출력 노드처럼 선언 종류를 알 수 없는 워크플로
          status: "idle",
          outputs: [{ kind: "text", text: "old runtime" }],
        },
      }),
    ];
    const edges = [edge("e1", "M", "G"), edge("e2", "C", "G")];
    const snapshot = captureSceneGenerationInputSnapshot(["G"], ["C"], byId(cards), edges);
    const runtimeChanged = cards.map((item) => ({
      ...item,
      x: item.x + 500,
      y: item.y + 300,
      comfyCfg:
        item.id === "C"
          ? { ...item.comfyCfg, status: "done" as const, outputs: [{ kind: "text" as const, text: "new runtime" }] }
          : item.comfyCfg,
      genId: item.id === "C" ? "saved-new" : item.genId,
      genIds: item.id === "C" ? ["saved-old", "saved-new"] : item.genIds,
      refs:
        item.id === "G"
          ? [
              {
                file_path: "/new-comfy.png",
                type: "image",
                source_gen_id: "saved-new",
                from_card: true,
              },
            ]
          : item.refs,
    }));

    expect(
      isSceneGenerationInputSnapshotCurrent(snapshot, byId(runtimeChanged), edges),
    ).toBe(true);
  });

  it("생성카드 프롬프트 또는 모델 파라미터가 바뀌면 이전 입력을 폐기한다", () => {
    const cards = [
      card("G", "generation", { prompt: "before" }),
      card("M", "model", { modelCfg: { model: "nano", params: { quality: "high" } } }),
      card("C", "comfy", { comfyCfg: { content: saveImageWorkflow } }),
    ];
    const edges = [edge("e1", "M", "G"), edge("e2", "C", "G")];
    const snapshot = captureSceneGenerationInputSnapshot(["G"], ["C"], byId(cards), edges);
    const promptChanged = cards.map((item) =>
      item.id === "G" ? { ...item, prompt: "after" } : item,
    );
    const paramsChanged = cards.map((item) =>
      item.id === "M"
        ? { ...item, modelCfg: { ...item.modelCfg, params: { quality: "low" } } }
        : item,
    );

    expect(isSceneGenerationInputSnapshotCurrent(snapshot, byId(promptChanged), edges)).toBe(false);
    expect(isSceneGenerationInputSnapshotCurrent(snapshot, byId(paramsChanged), edges)).toBe(false);
  });

  it("연결 텍스트와 수동 레퍼런스가 바뀌면 이전 입력을 폐기하되 thumb 갱신은 허용한다", () => {
    const cards = [
      card("G", "generation", {
        refs: [{ file_path: "/ref.png", type: "image", name: "ref", thumb: "/thumb-v1" }],
      }),
      card("M", "model", { modelCfg: { model: "nano" } }),
      card("T", "text", { text: "before" }),
      card("C", "comfy", { comfyCfg: { content: saveTextWorkflow } }),
    ];
    const edges = [
      edge("e1", "M", "G"),
      edge("e2", "T", "G"),
      edge("e3", "C", "T"),
    ];
    const snapshot = captureSceneGenerationInputSnapshot(["G"], ["C"], byId(cards), edges);
    const textChanged = cards.map((item) =>
      item.id === "T" ? { ...item, text: "after" } : item,
    );
    const refChanged = cards.map((item) =>
      item.id === "G"
        ? { ...item, refs: [{ ...item.refs![0], file_path: "/other.png" }] }
        : item,
    );
    const thumbChanged = cards.map((item) =>
      item.id === "G"
        ? { ...item, refs: [{ ...item.refs![0], thumb: "/thumb-v2" }] }
        : item,
    );
    const unusedPromptChanged = cards.map((item) =>
      item.id === "G" ? { ...item, prompt: "연결 텍스트가 있어 사용되지 않는 초안" } : item,
    );

    expect(isSceneGenerationInputSnapshotCurrent(snapshot, byId(textChanged), edges)).toBe(false);
    expect(isSceneGenerationInputSnapshotCurrent(snapshot, byId(refChanged), edges)).toBe(false);
    expect(isSceneGenerationInputSnapshotCurrent(snapshot, byId(thumbChanged), edges)).toBe(true);
    expect(
      isSceneGenerationInputSnapshotCurrent(snapshot, byId(unusedPromptChanged), edges),
    ).toBe(true);
  });

  it("동적 Comfy 레퍼런스의 연결 순서가 바뀌면 이전 입력을 폐기한다", () => {
    const cards = [
      card("G", "generation"),
      card("M", "model", { modelCfg: { model: "nano" } }),
      card("C1", "comfy", { comfyCfg: { content: saveImageWorkflow, name: "first" } }),
      card("C2", "comfy", { comfyCfg: { content: saveImageWorkflow, name: "second" } }),
    ];
    const edges = [
      edge("e1", "M", "G"),
      edge("e2", "C1", "G", 0),
      edge("e3", "C2", "G", 1),
    ];
    const snapshot = captureSceneGenerationInputSnapshot(
      ["G"],
      ["C1", "C2"],
      byId(cards),
      edges,
    );
    const reordered = edges.map((item) =>
      item.id === "e2" ? { ...item, order: 1 } : item.id === "e3" ? { ...item, order: 0 } : item,
    );

    expect(
      isSceneGenerationInputSnapshotCurrent(snapshot, byId(cards), reordered),
    ).toBe(false);
  });

  it("List 경유 Comfy 배치 결과는 이전 저장 ref를 현재 overlay로 교체한다", () => {
    const cards = [
      card("G", "generation", {
        refs: [
          {
            file_path: "/old.png",
            type: "image",
            source_gen_id: "saved-old",
            from_card: true,
          },
          {
            file_path: "/unrelated-old.png",
            type: "image",
            source_gen_id: "unrelated-old",
            from_card: true,
          },
        ],
      }),
      card("M", "model", { modelCfg: { model: "nano" } }),
      card("L", "list"),
      card("C", "comfy", {
        genId: "saved-old",
        genIds: ["saved-old"],
        comfyCfg: { content: saveImageWorkflow },
      }),
      card("U", "comfy", {
        genId: "unrelated-old",
        genIds: ["unrelated-old"],
        comfyCfg: { content: saveImageWorkflow },
      }),
    ];
    const edges = [
      edge("e1", "M", "G"),
      edge("e2", "C", "L"),
      edge("e3", "L", "G"),
    ];

    const job = buildSceneGenerationJobInput(
      "G",
      byId(cards),
      resolvePortEdges(byId(cards), edges),
      {
        C: [{ kind: "image", url: "/current.png" }],
        U: [{ kind: "image", url: "/unrelated-current.png" }],
      },
    );

    expect(job?.refs.map((ref) => ref.file_path)).toEqual([
      "/unrelated-old.png",
      "/current.png",
    ]);

    const textOnlyJob = buildSceneGenerationJobInput(
      "G",
      byId(cards),
      resolvePortEdges(byId(cards), edges),
      {
        C: [{ kind: "text", text: "이번 실행에는 미디어 없음" }],
        U: [{ kind: "image", url: "/unrelated-current.png" }],
      },
    );
    expect(textOnlyJob?.refs.map((ref) => ref.file_path)).toEqual(["/unrelated-old.png"]);
  });
});
