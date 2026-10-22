// @vitest-environment jsdom
// 프롬프트·레퍼런스 비우기(Jay 10-22) — 각 칸의 지우개 단추도 Shift+Backspace 도 그 칸만 비운다(한때 단축키를 둘 다로 했다가 Jay 가 되돌림).
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

  it("Shift+Backspace 는 초점 자리만 — 프롬프트에서는 프롬프트만, 레퍼런스 칸에서는 레퍼런스만(Jay 10-22 '각각 나눠서')", async () => {
    view = await mountPrompt({ trayBinding: binding() });
    shiftBackspace(editor()); await settle();
    expect(editor().textContent).toBe("");
    expect(items()).toHaveLength(2);
    view.dispose();
    view = await mountPrompt({ trayBinding: binding() });
    shiftBackspace(required(view.container, ".sl-reftray")); await settle();
    expect(items()).toHaveLength(0);
    expect(editor().textContent).toContain("비 오는 옥상");
  });

  it("프롬프트 드롭다운이 열려 있어도 역할 메뉴가 같이 떠 있으면 Shift+Backspace 는 쉰다(Codex C1)", async () => {
    view = await mountPrompt({ trayBinding: binding() });
    act(() => {
      const item = items()[0];
      item.dispatchEvent(new MouseEvent("mousedown", { button: 2, bubbles: true, cancelable: true }));
      item.dispatchEvent(new MouseEvent("contextmenu", { button: 2, clientX: 100, clientY: 100, bubbles: true, cancelable: true }));
    });
    expect(document.querySelector(".sl-ref-role-menu")).not.toBeNull();
    click(required(view.container, 'button[title="고급 옵션 (모드·비트레이트·장르 등)"]')); // 키보드로 연 것처럼 — 역할 메뉴는 그대로
    expect(view.container.querySelector(".sl-adv-pop")).not.toBeNull();
    expect(document.querySelector(".sl-ref-role-menu")).not.toBeNull();
    shiftBackspace(editor()); await settle();
    expect(editor().textContent).toContain("비 오는 옥상");
  });

  it("캔버스에서 프롬프트 지우개를 누른 뒤에도 바로 이어서 칠 수 있게 초점이 돌아온다(Codex C2)", async () => {
    view = await mountPrompt({ trayBinding: binding() }); // 하네스는 캔버스(inCompose) — 누르지 않은 초점은 튕긴다
    const ed = editor();
    act(() => { ed.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); ed.focus(); });
    expect(document.activeElement).toBe(ed);
    click(required(view.container, ".sl-prompt-clear"));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });
    expect(editor().textContent).toBe("");
    expect(document.activeElement).toBe(ed);
  });

  it("레퍼런스 지우개는 썸네일 스크롤 칸 밖에 있다 — 넘쳐 스크롤해도 썸네일 위를 덮지 않는다(Codex C3)", async () => {
    view = await mountPrompt({ trayBinding: binding() });
    const scroller = required(view.container, ".sl-reftray .sl-reftray-scroll");
    const clear = required(view.container, ".sl-reftray > .sl-reftray-clear");
    expect(scroller.contains(clear)).toBe(false);
    expect(scroller.querySelectorAll(".sl-reftray-item")).toHaveLength(2);
  });

  it("빈 프롬프트의 안내 문구는 글줄 밖에 겹쳐 그린다 — 커서가 문구 앞(맨 처음)에 선다", async () => {
    view = await mountPrompt({ trayBinding: binding() });
    shiftBackspace(editor()); await settle();
    expect(editor().hasAttribute("data-empty")).toBe(true);
    const before = getComputedStyle(editor(), "::before");
    // jsdom 은 가상요소 배치를 계산하지 않는다 — 제품 CSS 의 규칙 값만 본다(실제 커서 자리는 실브라우저 확인)
    expect([...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]).map((rule) => rule.cssText)
      .some((text) => text.includes(".sl-prompt[data-empty]::before") && text.includes("position: absolute"))).toBe(true);
    expect(before).toBeDefined();
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
