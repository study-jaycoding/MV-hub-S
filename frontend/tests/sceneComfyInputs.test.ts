// sceneComfyInputs 순수 이동 계약 — 세부 그래프 로직은 sceneEdges.test 가 커버, 여기선 경계·위임 계약만.
import { describe, it, expect } from "vitest";
import {
  driveTextParams,
  gatherComfyMedia,
  hasTextConnection,
  prepareSceneComfyInputs,
  samePreparedSceneComfyInputs,
  comfySceneFingerprints,
} from "../src/lib/sceneComfyInputs";
import type { SceneCard, Scene } from "../src/lib/scenes";
import type { Generation } from "../src/types";

it("문서 입력 지문은 seed·연결 텍스트·상류 묶음을 구분하고 자기 묶음과 같은 묶음 copy 출력은 제외한다", () => {
  const scene: Scene = { id: "s", name: "s", created_at: 1, cards: [
    { id: "c", kind: "comfy", x: 0, y: 0, comfyCfg: { content: "{}", paramValues: { seed: 1, "1|text": "manual" },
      params: [{ key: "1|text", type: "text", label: "Text" }] } },
    { id: "up", kind: "comfy", x: 0, y: 0, comfyCfg: { content: "{}", outputs: [{ kind: "text", text: "copy0" }] } },
    { id: "t", kind: "text", x: 0, y: 0, text: "prompt" },
  ], edges: [{ from: "up", to: "c", role: "text" }, { from: "t", to: "c", role: "text" }],
    comfyCardRuns: { c: { groupId: "self", groupSeq: 1 }, up: { groupId: "up1", groupSeq: 1 } } };
  const first = comfySceneFingerprints(scene, "c")!;
  scene.comfyCardRuns!.c = { groupId: "self2", groupSeq: 2 };
  scene.cards[1].comfyCfg!.outputs = [{ kind: "text", text: "copy2" }];
  expect(comfySceneFingerprints(scene, "c")).toEqual(first);
  scene.cards[0].comfyCfg!.paramValues!.seed = 2;
  expect(comfySceneFingerprints(scene, "c")!.inputFp).not.toBe(first.inputFp);
  scene.cards[0].comfyCfg!.paramValues!.seed = 1;
  scene.cards[2].text = "changed";
  expect(comfySceneFingerprints(scene, "c")!.inputFp).not.toBe(first.inputFp);
  scene.cards[2].text = "prompt";
  scene.comfyCardRuns!.up.groupId = "up2";
  expect(comfySceneFingerprints(scene, "c")!.inputFp).not.toBe(first.inputFp);
});

it("복구된 상류의 generation 참조를 입력 미디어로 읽고 copy overlay에는 섞지 않는다", () => {
  const up = { id: "up", kind: "comfy", x: 0, y: 0, comfyCfg: { outputs: [{ kind: "image", saved_generation_id: "saved" }] } } as SceneCard;
  const target = { id: "c", kind: "comfy", x: 1, y: 0 } as SceneCard;
  const gens = { saved: { assets: [{ type: "image", file_path: "/media/saved.png" }] } as Generation };
  const edges = [{ from: "up", to: "c" }];
  expect(gatherComfyMedia("c", [up, target], edges, gens)).toMatchObject([{ source_gen_id: "saved", url: "/media/saved.png" }]);
  expect(gatherComfyMedia("c", [up, target], edges, gens, {})).toEqual([]);
});

it("앞 노드의 실행 결과(서버 run_status 의 {kind,url})가 뒤 노드 입력이 된다 — 영수증 모양이면 입력이 비었다(최종 검토 C-05)", () => {
  const up = { id: "up", kind: "comfy", x: 0, y: 0 } as SceneCard;
  const target = { id: "c", kind: "comfy", x: 1, y: 0 } as SceneCard;
  const edges = [{ from: "up", to: "c" }];
  const media = gatherComfyMedia("c", [up, target], edges, {}, { up: [{ kind: "image", url: "/media/comfy/a.png" }, { kind: "text", text: "글" }] });
  expect(media).toMatchObject([{ type: "image", url: "/media/comfy/a.png" }]);
});

const comfy = (id: string, o: Partial<SceneCard> = {}): SceneCard => ({ id, kind: "comfy", x: 0, y: 0, ...o }) as SceneCard;

describe("sceneComfyInputs", () => {
  it("입력 엣지가 없으면 수집 미디어 없음", () => {
    expect(gatherComfyMedia("c", [comfy("c")], [], {})).toEqual([]);
  });
  it("텍스트 연결 엣지가 없으면 hasTextConnection=false", () => {
    expect(hasTextConnection("c", new Map([["c", comfy("c")]]), [], {})).toBe(false);
  });
  it("텍스트 연결이 없으면 driveTextParams 는 baseParams 를 그대로(참조 동일) 반환", () => {
    const base = { text: "hi", model: "m" };
    const out = driveTextParams("c", base, [{ key: "text", type: "text" }], [comfy("c")], [], {});
    expect(out).toBe(base); // 연결 없음 → 원본 편집값 유지(불필요 복사 없음)
  });
  it("실제 미디어·텍스트 값만 비교하고 결과에 영향 없는 카드 이동은 무시한다", () => {
    const reference = {
      id: "ref",
      kind: "reference",
      x: 10,
      y: 20,
      refs: [{ file_path: "https://cdn/input.png", type: "image", name: "input.png" }],
    } as SceneCard;
    const text = { id: "text", kind: "text", x: 0, y: 0, text: "old prompt" } as SceneCard;
    const target = comfy("c", {
      comfyCfg: {
        content: "workflow",
        paramValues: { "1|prompt": "manual" },
        params: [{ key: "1|prompt", label: "Prompt", type: "text" }],
      },
    });
    const edges = [
      { id: "ref-edge", from: "ref", to: "c", role: "ref" as const },
      { id: "text-edge", from: "text", to: "c", role: "text" as const },
    ];
    const initial = prepareSceneComfyInputs(
      "c",
      { "1|prompt": "manual" },
      [reference, text, target],
      edges,
      {},
      {},
    );
    const moved = prepareSceneComfyInputs(
      "c",
      { "1|prompt": "manual" },
      [{ ...reference, x: 999 }, text, target],
      edges,
      {},
      {},
    );
    const edited = prepareSceneComfyInputs(
      "c",
      { "1|prompt": "manual" },
      [reference, { ...text, text: "new prompt" }, target],
      edges,
      {},
      {},
    );

    expect(initial.media).toMatchObject([
      { type: "image", url: "https://cdn/input.png", source_gen_id: undefined },
    ]);
    expect(initial.drivenParamValues["1|prompt"]).toBe("old prompt");
    expect(samePreparedSceneComfyInputs(initial, moved)).toBe(true);
    expect(samePreparedSceneComfyInputs(initial, edited)).toBe(false);
  });
});
