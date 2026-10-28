// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Generation, WorkspaceContext } from "../src/types";
const mocks = vi.hoisted(() => ({ prepareCreate: vi.fn(), uploadCapture: vi.fn(), getGeneration: vi.fn(), fetchBlob: vi.fn(),
  cost: vi.fn(), queued: vi.fn(), setModel: vi.fn(), current: true, blocked: null as string | null, model: null as string | null }));
vi.mock("../src/api", () => ({ api: { prepareCreate: mocks.prepareCreate, uploadCapture: mocks.uploadCapture,
  getGeneration: mocks.getGeneration, assetThumbUrl: () => "thumb", discardCapture: vi.fn() } }));
vi.mock("../src/lib/download", () => ({ fetchBlob: mocks.fetchBlob }));
vi.mock("../src/lib/useModels", () => ({ sharedCostEstimate: mocks.cost,
  useModels: (_error: unknown, policy: { initialModel: string }) => ({ model: mocks.model ?? policy.initialModel, setModel: mocks.setModel,
    paramsModel: mocks.model ?? policy.initialModel, paramsLoading: false, params: [
      { name: "aspect_ratio", enum: ["16:9", "1:1"] }, { name: "resolution", enum: ["720p", "1080p"], default: "720p" },
      { name: "mode", enum: ["std", "pro", "4k"], default: "pro" },
      { name: "bitrate_mode", enum: ["standard", "high"], default: "standard" }, { name: "generate_audio", type: "boolean", default: true },
    ] }) }));
vi.mock("../src/lib/modelPolicy", () => ({ useModelPolicy: () => ({ allowed: new Set(), status: "ready" }) }));
vi.mock("../src/lib/modelPolicyCore", () => ({ submitBlockMessage: () => mocks.blocked, modelAllowed: () => true }));
vi.mock("../src/app/operationContext", () => ({ captureOperationContext: (workspace: WorkspaceContext) => ({ workspaceId: workspace.id }),
  isOperationContextCurrent: () => mocks.current }));
vi.mock("../src/lib/unloadGuard", () => ({ holdUnload: vi.fn() }));
import { PartialEditModal } from "../src/components/edit/PartialEditModal";
import { DRAG_TYPES } from "../src/lib/dragTypes";

