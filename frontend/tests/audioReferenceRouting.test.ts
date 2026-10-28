// 오디오를 레퍼런스로 쓰는 경로(Jay 2026-10-28 "오디오로 들어가지지 않는 것 같다") — 프롬프트와 캔버스에서 만든 제출 본문의 오디오가
// 오디오(type audio · @AudioN, Seed Audio 는 audio_references)로 실리는지. 에이전트가 이것을 --audio-references 로 넘기는 것은
// backend/tests/test_audio_reference_routing.py. 기록: docs/status/오디오_레퍼런스_검수_2026-10-28.md
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withCanvasReferences } from "../src/features/canvas/references";
import { setHubFeatures } from "../src/lib/hubFeatures";
import { referenceMediaTypeFromFile } from "../src/lib/media";
import type { ChipRef } from "../src/lib/promptEditor";
import { buildSceneGenerationJobInput } from "../src/lib/sceneGenerationInputs";
import { resolvePortEdges } from "../src/lib/sceneEdges";
import type { SceneCard, SceneEdge } from "../src/lib/scenes";
import { spotlightAssetRefBase } from "../src/lib/spotlightAssetRefs";
import { buildSpotlightCreateBody } from "../src/lib/spotlightSubmit";
import type { Generation } from "../src/types";

const chip = (type: ChipRef["type"], file_path: string, over: Partial<ChipRef> = {}): ChipRef =>
  ({ file_path, type, role: "", name: file_path, thumb: "", ...over });
const IMG = chip("image", "asset:p|still.png");
const VID = chip("video", "asset:p|clip.mp4");
const AUD = chip("audio", "asset:p|line.mp3");
const base = { parts: [], displayPrompt: "", armedAutoTags: [] };
const refsOf = (body: ReturnType<typeof buildSpotlightCreateBody>) =>
  body.body?.references?.map((ref) => [ref.type, ref.role]);
// 오디오 모델은 서버가 audio-models-v1 을 알릴 때만 열린다(dev 서버는 알린다 — /api/auth/config features).
beforeAll(() => setHubFeatures(["audio-models-v1"]));
afterAll(() => setHubFeatures([]));

describe("프롬프트 — 트레이·인라인 오디오", () => {
  it.each(["seedance_2_5", "seedance_2_0", "seedance_2_0_mini"])("%s: 이미지+오디오 → 오디오는 @Audio1, 토큰은 <<<audio1>>>", (model) => {
    const out = buildSpotlightCreateBody({ ...base, model, text: "@image1 이 @audio1 대사를 말한다", optionValues: {},
      trayRefs: [IMG, AUD], inlineRefs: [] });
    expect(out.error).toBeNull();
    expect(refsOf(out)).toEqual([["image", "@Image1"], ["audio", "@Audio1"]]);
    expect(out.body?.prompt).toContain("<<<audio1>>>");
  });

  it("생성된 오디오를 @ 로 넣은 인라인 칩(역할이 @Image 로 붙어 와도) → @Audio1", () => {
    const out = buildSpotlightCreateBody({ ...base, model: "seedance_2_5", text: "말하기", optionValues: {},
      trayRefs: [IMG], inlineRefs: [chip("audio", "https://cdn.example/tts.mp3", { role: "@Image2", source_gen_id: "g-tts" })] });
    expect(refsOf(out)).toEqual([["image", "@Image1"], ["audio", "@Audio1"]]);
    expect(out.body?.references?.[1].source_gen_id).toBe("g-tts");
  });

  it("Seed Audio: 오디오 참고 → audio_references", () => {
    const out = buildSpotlightCreateBody({ ...base, model: "seed_audio", text: "새 대본", optionValues: {},
      trayRefs: [AUD], inlineRefs: [] });
    expect(out.error).toBeNull();
    expect(refsOf(out)).toEqual([["audio", "audio_references"]]);
  });

  it.each(["elevenlabs_v4", "qwen_audio_tts"])("%s: 오디오 입력이 없는 모델은 레퍼런스를 막는다", (model) => {
    const out = buildSpotlightCreateBody({ ...base, model, text: "대본", optionValues: { voice_id: "v", voice_type: "preset" },
      trayRefs: [AUD], inlineRefs: [] });
    expect(out.body).toBeNull();
    expect(out.error).toBe("이 음성 모델에는 레퍼런스를 사용할 수 없습니다");
  });
});

describe("Seedance 2.0·Mini 오디오 규칙(CLI model get rules) — 제출 전에 막는다", () => {
  const build = (model: string, trayRefs: ChipRef[]) =>
    buildSpotlightCreateBody({ ...base, model, text: "장면", optionValues: {}, trayRefs, inlineRefs: [] });

  it.each(["seedance_2_0", "seedance_2_0_mini"])("%s: 오디오만이면 막고, 이미지나 영상이 있으면 통과", (model) => {
    expect(build(model, [AUD]).error).toBe("오디오 레퍼런스는 이미지나 영상 레퍼런스와 함께 넣어야 합니다 — Seedance 2.0·Mini 는 오디오만으로 만들 수 없습니다.");
    expect(build(model, [VID, AUD]).error).toBeNull();
    expect(build(model, [IMG, AUD]).error).toBeNull();
  });

  it.each(["seedance_2_0", "seedance_2_0_mini"])("%s: 오디오 4개는 막고 3개는 통과", (model) => {
    const audios = (n: number) => Array.from({ length: n }, (_, i) => chip("audio", `asset:p|a${i}.mp3`));
    expect(build(model, [IMG, ...audios(4)]).error).toBe("오디오 레퍼런스는 3개까지 넣을 수 있습니다 — 지금 4개입니다.");
    expect(build(model, [IMG, ...audios(3)]).error).toBeNull();
  });

  it("Seedance 2.5 는 오디오만이어도 통과(omni_reference)", () => {
    const out = buildSpotlightCreateBody({ ...base, model: "seedance_2_5", text: "장면", optionValues: { mode: "omni_reference" },
      trayRefs: [AUD], inlineRefs: [] });
    expect(out.error).toBeNull();
    expect(out.body?.params?.mode).toBe("omni_reference");
  });
});

