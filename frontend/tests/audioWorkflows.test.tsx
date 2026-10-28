// @vitest-environment jsdom
// 오디오 2-B — 보이스 체인지·번역: 영상 1개 입력·글 없음·실제 길이 견적·대상당 1개·기능 표시 게이트.
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSpotlightCreateBody } from "../src/lib/spotlightSubmit";
import { readVideoDuration } from "../src/lib/useSceneGenerationSubmission";
import { setHubFeatures } from "../src/lib/hubFeatures";
import {
  AUDIO_TASK_MODELS, DUBBING_LANGUAGES, VIDEO_VOICE_INPUT_ERROR, audioModelBlocked, audioTaskOf, spotlightValueLabel,
} from "../src/lib/spotlightPromptConfig";

const mocks = vi.hoisted(() => ({ voices: vi.fn(), modelParams: vi.fn(), estimateCost: vi.fn() }));
vi.mock("../src/api", () => ({ api: mocks }));
vi.mock("../src/lib/modelCatalogCache", () => ({ fetchModelCatalog: async () => [] }));

const SHA = "sha256:" + "a".repeat(64);
const video = (over: Record<string, unknown> = {}) =>
  ({ file_path: "C:/clips/a.mp4", type: "video", role: "@Video", name: "a", thumb: "", uid: "u1", ...over }) as never;
const ctx = (over: Record<string, unknown> = {}) => ({ duration: 8.4, input_ref: "C:/clips/a.mp4", ...over });
const build = (model: string, optionValues: Record<string, unknown>, trayRefs: never[] = [video()], costContext: unknown = ctx(), text = "") =>
  buildSpotlightCreateBody({ text, inlineRefs: [], trayRefs, parts: [], displayPrompt: text, model, optionValues,
    armedAutoTags: [], activeProjectId: "project", folderPath: "cut", costContext: costContext as never });
const VOICE = { voice_id: "voice-1", voice_type: "preset" };

// jsdom 은 영상을 실제로 읽지 않는다 — 만든 <video> 를 붙잡아 메타데이터/오류 이벤트를 흉내 낸다.
function captureVideo() {
  const made: HTMLVideoElement[] = [];
  const original = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    const el = original(tag);
    if (tag === "video") made.push(el as HTMLVideoElement);
    return el;
  }) as typeof document.createElement);
  const finish = (duration: number | "error") => {
    const el = made[made.length - 1];
    if (duration === "error") el.onerror?.(new Event("error") as never);
    else {
      Object.defineProperty(el, "duration", { configurable: true, value: duration });
      el.onloadedmetadata?.(new Event("loadedmetadata"));
    }
  };
  return { made, finish };
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  setHubFeatures(["audio-models-v1", "video-voice-v1"]);
  for (const mock of Object.values(mocks)) mock.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  setHubFeatures([]); vi.restoreAllMocks(); vi.useRealTimers();
});

describe("dock-input — 영상 1개 · 글 없음", () => {
  it.each(["voice_change", "dubbing"])("%s: 영상 0개·2개·영상 아님은 같은 문구로 막는다", (model) => {
    const opts = model === "voice_change" ? VOICE : { target_language: "kor" };
    for (const refs of [[], [video(), video({ uid: "u2" })], [video({ type: "image", file_path: "x.png" })]]) {
      expect(build(model, opts, refs as never[]).error).toBe(VIDEO_VOICE_INPUT_ERROR);
    }
  });

  it("써 둔 글은 보내지 않는다 · 영상은 레퍼런스 한 개(input_video)로만 · params 에 복제하지 않는다", () => {
    const { body, error } = build("voice_change", { ...VOICE, variant: "elevenlabs" }, [video({ source_gen_id: "gen-1" })], ctx(), "남은 대본");
    expect(error).toBeNull();
    expect(body).toEqual({
      prompt: "", model: "voice_change", params: { ...VOICE, cost_context: ctx() },
      references: [{ file_path: "C:/clips/a.mp4", type: "video", role: "input_video", name: "a", thumbnail: "", source_gen_id: "gen-1" }],
      tags: undefined, auto_tags: [], project_id: "project", folder_path: "cut",
    });
  });

  it("번역은 언어 코드만 — 18개 표 밖이면 막는다", () => {
    expect(build("dubbing", { target_language: "kor" }).body?.params).toEqual({ target_language: "kor", cost_context: ctx() });
    expect(build("dubbing", {}).error).toBe("번역할 언어를 고르세요.");
    expect(build("dubbing", { target_language: "ko" }).error).toBe("번역할 언어를 고르세요.");
    expect(DUBBING_LANGUAGES).toHaveLength(18);
    expect(spotlightValueLabel("kor", "target_language")).toBe("한국어");
  });

  it("보이스 체인지는 프리셋 Voice 필수", () => {
    expect(build("voice_change", {}).error).toBe("Voice 에서 목소리를 고르세요.");
    expect(build("voice_change", { voice_id: "v", voice_type: "element" }).error).toBe("Voice 에서 목소리를 고르세요.");
  });

  it("Audio 의 일은 모델에서 나온다(재사용·복원이 모델만 돌려줘도 같은 일)", async () => {
    expect(AUDIO_TASK_MODELS).toEqual({ "voice-change": "voice_change", translate: "dubbing" });
    expect([audioTaskOf("voice_change"), audioTaskOf("dubbing"), audioTaskOf("seed_audio")]).toEqual(["voice-change", "translate", "tts"]);
    const { inferModelType } = await import("../src/lib/useModels");
    expect(inferModelType("dubbing")).toBe("audio");
  });
});

