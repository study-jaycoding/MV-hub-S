// @vitest-environment jsdom
// 업스케일 — 모델 표·보낼 값·결과 표시(순수 함수)와 창에서 보내는 요청 몸통. 설계: docs/status/업스케일_크게보기_2026-11-20.md
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UPSCALE_MODELS, initialValues, upscaleBadge, upscaleModel, upscaleModelsFor, upscaleParams, upscaleRequestBody, upscaleTarget,
} from "../src/lib/upscaleModels";
import type { Generation } from "../src/types";

const mocks = vi.hoisted(() => ({ modelParams: vi.fn(), estimateCost: vi.fn(), create: vi.fn(),
  thumbOrRaw: (path: string) => path }));
const ctx = vi.hoisted(() => ({ account: "artist-a" })); // 지금 계정(문맥) — 바꿨다 돌아오는 시험용
vi.mock("../src/api", () => ({ api: mocks }));
vi.mock("../src/lib/modelCatalogCache", () => ({ fetchModelCatalog: async () => [
  { job_set_type: "bytedance_image_upscale", display_name: "Bytedance Image Upscale", type: "image" },
  { job_set_type: "topaz_image", display_name: "Topaz", type: "image" },
] }));
vi.mock("../src/lib/modelPolicy", () => ({
  useModelPolicy: () => ({ key: "k", workspaceId: "", status: "ready", allowed: new Set<string>(), groupName: null, revision: null, fetchedAt: null }),
}));
vi.mock("../src/app/operationContext", () => ({
  captureOperationContext: () => ({ accountNamespace: ctx.account, serverOrigin: "http://127.0.0.1:8010" }),
  isOperationContextCurrent: () => true,
}));

const gen = {
  id: "g1", project_id: "p1", folder_path: "cut/010", source_name: "shot", job_id: "9abf27e3-e932-4f39-87b0-3c278c6b21c8",
  status: "done", model: "nano_banana_flash", params: {},
  assets: [{ type: "image", file_path: "https://cdn.example/src.png", thumbnail_path: null }],
} as unknown as Generation;

describe("upscale model table", () => {
  it("has three image and three video models, first = default, matching the CLI 1.2.2 choices", () => {
    expect(upscaleModelsFor("image").map((m) => m.id)).toEqual(["bytedance_image_upscale", "topaz_image", "topaz_image_generative"]);
    expect(upscaleModelsFor("video").map((m) => m.id)).toEqual(["bytedance_video_upscale", "topaz_video", "topaz_hyperion_2_5"]);
    expect(initialValues(upscaleModel("bytedance_image_upscale")!)).toEqual({ resolution: "4k", remove_bg: false });
    expect(initialValues(upscaleModel("bytedance_video_upscale")!)).toEqual({ resolution: "2k", preset: "aigc", fps: 24, model_version: "standard" });
    // Hyperion 은 우선 H.265 만(ProRes·EXR 은 결과 저장·미리보기 확인 뒤)
    expect(upscaleModel("topaz_hyperion_2_5")!.options[0].choices.map((c) => c.value)).toEqual(["h265"]);
    expect(UPSCALE_MODELS).toHaveLength(6);
  });

  it("turns Topaz scale into output pixels from the source and refuses without the source size", () => {
    expect(upscaleParams("topaz_image", { scale: 4 }, { w: 1280, h: 720 }))
      .toEqual({ variant: "Standard V2", face_enhancement: false, output_width: 5120, output_height: 2880 });
    expect(upscaleParams("topaz_image_generative", {}, { w: 1000, h: 1500 })).toEqual({ variant: "Redefine", output_width: 2000, output_height: 3000 });
    expect(upscaleParams("topaz_image", {}, null)).toBeNull();
    expect(upscaleParams("topaz_video", {})).toEqual({ resolution: "1080p", aspect_ratio: "auto" });
    expect(upscaleParams("nano_banana_flash", {})).toBeNull();
  });

  it("shows the target and the result card badge", () => {
    expect(upscaleTarget("topaz_image", { scale: 2 }, { w: 1280, h: 720 })).toBe("2560×1440");
    expect(upscaleTarget("bytedance_image_upscale", {}, { w: 1280, h: 720 })).toBe("4K");
    expect(upscaleTarget("topaz_video", { resolution: "2160p" })).toBe("4K");
    expect(upscaleBadge("bytedance_video_upscale", { resolution: "1080p" })).toBe("1080p");
    expect(upscaleBadge("topaz_image", { output_width: 5120, output_height: 2880 })).toBe("5120×2880");
    expect(upscaleBadge("topaz_hyperion_2_5", { output_format: "h265" })).toBe("H.265");
    expect(upscaleBadge("nano_banana_flash", { resolution: "4k" })).toBeNull();
  });

  it("builds the request from the source card — one source reference, placeholder prompt, same project and folder", () => {
    expect(upscaleRequestBody(gen, "https://cdn.example/src.mp4", "video", "topaz_video", { resolution: "2160p" })).toEqual({
      prompt: "(no text)", model: "topaz_video", params: { resolution: "2160p" }, project_id: "p1", folder_path: "cut/010",
      references: [{ file_path: "https://cdn.example/src.mp4", type: "video", role: "video_references", source_gen_id: "g1", name: "shot" }],
    });
  });
});

