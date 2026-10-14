// @vitest-environment jsdom
// 레퍼런스를 올리는 중의 생성(조작 규칙 52 — 25회차, Codex 전수 검토): 놓은 파일·붙여 넣은 그림은 올린 뒤에야 트레이에 들어온다 — 그 사이의 Generate·
//  Alt+Enter 는 그 파일이 빠진 요청으로 나갔고 레퍼런스는 뒤늦게 나타났다. 끝날 때까지 막고 이유를 보인다. 실제 SpotlightPrompt·제출 훅을 통과한다.
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Generation } from "../src/types";
import { click, deferred, installPromptBoundaryMocks, mountPrompt, required, settle, type PromptProps } from "./seedanceRenderHarness";

let boundary: ReturnType<typeof installPromptBoundaryMocks>;
let view: Awaited<ReturnType<typeof mountPrompt>> | undefined;
type Saved = { saved: { project: string; path: string; name: string; type: string }[]; skipped: string[] };
type Capture = { project: string; path: string; name: string; type: string };

const binding = (): NonNullable<PromptProps["trayBinding"]> => ({
  key: "scene:a", promptKey: null, prompt: "두 캐릭터가 파도를 본다",
  refs: [{ file_path: "https://fixture.invalid/a-0.png", type: "image", name: "a-0" }],
  modelKey: "model", model: { model: "nano_banana_flash", type: "image", params: {} },
} as NonNullable<PromptProps["trayBinding"]>);
const editor = () => required(view!.container, '[contenteditable="true"]');
const trayCount = () => view!.container.querySelectorAll(".sl-reftray-item").length;
const errorText = () => view!.container.querySelector(".sl-error")?.textContent ?? "";
const generate = async () => { click(required(view!.container, "button.sl-gen")); await settle(); };
const dropFile = () => act(() => {
  const file = new File(["x"], "outside.png", { type: "image/png" });
  required(view!.container, ".sl-panel").dispatchEvent(Object.assign(new Event("drop", { bubbles: true, cancelable: true }), {
    dataTransfer: { types: ["Files"], files: [file], items: [], getData: () => "" },
  }));
});
const paste = () => act(() => {
  const image = new File(["x"], "shot.png", { type: "image/png" });
  editor().dispatchEvent(Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
    clipboardData: { items: [{ type: "image/png", getAsFile: () => image }], getData: () => "" },
  }));
});

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  boundary = installPromptBoundaryMocks();
  Object.assign(boundary.api, {
    assetThumbUrl: (project: string, path: string) => `/thumb/${project}/${path}`,
    assetFileUrl: (project: string, path: string) => `/file/${project}/${path}`,
    assetTree: vi.fn().mockResolvedValue({ children: [] }),
  });
  boundary.api.prepareCreate.mockImplementation((body) => async () => ({
    id: "g", prompt: body.prompt, display_prompt: body.display_prompt || null, model: body.model, params: body.params,
    status: "pending", assets: [], references: body.references, tags: [], auto_tags: [],
  }) as Generation);
});
afterEach(() => {
  view?.dispose();
  view = undefined;
  expect(boundary.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it("놓은 파일을 올리는 동안 Generate 를 누르면 막고 이유를 보인다 — 끝나면 그 파일까지 실은 요청이 나간다", async () => {
  const upload = deferred<Saved>();
  Object.assign(boundary.api, { uploadReferenceFiles: vi.fn(() => upload.promise) });
  view = await mountPrompt({ trayBinding: binding() });
  expect(trayCount()).toBe(1);
  dropFile();
  await settle();
  await generate();
  expect(boundary.api.prepareCreate).not.toHaveBeenCalled(); // 전엔 파일 없는 요청이 먼저 나갔다
  expect(errorText()).toContain("가져오는 중");
  await act(async () => { upload.resolve({ saved: [{ project: "p", path: "imports/outside.png", name: "outside.png", type: "image" }], skipped: [] }); });
  await settle();
  expect(trayCount()).toBe(2);
  await generate();
  expect(boundary.api.prepareCreate).toHaveBeenCalledTimes(1);
  expect(boundary.api.prepareCreate.mock.calls[0][0].references).toHaveLength(2);
  expect(errorText()).not.toContain("가져오는 중");
});

// Codex 코드 리뷰: 카드의 '레퍼런스로 사용(@)'도 생성물을 받아 온 뒤에야 넣는다 — 그 사이의 Generate 에 같은 구멍이 있었다.
it("'레퍼런스로 사용(@)'을 받아 오는 동안도 막는다 — 끝나면 그 레퍼런스까지 실은 요청이 나간다", async () => {
  const fetched = deferred<unknown>();
  boundary.api.getGeneration.mockImplementationOnce(() => fetched.promise);
  view = await mountPrompt({ trayBinding: binding() });
  act(() => { window.dispatchEvent(new CustomEvent("ch:add-reference", { detail: "g2" })); });
  await settle();
  expect(boundary.api.getGeneration).toHaveBeenCalledWith("g2");
  await generate();
  expect(boundary.api.prepareCreate).not.toHaveBeenCalled(); // 전엔 레퍼런스 없는 요청이 먼저 나갔다
  expect(errorText()).toContain("가져오는 중");
  await act(async () => {
    fetched.resolve({ id: "g2", source_name: null, assets: [{ id: "a2", generation_id: "g2", type: "image", file_path: "/media/g2.png", thumbnail_path: null, source_url: null, cached: true }] });
  });
  await settle();
  expect(trayCount()).toBe(2);
  await generate();
  expect(boundary.api.prepareCreate).toHaveBeenCalledTimes(1);
  expect(boundary.api.prepareCreate.mock.calls[0][0].references).toHaveLength(2);
});

// 59회차(Codex): 그림 붙여넣기를 맡은 Ctrl+V 를 길게 누르면 반복 keydown 마다 paste 가 또 와, 같은 그림이 그만큼 올라가고 레퍼런스로 붙었다(조작 규칙 38).
it("그림을 붙인 Ctrl+V 를 길게 누르면 반복은 막는다 — 키를 떼면 다시 붙일 수 있다", async () => {
  Object.assign(boundary.api, { uploadCapture: vi.fn(() => deferred<Capture>().promise) });
  view = await mountPrompt({ trayBinding: binding() });
  paste();
  const repeat = () => {
    const event = new KeyboardEvent("keydown", { key: "v", ctrlKey: true, repeat: true, bubbles: true, cancelable: true });
    act(() => { editor().dispatchEvent(event); });
    return event.defaultPrevented;
  };
  expect(repeat()).toBe(true); // 전엔 막지 않아 반복마다 paste 가 왔다
  act(() => { editor().dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", ctrlKey: true, bubbles: true })); }); // 누른 채 다른 키만 뗐다(Codex 검토)
  expect(repeat()).toBe(true);
  act(() => { editor().dispatchEvent(new KeyboardEvent("keyup", { key: "v", ctrlKey: true, bubbles: true })); });
  expect(repeat()).toBe(false); // 키를 뗐다 — 글자 붙여넣기의 반복은 전처럼 둔다
});

it("붙여 넣은 그림도 같다 — 올리기가 실패해도 막힘은 풀린다", async () => {
  const upload = deferred<Capture>();
  Object.assign(boundary.api, { uploadCapture: vi.fn(() => upload.promise) });
  view = await mountPrompt({ trayBinding: binding() });
  paste();
  await settle();
  await generate();
  expect(boundary.api.prepareCreate).not.toHaveBeenCalled();
  expect(errorText()).toContain("가져오는 중");
  let fail!: (reason: unknown) => void;
  Object.assign(boundary.api, { uploadCapture: vi.fn(() => new Promise<Capture>((_resolve, reject) => { fail = reject; })) });
  await act(async () => { upload.resolve({ project: "captures", path: "shot.png", name: "shot.png", type: "image" }); });
  await settle();
  expect(trayCount()).toBe(2);
  paste(); // 두 번째는 실패한다
  await settle();
  await act(async () => { fail(new Error("disk")); });
  await settle();
  await generate(); // 실패로 끝났으니 막지 않는다
  expect(boundary.api.prepareCreate).toHaveBeenCalledTimes(1);
});
