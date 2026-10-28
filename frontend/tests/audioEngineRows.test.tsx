// @vitest-environment jsdom
// 오디오 1단계(2026-10-28 Jay·Codex 합의) — text2speech_v2 의 엔진(variant)을 모델 줄로 고르고, 목소리를 검색 창으로 고른다.
//  · 제출 키는 그대로(model=text2speech_v2, params.variant) — 화면에서만 가른다(Seedance Fast 와 같은 방식).
//  · 저장된 옛 엔진(vibe/cozy)은 '기존 설정' 줄로 보존하고, 엔진이 빠진 복원은 고를 때까지 제출·씬 저장을 막는다(Codex B1).
//  · 시험마다 `vi.resetModules()` — 파라미터·카탈로그 캐시가 모듈 전역이다(sceneModelModalRestore 와 같은 이유).
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const modelParams = vi.fn();
const voices = vi.fn();
vi.mock("../src/api", () => ({
  api: {
    models: () => Promise.resolve([{ display_name: "Text to Speech V2", job_set_type: "text2speech_v2", type: "audio" }]),
    modelParams: (...args: unknown[]) => modelParams(...args),
    estimateCost: () => Promise.resolve({ credits: 1 }),
    voices: (...args: unknown[]) => voices(...args),
  },
}));
vi.mock("../src/lib/modelPolicy", () => ({
  useModelPolicy: () => ({ status: "ready", ready: true, allowed: new Set<string>(), key: "k" }),
}));

const ENGINES = ["elevenlabs", "minimax", "seed_speech", "vibe_voice", "cozy_voice"];
const ttsSchema = () => ({
  job_set_type: "text2speech_v2", type: "audio", saved_at: Date.now() / 1000,
  params: [
    { name: "prompt", type: "string", required: true },
    { name: "variant", type: "string", required: true, enum: ENGINES },
    { name: "voice_id", type: "string", required: true },
    { name: "voice_type", type: "string", required: true, enum: ["preset", "element"] },
  ],
});

let container: HTMLDivElement;
let root: Root;
let saved: Record<string, unknown>[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  modelParams.mockReset().mockImplementation(async () => ttsSchema());
  voices.mockReset().mockResolvedValue({ items: [], cursor: null });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  saved = [];
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mountModal(initial: Record<string, unknown> | undefined) {
  vi.resetModules();
  const { SceneModelModal } = await import("../src/components/scene/SceneModelModal");
  act(() => {
    root.render(
      <StrictMode>
        <SceneModelModal initial={initial as never} onSave={(cfg) => saved.push(cfg as Record<string, unknown>)} onClose={() => {}} />
      </StrictMode>,
    );
  });
  await settle();
}

const chipText = () => (container.querySelector(".sl-chip-label")?.textContent || "").trim();
const button = (label: string) => {
  const found = [...container.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || b.textContent || "").trim() === label);
  if (!found) throw new Error(`'${label}' 버튼 없음: ${[...container.querySelectorAll("button")].map((b) => b.textContent).join(" | ")}`);
  return found as HTMLButtonElement;
};
const openModelList = () => act(() => (container.querySelector(".sl-chip") as HTMLButtonElement).click());
const rowNames = () => [...container.querySelectorAll(".sl-dropdown .sl-dd-item")].map((b) => (b.getAttribute("aria-label") || b.textContent || "").trim());
const audioNames = ["Seed Audio 1.0", "ElevenLabs v4", "ElevenLabs v4 Turbo", "ElevenLabs v3", "Qwen Audio 3.0 TTS", "MiniMax Speech 2.8 HD", "Seed Speech"];

