// @vitest-environment jsdom
// 캔버스에서 SVG + 참조 이미지 막기(GPT Image 2.6, Jay A안): 모델 노드 알약 · 모델 창 띠·저장 잠금 · 제출 건너뛰기용 판정.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelCard } from "../src/components/scene/cards/ModelCard";
import { modelNodeImageRefCount, modelNodeParamsForRefs, modelNodeRefSummary, svgReferenceConflicts } from "../src/lib/sceneGenerationInputs";
import type { SceneCard, SceneEdge } from "../src/lib/scenes";

const modelParams = vi.fn();
vi.mock("../src/api", () => ({
  api: {
    models: () => Promise.resolve([{ display_name: "GPT Image 2.6", job_set_type: "gpt_image_2_6", type: "image" }]),
    modelParams: (...args: unknown[]) => modelParams(...args),
    estimateCost: () => Promise.resolve({ credits: 1 }),
  },
}));
vi.mock("../src/lib/modelPolicy", () => ({
  useModelPolicy: () => ({ status: "ready", ready: true, allowed: new Set<string>(), key: "k" }),
}));

const ref = (n: number, type = "image") => ({ file_path: `https://example.test/ref${n}.png`, type, name: `ref${n}`, thumb: null });
const card = (c: Partial<SceneCard> & Pick<SceneCard, "id" | "kind">): SceneCard => ({ x: 0, y: 0, ...c });
const edge = (id: string, from: string, to: string): SceneEdge => ({ id, from, to });
const svgModel = (output_format: string, model = "gpt_image_2_6") =>
  card({ id: "m", kind: "model", modelCfg: { model, params: { output_format, aspect_ratio: "1:1" } } });

function scene(model: SceneCard, refs: ReturnType<typeof ref>[]) {
  const cards = [model, card({ id: "g", kind: "generation", refs })];
  return { cardsById: new Map(cards.map((c) => [c.id, c])), edges: [edge("e1", "m", "g")] };
}

describe("모델 노드·생성카드 판정", () => {
  it("svg 인 GPT 2.6 노드에 연결된 생성카드에 이미지 참조가 있으면 노드와 카드가 충돌로 잡힌다", () => {
    const { cardsById, edges } = scene(svgModel("svg"), [ref(1), ref(2)]);
    expect(modelNodeImageRefCount("m", cardsById, edges)).toBe(2);
    const conflicts = svgReferenceConflicts(cardsById, edges);
    expect([...conflicts.modelNodeIds]).toEqual(["m"]);
    expect([...conflicts.generationIds]).toEqual(["g"]);
  });

  it("참조가 없거나, png 거나, 다른 모델이거나, 이미지가 아닌 참조뿐이면 충돌이 아니다", () => {
    const none = (s: ReturnType<typeof scene>) => {
      const c = svgReferenceConflicts(s.cardsById, s.edges);
      return c.modelNodeIds.size === 0 && c.generationIds.size === 0;
    };
    expect(none(scene(svgModel("svg"), []))).toBe(true); // 참조 없음 → SVG 가능
    expect(none(scene(svgModel("png"), [ref(1)]))).toBe(true);
    expect(none(scene(svgModel("svg", "gpt_image_2_5"), [ref(1)]))).toBe(true);
    const videoOnly = scene(svgModel("svg"), [ref(1, "video")]);
    expect(modelNodeImageRefCount("m", videoOnly.cardsById, videoOnly.edges)).toBe(0);
    expect(none(videoOnly)).toBe(true);
  });

  it("모델 노드 저장 옵션: Gemini 길이는 칸이 보여 준 값과 같게 저장한다 — 참조·시작+끝은 10초, 시작 한 장은 15초 그대로", () => {
    const g = "gemini_omni_flash_1_2";
    const params = { mode: "text-to-video", duration: 15, aspect_ratio: "16:9" };
    const refs = (count: number, start = false, end = false) => ({ count, start, end });
    expect(modelNodeParamsForRefs(g, params, refs(2))).toEqual({ ...params, duration: 10 });
    expect(modelNodeParamsForRefs(g, params, refs(2, true, true))).toEqual({ ...params, duration: 10 });
    expect(modelNodeParamsForRefs(g, params, refs(1, true))).toBe(params); // 시작 프레임 한 장 = 이미지→영상 15초까지
    expect(modelNodeParamsForRefs(g, params, refs(0))).toBe(params); // 참조 없으면 그대로(같은 객체)
    expect(modelNodeParamsForRefs("kling4_0", params, refs(3))).toBe(params);
    expect(modelNodeParamsForRefs(g, { mode: "edit", duration: 15 }, refs(2))).toEqual({ mode: "edit", duration: 15 });
    const noDuration = { mode: "text-to-video" };
    expect(modelNodeParamsForRefs(g, noDuration, refs(2))).toBe(noDuration);
  });

  it("modelNodeRefSummary: 종류 무관 개수와 카드 글의 @simage·@eimage 로 시작·끝 프레임을 읽는다", () => {
    const withText = (text: string, refs: ReturnType<typeof ref>[]) => {
      const cards = [svgModel("png", "gemini_omni_flash_1_2"), card({ id: "g", kind: "generation", refs, prompt: text })];
      return { cardsById: new Map(cards.map((c) => [c.id, c])), edges: [edge("e1", "m", "g")] };
    };
    const mixed = withText("", [ref(1), ref(2, "video"), ref(3, "audio")]);
    expect(modelNodeRefSummary("m", mixed.cardsById, mixed.edges)).toEqual({ count: 3, start: false, end: false });
    const startOnly = withText("@simage1 에서 움직인다", [ref(1)]);
    expect(modelNodeRefSummary("m", startOnly.cardsById, startOnly.edges)).toEqual({ count: 1, start: true, end: false });
    const both = withText("@simage1 에서 @eimage2 로", [ref(1), ref(2)]);
    expect(modelNodeRefSummary("m", both.cardsById, both.edges)).toEqual({ count: 2, start: true, end: true });
    const none = scene(svgModel("png"), []);
    expect(modelNodeRefSummary("m", none.cardsById, none.edges)).toEqual({ count: 0, start: false, end: false });
  });
});

