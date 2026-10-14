// @vitest-environment jsdom
// 같은 모델로 '프롬프트 재사용'을 하면 원본에 없던 옵션이 앞서 넣은 값으로 남지 않는다(Codex P2, 2026-10-14).
// Nano Banana 2.1 의 시드·웹 검색은 기본값이 없어(null) 원본이 비워 두면 params 에 없다 — 전엔 지금 값 위에 얹어 남았다.
// 실제 SpotlightPrompt·useModels 를 통과한다. 생성물·모델 조회만 가짜 응답이다.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { installPromptBoundaryMocks, mountPrompt, settle } from "./seedanceRenderHarness";

const PARAMS = [
  { name: "aspect_ratio", type: "string", default: "auto", enum: ["auto", "1:1", "16:9"] },
  { name: "resolution", type: "string", default: "1k", enum: ["1k", "2k", "4k"] },
  { name: "thinking_level", type: "string", default: "medium", enum: ["minimal", "medium", "high"] },
  { name: "enable_web_search", type: "boolean", default: null },
  { name: "seed", type: "integer", default: null },
];
let boundary: ReturnType<typeof installPromptBoundaryMocks>;
let view: Awaited<ReturnType<typeof mountPrompt>> | undefined;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  boundary = installPromptBoundaryMocks();
  boundary.api.models.mockResolvedValue([{ job_set_type: "nano_banana_2_1", display_name: "Nano Banana 2.1", type: "image" }]);
  boundary.api.modelParams.mockImplementation((model: string) =>
    Promise.resolve({ params: model === "nano_banana_2_1" ? PARAMS : [], constraints: {} }));
});
afterEach(() => {
  view?.dispose();
  view = undefined;
  vi.unstubAllGlobals();
});

const gen = (id: string, params: Record<string, unknown>) => ({
  id, prompt: "장면", display_prompt: null, model: "nano_banana_2_1", params, references: [], assets: [], tags: [],
});
async function reuse(g: ReturnType<typeof gen>) {
  boundary.api.getGeneration.mockResolvedValueOnce(g);
  act(() => { window.dispatchEvent(new CustomEvent("ch:reuse-prompt", { detail: g.id })); });
  await settle();
  await settle();
}

it("같은 모델로 재사용하면 원본에 없는 시드·웹 검색은 비고, 나머지는 기본값 위에 원본 값", async () => {
  view = await mountPrompt();
  await reuse(gen("g1", { resolution: "4k", seed: 123, enable_web_search: true })); // 다른 모델에서 2.1 로 — 그대로 실린다
  expect(view.ref.current?.currentModel()).toMatchObject({
    model: "nano_banana_2_1", params: { resolution: "4k", seed: 123, enable_web_search: true },
  });
  await reuse(gen("g2", { resolution: "2k" })); // 같은 모델 — 시드·웹 검색을 비워 둔 원본
  const params = view.ref.current?.currentModel()?.params;
  expect(params).toMatchObject({ resolution: "2k", thinking_level: "medium", aspect_ratio: "auto" });
  expect(params).not.toHaveProperty("seed"); // 전엔 123 이 남아 다음 요청에 실렸다
  expect(params).not.toHaveProperty("enable_web_search");
});
