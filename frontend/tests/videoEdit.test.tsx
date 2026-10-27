// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Generation, WorkspaceContext } from "../src/types";
const mocks = vi.hoisted(() => ({ prepareCreate: vi.fn(), uploadCapture: vi.fn(), getGeneration: vi.fn(), fetchBlob: vi.fn(),
  cost: vi.fn(), queued: vi.fn(), current: true, blocked: null as string | null }));
vi.mock("../src/api", () => ({ api: { prepareCreate: mocks.prepareCreate, uploadCapture: mocks.uploadCapture,
  getGeneration: mocks.getGeneration, assetThumbUrl: () => "thumb", discardCapture: vi.fn() } }));
vi.mock("../src/lib/download", () => ({ fetchBlob: mocks.fetchBlob }));
vi.mock("../src/lib/useModels", () => ({ sharedCostEstimate: mocks.cost,
  useModels: (_error: unknown, policy: { initialModel: string }) => ({ model: policy.initialModel,
    paramsModel: policy.initialModel, paramsLoading: false, params: [
      { name: "aspect_ratio", enum: ["16:9", "1:1"] }, { name: "resolution", enum: ["720p", "1080p"], default: "720p" },
    ] }) }));
vi.mock("../src/lib/modelPolicy", () => ({ useModelPolicy: () => ({ allowed: new Set(), status: "ready" }) }));
vi.mock("../src/lib/modelPolicyCore", () => ({ submitBlockMessage: () => mocks.blocked }));
vi.mock("../src/app/operationContext", () => ({ captureOperationContext: (workspace: WorkspaceContext) => ({ workspaceId: workspace.id }),
  isOperationContextCurrent: () => mocks.current }));
vi.mock("../src/lib/unloadGuard", () => ({ holdUnload: vi.fn() }));
import { PartialEditModal } from "../src/components/edit/PartialEditModal";

