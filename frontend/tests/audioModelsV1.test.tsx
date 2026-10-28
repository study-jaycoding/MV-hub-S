// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpotlightOptionsBar } from "../src/components/spotlight/SpotlightOptionsBar";
import { AUDIO_MODELS_V1, audioReferenceError, modelRows } from "../src/lib/spotlightPromptConfig";
import { buildSpotlightCreateBody } from "../src/lib/spotlightSubmit";
import { setHubFeatures } from "../src/lib/hubFeatures";
import { ALLOWED, defaultOptions, MODEL_DISPLAY_NAMES } from "../src/lib/useModels";
import type { ModelParam } from "../src/types";
import { captureMcpContext, prepareMcpPlan } from "../src/lib/mcpContext";

const voices = vi.hoisted(() => vi.fn());
const mcp = vi.hoisted(() => ({ modelParams: vi.fn(), estimateCost: vi.fn(), models: vi.fn(), projects: vi.fn(), projectFolder: vi.fn() }));
vi.mock("../src/api", () => ({ api: { voices, ...mcp } }));
vi.mock("../src/lib/modelPolicy", () => ({ modelBlockMessage: () => null }));

let root: Root;
let host: HTMLDivElement;
let options: Record<string, string | number | boolean>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setHubFeatures(["audio-models-v1"]);
  voices.mockResolvedValue({ items: [], cursor: null });
  for (const mock of Object.values(mcp)) mock.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); setHubFeatures([]); vi.unstubAllGlobals(); });
const models = ALLOWED.audio.map((job_set_type) => ({ job_set_type, display_name: MODEL_DISPLAY_NAMES[job_set_type] || "Text to Speech V2", type: "audio" }));
const body = (model: string, optionValues: Record<string, unknown> = { voice_id: "voice", voice_type: "preset" }) =>
  buildSpotlightCreateBody({ model, optionValues, text: "첫 문장\n둘째 문장", inlineRefs: [], trayRefs: [], parts: [], displayPrompt: "", armedAutoTags: [] });

function Panel({ model, params = [], initial = {} }: { model: string; params?: ModelParam[]; initial?: Record<string, string | number | boolean> }) {
  const [values, setValues] = useState(initial);
  const [open, setOpen] = useState<string | null>("model");
  const [task, setTask] = useState("tts");
  options = values;
  return <SpotlightOptionsBar type="audio" setType={vi.fn()} model={model} setModel={vi.fn()} onPickModel={vi.fn()} modelName={model}
    typeModels={models} tunable={params} constraints={{}} optionValues={values} setOptionValues={setValues}
    setOpt={(key, value) => setValues((prev) => ({ ...prev, [key]: value }))} open={open} setOpen={setOpen} audioTask={task} onAudioTaskChange={setTask} />;
}

