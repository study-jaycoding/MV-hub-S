// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { buildSpotlightCreateBody } from "../src/lib/spotlightSubmit";
import { MediaThumbnail } from "../src/components/MediaThumbnail";

const mocks = vi.hoisted(() => ({ voices: vi.fn(), modelParams: vi.fn(), estimateCost: vi.fn(), generationMetrics: vi.fn() }));
vi.mock("../src/api", () => ({ api: mocks }));
vi.mock("../src/lib/modelCatalogCache", () => ({ fetchModelCatalog: async () => [
  { job_set_type: "text2speech_v2", display_name: "Text to speech", type: "audio" },
  { job_set_type: "unapproved_audio", display_name: "Other", type: "audio" },
] }));
let root: Root;
let container: HTMLDivElement;
const bodyInput = (overrides = {}) => ({ text: "안녕하세요\n두 번째 문장", inlineRefs: [], trayRefs: [], parts: [],
  displayPrompt: "안녕하세요\n두 번째 문장", model: "text2speech_v2",
  optionValues: { voice_id: "official-preset", voice_type: "preset", variant: "elevenlabs" },
  armedAutoTags: [], activeProjectId: "project", folderPath: "cut", ...overrides });

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  mocks.voices.mockReset(); mocks.modelParams.mockReset(); mocks.estimateCost.mockReset();
  mocks.generationMetrics.mockResolvedValue(null);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