let root: Root;
let container: HTMLDivElement;
let nextUrl = 0;
const workspace: WorkspaceContext = { scope: "team", id: "space-a", name: "A" };
const JOB = "9abf27e3-e932-4f39-87b0-3c278c6b21c8"; // 힉스필드 작업 id — 영상 수정 견적은 이 영상으로 낸다(2026-10-28)
function generation(type: "image" | "video" = "video", jobId: string | null = JOB): Generation {
  return { id: "source", status: "done", project_id: "project", folder_path: "cut", prompt: "source", job_id: jobId,
    assets: [{ type, file_path: `source.${type === "video" ? "mp4" : "png"}` }] } as Generation;
}
async function render(gen = generation(), selectedWorkspace = workspace) {
  await act(async () => root.render(<PartialEditModal gen={gen} mode={gen.assets[0].type as "image" | "video"}
    workspace={selectedWorkspace} onQueued={mocks.queued} onClose={vi.fn()} />));
}
async function prompt() {
  const box = container.querySelector<HTMLElement>('[aria-label="수정 지시"]')!; // 알약 편집칸(contentEditable, 2026-10-28)
  await act(async () => {
    box.textContent = "옷 색을 바꿔 주세요";
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const scrub = () => container.querySelector<HTMLElement>('[role="slider"][aria-label="수정할 영상 시점"]')!;
const pointer = (target: Element, type: string, x: number) => target.dispatchEvent(Object.assign(
  new MouseEvent(type, { bubbles: true, clientX: x, clientY: 10 }), { pointerId: 1 }));
/** 타임바를 x(0~100)에서 눌렀다 놓고, 멈춘 뒤 그 장면을 뜨는 것까지 기다린다. */
async function scrubTo(x: number) {
  await act(async () => { pointer(scrub(), "pointerdown", x); pointer(scrub(), "pointerup", x); });
  await act(async () => { vi.advanceTimersByTime(200); });
  for (let i = 0; i < 4; i += 1) await act(async () => {});
}
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
beforeEach(() => {
  vi.useFakeTimers();
  mocks.current = true; mocks.blocked = null; mocks.model = null; nextUrl = 0;
  for (const fn of [mocks.prepareCreate, mocks.uploadCapture, mocks.getGeneration, mocks.fetchBlob, mocks.cost, mocks.queued, mocks.setModel]) fn.mockReset();
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
    moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fillText: vi.fn(), strokeText: vi.fn(),
    getImageData: () => ({ data: [] }) } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 1280, height: 720 } as DOMRect);
  // 타임바 줄 — 폭 100 이라 clientX 30 = 길이 5초의 1.5초
  vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 4 } as DOMRect);
  Element.prototype.setPointerCapture = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(new Blob(["frame"], { type: "image/png" })));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("video edit reuses annotation UI", () => {
  it("sends the original video and exactly one flattened frame with time in the prompt (Kling 3.0 Omni Edit default)", async () => {
    await render(); await prompt();
    await scrubTo(30);
    expect(scrub().getAttribute("aria-valuenow")).toBe("1.5");
    await act(async () => (container.querySelector(".partial-edit-gen") as HTMLButtonElement).click());
    const [body, selected] = mocks.prepareCreate.mock.calls[0];
    expect(body).toMatchObject({ model: "kling_video_edit", project_id: "project", folder_path: "cut", params: { mode: "pro" } });
    expect(body.params).not.toHaveProperty("aspect_ratio"); // 영상 편집은 원본 화면 그대로
    expect(body.prompt).toContain("1.500초");
    expect(body.params).not.toHaveProperty("timestamp");
    expect(body.references).toHaveLength(2);
    expect(body.references[0]).toMatchObject({ file_path: "source.mp4", type: "video", role: "video", source_gen_id: "source" });
    expect(body.references[1]).toMatchObject({ file_path: "asset:project|frame.png", type: "image", role: "image_references", source_gen_id: "source" });
    expect(mocks.uploadCapture).toHaveBeenCalledTimes(1);
    expect(selected).toEqual(workspace);
  });
  it("steps one frame with the arrow key and the frame buttons", async () => {
    await render();
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    expect(Number(scrub().getAttribute("aria-valuenow"))).toBeCloseTo(1 / 24, 3);
    await act(async () => button("한 프레임 뒤로").click());
    expect(scrub().getAttribute("aria-valuenow")).toBe("0");
  });
  it("keeps the default image model and original-image path when there are no marks", async () => {
    await render(generation("image")); await prompt();
    await act(async () => (container.querySelector(".partial-edit-gen") as HTMLButtonElement).click());
    expect(mocks.prepareCreate.mock.calls[0][0]).toMatchObject({ model: "seedream_v5_pro", params: { aspect_ratio: "16:9" },
      references: [{ type: "image", file_path: "source.png" }] });
    expect(mocks.uploadCapture).not.toHaveBeenCalled();
  });
  it("lists only the chosen edit models and switches through the model chip", async () => {
    await render(generation("image"));
    await act(async () => button("수정 모델").click());
    const names = [...container.querySelectorAll('[role="option"]')].map((option) => option.textContent);
    expect(names).toEqual(["Seedream 5.0 Pro기본", "Nano Banana Pro", "Nano Banana 2", "Nano Banana 2.1", "GPT Image 2", "GPT Image 2.5"]);
    await act(async () => (container.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]).click());
    expect(mocks.setModel).toHaveBeenCalledWith("nano_banana_pro");
    await act(async () => root.render(<></>));
    await render();
    await act(async () => button("수정 모델").click());
    expect([...container.querySelectorAll('[role="option"]')].map((option) => option.textContent))
      .toEqual(["Kling 3.0 Omni Edit기본", "Kling 4.0 · Edit video", "Seedance 2.5 · Edit video"]);
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
  it("locks the frame after drawing, redoes an undone stroke and unlocks only after clearing", async () => {
    await render();
    expect(scrub().getAttribute("aria-disabled")).toBe("false");
    const canvas = container.querySelector("canvas")!;
    await act(async () => { for (const type of ["pointerdown", "pointerup"]) pointer(canvas, type, 10); });
    expect(scrub().getAttribute("aria-disabled")).toBe("true");
    expect(container.querySelector(".pe-lock")).not.toBeNull();
    await act(async () => button("되돌리기").click());
    expect(scrub().getAttribute("aria-disabled")).toBe("false");
    await act(async () => button("다시").click());
    expect(scrub().getAttribute("aria-disabled")).toBe("true");
    await act(async () => button("전체 지우기").click());
    expect(scrub().getAttribute("aria-disabled")).toBe("false");
    expect(button("다시").disabled).toBe(true); // 전체 지우기는 다시로 되살리지 않는다
  });
  it("writes text where the image is clicked — Enter keeps it, Esc drops only the typing, undo removes it", async () => {
    await render(generation("image"));
    const canvas = container.querySelector("canvas")!;
    await act(async () => button("글자").click());
    await act(async () => { pointer(canvas, "pointerdown", 40); });
    const typing = () => container.querySelector<HTMLInputElement>('input[aria-label="글자 입력"]');
    expect(typing()).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(typing()!, "수염 갈색");
      typing()!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { typing()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(typing()).toBeNull();
    expect(button("전체 지우기").disabled).toBe(false); // 글자가 한 획처럼 들어갔다
    await act(async () => { pointer(canvas, "pointerdown", 60); });
    expect(typing()).not.toBeNull();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(typing()).toBeNull(); // 쓰던 글자만 버렸다 — 창은 그대로
    expect(container.querySelector(".partial-edit-modal")).not.toBeNull();
    await act(async () => button("되돌리기").click());
    expect(button("전체 지우기").disabled).toBe(true);
  });
  it("shows the thickness slider in the tool capsule and lets the number be typed (clamped to 4–120)", async () => {
    await render(generation("image"));
    const slider = container.querySelector<HTMLInputElement>('.pe-dock input[aria-label="굵기"]')!;
    const number = () => container.querySelector<HTMLInputElement>('.pe-dock input[aria-label="굵기 숫자"]')!;
    expect(slider).not.toBeNull();
    const type = async (input: HTMLInputElement, value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await type(slider, "40");
    expect(number().value).toBe("40");
    await type(number(), "75");
    await act(async () => { number().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(slider.value).toBe("75");
    await type(number(), "999"); // 칸은 세 자리 — 넘는 값은 120 으로
    await act(async () => { number().dispatchEvent(new FocusEvent("focusout", { bubbles: true })); }); // React onBlur = focusout
    expect(slider.value).toBe("120");
    expect(number().value).toBe("120");
  });
  it("does not close on Esc — only the open menu closes; X still closes", async () => {
    const onClose = vi.fn();
    await act(async () => root.render(<PartialEditModal gen={generation("image")} mode="image" workspace={workspace}
      onQueued={mocks.queued} onClose={onClose} />));
    const esc = () => act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await esc();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => button("수정 모델").click());
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    await esc();
    expect(container.querySelector('[role="listbox"]')).toBeNull(); // 목록만 닫혔다
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => (container.querySelector(".assets-x") as HTMLButtonElement).click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("requires a successful price for the currently selected video option", async () => {
    let resolve!: (value: object) => void;
    mocks.cost.mockImplementation((_model, params) => params.mode === "4k"
      ? new Promise((yes) => { resolve = yes; }) : Promise.resolve({ credits: 8 }));
    await render(); await prompt();
    const generate = container.querySelector<HTMLButtonElement>(".partial-edit-gen")!;
    expect(generate.disabled).toBe(false);
    expect(container.querySelector(".partial-edit-cost")?.textContent).toBe("8");
    expect(button("영상 수정 품질").textContent).toBe("1080p›"); // 보내는 값 pro 를 힉스필드 웹처럼 해상도로(Jay 2026-10-28)
    await act(async () => button("영상 수정 품질").click());
    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual(["720p", "1080p", "4K"]);
    const fourK = options.find((option) => option.textContent === "4K")!; // 견적(위 mock)은 mode "4k" 로 불려야 풀린다
    await act(async () => fourK.click());
    expect(generate.disabled).toBe(true);
    expect(container.querySelector(".partial-edit-cost")?.textContent).toBe("…");
    await act(async () => resolve({ credits: 24 }));
    expect(generate.disabled).toBe(false);
    expect(container.querySelector(".partial-edit-cost")?.textContent).toBe("24");
  });
  it("blocks an unpriced video but keeps the existing image submission policy", async () => {
    mocks.cost.mockRejectedValue(new Error("offline"));
    await render(); await prompt();
    expect(container.querySelector<HTMLButtonElement>(".partial-edit-gen")!.disabled).toBe(true);
    expect(container.querySelector(".partial-edit-cost")).toBeNull();
    expect(container.textContent).toContain("견적 확인 안 됨 — 영상은 견적이 나와야 생성할 수 있습니다.");
    await act(async () => root.render(<></>));
    await render(generation("image")); await prompt();
    expect(container.querySelector<HTMLButtonElement>(".partial-edit-gen")!.disabled).toBe(false);
  });
  it("prices the video by its Higgsfield job id; a video without one stays locked with a reason", async () => {
    await render(); await prompt();
    expect(mocks.cost.mock.calls[0][4]).toBe(JOB); // 견적에 고칠 영상(작업 id)을 함께 보낸다
    expect(container.querySelector(".partial-edit-cost")?.textContent).toBe("26");
    await act(async () => root.render(<></>));
    mocks.cost.mockClear();
    await render(generation("video", null)); await prompt();
    expect(mocks.cost).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>(".partial-edit-gen")!.disabled).toBe(true);
    expect(container.textContent).toContain("힉스필드 작업 정보가 없어 견적을 낼 수 없습니다");
  });
  it("keeps a successful stale price when its background refresh fails", async () => {
    mocks.cost.mockResolvedValueOnce({ credits: 26, stale: true }).mockRejectedValueOnce(new Error("offline"));
    await render(); await prompt();
    expect(container.querySelector<HTMLButtonElement>(".partial-edit-gen")!.disabled).toBe(false);
    expect(container.querySelector(".partial-edit-cost")?.textContent).toBe("26");
  });
  it("sends Seedance 2.5 bitrate, sound, auto aspect and the source length", async () => {
    mocks.model = "seedance_2_5";
    await render(); await prompt();
    expect(button("비트레이트").textContent).toBe("High›"); // '비트레이트' 글자 없이 값만(이름은 마우스를 올리면, Jay 2026-10-28)
    expect(container.querySelector('button[aria-label="영상 길이"]')).toBeNull(); // 길이는 Kling 4.0 만 고른다
    expect(container.querySelector(".sl-ignored-note")?.textContent).toContain("길이·비율은 원본 영상을 따릅니다(5초)");
    await act(async () => button("소리 끄기").click());
    await act(async () => button("비트레이트").click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((o) => o.textContent === "Standard")!.click());
    await act(async () => (container.querySelector(".partial-edit-gen") as HTMLButtonElement).click());
    expect(mocks.prepareCreate.mock.calls[0][0].params).toEqual({ mode: "video_edit", aspect_ratio: "auto", resolution: "720p",
      duration: 5, bitrate_mode: "standard", generate_audio: false });
  });
  it("lets Kling 4.0 run longer than the source (extends the video) with an auto aspect", async () => {
    mocks.model = "kling4_0";
    await render(); await prompt();
    expect(button("영상 길이").textContent).toBe("5s"); // 칩엔 값만 — 누르면 위에 슬라이더 창
    expect(container.querySelector(".sl-dur-pop")).toBeNull();
    await act(async () => button("영상 길이").click());
    const slider = container.querySelector<HTMLInputElement>('.sl-dur-pop input[aria-label="영상 길이"]')!;
    expect([slider.min, slider.max, slider.value]).toEqual(["0", "400", "0"]); // 처음 = 원본 길이(눈금 5·10·15·20·30)
    expect(slider.getAttribute("aria-valuetext")).toBe("5s");
    expect(container.querySelector(".sl-ignored-note")?.textContent).toContain("더 길게 = 뒤로 이어 늘리기");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "60"); // 5 와 10 사이 60% = 8초
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button("영상 길이").textContent).toBe("8s");
    expect(container.querySelector(".sl-dur-head")?.textContent).toBe("8s");
    await act(async () => (container.querySelector(".partial-edit-gen") as HTMLButtonElement).click());
    expect(mocks.prepareCreate.mock.calls[0][0].params).toEqual({ mode: "video-edit", aspect_ratio: "auto", resolution: "720p", duration: 8 });
  });
  it("adds dropped images after the drawn frame up to the model's limit and sends them in order", async () => {
    await render(); await prompt(); // Kling 3.0 Omni Edit — 그린 프레임 포함 4장
    const items = ["a", "b", "c", "d"].map((name) => ({ project: "project", path: `${name}.png`, name: `${name}.png`, type: "image" }));
    const payload = JSON.stringify([...items, { project: "project", path: "v.mp4", name: "v.mp4", type: "video" }]);
    await act(async () => {
      container.querySelector(".sl-reftray")!.dispatchEvent(Object.assign(new Event("drop", { bubbles: true, cancelable: true }), {
        dataTransfer: { types: [DRAG_TYPES.asset], getData: (type: string) => type === DRAG_TYPES.asset ? payload : "", files: [], items: [] },
      }));
    });
    const names = () => [...container.querySelectorAll(".sl-reftray-item .sl-reftray-name")].map((node) => node.textContent);
    expect(names()).toEqual(["그린 프레임", "a.png", "b.png", "c.png"]); // 넘친 d·영상은 넣지 않는다
    expect(container.querySelector(".pe-refhint")?.textContent).toContain("이미지 4 / 최대 4장");
    await act(async () => button("2번 레퍼런스 빼기").click());
    expect(names()).toEqual(["그린 프레임", "b.png", "c.png"]);
    await act(async () => (container.querySelector(".partial-edit-gen") as HTMLButtonElement).click());
    const body = mocks.prepareCreate.mock.calls[0][0];
    expect(body.references.map((ref: { file_path: string; role: string }) => [ref.file_path, ref.role])).toEqual([
      ["source.mp4", "video"], ["asset:project|frame.png", "image_references"],
      ["asset:project|b.png", "image_references"], ["asset:project|c.png", "image_references"],
    ]);
    expect(body.prompt).toContain("첫 번째 참고 이미지는 원본 영상");
  });
  it("closes once the request is queued and hands the new card to the list; a failed request keeps it open", async () => {
    const onClose = vi.fn();
    const show = (gen: Generation) => act(async () => root.render(<PartialEditModal gen={gen} mode="image" workspace={workspace}
      onQueued={mocks.queued} onClose={onClose} />));
    await show(generation("image")); await prompt();
    await act(async () => (container.querySelector(".partial-edit-gen") as HTMLButtonElement).click());
    expect(mocks.queued).toHaveBeenCalledWith(expect.objectContaining({ id: "result" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.getGeneration).not.toHaveBeenCalled(); // 창 안에서 결과를 기다리지 않는다
    await act(async () => root.render(<></>));
    onClose.mockReset(); mocks.queued.mockReset();
    mocks.prepareCreate.mockReturnValue(async () => { throw new Error("offline"); });
    await show(generation("image")); await prompt();
    await act(async () => (container.querySelector(".partial-edit-gen") as HTMLButtonElement).click());
    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.queued).not.toHaveBeenCalled();
    expect(container.textContent).toContain("생성 요청 실패");
  });
});