describe("audio models v1", () => {
  it("seven-models: shows ordered descriptions and preserves old-engine rows", async () => {
    const rows = modelRows(models);
    expect(rows.map((row) => row.key)).toEqual(["seed_audio", "elevenlabs_v4", "elevenlabs_v4_turbo", "text2speech_v2:elevenlabs", "qwen_audio_tts", "text2speech_v2:minimax", "text2speech_v2:seed_speech"]);
    expect(rows.every((row) => row.description)).toBe(true);
    await act(async () => root.render(<Panel model="seed_audio" />));
    expect(host.querySelectorAll(".sl-model-description")).toHaveLength(7);
    act(() => [...host.querySelectorAll("button")].find((b) => b.textContent === "Voice Change")!.click());
    expect(host.querySelector('[role="status"]')?.textContent).toBe("준비 중");
  });

  it.each(AUDIO_MODELS_V1)("capability-gate: %s rejects old-server restore/scene/MCP body", async (model) => {
    setHubFeatures([]);
    expect(body(model).error).toBe("서버 업데이트 필요");
    await act(async () => root.render(<Panel model={model} />));
    expect(host.querySelector<HTMLButtonElement>(`button[aria-label="${MODEL_DISPLAY_NAMES[model]}"]`)?.disabled).toBe(true);
    setHubFeatures(["audio-models-v1"]);
    expect(body(model).error).toBeNull();
  });

  it("advanced-options: unknown defaults omitted, percent choice sends its fraction", async () => {
    const params: ModelParam[] = [
      { name: "stability", type: "number", default: null, required: false },
      { name: "similarity_boost", type: "number", default: null, required: false },
    ];
    expect(defaultOptions(params, "elevenlabs_v4")).toEqual({});
    await act(async () => root.render(<Panel model="elevenlabs_v4" params={params} initial={{ voice_id: "voice", voice_type: "preset" }} />));
    act(() => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("고급"))!.click());
    const field = host.querySelector<HTMLInputElement>('input[aria-label="안정성 (%)"]')!;
    expect(field.value).toBe("");
    expect(field.placeholder).toBe("공급자 기본값");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "50");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(options.stability).toBe(0.5);
    expect(body("elevenlabs_v4", options).body?.params?.stability).toBe(0.5);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "75");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(options.stability).toBe(0.75);
  });

  it("advanced-options: auto language omitted and numeric enums stay numeric", async () => {
    const params: ModelParam[] = [{ name: "language", type: "string", default: null, enum: ["ko", "en"], required: false },
      { name: "sample_rate", type: "integer", default: 24000, enum: ["24000", "48000"], required: false }];
    await act(async () => root.render(<Panel model="qwen_audio_tts" params={params} initial={{ language: "ko" }} />));
    act(() => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("고급"))!.click());
    act(() => [...host.querySelectorAll("button")].find((b) => b.textContent === "자동")!.click());
    expect(options.language).toBeUndefined();
    act(() => [...host.querySelectorAll("button")].find((b) => b.textContent === "48000")!.click());
    expect(options.sample_rate).toBe(48000);
  });

  it("qwen-voices: web Qwen voices are marked and listed first; others stay selectable; saved choice untouched", async () => {
    const qwenEmily = "6b3e3642-f7b7-4cb8-9688-51e233c4b92f"; // 웹 Qwen 목록에 있는 Emily
    voices.mockResolvedValue({ items: [
      { id: "e2a2d2e6-9ed2-59cd-82af-feaa27f8a678", name: "Grady", voice_type: "preset" }, // 웹 Qwen 목록에 없음
      { id: qwenEmily, name: "Emily", voice_type: "preset" },
    ], cursor: null });
    function VoicePanel({ model }: { model: string }) {
      const [values, setValues] = useState<Record<string, string | number | boolean>>({ voice_id: "kept", voice_type: "preset" });
      options = values;
      return <SpotlightOptionsBar type="audio" setType={vi.fn()} model={model} setModel={vi.fn()} onPickModel={vi.fn()} modelName={model}
        typeModels={models} tunable={[]} constraints={{}} optionValues={values} setOptionValues={setValues}
        setOpt={vi.fn()} open="voice" setOpen={vi.fn()} />;
    }
    await act(async () => root.render(<VoicePanel model="qwen_audio_tts" />));
    const rows = () => [...host.querySelectorAll(".sl-voice-pop .sl-dd-item")].map((b) => b.textContent);
    expect(rows()).toEqual(["Emily추천", "Grady"]);
    expect(host.querySelector(".sl-voice-pop .sl-dd-title")?.textContent).toContain("추천 1");
    expect(options.voice_id).toBe("kept");
    // 다른 엔진은 웹이 114개 전부를 내놓아 표시가 없다
    await act(async () => root.render(<VoicePanel model="seed_audio" />));
    expect(rows()).toEqual(["Grady", "Emily"]);
  });

  it("seed-audio-refs: valid counts, mixed/voice-image invalid; other TTS reject refs", () => {
    const refs = (type: string, n: number) => Array.from({ length: n }, () => ({ type, file_path: "file" }));
    expect(audioReferenceError("seed_audio", {}, refs("audio", 3))).toBeNull();
    expect(audioReferenceError("seed_audio", { voice_id: "voice" }, refs("audio", 3))).toContain("2개");
    expect(audioReferenceError("seed_audio", {}, [...refs("audio", 1), ...refs("image", 1)])).toContain("함께");
    expect(audioReferenceError("seed_audio", { voice_id: "voice" }, refs("image", 1))).toContain("함께");
    expect(audioReferenceError("elevenlabs_v4", {}, refs("audio", 1))).toBe("이 음성 모델에는 레퍼런스를 사용할 수 없습니다");
  });

  it("MCP also keeps the stored script and voice, and rejects unsupported-server plans before estimation", async () => {
    const scene = { id: "scene", name: "Scene", created_at: 1, cards: [], edges: [] };
    const workspace = { scope: "personal" as const, id: null, name: null };
    const context = await captureMcpContext(scene, workspace);
    mcp.projects.mockResolvedValue({ projects: [{ id: "project", workspace_scope: "personal", workspace_id: null }], unassigned: 0 });
    mcp.projectFolder.mockResolvedValue({ tree: { path: "", children: [{ path: "cut", children: [] }] } });
    mcp.models.mockResolvedValue(models);
    mcp.modelParams.mockResolvedValue({ params: [{ name: "dialogue", type: "array", required: true },
      { name: "voice_id", type: "string", required: true }, { name: "voice_type", type: "string", enum: ["preset"], required: true }] });
    mcp.estimateCost.mockResolvedValue({ credits: 0.23 });
    const input = { title: "Audio", context_id: context.id, items: [{ label: "Cut", prompt: "대본\n보존", model: "elevenlabs_v4", params: { voice_id: "voice", voice_type: "preset" }, reference_ids: [], project_id: "project", folder_path: "cut" }] };
    setHubFeatures([]);
    await expect(prepareMcpPlan(input, context, scene, workspace)).rejects.toThrow("서버 업데이트 필요");
    expect(mcp.estimateCost).not.toHaveBeenCalled();
    setHubFeatures(["audio-models-v1"]);
    const plan = await prepareMcpPlan(input, context, scene, workspace);
    expect(plan.items[0].request.create).toMatchObject({ prompt: "대본\n보존", params: input.items[0].params });
  });
});