describe("narration generation", () => {
  it("preserves the text, preset, project and cut in the existing request", () => {
    const result = buildSpotlightCreateBody(bodyInput());
    expect(result.error).toBeNull();
    expect(result.body).toMatchObject({ prompt: "안녕하세요\n두 번째 문장", model: "text2speech_v2",
      params: { variant: "elevenlabs", voice_id: "official-preset", voice_type: "preset" },
      project_id: "project", folder_path: "cut", references: [] });
  });
  it("rejects missing voices, non-preset voices, unsupported variants and references", () => {
    for (const optionValues of [{ variant: "elevenlabs" }, { variant: "elevenlabs", voice_id: "x", voice_type: "element" },
      { variant: "fake", voice_id: "x", voice_type: "preset" }]) {
      expect(buildSpotlightCreateBody(bodyInput({ optionValues })).body).toBeNull();
    }
    expect(buildSpotlightCreateBody(bodyInput({ trayRefs: [{ type: "image", file_path: "original.png" }] })).body).toBeNull();
    expect(buildSpotlightCreateBody(bodyInput({ text: "x".repeat(5001) })).body).toBeNull();
  });
  it("renders audio controls without autoplay", async () => {
    await act(async () => root.render(<MediaThumbnail isVideo={false} isAudio src="result.mp3" thumb={null} fallback="missing" />));
    const player = container.querySelector("audio")!;
    expect(player.controls).toBe(true);
    expect(player.autoplay).toBe(false);
    expect(container.querySelector("img")).toBeNull();
  });
  it("shows only the matching edit button in the header, left of history", async () => {
    const { InfoPopup } = await import("../src/components/InfoPopup");
    const { APP_EVENTS } = await import("../src/lib/appEvents");
    mocks.estimateCost.mockResolvedValue({ credits: 2 });
    const listener = vi.fn();
    window.addEventListener(APP_EVENTS.partialEdit, listener);
    const label = { image: "이미지 수정", video: "영상 수정", audio: null };
    try {
      for (const type of ["image", "video", "audio"] as const) {
        const gen = { id: type, status: "done", prompt: "result", model: "test", tags: [], references: [],
          assets: [{ type, file_path: `result.${type}` }] } as import("../src/types").Generation;
        await act(async () => root.render(<InfoPopup target={{ kind: "generation", gen, x: 0, y: 0 }}
          onClose={vi.fn()} onPreview={vi.fn()} onOpenInBoard={vi.fn()} onOpenCanvas={vi.fn()} />));
        const head = [...container.querySelectorAll<HTMLButtonElement>(".info-head button")];
        // 아이콘은 글자가 없어 textContent 는 글자만 — 마지막 "" 는 닫기
        expect(head.map((button) => button.textContent)).toEqual([...(label[type] ? [label[type]] : []), "히스토리", "캔버스", ""]);
        if (label[type]) expect(head[0].disabled).toBe(false);
        expect(container.querySelector(".info-body")?.textContent).not.toMatch(/이미지 수정|영상 수정/);
        expect(container.textContent).not.toContain("결과·레퍼런스 ZIP");
        if (type === "video") {
          await act(async () => head[0].click());
          expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ genId: "video", mode: "video" });
        }
        if (type === "audio") expect(container.querySelector("audio")?.autoplay).toBe(false);
      }
      const running = { id: "running", status: "running", prompt: "result", model: "test", tags: [], references: [],
        assets: [{ type: "video", file_path: "result.video" }] } as import("../src/types").Generation;
      await act(async () => root.render(<InfoPopup target={{ kind: "generation", gen: running, x: 0, y: 0 }}
        onClose={vi.fn()} onPreview={vi.fn()} onOpenInBoard={vi.fn()} onOpenCanvas={vi.fn()} />));
      expect(container.querySelector<HTMLButtonElement>(".info-head button")!.disabled).toBe(true);
    } finally { window.removeEventListener(APP_EVENTS.partialEdit, listener); }
  });
  it("loads all official preset pages and does not substitute a saved voice", async () => {
    const { SpotlightOptionsBar } = await import("../src/components/spotlight/SpotlightOptionsBar");
    mocks.voices.mockImplementation(async (cursor?: string) => cursor
      ? { items: [{ id: "second", name: "Second", voice_type: "preset" }], cursor: null }
      : { items: [{ id: "first", name: "First", voice_type: "preset" }, { id: "clone", name: "Clone", voice_type: "element" }], cursor: "next" });
    const setOptionValues = vi.fn();
    // 목소리는 검색 목록 창(2026-10-28 오디오 1단계) — 칩을 열어 둔 상태로 그려 목록까지 본다.
    await act(async () => root.render(<SpotlightOptionsBar type="audio" setType={vi.fn()} model="text2speech_v2"
      setModel={vi.fn()} onPickModel={vi.fn()} modelName="Speech" typeModels={[]} tunable={[]} constraints={{}}
      optionValues={{ voice_id: "saved" }} setOptionValues={setOptionValues} setOpt={vi.fn()} open="voice" setOpen={vi.fn()} />));
    expect(mocks.voices.mock.calls).toEqual([[undefined], ["next"]]);
    const chip = container.querySelector<HTMLButtonElement>('button[aria-label="내레이션 목소리"]')!;
    expect(chip.textContent).toContain("saved (확인 필요)");
    expect([...container.querySelectorAll(".sl-voice-pop .sl-dd-item")].map((item) => item.textContent)).toEqual(["First", "Second"]);
    expect(setOptionValues).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Audio");
  });
  it("allows managers to select video editing and narration without changing existing model IDs", async () => {
    const { GroupEditor } = await import("../src/components/manage/CreditPlanFields");
    const group = { id: "group", name: "Artists", unlimited: true, limitInput: "", limitPeriod: "month" as const,
      allowedModels: ["future_model_9"], isNew: false };
    const draft = { groups: [group], members: [] } as unknown as import("../src/lib/creditPlan").CreditPlanDraft;
    const apply = vi.fn();
    await act(async () => root.render(<GroupEditor draft={draft} group={group} onClose={vi.fn()} onApply={apply} />));
    const buttons = () => [...container.querySelectorAll<HTMLButtonElement>("button")];
    await act(async () => buttons().find((button) => button.textContent === "+ 고르기")!.click());
    const choices = [...container.querySelectorAll<HTMLLabelElement>(".credit-allow-row")];
    await act(async () => {
      choices.find((label) => label.textContent === "영상 수정")!.querySelector<HTMLInputElement>("input")!.click();
      choices.find((label) => label.textContent === "Text to speech")!.querySelector<HTMLInputElement>("input")!.click();
    });
    await act(async () => buttons().find((button) => button.textContent === "저장")!.click());
    expect(apply.mock.calls[0][0].allowedModels).toEqual(["future_model_9", "draw_to_video", "text2speech_v2"]);
    expect(choices.some((label) => label.textContent?.includes("Seedream"))).toBe(false);
  });
  it("uses narration text in the price key and ignores older text responses", async () => {
    const { useModels, ALLOWED } = await import("../src/lib/useModels");
    expect(ALLOWED.audio).toEqual(["seed_audio", "elevenlabs_v4", "elevenlabs_v4_turbo", "text2speech_v2", "qwen_audio_tts"]);
    mocks.modelParams.mockResolvedValue({ job_set_type: "text2speech_v2", type: "audio", saved_at: Date.now() / 1000,
      params: [{ name: "variant", type: "string", default: "elevenlabs", enum: ["elevenlabs"] },
        { name: "voice_id", type: "string", default: "first" }, { name: "voice_type", type: "string", default: "preset" }] });
    let resolveOld!: (value: object) => void;
    mocks.estimateCost.mockImplementation((_model, _options, prompt) => prompt === "first text"
      ? new Promise((resolve) => { resolveOld = resolve; }) : Promise.resolve({ credits: 7, saved_at: Date.now() / 1000 }));
    let result: ReturnType<typeof useModels>;
    function View({ text }: { text: string }) {
      result = useModels(vi.fn(), { allowed: new Set(), ready: false, initialType: "audio", initialModel: "text2speech_v2", costPrompt: text });
      return <span>{result.cost}</span>;
    }
    await act(async () => root.render(<View text="first text" />));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    await act(async () => root.render(<View text="second text" />));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(result!.cost).toBe(7);
    await act(async () => resolveOld({ credits: 1, saved_at: Date.now() / 1000 }));
    expect(result!.cost).toBe(7);
    expect(mocks.estimateCost.mock.calls.map((call) => call[2])).toEqual(["first text", "second text"]);
    expect(result!.typeModels.map((model) => model.job_set_type)).toEqual(ALLOWED.audio);
  });
});
