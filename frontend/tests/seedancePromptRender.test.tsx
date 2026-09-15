// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  button, click, deferred, expectShownMode, installPromptBoundaryMocks, installPromptStyles,
  mountPrompt, required, SEEDANCE_PARAMS, settle, type PromptProps,
} from "./seedanceRenderHarness";

// 실물: SpotlightPrompt, useModels, useSpotlightTray, promptEditor, SpotlightOptionsBar.
// 가짜: 모델/비용/레퍼런스 API 응답, 정책 응답, 서버 콘솔. 네트워크·CLI 실행 없음.
let boundary: ReturnType<typeof installPromptBoundaryMocks>;
let view: Awaited<ReturnType<typeof mountPrompt>> | undefined;
let style: HTMLStyleElement;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  boundary = installPromptBoundaryMocks();
  style = installPromptStyles();
});

afterEach(() => {
  view?.dispose();
  view = undefined;
  style?.remove();
  vi.unstubAllGlobals();
  expect(boundary.fetch).not.toHaveBeenCalled();
  expect(boundary.api.prepareCreate).not.toHaveBeenCalled();
});

function binding(mode: string, key = "scene:card"): NonNullable<PromptProps["trayBinding"]> {
  return {
    key, refs: [], prompt: "시험 프롬프트", modelKey: `${key}:${mode}`,
    model: { model: "seedance_2_5", type: "video", params: {
      mode, duration: 5, aspect_ratio: "16:9", ...(mode === "video_extension" ? { extension_mode: "forward" } : {}),
    } },
  };
}

async function addReference() {
  const { APP_EVENTS } = await import("../src/lib/appEvents");
  act(() => { window.dispatchEvent(new CustomEvent(APP_EVENTS.addReference, { detail: "reference-fixture" })); });
  await settle();
}

describe("Seedance 2.5 프롬프트의 실제 모드 표시", () => {
  it("트레이 추가/제거와 수동 t2v 선택을 따라 자동으로 맞춘다", async () => {
    view = await mountPrompt({ trayBinding: binding("omni_reference") });
    expectShownMode(view.container, "t2v");
    await addReference();
    expect(view.container.querySelectorAll(".sl-reftray-item")).toHaveLength(1);
    expectShownMode(view.container, "omni_reference");
    click(button(required(view.container, ".sl-adv-pop"), "t2v"));
    await settle();
    expectShownMode(view.container, "omni_reference");
    click(required(view.container, ".sl-reftray-x"));
    await settle();
    expect(view.container.querySelectorAll(".sl-reftray-item")).toHaveLength(0);
    expectShownMode(view.container, "t2v");
    click(button(required(view.container, ".sl-adv-pop"), "omni_reference"));
    await settle();
    expectShownMode(view.container, "t2v");
  });

  it("인라인 칩 추가와 키보드 비우기로 omni → t2v를 표시한다", async () => {
    view = await mountPrompt({ expanded: false, trayBinding: binding("t2v") });
    expectShownMode(view.container, "t2v");
    await addReference();
    expect(view.container.querySelectorAll(".inline-ref")).toHaveLength(1);
    expectShownMode(view.container, "omni_reference");
    const editor = required(view.container, '[contenteditable="true"]');
    act(() => { editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", code: "Backspace", shiftKey: true, bubbles: true })); });
    await settle();
    expect(view.container.querySelectorAll(".inline-ref")).toHaveLength(0);
    expectShownMode(view.container, "t2v");
  });

  it("인라인 칩 × 제거만으로 t2v로 돌아온다 (추가 input 이벤트로 보정하지 않음)", async () => {
    view = await mountPrompt({ expanded: false, trayBinding: binding("t2v") });
    await addReference();
    expectShownMode(view.container, "omni_reference");
    // 실제 ×는 click이 아니라 mousedown에서 DOM을 지운다.
    act(() => { required(view!.container, ".inline-ref-remove").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); });
    await settle();
    expect(view.container.querySelectorAll(".inline-ref")).toHaveLength(0);
    expectShownMode(view.container, "t2v");
  });

  it("다른 모델의 복원된 인라인 칩도 × 삭제를 초안과 placeholder에 반영한다", async () => {
    const onDraft = vi.fn();
    view = await mountPrompt({
      expanded: false, onTrayBindingPromptChange: onDraft,
      trayBinding: {
        key: "scene:image", refs: [], modelKey: "image",
        model: { model: "nano_banana_flash", type: "image", params: {} },
        prompt: JSON.stringify([{ t: "chip", ref: {
          file_path: "/fixtures/reference.png", type: "image", role: "@Image1", name: "시험 이미지", thumb: "",
        } }]),
      },
    });
    expect(view.container.querySelectorAll(".inline-ref")).toHaveLength(1);
    onDraft.mockClear();
    act(() => { required(view!.container, ".inline-ref-remove").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); });
    await settle();
    expect(view.container.querySelectorAll(".inline-ref")).toHaveLength(0);
    expect(required(view.container, '[contenteditable="true"]').hasAttribute("data-empty")).toBe(true);
    expect(onDraft).toHaveBeenCalledTimes(1);
    const parts = JSON.parse(onDraft.mock.calls[0][0]);
    expect(parts.every((part: { t: string }) => part.t !== "chip")).toBe(true);
    expect(view.ref.current?.currentModel()?.model).toBe("nano_banana_flash");
  });
});