describe("duration-cost — 실제 길이로 · 못 읽으면 막는다", () => {
  it("길이 문맥이 없거나 다른 영상의 것이면 제출을 막는다 · 지문이 있으면 지문으로 대조", () => {
    expect(build("voice_change", VOICE, [video()], null).error).toContain("영상 길이");
    expect(build("voice_change", VOICE, [video()], ctx({ input_ref: "C:/clips/other.mp4" })).error).toContain("영상 길이");
    const withSha = build("voice_change", VOICE, [video({ asset_content_id: SHA })], ctx({ input_ref: SHA }));
    expect(withSha.error).toBeNull();
    expect(withSha.body?.references?.[0].asset_content_id).toBe(SHA);
  });

  it("readVideoDuration: 메타데이터의 길이 · 오류·0초·시간 초과는 null(기본 길이를 만들지 않는다)", async () => {
    const { made, finish } = captureVideo();
    const ok = readVideoDuration("/media/a.mp4");
    expect(made[0].preload).toBe("metadata");
    finish(8.4);
    expect(await ok).toBe(8.4);
    const broken = readVideoDuration("/media/b.mp4");
    finish("error");
    expect(await broken).toBeNull();
    const zero = readVideoDuration("/media/c.mp4");
    finish(Number.NaN);
    expect(await zero).toBeNull();
    vi.useFakeTimers();
    const slow = readVideoDuration("/media/d.mp4", 1000);
    vi.advanceTimersByTime(1000);
    expect(await slow).toBeNull();
  });

  it("useModels: 길이 문맥이 없으면 견적을 묻지 않고, 있으면 cost_context 를 함께 보낸다(영상이 바뀌면 다시)", async () => {
    vi.useFakeTimers();
    const { useModels } = await import("../src/lib/useModels");
    mocks.modelParams.mockResolvedValue({ job_set_type: "voice_change", type: "video", saved_at: Date.now() / 1000, params: [
      { name: "folder_id", type: "string|null", default: null }, { name: "input_video", type: "object", required: true },
      { name: "voice_id", type: "string", required: true }, { name: "voice_type", type: "string", default: "preset", enum: ["preset", "element"] }] });
    mocks.estimateCost.mockResolvedValue({ credits: 1, saved_at: Date.now() / 1000 });
    let result: ReturnType<typeof useModels>;
    function View({ costContext }: { costContext: ReturnType<typeof ctx> | null }) {
      result = useModels(vi.fn(), { allowed: new Set(), ready: false, initialType: "audio", initialModel: "voice_change", costContext });
      return <span>{result.cost}</span>;
    }
    await act(async () => root.render(<View costContext={null} />));
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(mocks.estimateCost).not.toHaveBeenCalled();
    expect(result!.cost).toBeNull();
    expect(result!.model).toBe("voice_change"); // Audio 탭에서 지원 목록 밖이라고 갈아치우지 않는다
    await act(async () => root.render(<View costContext={ctx()} />));
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(mocks.estimateCost.mock.calls.at(-1)?.[1]).toMatchObject({ cost_context: ctx() });
    expect(result!.cost).toBe(1);
    await act(async () => root.render(<View costContext={ctx({ duration: 30, input_ref: "C:/clips/b.mp4" })} />));
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(mocks.estimateCost.mock.calls.at(-1)?.[1]).toMatchObject({ cost_context: { duration: 30, input_ref: "C:/clips/b.mp4" } });
    // Image 탭으로 옮기면 이미지 모델로 바뀐다(보이스 체인지가 남아 이미지로 제출되지 않게)
    await act(async () => result!.setType("image"));
    expect(result!.model).not.toBe("voice_change");
  });
});

