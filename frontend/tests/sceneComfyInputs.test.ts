// sceneComfyInputs 순수 이동 계약 — 세부 그래프 로직은 sceneEdges.test 가 커버, 여기선 경계·위임 계약만.
import { describe, it, expect } from "vitest";
import {
  driveTextParams,
  gatherComfyMedia,
  hasTextConnection,
  prepareSceneComfyInputs,
  samePreparedSceneComfyInputs,
} from "../src/lib/sceneComfyInputs";
import type { SceneCard } from "../src/lib/scenes";

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
