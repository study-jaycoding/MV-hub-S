// @vitest-environment jsdom
// Codex E-1(P1, 2026-10-28): 옵션 스키마가 캐시에 있는 모델로 바꾸면(Seed Audio → Qwen), 범위 보정 효과가 같은 그림에서
//  옛 모델의 옵션·스키마로 새 모델 기본값을 덮었다(속도·음높이 0 → 0.5 · Seed Audio 의 loudness_rate 가 남아 제출 실패).
//  보정은 옵션이 지금 모델 것(paramsModel === model)일 때만 돈다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ modelParams: vi.fn(), estimateCost: vi.fn(), voices: vi.fn() }));
vi.mock("../src/api", () => ({ api: mocks }));
vi.mock("../src/lib/modelCatalogCache", () => ({ fetchModelCatalog: async () => [] }));
import { useModels } from "../src/lib/useModels";

const PARAMS: Record<string, unknown[]> = {
  seed_audio: [
    { name: "speech_rate", type: "integer", default: 0 },
    { name: "pitch_rate", type: "integer", default: 0 },
    { name: "loudness_rate", type: "integer", default: 0 },
  ],
  qwen_audio_tts: [
    { name: "speech_rate", type: "number", default: 1 },
    { name: "pitch_rate", type: "number", default: 1 },
  ],
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  mocks.modelParams.mockImplementation((model: string) =>
    Promise.resolve({ job_set_type: model, type: "audio", saved_at: Date.now() / 1000, params: PARAMS[model] ?? [] }));
  mocks.estimateCost.mockResolvedValue({ credits: 1, saved_at: Date.now() / 1000 });
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const settle = () => act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });

it("캐시에 있는 Qwen 으로 돌아오면 Qwen 기본값 그대로 — Seed Audio 옵션이 범위 보정으로 덮지 않는다", async () => {
  let r!: ReturnType<typeof useModels>;
  function View() {
    r = useModels(vi.fn(), { allowed: new Set(), ready: false, initialType: "audio", initialModel: "qwen_audio_tts" });
    return null;
  }
  await act(async () => root.render(<View />));
  await settle(); // Qwen 스키마를 받아 캐시에 둔다
  expect(r.optionValues).toEqual({ speech_rate: 1, pitch_rate: 1 });
  act(() => r.setModel("seed_audio"));
  await settle();
  expect(r.optionValues).toEqual({ speech_rate: 0, pitch_rate: 0, loudness_rate: 0 });
  act(() => r.setModel("qwen_audio_tts")); // 캐시 적중 — 같은 그림에서 옵션이 바뀐다
  await settle();
  expect(r.paramsModel).toBe("qwen_audio_tts");
  expect(r.optionValues).toEqual({ speech_rate: 1, pitch_rate: 1 });
});
