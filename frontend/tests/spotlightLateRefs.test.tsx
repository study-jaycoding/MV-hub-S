// @vitest-environment jsdom
// 응답을 기다린 뒤에 레퍼런스를 넣는 길 — 기다리는 사이 고른 카드가 바뀌면 지금 카드에 넣지 않는다.
// 2026-10-12(조작 점검 10회차, Codex 검토): 카드 A 를 고른 채 프롬프트에 놓은 외부 파일이, 올리는 사이 B 를 고르면 B 의 레퍼런스로 저장됐다
//  (트레이는 이미 B 의 것이라 거기에 붙고, 트레이의 변경 통지가 B 에 쓴다). 큰 영상은 올리는 데 몇 초 걸린다.
// 실제 SpotlightPrompt·트레이 훅을 통과한다. 업로드·생성물 조회만 가짜 응답이다.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import {
  deferred,
  installPromptBoundaryMocks,
  mountPrompt,
  required,
  settle,
  type PromptProps,
} from "./seedanceRenderHarness";

let boundary: ReturnType<typeof installPromptBoundaryMocks>;
let view: Awaited<ReturnType<typeof mountPrompt>> | undefined;
type Saved = { saved: { project: string; path: string; name: string; type: string }[]; skipped: string[] };

function binding(card: string, refs: number): NonNullable<PromptProps["trayBinding"]> {
  return {
    key: `scene:${card}`,
    promptKey: null,
    prompt: "",
    refs: Array.from({ length: refs }, (_, index) => ({ file_path: `https://fixture.invalid/${card}-${index}.png`, type: "image", name: `${card}-${index}` })),
    modelKey: "model",
    model: { model: "nano_banana_flash", type: "image", params: {} },
  } as NonNullable<PromptProps["trayBinding"]>;
}
const trayCount = () => view!.container.querySelectorAll(".sl-reftray-item").length;
const editor = () => required(view!.container, '[contenteditable="true"]');
const dropFile = () => {
  const file = new File(["x"], "outside.png", { type: "image/png" });
  const event = Object.assign(new Event("drop", { bubbles: true, cancelable: true }), {
    dataTransfer: { types: ["Files"], files: [file], items: [], getData: () => "" },
  });
  act(() => { required(view!.container, ".sl-panel").dispatchEvent(event); });
};
const saved = (): Saved => ({ saved: [{ project: "p", path: "imports/outside.png", name: "outside.png", type: "image" }], skipped: [] });

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  boundary = installPromptBoundaryMocks();
  // 에셋 레퍼런스의 썸네일 주소 — 공통 대역에는 없다(주소 문자열만 만든다)
  Object.assign(boundary.api, {
    assetThumbUrl: (project: string, path: string) => `/thumb/${project}/${path}`,
    assetFileUrl: (project: string, path: string) => `/file/${project}/${path}`,
    assetTree: vi.fn().mockResolvedValue({ children: [] }), // 에셋 레퍼런스의 버전표 갱신이 읽는다 — 빈 트리
  });
});
afterEach(() => {
  view?.dispose();
  view = undefined;
  expect(boundary.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it("외부 파일을 올리는 사이 고른 카드가 바뀌면 지금 카드의 레퍼런스에 넣지 않는다 — 가져온 것은 알리고, 그대로면 넣는다", async () => {
  const upload = deferred<Saved>();
  const uploadReferenceFiles = vi.fn(() => upload.promise);
  Object.assign(boundary.api, { uploadReferenceFiles });
  const onChange = vi.fn((refs: unknown[]) => refs);
  view = await mountPrompt({ trayBinding: binding("a", 1), onTrayBindingRefsChange: onChange as never });
  expect(trayCount()).toBe(1);

  dropFile(); // A 를 고른 채 놓았다 — 올리는 중
  await settle();
  expect(uploadReferenceFiles).toHaveBeenCalledTimes(1);
  await view.render({ trayBinding: binding("b", 2) }); // 그사이 B 를 골랐다
  expect(trayCount()).toBe(2);
  onChange.mockClear();
  await act(async () => { upload.resolve(saved()); });
  await settle();
  expect(trayCount()).toBe(2); // B 의 트레이에 붙지 않았다
  expect(onChange).not.toHaveBeenCalled(); // B 에 저장되지도 않았다
  expect(view.container.textContent).toContain("고른 카드가 바뀌어");

  // 카드가 그대로면 전처럼 넣는다
  uploadReferenceFiles.mockImplementation(() => Promise.resolve(saved()));
  dropFile();
  await settle();
  expect(trayCount()).toBe(3);
  expect(onChange).toHaveBeenCalledTimes(1);
});

// 21회차(조작 규칙 48, Codex 전수 검토): 놓은 파일은 10회차에 막았는데, **붙여 넣은 그림**(Ctrl+V 캡처)의 완료부에는 그 검사가 없었다.
it("붙여 넣은 그림도 같다 — 올리는 사이 고른 카드가 바뀌면 지금 카드의 레퍼런스에 넣지 않는다", async () => {
  type Capture = { project: string; path: string; name: string; type: string };
  const upload = deferred<Capture>();
  const uploadCapture = vi.fn(() => upload.promise);
  Object.assign(boundary.api, { uploadCapture });
  const onChange = vi.fn((refs: unknown[]) => refs);
  const capture = (): Capture => ({ project: "captures", path: "shot.png", name: "shot.png", type: "image" });
  const paste = () => act(() => {
    const image = new File(["x"], "shot.png", { type: "image/png" });
    editor().dispatchEvent(Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
      clipboardData: { items: [{ type: "image/png", getAsFile: () => image }], getData: () => "" },
    }));
  });
  view = await mountPrompt({ trayBinding: binding("a", 1), onTrayBindingRefsChange: onChange as never });
  paste(); // A 를 고른 채 붙여 넣었다 — 올리는 중
  await settle();
  expect(uploadCapture).toHaveBeenCalledTimes(1);
  await view.render({ trayBinding: binding("b", 2) }); // 그사이 B 를 골랐다
  onChange.mockClear();
  await act(async () => { upload.resolve(capture()); });
  await settle();
  expect([trayCount(), onChange.mock.calls.length]).toEqual([2, 0]); // 전엔 B 의 트레이에 붙고 B 에 저장됐다
  expect(view.container.textContent).toContain("고른 카드가 바뀌어");

  uploadCapture.mockImplementation(() => Promise.resolve(capture())); // 카드가 그대로면 전처럼 넣는다
  paste();
  await settle();
  expect(trayCount()).toBe(3);
});

const promptGen = (id: string, prompt: string) => ({
  id, prompt, display_prompt: null, model: "nano_banana_flash", params: {}, references: [], assets: [], tags: [],
});
const reuse = (id: string) => act(() => { window.dispatchEvent(new CustomEvent("ch:reuse-prompt", { detail: id })); });
const typeNew = (text: string) => act(() => {
  editor().textContent = text;
  editor().dispatchEvent(new Event("input", { bubbles: true }));
});

// Codex 코드 리뷰: 묶임의 이름만 견주면 A → B → A 로 다녀온 경우를 못 거른다 — 돌아와 친 새 글을 옛 응답이 덮는다.
it("프롬프트 재사용 — 받아 오는 사이 다른 카드에 다녀왔으면 입력칸을 갈아 치우지 않는다(돌아와 친 새 글이 남는다)", async () => {
  const fetched = deferred<unknown>();
  boundary.api.getGeneration.mockImplementationOnce(() => fetched.promise);
  view = await mountPrompt({ trayBinding: binding("a", 0) });
  reuse("g1");
  await settle();
  await view.render({ trayBinding: binding("b", 0) });
  await view.render({ trayBinding: binding("a", 0) }); // 돌아왔다
  typeNew("돌아와서 친 새 글");
  await act(async () => { fetched.resolve(promptGen("g1", "옛 재사용 프롬프트")); });
  await settle();
  expect(editor().textContent).toBe("돌아와서 친 새 글");

  boundary.api.getGeneration.mockImplementationOnce(() => Promise.resolve(promptGen("g2", "새로 재사용한 프롬프트"))); // 그대로 있으면 전처럼 갈아 치운다
  reuse("g2");
  await settle();
  expect(editor().textContent).toBe("새로 재사용한 프롬프트");
});

it("프롬프트 재사용을 잇달아 둘 누르면 나중 것이 남는다 — 응답이 뒤바뀌어 와도", async () => {
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  boundary.api.getGeneration.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
  view = await mountPrompt({ trayBinding: binding("a", 0) });
  reuse("g1");
  reuse("g2");
  await settle();
  await act(async () => { second.resolve(promptGen("g2", "둘째로 누른 프롬프트")); });
  await settle();
  expect(editor().textContent).toBe("둘째로 누른 프롬프트");
  await act(async () => { first.resolve(promptGen("g1", "첫째로 누른 프롬프트")); }); // 늦게 온 첫 응답
  await settle();
  expect(editor().textContent).toBe("둘째로 누른 프롬프트");
});

it("'레퍼런스로 사용'도 같다 — 생성물을 받아 오는 사이 고른 카드가 바뀌면 넣지 않는다", async () => {
  const fetched = deferred<unknown>();
  const generation = { id: "reference-fixture", source_name: "시험 이미지", tags: [],
    assets: [{ type: "image", file_path: "/fixtures/reference.png", thumbnail_path: "/fixtures/reference.png" }] };
  boundary.api.getGeneration.mockImplementationOnce(() => fetched.promise);
  const onChange = vi.fn((refs: unknown[]) => refs);
  view = await mountPrompt({ trayBinding: binding("a", 1), onTrayBindingRefsChange: onChange as never });
  act(() => { window.dispatchEvent(new CustomEvent("ch:add-reference", { detail: "reference-fixture" })); });
  await settle();
  await view.render({ trayBinding: binding("b", 2) });
  onChange.mockClear();
  await act(async () => { fetched.resolve(generation); });
  await settle();
  expect([trayCount(), onChange.mock.calls.length]).toEqual([2, 0]);

  act(() => { window.dispatchEvent(new CustomEvent("ch:add-reference", { detail: "reference-fixture" })); }); // 그대로면 넣는다
  await settle();
  expect(trayCount()).toBe(3);
});