describe("씬/카드 복원과 모델 스키마 응답 순서", () => {
  it.each(["video_edit", "video_extension"])("%s 복원: 파라미터 대기 중 레퍼런스 변경 후에도 선택 유지", async (mode) => {
    const pending = deferred<{ params: typeof SEEDANCE_PARAMS; constraints: object }>();
    boundary.api.modelParams.mockImplementation((model: string) => model === "seedance_2_5"
      ? pending.promise : Promise.resolve({ params: [], constraints: {} }));
    view = await mountPrompt(); // 다른 모델이 준비된 화면에서 씬으로 진입
    const saved = binding(mode);
    await view.render({ trayBinding: saved });
    expect(boundary.api.modelParams).toHaveBeenCalledWith("seedance_2_5");
    expect(view.ref.current?.currentModel()).toBeNull(); // 아직 이전 모델의 옵션: 준비 게이트 확인
    await addReference();
    expect(view.ref.current?.currentModel()).toBeNull();
    await act(async () => pending.resolve({ params: SEEDANCE_PARAMS, constraints: {} }));
    await settle();
    expectShownMode(view.container, mode);
    expect(view.ref.current?.currentModel()?.params?.mode).toBe(mode);
    click(required(view.container, ".sl-reftray-x"));
    await settle();
    expectShownMode(view.container, mode);
    expect(saved.model?.params?.mode).toBe(mode); // 저장된 공유 설정도 불변
  });

  it("같은 모델의 다른 카드 복원도 edit/extension 선택을 보존한다", async () => {
    view = await mountPrompt({ trayBinding: binding("t2v", "scene:plain") });
    for (const mode of ["video_edit", "video_extension", "video_edit"]) {
      await view.render({ trayBinding: binding(mode, `scene:${mode}`) });
      expectShownMode(view.container, mode);
      expect(view.ref.current?.currentModel()?.params?.mode).toBe(mode);
    }
  });

  it("기존 제한(0298cdb9): 로딩 중 같은 모델 카드 전환은 첫 예약 옵션이 남는다", async () => {
    // A2 이전 applyModelCfg의 같은 모델 분기는 pendingOptsRef를 갱신하지 않는다.
    // 늦은 useModels 응답이 첫 카드의 예약값을 다시 적용한다. 이번 범위 밖인 기존 결함의 특성화이며,
    // '마지막 카드가 이긴다'는 보장이 통과했다고 보고하지 않는다. 별도 수정 때 기대값을 바꿀 것.
    const pending = deferred<{ params: typeof SEEDANCE_PARAMS; constraints: object }>();
    boundary.api.modelParams.mockImplementation((model: string) => model === "seedance_2_5"
      ? pending.promise : Promise.resolve({ params: [], constraints: {} }));
    view = await mountPrompt();
    await view.render({ trayBinding: binding("video_edit", "scene:first") });
    expect(view.ref.current?.currentModel()).toBeNull();
    await view.render({ trayBinding: binding("video_extension", "scene:last") });
    expect(view.ref.current?.currentModel()).toBeNull();
    await act(async () => pending.resolve({ params: SEEDANCE_PARAMS, constraints: {} }));
    await settle();
    expectShownMode(view.container, "video_edit");
    expect(view.ref.current?.currentModel()?.params?.mode).toBe("video_edit");
    // 스키마가 준비된 뒤의 카드 복원은 현재 지원 계약이다. 이때에는 새 카드 값이 적용되어야 한다.
    await view.render({ trayBinding: binding("video_extension", "scene:after-load") });
    expectShownMode(view.container, "video_extension");
    expect(view.ref.current?.currentModel()?.params).toMatchObject({ mode: "video_extension", extension_mode: "forward" });
  });
});