let root: Root;
let container: HTMLDivElement;
let nextUrl = 0;
const workspace: WorkspaceContext = { scope: "team", id: "space-a", name: "A" };
function generation(type: "image" | "video" = "video"): Generation {
  return { id: "source", status: "done", project_id: "project", folder_path: "cut", prompt: "source",
    assets: [{ type, file_path: `source.${type === "video" ? "mp4" : "png"}` }] } as Generation;
}
async function render(gen = generation(), selectedWorkspace = workspace) {
  await act(async () => root.render(<PartialEditModal gen={gen} mode={gen.assets[0].type as "image" | "video"}
    workspace={selectedWorkspace} onQueued={mocks.queued} onClose={vi.fn()} />));
}
async function prompt() {
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "옷 색을 바꿔 주세요");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  mocks.current = true; mocks.blocked = null; nextUrl = 0;
  for (const fn of [mocks.prepareCreate, mocks.uploadCapture, mocks.getGeneration, mocks.fetchBlob, mocks.cost, mocks.queued]) fn.mockReset();
  mocks.fetchBlob.mockResolvedValue(new Blob(["media"]));
  mocks.cost.mockResolvedValue({ credits: 26, saved_at: Date.now() / 1000 });
  mocks.uploadCapture.mockResolvedValue({ project: "project", path: "frame.png", reused: true });
  mocks.prepareCreate.mockReturnValue(async () => ({ id: "result", status: "pending" }));
  mocks.getGeneration.mockResolvedValue({ id: "result", status: "running", assets: [] });
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 1280, height: 720, close: vi.fn() })));
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => `blob:media-${++nextUrl}`), revokeObjectURL: vi.fn() }));
  vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(5);
  vi.spyOn(HTMLMediaElement.prototype, "src", "set").mockImplementation(function (this: HTMLMediaElement) {
    queueMicrotask(() => this.dispatchEvent(new Event("loadeddata")));
  });
  vi.spyOn(HTMLMediaElement.prototype, "currentTime", "set").mockImplementation(function (this: HTMLMediaElement) {
    queueMicrotask(() => this.dispatchEvent(new Event("seeked")));
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ save: vi.fn(), restore: vi.fn(),
    clearRect: vi.fn(), drawImage: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(),
    moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), getImageData: () => ({ data: [] }) } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 1280, height: 720 } as DOMRect);
  Element.prototype.setPointerCapture = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(new Blob(["frame"], { type: "image/png" })));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("video edit reuses annotation UI", () => {
  it("sends the original video and exactly one flattened frame with time in the prompt", async () => {
    await render(); await prompt();
    const slider = container.querySelector<HTMLInputElement>('input[aria-label="수정할 영상 시점"]')!;
    expect(slider).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "1.5");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => (container.querySelector(".partial-edit-gen") as HTMLButtonElement).click());
    const [body, selected] = mocks.prepareCreate.mock.calls[0];
    expect(body).toMatchObject({ model: "draw_to_video", project_id: "project", folder_path: "cut",
      params: { duration: 5, resolution: "720p", aspect_ratio: "16:9" } });
    expect(body.prompt).toContain("1.500초");
    expect(body.params).not.toHaveProperty("timestamp");
    expect(body.references).toHaveLength(2);
    expect(body.references[0]).toMatchObject({ file_path: "source.mp4", type: "video", role: "video", source_gen_id: "source" });
    expect(body.references[1]).toMatchObject({ file_path: "asset:project|frame.png", type: "image", role: "image_references", source_gen_id: "source" });
    expect(mocks.uploadCapture).toHaveBeenCalledTimes(1);
    expect(selected).toEqual(workspace);
  });
  it("keeps the fixed image model and original-image path when there are no marks", async () => {
    await render(generation("image")); await prompt();
    await act(async () => (container.querySelector(".partial-edit-gen") as HTMLButtonElement).click());
    expect(mocks.prepareCreate.mock.calls[0][0]).toMatchObject({ model: "seedream_v5_pro", references: [{ type: "image", file_path: "source.png" }] });
    expect(mocks.uploadCapture).not.toHaveBeenCalled();
  });
  it("blocks a changed workspace and policy restriction without submitting", async () => {
    await render(); await prompt();
    await render(generation(), { ...workspace, id: "space-b" });
    expect((container.querySelector(".partial-edit-gen") as HTMLButtonElement).disabled).toBe(true);
    mocks.blocked = "이 모델은 허용되지 않습니다.";
    await render();
    expect((container.querySelector(".partial-edit-gen") as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.prepareCreate).not.toHaveBeenCalled();
  });
  it("does not allow editing when the original video file is absent", async () => {
    const missing = generation(); missing.assets[0].file_path = "";
    await render(missing);
    expect(container.querySelector(".partial-edit-gen")).toBeNull();
    expect(mocks.prepareCreate).not.toHaveBeenCalled();
    expect(mocks.fetchBlob).not.toHaveBeenCalled();
  });
  it("locks the frame after drawing and unlocks only after clearing the annotations", async () => {
    await render();
    const slider = container.querySelector<HTMLInputElement>('input[aria-label="수정할 영상 시점"]')!;
    expect(slider.disabled).toBe(false);
    const canvas = container.querySelector("canvas")!;
    await act(async () => {
      for (const type of ["pointerdown", "pointerup"]) canvas.dispatchEvent(Object.assign(
        new MouseEvent(type, { bubbles: true, clientX: 10, clientY: 10 }), { pointerId: 1 }));
    });
    expect(slider.disabled).toBe(true);
    const clear = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "전체 지우기")!;
    await act(async () => clear.click());
    expect(slider.disabled).toBe(false);
  });
  it("requires a successful price for the currently selected video options", async () => {
    let resolve!: (value: object) => void;
    mocks.cost.mockImplementation((_model, params) => params.resolution === "1080p"
      ? new Promise((yes) => { resolve = yes; }) : Promise.resolve({ credits: 26 }));
    await render(); await prompt();
    const button = container.querySelector<HTMLButtonElement>(".partial-edit-gen")!;
    expect(button.disabled).toBe(false);
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="영상 수정 해상도"]')!;
    await act(async () => { select.value = "1080p"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(button.disabled).toBe(true);
    expect(container.querySelector(".partial-edit-cost")?.textContent).toBe("견적 조회 중…");
    await act(async () => resolve({ credits: 64 }));
    expect(button.disabled).toBe(false);
    expect(container.querySelector(".partial-edit-cost")?.textContent).toBe("64 cr");
  });
  it("blocks an unpriced video but keeps the existing image submission policy", async () => {
    mocks.cost.mockRejectedValue(new Error("offline"));
    await render(); await prompt();
    expect(container.querySelector<HTMLButtonElement>(".partial-edit-gen")!.disabled).toBe(true);
    expect(container.querySelector(".partial-edit-cost")?.textContent).toBe("견적 확인 안 됨");
    await act(async () => root.render(<></>));
    await render(generation("image")); await prompt();
    expect(container.querySelector<HTMLButtonElement>(".partial-edit-gen")!.disabled).toBe(false);
  });
  it("keeps a successful stale price when its background refresh fails", async () => {
    mocks.cost.mockResolvedValueOnce({ credits: 26, stale: true }).mockRejectedValueOnce(new Error("offline"));
    await render(); await prompt();
    expect(container.querySelector<HTMLButtonElement>(".partial-edit-gen")!.disabled).toBe(false);
    expect(container.querySelector(".partial-edit-cost")?.textContent).toBe("26 cr");
  });
  it("renders a completed video with controls and no autoplay", async () => {
    mocks.getGeneration.mockResolvedValue({ id: "result", status: "done", assets: [{ type: "video", file_path: "result.mp4" }] });
    await render(); await prompt();
    await act(async () => (container.querySelector(".partial-edit-gen") as HTMLButtonElement).click());
    const player = container.querySelector(".partial-edit-video-result") as HTMLVideoElement;
    expect(player).not.toBeNull(); expect(player.controls).toBe(true); expect(player.autoplay).toBe(false);
  });
});