describe("모델 노드 카드", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("svgRefBlocked 이면 'SVG + 참조 불가' 알약(이유 툴팁)이 붙고, 아니면 없다", () => {
    const model = svgModel("svg");
    act(() => root.render(<ModelCard mode="read" card={model} svgRefBlocked />));
    const pill = host.querySelector(".scene-modelnode-blocked")!;
    expect(pill.textContent).toBe("SVG + 참조 불가");
    expect(pill.getAttribute("title")).toContain("SVG 는 참조 이미지와 함께 쓸 수 없습니다.");
    act(() => root.render(<ModelCard mode="read" card={model} />));
    expect(host.querySelector(".scene-modelnode-blocked")).toBeNull();
  });
});

describe("모델 창", () => {
  let root: Root;
  let host: HTMLDivElement;
  const saved: Record<string, unknown>[] = [];
  beforeEach(() => {
    saved.length = 0;
    modelParams.mockReset();
    modelParams.mockResolvedValue({ job_set_type: "gpt_image_2_6", type: "image", saved_at: Date.now() / 1000, params: [
      { name: "prompt", type: "string", required: true },
      { name: "aspect_ratio", type: "string", default: "1:1", enum: ["1:1", "16:9"] },
      { name: "output_format", type: "string", default: "png", enum: ["png", "jpeg", "svg"] },
    ] });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  async function mount(svgRefCount: number) {
    vi.resetModules();
    const { SceneModelModal } = await import("../src/components/scene/SceneModelModal");
    act(() => root.render(
      <SceneModelModal initial={{ model: "gpt_image_2_6", params: { output_format: "svg", aspect_ratio: "1:1" } }} svgRefCount={svgRefCount}
        onSave={(cfg) => saved.push(cfg as Record<string, unknown>)} onClose={() => {}} />));
    for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
  const save = () => [...host.querySelectorAll("button")].find((b) => b.textContent === "저장") as HTMLButtonElement;

  it("SVG + 참조: 띠가 뜨고 저장이 잠기며, [png 로 바꾸기]를 누르면 띠가 사라지고 저장되며 형식만 png 로 바뀐다", async () => {
    await mount(2);
    const band = host.querySelector(".sl-svg-band")!;
    expect(band.textContent).toContain("SVG 는 참조 이미지와 함께 쓸 수 없습니다.");
    expect(save().disabled).toBe(true);
    act(() => host.querySelector<HTMLButtonElement>(".sl-svg-band-fix")!.click());
    expect(host.querySelector(".sl-svg-band")).toBeNull();
    expect(save().disabled).toBe(false);
    act(() => save().click());
    expect(saved).toHaveLength(1);
    expect(saved[0].params).toMatchObject({ output_format: "png", aspect_ratio: "1:1" }); // 다른 옵션은 그대로
  });

  it("참조가 없으면 SVG 로 저장할 수 있고 띠도 없다", async () => {
    await mount(0);
    expect(host.querySelector(".sl-svg-band")).toBeNull();
    expect(save().disabled).toBe(false);
    act(() => save().click());
    expect(saved[0].params).toMatchObject({ output_format: "svg" });
  });
});
