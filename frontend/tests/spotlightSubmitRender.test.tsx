import { configureOperationContext } from "../src/app/operationContext";
import { preparedFixture } from "./preparedSubmissionFixture";
// @vitest-environment jsdom
import { act, useRef, useState, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { useSpotlightSubmit } from "../src/components/spotlight/useSpotlightSubmit";
import type { SpotlightTrayRef } from "../src/components/spotlight/SpotlightRefTray";
import type { HistEntry } from "../src/lib/promptEditor";
import { restoreParts } from "../src/lib/promptEditor";
import { setLang } from "../src/lib/i18n";
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
const reload = vi.fn();
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
    reload,
    canvasTarget: target,
    prepareCanvasGeneration: (destination, count) => Array.from({ length: count }, () => ({
      attempt_id: `attempt-${++linkNumber}`,
      generation_id: `generation-${linkNumber}`,
      scene_id: destination.sceneId,
      card_id: destination.cardId,
    })),
    confirmCanvasGeneration: () => true,
    settleCanvasGeneration,
    discardCanvasGeneration,
    onCanvasBatchCreated,
    optionValues: { mode: "omni_reference", duration: 30, aspect_ratio: "16:9", resolution: "1080p" },
    paramsLoading: false,
    paramsModel: "seedance_2_5",
    trayRefs: tenReferences(),
    trayReady: true,
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
  setLang("ko");
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
  setLang("ko");
  await act(async () => { root.unmount(); });
  host.remove();
  editor.remove();
  expect(fetchGuard).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("실제 프롬프트 제출: 캔버스 연속 생성과 응답 후 편집 보존", () => {
  it.each([false, true])("카드 반영 실패는 서버 성공을 보존하고 제출 실패와 구분한다(다른 요청 거절=%s)", async (rejectOther) => {
    let call = 0;
    prepareCreate.mockImplementation((_body, _workspace, link) => {
      const index = call++;
      return async () => {
        if (rejectOther && index === 1) throw Object.assign(new Error("server rejected"), { status: 400 });
        return generation(link!.generation_id);
      };
    });
    // 상태 코드가 붙은 로컬 오류라도 서버 거절로 취급해 성공 표식을 버리면 안 된다.
    settleCanvasGeneration.mockImplementationOnce(() => { throw Object.assign(new Error("card write failed"), { status: 400 }); });
    await mount();
    await run(2);
    expect(onCanvasBatchCreated).toHaveBeenCalledTimes(1);
    expect(onCanvasBatchCreated.mock.calls[0][0]).toHaveLength(rejectOther ? 1 : 2);
    expect(discardCanvasGeneration).toHaveBeenCalledTimes(rejectOther ? 1 : 0);
    expect(errors.at(-1)).toContain("1장 화면 반영 실패");
    if (rejectOther) expect(errors.at(-1)).toContain("1장 제출 실패");
    else expect(errors.at(-1)).not.toContain("제출 실패");
    expect(prepareCreate).toHaveBeenCalledTimes(2);
  });

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

  // 2026-10-11 Codex 코드 리뷰: 묶인 카드(씬)가 막 바뀐 한 박자에는 트레이가 아직 앞 카드의 레퍼런스다 — 그때의 제출은 앞 카드의
  //  레퍼런스로 나갔다(씬을 바꾼 직후에는 대상 카드가 없어 캔버스 연결 없는 일반 생성으로). 글 없이 레퍼런스만 있는 요청도 정상 요청이라
  //  '빈 입력' 검사가 막지 못한다.
  it("트레이가 지금의 묶임에 맞춰지기 전(trayReady 거짓)의 제출은 나가지 않는다 — 글이 없고 앞 카드의 레퍼런스만 남은 경우도", async () => {
    await mount({ trayReady: false, canvasTarget: null }, "");
    await run();
    expect(prepareCreate).not.toHaveBeenCalled();
    expect(errors).toEqual([]); // 오류 문구도 띄우지 않는다 — 그 키는 지나간 화면의 것이다

    await rerender({ trayReady: true }); // 트레이가 맞춰진 뒤(여기서는 같은 레퍼런스로)에는 평소대로
    await run();
    expect(prepareCreate).toHaveBeenCalledTimes(1);
  });

  it("라이브러리는 정상 성공하면 기존대로 입력창을 비운다", async () => {
    await mount({ inCompose: false, canvasTarget: null, preservePromptAfterSubmit: false, promptContextKey: null });
    await run();
    expect(editor.innerHTML).toBe("");
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onCanvasBatchCreated).not.toHaveBeenCalled();
    expect(notifyPromptChanged).toHaveBeenCalledTimes(1);
  });

  it("라이브러리는 성공하면 보낸 레퍼런스(uid)도 비우라고 알린다 — 접수 불명이면 알리지 않는다(Jay 10-23)", async () => {
    const cleared = vi.fn();
    await mount({ inCompose: false, canvasTarget: null, preservePromptAfterSubmit: false, promptContextKey: null, clearSubmittedRefs: cleared });
    await run();
    expect(cleared).toHaveBeenCalledTimes(1);
    expect([...cleared.mock.calls[0][0]]).toEqual(tenReferences().map((ref) => ref.uid));
    prepareCreate.mockImplementationOnce(() => async () => { throw new TypeError("Failed to fetch"); });
    restoreParts(editor, [{ t: "text", v: sourceText }]);
    await run();
    expect(cleared).toHaveBeenCalledTimes(1); // 접수 불명 — 프롬프트도 레퍼런스도 그대로
  });

  it("응답을 기다리며 프롬프트를 고쳤으면 레퍼런스도 비우라고 하지 않는다", async () => {
    const cleared = vi.fn();
    const response = deferred<Generation>();
    prepareCreate.mockImplementation(() => () => response.promise);
    await mount({ inCompose: false, canvasTarget: null, preservePromptAfterSubmit: false, promptContextKey: null, clearSubmittedRefs: cleared });
    const { pending } = await beginPending();
    restoreParts(editor, [{ t: "text", v: "다음 작업의 새 프롬프트" }]);
    await act(async () => { response.resolve(generation()); await pending; });
    expect(cleared).not.toHaveBeenCalled();
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

  // 저장소가 꽉 차면 App 의 prepareCanvasGenerationBatch 가 빈 배열을 돌려준다(저장 실패).
  // 그 상태로 제출하면 '어느 카드 것인지' 표식이 없는 생성이 서버에 남아, 응답 전에 창이 닫히면
  // 결과를 영영 못 잇는다. 그래서 링크가 batch 수만큼 안 나오면 요청을 아예 보내지 않는다.
  it("캔버스 표식을 저장하지 못하면 생성 요청을 보내지 않는다", async () => {
    await mount({ prepareCanvasGeneration: () => [] });
    await run();
    expect(prepareCreate).not.toHaveBeenCalled();
    expect(errors.filter(Boolean)).toEqual([
      "Error: 캔버스 생성 위치를 저장하지 못했습니다. 씬을 다시 선택한 뒤 시도하세요.",
    ]);
  });

  it("모든 요청이 확실히 거절되면 캔버스 입력·히스토리를 보존한다", async () => {
    prepareCreate.mockImplementation(() => async () => { throw Object.assign(new Error("fixture failure"), { status: 400 }); });
    await mount();
    const before = editor.innerHTML;
    await run();
    expect(editor.innerHTML).toBe(before);
    expect(history.current).toEqual([]);
    expect(errors.filter(Boolean)).toEqual(["Error: fixture failure"]);
    expect(onCanvasBatchCreated).not.toHaveBeenCalled();
  });

  it.each([
    ["모름 1건", ["unknown"]],
    ["모름 1건과 성공", ["unknown", "accepted"]],
    ["전부 모름", ["unknown", "unknown"]],
    ["모름과 확실한 실패", ["unknown", "rejected", "prepare_failed"]],
  ])("%s은 접수 확인을 안내하고 입력과 미확정 표식을 보존한다", async (_name, kinds) => {
    for (const kind of kinds) {
      prepareCreate.mockImplementationOnce(() => {
        return async () => {
          if (kind === "unknown") throw new TypeError("Failed to fetch");
          if (kind === "rejected") throw Object.assign(new Error("rejected"), { status: 400 });
          return generation();
        };
      });
    }
    let confirmation = 0;
    await mount({ preservePromptAfterSubmit: false,
      confirmCanvasGeneration: () => kinds[confirmation++] !== "prepare_failed" });
    const before = editor.innerHTML;
    await run(kinds.length);
    expect(editor.innerHTML).toBe(before);
    expect(notifyPromptChanged).not.toHaveBeenCalled();
    expect(errors.at(-1)).toContain("접수 여부를 확인하지 못했습니다");
    expect(errors.at(-1)).toContain("다시 제출하지 말고");
    expect(errors.at(-1)).not.toContain("Failed to fetch");
    const failed = kinds.filter(kind => kind === "rejected" || kind === "prepare_failed").length;
    expect(discardCanvasGeneration).toHaveBeenCalledTimes(failed);
    if (failed) expect(errors.at(-1)).toContain(`${failed}장 제출 실패`);
    else expect(errors.at(-1)).not.toContain("제출 실패");
    expect(onCanvasBatchCreated).toHaveBeenCalledTimes(kinds.includes("accepted") ? 1 : 0);
    expect(reload).not.toHaveBeenCalled();
  });

  it.each(["ko", "en"] as const)("라이브러리 접수 불명은 목록을 한 번 갱신하고 %s 안내와 입력을 보존한다", async (lang) => {
    setLang(lang);
    prepareCreate.mockImplementationOnce(() => async () => { throw new TypeError("Failed to fetch"); });
    await mount({ inCompose: false, canvasTarget: null, preservePromptAfterSubmit: false, promptContextKey: null });
    const before = editor.innerHTML;
    await run();
    expect(editor.innerHTML).toBe(before);
    expect(history.current).toEqual([]);
    expect(onCreated).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(errors.at(-1)).toBe(lang === "ko"
      ? "1장 요청의 접수 여부를 확인하지 못했습니다. 다시 제출하지 말고 생성 목록에서 기존 요청을 확인하세요."
      : "Could not confirm acceptance of 1 requests. Do not submit again; check existing requests in the generation list.");
    await run();
    expect(prepareCreate).toHaveBeenCalledTimes(2);
    expect(editor.innerHTML).toBe("");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("영어 부분 실패 안내는 성공 유무를 구분한다(성공=%s)", async (accepted) => {
    setLang("en");
    prepareCreate.mockImplementationOnce(() => async () => { throw Object.assign(new Error("rejected"), { status: 400 }); });
    prepareCreate.mockImplementationOnce(() => async () => {
      if (!accepted) throw new TypeError("Failed to fetch");
      return generation();
    });
    await mount();
    await run(2);
    expect(errors.at(-1)).toContain(accepted
      ? "1 of 2 requests failed to submit — accepted requests will continue."
      : "1 of 2 requests failed to submit.");
    expect(reload).not.toHaveBeenCalled();
  });

  // Codex 62회차(4B) — 다른 탭 로그아웃으로 멈춰 보내지 못한 요청은 '나갔을 수 있는' 것이 아니다. 표식을 남기면 대기 카드가 남는다.
  it("멈춤으로 보내지 못한 요청은 캔버스 대기 표식을 치우고, 답을 못 받은 요청은 남긴다", async () => {
    const { ApiPausedError } = await import("../src/lib/http");
    prepareCreate.mockImplementation(() => async () => { throw new ApiPausedError("paused"); });
    await mount();
    await run();
    expect(discardCanvasGeneration).toHaveBeenCalledTimes(1);
    discardCanvasGeneration.mockClear();
    prepareCreate.mockImplementation(() => async () => { throw new TypeError("Failed to fetch"); });
    await run();
    expect(discardCanvasGeneration).not.toHaveBeenCalled();
  });

  it("배치 일부만 성공해도 같은 캔버스 프롬프트로 다시 제출할 수 있다", async () => {
    prepareCreate
      .mockImplementationOnce(() => async () => generation("successful-part"))
      .mockImplementationOnce(() => async () => { throw Object.assign(new Error("failed part"), { status: 400 }); });
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

  // 2026-10-12(조작 점검 10회차, Codex 검토): 응답을 기다리는 사이 검색칸으로 옮긴 초점을 성공 처리가 프롬프트로 가져가, 치던 글자가 프롬프트에 들어갔다.
  it("응답을 기다리며 다른 입력칸으로 옮긴 초점은 가져오지 않는다 — 갈 곳을 잃었을 때만 프롬프트로 돌려준다", async () => {
    const response = deferred<Generation>();
    prepareCreate.mockImplementation(() => () => response.promise);
    await mount({ inCompose: false, canvasTarget: null, preservePromptAfterSubmit: false, promptContextKey: null });
    const search = document.createElement("input");
    // 실제 화면처럼: 프롬프트 패널 안에 입력칸·옵션 입력(길이·시드 등)·생성 단추가 같이 있다
    const panel = document.createElement("div");
    panel.className = "sl-panel";
    const option = document.createElement("input");
    const generate = document.createElement("button");
    generate.className = "sl-gen";
    document.body.append(search, panel);
    panel.append(editor, option, generate);
    editor.tabIndex = 0; // jsdom 에서도 초점을 받게
    try {
      editor.focus();
      const { pending } = await beginPending();
      search.focus(); // 응답 전에 검색칸으로 갔다
      await act(async () => { response.resolve(generation()); await pending; });
      expect(editor.innerHTML).toBe(""); // 제출한 프롬프트는 비워졌다
      expect(document.activeElement).toBe(search); // 초점은 그대로

      prepareCreate.mockImplementation(() => async () => generation());
      const submitWithFocusOn = async (focused: HTMLElement | null) => {
        restoreParts(editor, [{ t: "text", v: "다음 프롬프트" }]);
        if (focused) focused.focus();
        else (document.activeElement as HTMLElement | null)?.blur();
        await run();
        return document.activeElement;
      };
      expect(await submitWithFocusOn(option)).toBe(option); // 패널 안이라도 옵션 입력으로 옮긴 초점은 둔다
      expect(await submitWithFocusOn(null)).toBe(editor); // 초점이 갈 곳을 잃었으면(BODY) 전처럼 프롬프트로
      expect(await submitWithFocusOn(generate)).toBe(editor); // 마우스로 누른 생성 단추에 남은 초점도 프롬프트로
    } finally {
      document.body.append(editor); // 뒷정리(afterEach)가 떼는 자리로
      search.remove();
      panel.remove();
    }
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

vi.mock("../src/features/generation/api", async (original) => ({
  ...await original<typeof import("../src/features/generation/api")>(),
  prepareCreateSubmission: (...args: Parameters<typeof import("../src/features/generation/api").prepareCreateSubmission>) => preparedFixture(api.prepareCreate(args[0], args[1], args[2]), args[1], args[2], args[3]),
  prepareRegenerateSubmission: (...args: Parameters<typeof import("../src/features/generation/api").prepareRegenerateSubmission>) => preparedFixture(api.prepareRegenerate(args[0], args[1], args[2], args[3]), args[2], args[3], args[4]),
}));

it("계정 세대가 바뀐 뒤 받은 접수 결과를 새 화면/카드에 쓰지 않는다", async () => {
  let done!: (generation: Generation) => void;
  prepareCreate.mockImplementation(() => () => new Promise(resolve => { done = resolve; }));
  await mount();
  const { pending } = await beginPending();
  const before = editor.innerHTML;
  configureOperationContext({ key: "different-account", serverOrigin: "http://different.invalid", authority: "team", ready: true });
  await act(async () => { done(generation()); await pending; });
  expect(settleCanvasGeneration).not.toHaveBeenCalled();
  expect(discardCanvasGeneration).not.toHaveBeenCalled();
  expect(onCreated).not.toHaveBeenCalled();
  expect(onCanvasBatchCreated).not.toHaveBeenCalled();
  expect(editor.innerHTML).toBe(before);
});
