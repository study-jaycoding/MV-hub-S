// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPromptBoundaryMocks, installPromptStyles, mountPrompt, required, settle, type PromptProps } from "./seedanceRenderHarness";

// 카드를 고르면 프롬프트 칸이 그 카드의 프롬프트를 되살린다. 되살리기는 편집이 아니다 — 카드에 다시 저장하면 되돌리기 기록이
//  하나 늘어 첫 Ctrl+Z 가 헛돈다(2026-10-22 격리 실측: 폴더 창에서 놓은 카드·Tab→N 새 카드). 원문이 평문·빈 글자여도 같다.
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
});

const card = (key: string, prompt: string): NonNullable<PromptProps["trayBinding"]> => ({
  key, refs: [], prompt, modelKey: "none", model: null,
});

describe("카드 프롬프트 되살리기", () => {
  it("평문·빈 글자·저장 형식 어느 것을 되살려도 카드에 다시 저장하지 않는다", async () => {
    const onDraft = vi.fn();
    view = await mountPrompt({ expanded: false, onTrayBindingPromptChange: onDraft, trayBinding: card("scene:a", "") });
    await view.render({ trayBinding: card("scene:b", "@image1과 @image2가 달리기 시합을 한다") });
    await view.render({ trayBinding: card("scene:c", JSON.stringify([{ t: "text", v: "저장 형식" }])) });
    await view.render({ trayBinding: card("scene:d", "") });
    expect(onDraft).not.toHaveBeenCalled();
  });

  it("되살린 뒤 실제로 고치면 지금처럼 저장한다", async () => {
    const onDraft = vi.fn();
    view = await mountPrompt({ expanded: false, onTrayBindingPromptChange: onDraft, trayBinding: card("scene:a", "지울 글") });
    const editor = required(view.container, '[contenteditable="true"]');
    act(() => { editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", code: "Backspace", shiftKey: true, bubbles: true })); });
    await settle();
    expect(onDraft).toHaveBeenCalledTimes(1);
    expect(JSON.parse(onDraft.mock.calls[0][0])).toEqual([]);
  });
});