describe("오디오 엔진 줄 — 씬 모델 창", () => {
  it("새로 고르면 첫 엔진(elevenlabs)이 옵션값에도 실리고, 고급에 variant 가 없다", async () => {
    await mountModal({ type: "audio" });
    expect(chipText()).toBe("ElevenLabs v3");
    expect(container.querySelector('button[title^="고급 옵션"]')).toBeNull(); // 고급(Set) 칩 없음
    openModelList();
    expect(rowNames()).toEqual(audioNames);
    act(() => button("저장").click());
    expect(saved[0]).toMatchObject({ model: "text2speech_v2", modelName: "ElevenLabs v3", params: { variant: "elevenlabs" } });
  });

  it("엔진이 빠진 복원은 기본값으로 메우지 않고, 고를 때까지 저장을 막는다", async () => {
    await mountModal({ model: "text2speech_v2", params: { voice_id: "v1", voice_type: "preset" } });
    expect(chipText()).toBe("엔진 선택");
    expect(button("저장").disabled).toBe(true);
    expect(container.textContent).toContain("음성 엔진이 없습니다");
    openModelList();
    expect(container.querySelector(".sl-dropdown .sl-dd-item.sel")).toBeNull(); // 어느 줄도 고른 것처럼 보이지 않는다
    act(() => button("MiniMax Speech 2.8 HD").click());
    await settle();
    expect(chipText()).toBe("MiniMax Speech 2.8 HD");
    expect(button("저장").disabled).toBe(false);
    act(() => button("저장").click());
    expect(saved[0]).toMatchObject({ modelName: "MiniMax Speech 2.8 HD", params: { variant: "minimax", voice_id: "v1", voice_type: "preset" } });
  });

  it("저장된 옛 엔진은 '기존 설정' 줄로 보이고 값이 바뀌지 않는다", async () => {
    await mountModal({ model: "text2speech_v2", params: { variant: "cozy_voice", voice_id: "v1", voice_type: "preset" } });
    expect(chipText()).toBe("Cozy Voice (기존 설정)");
    openModelList();
    expect(rowNames()).toEqual([...audioNames, "Cozy Voice (기존 설정)"]);
    expect(container.querySelector(".sl-dropdown .sl-dd-item.sel")?.getAttribute("aria-label")).toBe("Cozy Voice (기존 설정)");
    act(() => button("저장").click());
    expect(saved[0]).toMatchObject({ params: { variant: "cozy_voice" } });
  });
});

describe("목소리 검색 창", () => {
  it("이름으로 거르고, 고르면 preset 으로 저장한다(element 는 목록에 없다)", async () => {
    vi.resetModules();
    voices.mockResolvedValue({ items: [
      { id: "g", name: "Grady", voice_type: "preset" },
      { id: "e", name: "Emily", voice_type: "preset" },
      { id: "c", name: "MyClone", voice_type: "element" },
    ], cursor: null });
    const { SpotlightOptionsBar } = await import("../src/components/spotlight/SpotlightOptionsBar");
    let values: Record<string, string | number | boolean> = { variant: "minimax" };
    const setOptionValues = vi.fn((next) => { values = typeof next === "function" ? next(values) : next; });
    const setOpen = vi.fn();
    act(() => root.render(<SpotlightOptionsBar type="audio" setType={vi.fn()} model="text2speech_v2" setModel={vi.fn()}
      onPickModel={vi.fn()} modelName="Text to Speech V2" typeModels={[]} tunable={[]} constraints={{}}
      optionValues={values} setOptionValues={setOptionValues} setOpt={vi.fn()} open="voice" setOpen={setOpen} />));
    await settle();
    expect([...container.querySelectorAll(".sl-voice-pop .sl-dd-item")].map((b) => b.textContent)).toEqual(["Grady", "Emily"]);
    const input = container.querySelector<HTMLInputElement>(".sl-voice-search")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(input, "em");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect([...container.querySelectorAll(".sl-voice-pop .sl-dd-item")].map((b) => b.textContent)).toEqual(["Emily"]);
    act(() => button("Emily").click());
    expect(values).toEqual({ variant: "minimax", voice_id: "e", voice_type: "preset" });
    expect(setOpen).toHaveBeenCalledWith(null);
  });

  it("조회가 실패해도 저장된 목소리를 지우지 않는다", async () => {
    vi.resetModules();
    voices.mockRejectedValue(new Error("down"));
    const { SpotlightOptionsBar } = await import("../src/components/spotlight/SpotlightOptionsBar");
    const setOptionValues = vi.fn();
    act(() => root.render(<SpotlightOptionsBar type="audio" setType={vi.fn()} model="text2speech_v2" setModel={vi.fn()}
      onPickModel={vi.fn()} modelName="Text to Speech V2" typeModels={[]} tunable={[]} constraints={{}}
      optionValues={{ variant: "minimax", voice_id: "kept" }} setOptionValues={setOptionValues} setOpt={vi.fn()} open={null} setOpen={vi.fn()} />));
    await settle();
    expect(container.querySelector('button[aria-label="Voice"]')?.textContent).toContain("kept (확인 필요)");
    expect(setOptionValues).not.toHaveBeenCalled();
  });
});

