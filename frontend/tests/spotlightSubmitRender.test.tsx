// @vitest-environment jsdom
import { act, useRef, useState, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { useSpotlightSubmit } from "../src/components/spotlight/useSpotlightSubmit";
import type { SpotlightTrayRef } from "../src/components/spotlight/SpotlightRefTray";
import type { HistEntry } from "../src/lib/promptEditor";
import { restoreParts } from "../src/lib/promptEditor";
import type { Generation } from "../src/types";

// 실제 제출 훅·contentEditable 직렬화·Seedance 빌더·비율 처리·히스토리 저장을 실행한다.
// 유료 경계인 API만 가짜 응답으로 대체한다. fetch는 항상 실패하므로 실제 서버에 갈 수 없다.
vi.mock("../src/api", () => ({ api: { prepareCreate: vi.fn() } }));

type Options = Parameters<typeof useSpotlightSubmit>[0];
type Submit = ReturnType<typeof useSpotlightSubmit>;
type Props = Partial<Options>;

const sourceText = "두 캐릭터가 @image1 위를 본다.\n@image10의 조명을 유지한다.";
const target = { sceneId: "scene-fixture", cardId: "card-fixture" };
const prepareCreate = vi.mocked(api.prepareCreate);
const noop = () => {};
const tenReferences = (): SpotlightTrayRef[] => Array.from({ length: 10 }, (_, index) => ({
  uid: `reference-${index}`,
  file_path: `https://fixture.invalid/ref-${index}.png`,
  type: "image",
  role: "",
  name: `reference ${index + 1}`,
  thumb: "",
}));

function generation(id = "fixture-result"): Generation {
  return { id, prompt: sourceText, model: "seedance_2_5", status: "pending", assets: [], tags: [] } as unknown as Generation;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

let root: Root;
let host: HTMLDivElement;
let editor: HTMLDivElement;
let submit: Submit;
let props: Props;
let history: MutableRefObject<HistEntry[]>;
let errors: Array<string | null>;
let fetchGuard: ReturnType<typeof vi.fn>;
let linkNumber: number;
const clearMention = vi.fn();
const notifyPromptChanged = vi.fn();
const onCreated = vi.fn();
const onCanvasBatchCreated = vi.fn();
const settleCanvasGeneration = vi.fn();
const discardCanvasGeneration = vi.fn();

function Harness({ options }: { options: Props }) {
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  const editorRef = useRef(editor);
  const historyRef = useRef<HistEntry[]>([]);
  const dragParentRef = useRef<string | null>(null);
  history = historyRef;
  submit = useSpotlightSubmit({
    activeProjectId: undefined,
    armedAutoTags: [],
    busy,
    count: 1,
    dragParentRef,
    editorRef,
    historyRef,
    inCompose: true,
    preservePromptAfterSubmit: true,
    promptContextKey: "scene-fixture:card-fixture:text-source",
    model: "seedance_2_5",
    onCreated,
    canvasTarget: target,
    prepareCanvasGeneration: (destination, count) => Array.from({ length: count }, () => ({
      attempt_id: `attempt-${++linkNumber}`,
      generation_id: `generation-${linkNumber}`,
      scene_id: destination.sceneId,
      card_id: destination.cardId,
    })),
    settleCanvasGeneration,
    discardCanvasGeneration,
    onCanvasBatchCreated,
    optionValues: { mode: "omni_reference", duration: 30, aspect_ratio: "16:9", resolution: "1080p" },
    paramsLoading: false,
    paramsModel: "seedance_2_5",
    trayRefs: tenReferences(),
    tunable: [],
    workspace: { scope: "personal", id: null, name: null },
    setBusy,
    setError: (message) => { errors.push(message); },
    clearMention,
    updatePlaceholder: noop,
    notifyPromptChanged: () => { notifyPromptChanged(); tick((value) => value + 1); },
    ...options,
  });
  return null;
}

async function mount(options: Props = {}, text = sourceText) {
  props = options;
  restoreParts(editor, text ? [{ t: "text", v: text }] : []);
  await act(async () => { root.render(<Harness options={props} />); });
}

async function rerender(changes: Props) {
  props = { ...props, ...changes };
  await act(async () => { root.render(<Harness options={props} />); });
}

async function run(count?: number) {
  await act(async () => { await submit(count); });
}

async function beginPending() {
  let pending!: Promise<void>;
  await act(async () => { pending = submit(); await Promise.resolve(); });
  expect(prepareCreate).toHaveBeenCalledTimes(1);
  return { pending };
}

beforeEach(() => {
  vi.clearAllMocks();
  prepareCreate.mockImplementation(() => async () => generation());
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  fetchGuard = vi.fn(() => { throw new Error("시험 중 실제 네트워크 호출 금지"); });
  vi.stubGlobal("fetch", fetchGuard);
  localStorage.clear();
  errors = [];
  linkNumber = 0;
  host = document.createElement("div");
  editor = document.createElement("div");
  editor.contentEditable = "true";
  document.body.append(host, editor);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  editor.remove();
  expect(fetchGuard).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("실제 프롬프트 제출: 캔버스 연속 생성과 응답 후 편집 보존", () => {
  it("동일 캔버스 카드에서 두 번 제출해도 Text 노드 프롬프트·레퍼런스 10개가 같다", async () => {
    await mount();
    await run();
    await run();

    expect(prepareCreate).toHaveBeenCalledTimes(2);
    for (const [body, , link] of prepareCreate.mock.calls) {
      expect(body.prompt).toBe("두 캐릭터가 <<<image1>>> 위를 본다. <<<image10>>>의 조명을 유지한다.");
      expect(body.display_prompt).toBe(sourceText);
      expect(body.references).toHaveLength(10);
      expect(body.params).toMatchObject({ mode: "omni_reference", duration: 30, resolution: "1080p", aspect_ratio: "16:9" });
      expect(link).toMatchObject({ scene_id: target.sceneId, card_id: target.cardId });
    }
    expect(editor.textContent).toContain("두 캐릭터");
    expect(history.current).toHaveLength(1);
    expect(history.current[0].text).toBe(sourceText);
    expect(errors.filter(Boolean)).toEqual([]);
  });

  it("라이브러리는 정상 성공하면 기존대로 입력창을 비운다", async () => {
    await mount({ inCompose: false, canvasTarget: null, preservePromptAfterSubmit: false, promptContextKey: null });
    await run();
    expect(editor.innerHTML).toBe("");
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onCanvasBatchCreated).not.toHaveBeenCalled();
    expect(notifyPromptChanged).toHaveBeenCalledTimes(1);
  });

  it("연결 Text가 없는 일반 캔버스 카드는 기존대로 입력창을 비운다", async () => {
    await mount({ preservePromptAfterSubmit: false, promptContextKey: "scene-fixture:card-fixture:own-draft" });
    await run();
    expect(editor.innerHTML).toBe("");
    expect(onCanvasBatchCreated).toHaveBeenCalledTimes(1);
    expect(notifyPromptChanged).toHaveBeenCalledTimes(1);
  });

  it("의도적으로 텍스트 없이 레퍼런스만 넣은 생성은 계속 허용한다", async () => {
    await mount({ preservePromptAfterSubmit: false }, "");
    await run();
    const [body] = prepareCreate.mock.calls[0];
    expect(body.prompt).toBe("(no text)");
    expect(body.display_prompt).toBeUndefined();
    expect(body.references).toHaveLength(10);
    expect(errors.filter(Boolean)).toEqual([]);
  });

  it("파생 Text를 편집기에서 임시 수정해도 원본으로 강제 복구하지 않는다", async () => {
    await mount();
    restoreParts(editor, [{ t: "text", v: "@image1의 색만 다르게 표현한다." }]);
    await run();
    expect(prepareCreate.mock.calls[0][0].display_prompt).toBe("@image1의 색만 다르게 표현한다.");
    expect(editor.textContent).toBe("@image1의 색만 다르게 표현한다.");
    expect(notifyPromptChanged).not.toHaveBeenCalled();
  });

  it("파생 Text가 있어도 사용자가 편집기를 직접 비운 refs-only 의도는 유지한다", async () => {
    await mount();
    restoreParts(editor, []);
    await run();
    expect(prepareCreate.mock.calls[0][0].prompt).toBe("(no text)");
    expect(prepareCreate.mock.calls[0][0].references).toHaveLength(10);
    expect(errors.filter(Boolean)).toEqual([]);
  });

  it("텍스트·레퍼런스가 모두 없으면 제출하지 않는다", async () => {
    await mount({ trayRefs: [] }, "");
    await run();
    expect(prepareCreate).not.toHaveBeenCalled();
    expect(errors).toContain("프롬프트를 입력하세요.");
  });

  it("모든 요청이 실패하면 캔버스 입력·히스토리를 보존한다", async () => {
    prepareCreate.mockImplementation(() => async () => { throw new Error("fixture failure"); });
    await mount();
    const before = editor.innerHTML;
    await run();
    expect(editor.innerHTML).toBe(before);
    expect(history.current).toEqual([]);
    expect(errors.filter(Boolean)).toEqual(["Error: fixture failure"]);
    expect(onCanvasBatchCreated).not.toHaveBeenCalled();
  });

  it("배치 일부만 성공해도 같은 캔버스 프롬프트로 다시 제출할 수 있다", async () => {
    prepareCreate
      .mockImplementationOnce(() => async () => generation("successful-part"))
      .mockImplementationOnce(() => async () => { throw new Error("failed part"); });
    await mount();
    await run(2);
    expect(errors).toContain("2장 중 1장 제출 실패 — 성공한 요청은 계속 진행됩니다.");
    expect(onCanvasBatchCreated.mock.calls[0][0]).toHaveLength(1);
    await run();
    expect(prepareCreate.mock.calls[2][0].display_prompt).toBe(sourceText);
    expect(prepareCreate.mock.calls[2][0].prompt).not.toBe("(no text)");
  });

  it("응답을 기다리며 새로 입력한 라이브러리 프롬프트를 지우지 않는다", async () => {
    const response = deferred<Generation>();
    prepareCreate.mockImplementation(() => () => response.promise);
    await mount({ inCompose: false, canvasTarget: null, preservePromptAfterSubmit: false, promptContextKey: null });
    const { pending } = await beginPending();
    restoreParts(editor, [{ t: "text", v: "다음 작업의 새 프롬프트" }]);
    await act(async () => { response.resolve(generation()); await pending; });
    expect(editor.textContent).toBe("다음 작업의 새 프롬프트");
    expect(history.current[0].text).toBe(sourceText);
    expect(notifyPromptChanged).not.toHaveBeenCalled();
  });

  it("응답을 기다리며 다른 카드로 바뀌면 그 카드의 같은 내용도 지우지 않는다", async () => {
    const response = deferred<Generation>();
    prepareCreate.mockImplementation(() => () => response.promise);
    await mount({ inCompose: false, canvasTarget: null, preservePromptAfterSubmit: false, promptContextKey: null });
    const { pending } = await beginPending();
    await rerender({ inCompose: true, canvasTarget: { sceneId: "scene-other", cardId: "card-other" } });
    const before = editor.innerHTML;
    await act(async () => { response.resolve(generation()); await pending; });
    expect(editor.innerHTML).toBe(before);
    expect(notifyPromptChanged).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("캔버스 제출 후 라이브러리로 바뀌어도 새 초안을 보존한다", async () => {
    const response = deferred<Generation>();
    prepareCreate.mockImplementation(() => () => response.promise);
    await mount();
    const { pending } = await beginPending();
    await rerender({ inCompose: false, canvasTarget: null });
    restoreParts(editor, [{ t: "text", v: "라이브러리 새 초안" }]);
    await act(async () => { response.resolve(generation()); await pending; });
    expect(editor.textContent).toBe("라이브러리 새 초안");
    expect(onCanvasBatchCreated).toHaveBeenCalledTimes(1);
    expect(settleCanvasGeneration).toHaveBeenCalledTimes(1);
    expect(prepareCreate.mock.calls[0][2]?.card_id).toBe(target.cardId);
  });

  it("다른 카드로 갔다가 원래 컨텍스트로 돌아와도 늦은 응답이 초안을 지우지 않는다", async () => {
    const response = deferred<Generation>();
    prepareCreate.mockImplementation(() => () => response.promise);
    await mount({ preservePromptAfterSubmit: false, promptContextKey: "context-a" });
    const { pending } = await beginPending();
    await rerender({ canvasTarget: { sceneId: target.sceneId, cardId: "card-b" }, promptContextKey: "context-b" });
    await rerender({ canvasTarget: target, promptContextKey: "context-a" });
    const before = editor.innerHTML;
    await act(async () => { response.resolve(generation()); await pending; });
    expect(editor.innerHTML).toBe(before);
    expect(notifyPromptChanged).not.toHaveBeenCalled();
  });

  it("같은 카드라도 연결 프롬프트 컨텍스트가 바뀌면 늦은 응답이 지우지 않는다", async () => {
    const response = deferred<Generation>();
    prepareCreate.mockImplementation(() => () => response.promise);
    await mount({ preservePromptAfterSubmit: false, promptContextKey: "source-a" });
    const { pending } = await beginPending();
    await rerender({ promptContextKey: "source-b" });
    const before = editor.innerHTML;
    await act(async () => { response.resolve(generation()); await pending; });
    expect(editor.innerHTML).toBe(before);
    expect(notifyPromptChanged).not.toHaveBeenCalled();
  });

  it("개인→팀→개인 워크스페이스 왕복 뒤에도 이전 응답이 입력을 지우지 않는다", async () => {
    const response = deferred<Generation>();
    prepareCreate.mockImplementation(() => () => response.promise);
    await mount({ inCompose: false, canvasTarget: null, preservePromptAfterSubmit: false, promptContextKey: null });
    const { pending } = await beginPending();
    await rerender({ workspace: { scope: "team", id: "team-fixture", name: "테스트 팀" } });
    await rerender({ workspace: { scope: "personal", id: null, name: null } });
    const before = editor.innerHTML;
    await act(async () => { response.resolve(generation()); await pending; });
    expect(editor.innerHTML).toBe(before);
    expect(notifyPromptChanged).not.toHaveBeenCalled();
  });
});