describe("무시되는 옵션은 조작할 수 없고, 고른 값은 보존된다", () => {
  it("edit의 길이·비율은 만질 수 없고, 되돌리면 고르던 값이 살아 있다", async () => {
    view = await mountPrompt({ trayBinding: binding("video_edit") });
    const slider = required<HTMLInputElement>(view.container, '.sl-opt-slider input[type="range"]');
    const sliderChip = required(view.container, ".sl-opt-slider");
    const ratio = required<HTMLButtonElement>(view.container, 'button[title="aspect_ratio"]');
    expect(sliderChip.classList.contains("sl-opt-ignored")).toBe(true);
    expect(ratio.classList.contains("sl-opt-ignored")).toBe(true);
    // ★2026-09-15 Jay: 흐리게만 두면 "만질 수 있으니 효과가 있나 보다" 로 헷갈린다 — 아예 잠근다.
    expect(slider.disabled).toBe(true);
    expect(ratio.disabled).toBe(true);
    expect(getComputedStyle(sliderChip).opacity).toBe("0.45");
    click(ratio);
    await settle();
    expect(view.container.querySelector(".sl-dropdown")).toBeNull();

    // 안내 문구는 잠근 이유를 알려주는 자리라 흐리지 않는다.
    const note = required(view.container, ".sl-ignored-note");
    expect(note.closest(".sl-opt-ignored")).toBeNull();
    expect(getComputedStyle(note).opacity).not.toBe("0.45");
    expect(note.textContent).toContain("길이·비율은 넣은 영상을 따릅니다.");
    expect(required(note, "strong").textContent).toBe("요금도 그 영상 길이로 매겨집니다.");

    // 효과가 있는 모드에서는 종전대로 조작된다.
    expectShownMode(view.container, "video_edit");
    click(button(required(view.container, ".sl-adv-pop"), "t2v"));
    await settle();
    expect(view.container.querySelector(".sl-opt-ignored")).toBeNull();
    expect(view.container.querySelector(".sl-ignored-note")).toBeNull();
    const freeSlider = required<HTMLInputElement>(view.container, '.sl-opt-slider input[type="range"]');
    expect(freeSlider.disabled).toBe(false);
    act(() => {
      // React의 value tracker를 갱신하지 않고 브라우저 입력처럼 실제 DOM 값을 바꾼다.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(freeSlider, "12");
      freeSlider.dispatchEvent(new Event("input", { bubbles: true }));
      freeSlider.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(view.ref.current?.currentModel()?.params?.duration).toBe(12);
    expect(required(view.container, ".sl-opt-val").textContent).toBe("12s");
    click(required<HTMLButtonElement>(view.container, 'button[title="aspect_ratio"]'));
    click(button(required(view.container, ".sl-dropdown"), "9:16"));
    await settle();
    expect(view.ref.current?.currentModel()?.params?.aspect_ratio).toBe("9:16");

    // 무시되는 모드로 돌아가면 다시 잠기고, 고르던 값은 그대로 남아 제출에도 실린다.
    expectShownMode(view.container, "t2v");
    click(button(required(view.container, ".sl-adv-pop"), "video_extension"));
    await settle();
    expect(required<HTMLInputElement>(view.container, '.sl-opt-slider input[type="range"]').disabled).toBe(false);
    expect(required<HTMLButtonElement>(view.container, 'button[title="aspect_ratio"]').disabled).toBe(true);
    expect(required(view.container, ".sl-ignored-note").textContent).toBe("비율은 넣은 영상을 따릅니다.");
    expectShownMode(view.container, "video_extension");
    click(button(required(view.container, ".sl-adv-pop"), "video_edit"));
    await settle();
    expect(required<HTMLInputElement>(view.container, '.sl-opt-slider input[type="range"]').disabled).toBe(true);
    expect(view.ref.current?.currentModel()?.params).toMatchObject({ duration: 12, aspect_ratio: "9:16" });
  });
});