describe("복원 규칙·제출·표시명", () => {
  it("withEffectiveDefaults 는 꼭 골라야 하는 엔진만 비워 둔다", async () => {
    const { withEffectiveDefaults } = await import("../src/lib/useModels");
    const params = ttsSchema().params;
    expect(withEffectiveDefaults(params, "text2speech_v2", { voice_id: "x" }).variant).toBe("");
    expect(withEffectiveDefaults(params, "text2speech_v2", { variant: "seed_speech" }).variant).toBe("seed_speech");
    // Seedance 는 종전대로 빈 값을 기본값으로 채운다
    const seedance = [{ name: "mode", type: "string", enum: ["std", "fast"] }];
    expect(withEffectiveDefaults(seedance, "seedance_2_0", {}).mode).toBe("std");
  });

  it("엔진이 비면 제출 본문을 만들지 않는다 · 한도는 제출과 글자 수 표시가 같은 값", async () => {
    const { buildSpotlightCreateBody, SPEECH_TEXT_LIMITS } = await import("../src/lib/spotlightSubmit");
    const input = (variant: string, text = "안녕하세요") => ({ text, inlineRefs: [], trayRefs: [], parts: [], displayPrompt: text,
      model: "text2speech_v2", optionValues: { variant, voice_id: "v", voice_type: "preset" }, armedAutoTags: [] });
    expect(buildSpotlightCreateBody(input(""))).toEqual({ body: null, error: "모델 목록에서 음성 엔진을 고르세요." });
    expect(buildSpotlightCreateBody(input("minimax", "x".repeat(SPEECH_TEXT_LIMITS.minimax))).error).toBeNull();
    expect(buildSpotlightCreateBody(input("minimax", "x".repeat(SPEECH_TEXT_LIMITS.minimax + 1))).body).toBeNull();
  });

  it("대본 칸은 안내 문구와 글자 수/한도를 보인다", async () => {
    const { SpotlightPromptRow } = await import("../src/components/spotlight/SpotlightPromptRow");
    const noop = () => {};
    const editorRef = { current: null };
    act(() => root.render(<SpotlightPromptRow expanded={false} tagFilter={null} editorRef={editorRef} onToggleExpand={noop}
      onClearTagFilter={noop} onInput={noop} onCaretMove={noop} onKeyDown={noop} onPaste={noop} onCompositionStart={noop}
      onCompositionEnd={noop} onDragOver={noop} onDrop={noop} onDragLeave={noop} onCopyPrompt={noop} onClearPrompt={noop}
      script={{ count: 5001, max: 5000 }} />));
    expect(container.querySelector(".sl-prompt")?.getAttribute("data-placeholder")).toBe("Write the exact words to be spoken");
    const count = container.querySelector(".sl-char-count")!;
    expect(count.textContent).toBe(`${(5001).toLocaleString()} / ${(5000).toLocaleString()}자`);
    expect(count.classList.contains("over")).toBe(true);
  });

  it("생성물 표시명은 엔진, 집계(params 없이)는 모델 이름", async () => {
    const { modelDisplayName } = await import("../src/lib/modelCatalog");
    expect(modelDisplayName("text2speech_v2", { variant: "seed_speech" })).toBe("Seed Speech");
    expect(modelDisplayName("text2speech_v2")).not.toBe("ElevenLabs v3");
    expect(modelDisplayName("seedance_2_0", { mode: "fast" })).toBe("Seedance 2.0");
  });
});