describe("upscale window", () => {
  let root: Root;
  let container: HTMLDivElement;
  const RealImage = globalThis.Image;
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // 원본 크기 — jsdom 은 그림을 받지 않으므로 src 를 넣으면 1280×720 으로 읽힌 것처럼
    globalThis.Image = class {
      naturalWidth = 1280; naturalHeight = 720; onload: (() => void) | null = null; onerror: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    } as unknown as typeof Image;
    mocks.modelParams.mockImplementation(async (model: string) => ({
      job_set_type: model, type: "image", saved_at: Date.now() / 1000,
      params: model === "topaz_image"
        ? [{ name: "image_references", type: "array" }, { name: "output_width", type: "integer" }, { name: "output_height", type: "integer" },
          { name: "variant", type: "string", enum: ["Standard V2", "Low Resolution V2", "CGI", "High Fidelity V2", "Text Refine"] },
          { name: "face_enhancement", type: "boolean" }]
        : [{ name: "image_references", type: "array" }, { name: "remove_bg", type: "boolean" }, { name: "resolution", type: "string", enum: ["2k", "4k"] }],
    }));
    mocks.estimateCost.mockResolvedValue({ credits: 2, saved_at: Date.now() / 1000 });
    mocks.create.mockResolvedValue({ ...gen, id: "new" });
    ctx.account = "artist-a";
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    globalThis.Image = RealImage;
    vi.clearAllMocks();
  });

  it("sends Topaz 4× as output pixels with the source as the only reference", async () => {
    const { UpscaleModal } = await import("../src/components/upscale/UpscaleModal");
    const onQueued = vi.fn();
    const onClose = vi.fn();
    await act(async () => root.render(<UpscaleModal gen={gen} mode="image" workspace={{ scope: "personal", id: null } as never}
      onQueued={onQueued} onClose={onClose} />));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(container.textContent).toContain("1280×720");
    expect(container.textContent).toContain("4K"); // Bytedance 기본 4K
    const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === label)!;
    await act(async () => button("업스케일 모델").click());
    expect([...container.querySelectorAll(".upscale-menu .sl-dd-item")].map((b) => b.getAttribute("aria-label")))
      .toEqual(["Bytedance Upscale", "Topaz", "Topaz Generative"]);
    await act(async () => button("Topaz").click());
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => button("배율").click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".sl-dd-item")].find((b) => b.textContent === "4×")!.click());
    expect(container.textContent).toContain("5120×2880");
    expect(container.textContent).toContain("Topaz 는 견적이 없습니다");
    const upscale = container.querySelector<HTMLButtonElement>(".upscale-gen")!;
    expect(upscale.disabled).toBe(false);
    await act(async () => upscale.click());
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0][0]).toEqual({
      prompt: "(no text)", model: "topaz_image",
      params: { variant: "Standard V2", face_enhancement: false, output_width: 5120, output_height: 2880 },
      project_id: "p1", folder_path: "cut/010",
      references: [{ file_path: "https://cdn.example/src.png", type: "image", role: "image_references", source_gen_id: "g1", name: "shot" }],
    });
    expect(mocks.create.mock.calls[0][3]).toMatch(/^[0-9a-f-]{36}$/); // 요청 키(UUID)를 실어 보낸다
    expect(onQueued).toHaveBeenCalledWith(expect.objectContaining({ id: "new" }));
    expect(onClose).toHaveBeenCalled();
    // Topaz 는 CLI 가 견적을 주지 않는다 — 묻지 않는다
    expect(mocks.estimateCost.mock.calls.every((call) => call[0] !== "topaz_image")).toBe(true);
  });

  async function openDefault() {
    const { UpscaleModal } = await import("../src/components/upscale/UpscaleModal");
    const onClose = vi.fn();
    await act(async () => root.render(<UpscaleModal gen={gen} mode="image" workspace={{ scope: "personal", id: null } as never}
      onQueued={vi.fn()} onClose={onClose} />));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const press = () => act(async () => container.querySelector<HTMLButtonElement>(".upscale-gen")!.click());
    return { onClose, press };
  }

  const reopen = async () => {
    await act(async () => root.unmount());
    root = createRoot(container);
    return openDefault();
  };
  const keys = () => mocks.create.mock.calls.map((call) => call[3]);

  it("retries an unanswered request with the same request key (no second charge), also after closing and reopening", async () => {
    mocks.create.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const first = await openDefault();
    await first.press();
    expect(container.textContent).toContain("접수됐는지 확인하지 못했습니다");
    const second = await reopen(); // 닫았다가 같은 선택으로 다시 열어
    await second.press();
    expect(keys()).toHaveLength(2);
    expect(keys()[1]).toBe(keys()[0]); // 같은 키로 다시 확인 — 서버가 한 번만 받는다
    expect(second.onClose).toHaveBeenCalled();
  });

  it("after switching account and coming back, the same key goes out again with the current context", async () => {
    mocks.create.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await (await openDefault()).press(); // 계정 A — 답 없음
    ctx.account = "artist-b";
    await (await reopen()).press(); // 계정 B 의 요청은 다른 요청(다른 키)
    ctx.account = "artist-a";
    await (await reopen()).press(); // A 로 돌아와 다시 — 처음 키 그대로, 이번엔 보낸다(옛 문맥에 묶여 막히지 않음)
    expect(keys()).toHaveLength(3);
    expect(keys()[1]).not.toBe(keys()[0]);
    expect(keys()[2]).toBe(keys()[0]);
  });

  it("a definite rejection (422) lets the next press make a new request", async () => {
    const { HttpError } = await import("../src/lib/http");
    mocks.create.mockRejectedValueOnce(new HttpError(422, "bad"));
    const view = await openDefault();
    await view.press();
    expect(container.textContent).toContain("업스케일 요청 실패");
    await view.press();
    expect(keys()).toHaveLength(2);
    expect(keys()[1]).not.toBe(keys()[0]);
  });
});
