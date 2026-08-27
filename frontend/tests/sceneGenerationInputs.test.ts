import { describe, expect, it } from "vitest";
import {
  buildSceneGenerationJobInput,
  collectSceneGenerationAssignment,
  captureSceneGenerationInputSnapshot,
  isSceneGenerationInputSnapshotCurrent,
  resolveSceneGenerationModel,
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
  it("Set 노드의 폴더·태그를 생성 요청 정보로 모으되 프롬프트는 바꾸지 않는다", () => {
    const cards = [
      card("G", "generation", { prompt: "원래 프롬프트" }),
      card("M", "model", { modelCfg: { model: "nano" } }),
      card("S1", "set", {
        x: 10,
        y: 10,
        setCfg: {
          folder: { projectId: "project-1", projectName: "테스트", path: "ep001/c0010" },
          tagsText: "hero, night",
        },
      }),
      card("S2", "set", { x: 20, y: 20, setCfg: { tagsText: "Night, final" } }),
    ];
    const edges = [edge("e1", "M", "G"), edge("e2", "S1", "G"), edge("e3", "S2", "G")];
    const resolved = resolvePortEdges(byId(cards), edges);

    expect(collectSceneGenerationAssignment("G", byId(cards), resolved)).toEqual({
      projectId: "project-1",
      folderPath: "ep001/c0010",
      tags: ["hero", "night", "final"],
    });
    expect(buildSceneGenerationJobInput("G", byId(cards), resolved)).toMatchObject({
      text: "원래 프롬프트",
      assignment: {
        projectId: "project-1",
        folderPath: "ep001/c0010",
        tags: ["hero", "night", "final"],
      },
    });
  });

  it("Set 설정 변경은 실행 중 입력 변경으로 판정한다", () => {
    const cards = [
      card("G", "generation", { prompt: "prompt" }),
      card("M", "model", { modelCfg: { model: "nano" } }),
      card("S", "set", { setCfg: { tagsText: "before" } }),
    ];
    const edges = [edge("e1", "M", "G"), edge("e2", "S", "G")];
    const snapshot = captureSceneGenerationInputSnapshot(["G"], [], byId(cards), edges);
    const changed = cards.map((item) =>
      item.id === "S" ? { ...item, setCfg: { tagsText: "after" } } : item,
    );
    expect(isSceneGenerationInputSnapshotCurrent(snapshot, byId(changed), edges)).toBe(false);
  });

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

describe("sceneGenerationInputs — 모델 노드 없는 카드의 하단 프롬프트 모델 폴백", () => {
  const fallback = {
    type: "image",
    model: "spot-model",
    modelName: "Spot",
    params: { ratio: "16:9" },
  };

  it("모델 노드가 없으면 폴백 모델·옵션으로 job 을 만들고 텍스트·refs 는 카드 것을 쓴다", () => {
    const cards = [
      card("G", "generation", {
        prompt: "draft",
        refs: [{ file_path: "/r.png", type: "image", name: "r" }],
      }),
    ];
    const resolved = resolvePortEdges(byId(cards), []);
    const job = buildSceneGenerationJobInput("G", byId(cards), resolved, undefined, fallback);
    expect(job).toMatchObject({
      cardId: "G",
      model: "spot-model",
      modelName: "Spot",
      modelSource: "fallback",
      params: { ratio: "16:9" },
      text: "draft",
    });
    expect(job?.refs.map((ref) => ref.file_path)).toEqual(["/r.png"]);
    expect(job?.params).not.toBe(fallback.params); // 복사본 — 하단 옵션 객체를 건드리지 않는다
    expect(resolveSceneGenerationModel("G", byId(cards), resolved, fallback)).toMatchObject({
      model: "spot-model",
      source: "fallback",
    });
  });

  it("폴백이 없거나 비어 있으면 지금처럼 null(건너뜀)", () => {
    const cards = [card("G", "generation", { prompt: "draft" })];
    const resolved = resolvePortEdges(byId(cards), []);
    expect(buildSceneGenerationJobInput("G", byId(cards), resolved)).toBeNull();
    expect(buildSceneGenerationJobInput("G", byId(cards), resolved, undefined, null)).toBeNull();
    expect(
      buildSceneGenerationJobInput("G", byId(cards), resolved, undefined, { model: "" }),
    ).toBeNull();
  });

  it("모델 노드가 1개면 폴백보다 노드 모델·파라미터가 우선", () => {
    const cards = [
      card("G", "generation", { prompt: "draft" }),
      card("M", "model", {
        modelCfg: { model: "nano", modelName: "Nano", params: { quality: "high" } },
      }),
    ];
    const resolved = resolvePortEdges(byId(cards), [edge("e1", "M", "G")]);
    expect(
      buildSceneGenerationJobInput("G", byId(cards), resolved, undefined, fallback),
    ).toMatchObject({
      model: "nano",
      modelName: "Nano",
      modelSource: "node",
      params: { quality: "high" },
    });
  });

  it("모델 노드가 2개(모호)이거나 1개인데 모델 미설정이면 폴백하지 않고 null", () => {
    const two = [
      card("G", "generation", { prompt: "draft" }),
      card("M1", "model", { modelCfg: { model: "nano" } }),
      card("M2", "model", { modelCfg: { model: "flux" } }),
    ];
    const twoResolved = resolvePortEdges(byId(two), [
      edge("e1", "M1", "G"),
      edge("e2", "M2", "G"),
    ]);
    expect(
      buildSceneGenerationJobInput("G", byId(two), twoResolved, undefined, fallback),
    ).toBeNull();

    const unset = [card("G", "generation", { prompt: "draft" }), card("M", "model")];
    const unsetResolved = resolvePortEdges(byId(unset), [edge("e1", "M", "G")]);
    expect(
      buildSceneGenerationJobInput("G", byId(unset), unsetResolved, undefined, fallback),
    ).toBeNull();
    const emptyCfg = unset.map((item) => (item.id === "M" ? { ...item, modelCfg: {} } : item));
    expect(
      buildSceneGenerationJobInput("G", byId(emptyCfg), unsetResolved, undefined, fallback),
    ).toBeNull();
  });

  it("지문: 모델 노드 없는 카드도 프롬프트·ref·Set·연결 텍스트 변경을 감지하고 위치 이동은 무시한다", () => {
    const cards = [
      card("G", "generation", {
        prompt: "before",
        refs: [{ file_path: "/ref.png", type: "image", name: "ref" }],
      }),
      card("S", "set", { setCfg: { tagsText: "before" } }),
    ];
    const edges = [edge("e1", "S", "G")];
    const snapshot = captureSceneGenerationInputSnapshot(["G"], [], byId(cards), edges);
    const promptChanged = cards.map((item) =>
      item.id === "G" ? { ...item, prompt: "after" } : item,
    );
    const refChanged = cards.map((item) =>
      item.id === "G" ? { ...item, refs: [{ ...item.refs![0], file_path: "/other.png" }] } : item,
    );
    const setChanged = cards.map((item) =>
      item.id === "S" ? { ...item, setCfg: { tagsText: "after" } } : item,
    );
    const moved = cards.map((item) => ({ ...item, x: item.x + 100 }));
    expect(isSceneGenerationInputSnapshotCurrent(snapshot, byId(cards), edges)).toBe(true);
    expect(isSceneGenerationInputSnapshotCurrent(snapshot, byId(promptChanged), edges)).toBe(false);
    expect(isSceneGenerationInputSnapshotCurrent(snapshot, byId(refChanged), edges)).toBe(false);
    expect(isSceneGenerationInputSnapshotCurrent(snapshot, byId(setChanged), edges)).toBe(false);
    expect(isSceneGenerationInputSnapshotCurrent(snapshot, byId(moved), edges)).toBe(true);

    const withText = [card("G", "generation"), card("T", "text", { text: "before" })];
    const textEdges = [edge("e1", "T", "G")];
    const textSnapshot = captureSceneGenerationInputSnapshot(["G"], [], byId(withText), textEdges);
    const textChanged = withText.map((item) =>
      item.id === "T" ? { ...item, text: "after" } : item,
    );
    expect(isSceneGenerationInputSnapshotCurrent(textSnapshot, byId(textChanged), textEdges)).toBe(
      false,
    );
  });

  it("지문: 모델 노드 추가·제거·미설정·복수 전환을 감지한다", () => {
    const alone = [card("G", "generation", { prompt: "p" })];
    const aloneSnapshot = captureSceneGenerationInputSnapshot(["G"], [], byId(alone), []);
    const added = [...alone, card("M", "model", { modelCfg: { model: "nano" } })];
    expect(
      isSceneGenerationInputSnapshotCurrent(aloneSnapshot, byId(added), [edge("e1", "M", "G")]),
    ).toBe(false);

    const linked = [
      card("G", "generation", { prompt: "p" }),
      card("M", "model", { modelCfg: { model: "nano" } }),
    ];
    const linkedEdges = [edge("e1", "M", "G")];
    const linkedSnapshot = captureSceneGenerationInputSnapshot(["G"], [], byId(linked), linkedEdges);
    expect(isSceneGenerationInputSnapshotCurrent(linkedSnapshot, byId(linked), [])).toBe(false);
    const unset = linked.map((item) => (item.id === "M" ? { ...item, modelCfg: {} } : item));
    expect(isSceneGenerationInputSnapshotCurrent(linkedSnapshot, byId(unset), linkedEdges)).toBe(
      false,
    );
    const doubled = [...linked, card("M2", "model", { modelCfg: { model: "flux" } })];
    expect(
      isSceneGenerationInputSnapshotCurrent(linkedSnapshot, byId(doubled), [
        ...linkedEdges,
        edge("e2", "M2", "G"),
      ]),
    ).toBe(false);
  });
});