describe("캔버스 — 오디오 파일 레퍼런스 카드·생성된 오디오 카드·리스트 → 생성 카드", () => {
  const n = (id: string, kind: SceneCard["kind"], over: Partial<SceneCard> = {}): SceneCard => ({ id, kind, x: 0, y: 0, ...over });
  const edge = (from: string, to: string, order?: number): SceneEdge => ({ id: `${from}>${to}`, from, to, ...(order == null ? {} : { order }) });
  const generations = {
    tts: { id: "tts", prompt: "대사", status: "done", assets: [{ file_path: "https://cdn.example/tts.mp3", type: "audio" }] },
  } as unknown as Record<string, Generation>;

  // 캔버스에 놓은 오디오 파일은 이 모양의 레퍼런스가 된다(useSceneClipboardDrop → spotlightAssetRefBase).
  const dropped = spotlightAssetRefBase({ project: "p", path: "sfx/line.wav", name: "line.wav", type: "audio" });
  it("놓은 오디오 파일은 audio 레퍼런스", () => {
    expect(referenceMediaTypeFromFile(new File([], "line.wav", { type: "audio/wav" }))).toBe("audio");
    expect(referenceMediaTypeFromFile(new File([], "line.m4a", { type: "" }))).toBe("audio");
    expect(dropped).toMatchObject({ type: "audio", file_path: "asset:p|sfx/line.wav" });
  });

  const submit = (model: string, cards: SceneCard[], edges: SceneEdge[], text = "말한다 @audio1") => {
    const withRefs = withCanvasReferences([...cards, n("T", "text", { text }), n("M", "model", { modelCfg: { model, params: {} } })],
      [...edges, edge("T", "G"), edge("M", "G")], generations);
    const byId = new Map(withRefs.map((card) => [card.id, card] as const));
    const allEdges = [...edges, edge("T", "G"), edge("M", "G")];
    const job = buildSceneGenerationJobInput("G", byId, resolvePortEdges(byId, allEdges));
    expect(job).not.toBeNull();
    return buildSpotlightCreateBody({ ...base, text: job!.text, displayPrompt: job!.text, model: job!.model,
      optionValues: job!.params, trayRefs: job!.refs, inlineRefs: [] });
  };
  const still = n("RI", "reference", { refs: [{ file_path: "asset:p|still.png", type: "image", name: "still" }] });
  const audioCard = n("RA", "reference", { refs: [dropped] });
  const ttsCard = n("GA", "generation", { genId: "tts", genIds: ["tts"] });
  const target = n("G", "generation", { refs: [] });

  it.each(["seedance_2_5", "seedance_2_0", "seedance_2_0_mini"])("%s: 오디오 파일 카드 + 그림 카드", (model) => {
    const out = submit(model, [still, audioCard, target], [edge("RI", "G", 0), edge("RA", "G", 1)]);
    expect(out.error).toBeNull();
    expect(refsOf(out)).toEqual([["image", "@Image1"], ["audio", "@Audio1"]]);
    expect(out.body?.references?.[1].file_path).toBe("asset:p|sfx/line.wav");
    expect(out.body?.prompt).toContain("<<<audio1>>>");
  });

  it.each(["seedance_2_5", "seedance_2_0", "seedance_2_0_mini"])("%s: 생성된 오디오 카드 + 그림 카드", (model) => {
    const out = submit(model, [still, ttsCard, target], [edge("RI", "G", 0), edge("GA", "G", 1)]);
    expect(refsOf(out)).toEqual([["image", "@Image1"], ["audio", "@Audio1"]]);
    expect(out.body?.references?.[1]).toMatchObject({ file_path: "https://cdn.example/tts.mp3", source_gen_id: "tts" });
  });

  it("리스트에 그림·오디오 파일·생성된 오디오를 모아 이어도 순서대로 오디오 둘", () => {
    const list = n("L", "list");
    const out = submit("seedance_2_5", [still, audioCard, ttsCard, list, target],
      [edge("RI", "L", 0), edge("RA", "L", 1), edge("GA", "L", 2), edge("L", "G")]);
    expect(refsOf(out)).toEqual([["image", "@Image1"], ["audio", "@Audio1"], ["audio", "@Audio2"]]);
  });

  it("Seed Audio: 오디오 파일 카드·생성된 오디오 카드 → audio_references", () => {
    const out = submit("seed_audio", [audioCard, ttsCard, target], [edge("RA", "G", 0), edge("GA", "G", 1)], "새 대본");
    expect(out.error).toBeNull();
    expect(refsOf(out)).toEqual([["audio", "audio_references"], ["audio", "audio_references"]]);
  });

  it("Seedance 2.0 Mini: 생성된 오디오 카드만 이으면 제출 전에 막는다", () => {
    const out = submit("seedance_2_0_mini", [ttsCard, target], [edge("GA", "G", 0)]);
    expect(out.body).toBeNull();
    expect(out.error).toContain("이미지나 영상 레퍼런스와 함께");
  });
});