describe("생성 바 — 모델 칩·고급·준비 중 없이 Voice / 번역 언어", () => {
  async function renderBar(model: string, initial: Record<string, string | number | boolean> = {}) {
    const { SpotlightOptionsBar } = await import("../src/components/spotlight/SpotlightOptionsBar");
    let values = initial;
    const tunable = [{ name: "voice_type", type: "string", default: "preset", enum: ["preset", "element"] },
      { name: "target_language", type: "string", default: null, required: true, enum: DUBBING_LANGUAGES.map(([code]) => code) }];
    function Bar() {
      const [v, setV] = React.useState(initial);
      const [open, setOpen] = React.useState<string | null>(null);
      values = v;
      return <SpotlightOptionsBar type="audio" setType={vi.fn()} audioTask={audioTaskOf(model)} onAudioTaskChange={vi.fn()} model={model}
        setModel={vi.fn()} onPickModel={vi.fn()} modelName="모델 선택" typeModels={[]} tunable={tunable as never} constraints={{}}
        optionValues={v} setOptionValues={setV} setOpt={vi.fn()} open={open} setOpen={setOpen} />;
    }
    await act(async () => root.render(<Bar />));
    return () => values;
  }
  const buttonTexts = () => [...container.querySelectorAll("button")].map((b) => b.textContent);

  it("Voice Change: 모델 칩·고급·'준비 중' 없이 Voice 칩(목록은 보이스 체인지에서도 받는다)", async () => {
    mocks.voices.mockResolvedValue({ items: [{ id: "voice-1", name: "Grady", voice_type: "preset" }], cursor: null });
    await renderBar("voice_change");
    expect(container.querySelector(".sl-dot")).toBeNull(); // 모델 칩 없음
    expect(container.querySelector('button[title^="고급 옵션"]')).toBeNull(); // 고급(Set) 칩 없음
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Voice"]')).not.toBeNull();
    expect(mocks.voices).toHaveBeenCalled();
    expect(container.querySelector('button[aria-label="번역 언어"]')).toBeNull();
  });

  it("Translate: 번역 언어 칩에서 고르면 target_language 코드가 실린다", async () => {
    const read = await renderBar("dubbing");
    const chip = container.querySelector<HTMLButtonElement>('button[aria-label="번역 언어"]')!;
    expect(chip.textContent).toContain("번역 언어");
    expect(container.querySelector('button[aria-label="Voice"]')).toBeNull();
    act(() => chip.click());
    expect(container.querySelectorAll(".sl-dropdown .sl-dd-item")).toHaveLength(18);
    act(() => [...container.querySelectorAll<HTMLButtonElement>(".sl-dropdown .sl-dd-item")].find((b) => b.textContent === "일본어")!.click());
    expect(read().target_language).toBe("jpn");
    expect(container.querySelector('button[aria-label="번역 언어"]')!.textContent).toContain("일본어");
  });
});

describe("capability-gate · 씬", () => {
  it.each(["voice_change", "dubbing"])("%s: 서버가 video-voice-v1 을 알리지 않으면 신규·씬·재생성 모두 '서버 업데이트 필요'", (model) => {
    setHubFeatures(["audio-models-v1"]);
    expect(audioModelBlocked(model)).toBe("서버 업데이트 필요");
    expect(build(model, model === "voice_change" ? VOICE : { target_language: "kor" }).error).toBe("서버 업데이트 필요");
    setHubFeatures(["audio-models-v1", "video-voice-v1"]);
    expect(audioModelBlocked(model)).toBeNull();
  });

  it("씬 반복: 두 워크플로는 카드당 1개 · 다른 모델은 반복 수 그대로 · 카드마다 자기 영상 길이를 읽는다", async () => {
    const { sceneRepeatCount, videoCostContext } = await import("../src/lib/useSceneGenerationSubmission");
    expect([sceneRepeatCount("dubbing", 4), sceneRepeatCount("voice_change", 3), sceneRepeatCount("seedance_2_5", 3)]).toEqual([1, 1, 3]);
    const { finish } = captureVideo();
    const measured = videoCostContext("dubbing", [{ type: "video", file_path: "asset:proj|clips/b.mp4", asset_content_id: SHA }]);
    finish(12.3456);
    expect(await measured).toEqual({ duration: 12.346, input_ref: SHA });
    expect(await videoCostContext("dubbing", [])).toBeNull();
    expect(await videoCostContext("seedance_2_5", [{ type: "video", file_path: "x.mp4" }])).toBeNull();
  });
});
