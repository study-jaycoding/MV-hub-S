// @vitest-environment jsdom
// 프롬프트·레퍼런스 비우기(Jay 10-22) — 각 칸의 지우개 단추는 그 칸만, Shift+Backspace 는 초점이 어디든 둘 다 비운다.
//  레퍼런스는 캔버스 연결(from_card)을 남기는 같은 범위이고, 위에 메뉴가 떠 있으면 Shift+Backspace 는 쉰다(Codex 10-22 판단).
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, installPromptBoundaryMocks, installPromptStyles, mountPrompt, required, settle, type PromptProps } from "./seedanceRenderHarness";

let boundary: ReturnType<typeof installPromptBoundaryMocks>;
let view: Awaited<ReturnType<typeof mountPrompt>> | undefined;
let style: HTMLStyleElement;
beforeEach(() => {
  vi.resetModules(); localStorage.clear();
  boundary = installPromptBoundaryMocks(); style = installPromptStyles();
});
afterEach(() => {
  view?.dispose(); view = undefined; style?.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  expect(boundary.fetch).not.toHaveBeenCalled();
});

function binding(): NonNullable<PromptProps["trayBinding"]> {
  return { key: "scene:clear", prompt: "비 오는 옥상", modelKey: "scene:clear:omni_reference",
    model: { model: "seedance_2_5", type: "video", params: { mode: "omni_reference" } },
    refs: [
      { type: "image", file_path: "/fixtures/a.png", name: "A", thumb: "/fixtures/a.png" },
      { type: "image", file_path: "/fixtures/b.png", name: "B", thumb: "/fixtures/b.png" },
    ],
  };
}
const editor = () => required<HTMLElement>(view!.container, '[contenteditable="true"]');
const items = () => view!.container.querySelectorAll(".sl-reftray-item");
const shiftBackspace = (target: HTMLElement) => act(() => {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", code: "Backspace", shiftKey: true, bubbles: true, cancelable: true }));
});

describe("프롬프트·레퍼런스 비우기", () => {
  it("프롬프트 지우개는 프롬프트만, 레퍼런스 지우개는 레퍼런스만 비운다", async () => {
    view = await mountPrompt({ trayBinding: binding() });
    expect(editor().textContent).toContain("비 오는 옥상");
    expect(items()).toHaveLength(2);
    // 두 지우개는 각 칸 오른쪽 위 — 레퍼런스 쪽은 레퍼런스가 있을 때만 그린다
    const promptClear = required<HTMLButtonElement>(view.container, ".sl-prompt-row .sl-prompt-clear");
    click(promptClear); await settle();
    expect(editor().textContent).toBe("");
    expect(items()).toHaveLength(2);
    view.dispose();
    view = await mountPrompt({ trayBinding: binding() });
    click(required(view.container, ".sl-reftray .sl-reftray-clear")); await settle();
    expect(items()).toHaveLength(0);
    expect(view.container.querySelector(".sl-reftray-clear")).toBeNull();
    expect(editor().textContent).toContain("비 오는 옥상");
  });

  it("Shift+Backspace 는 프롬프트에서도 레퍼런스 칸에서도 둘 다 비운다", async () => {
    view = await mountPrompt({ trayBinding: binding() });
    shiftBackspace(editor()); await settle();
    expect(editor().textContent).toBe("");
    expect(items()).toHaveLength(0);
    view.dispose();
    view = await mountPrompt({ trayBinding: binding() });
    shiftBackspace(required(view.container, ".sl-reftray")); await settle();
    expect(items()).toHaveLength(0);
    expect(editor().textContent).toBe("");
  });

  it("위에 메뉴가 떠 있으면 프롬프트의 Shift+Backspace 도 쉰다", async () => {
    view = await mountPrompt({ trayBinding: binding() });
    act(() => {
      const item = items()[0];
      item.dispatchEvent(new MouseEvent("mousedown", { button: 2, bubbles: true, cancelable: true }));
      item.dispatchEvent(new MouseEvent("contextmenu", { button: 2, clientX: 100, clientY: 100, bubbles: true, cancelable: true }));
    });
    const { backgroundKeysBlocked } = await import("../src/lib/keyGate");
    expect(backgroundKeysBlocked()).toBe(true);
    shiftBackspace(editor()); await settle();
    expect(editor().textContent).toContain("비 오는 옥상");
    expect(items()).toHaveLength(2);
  });
});
