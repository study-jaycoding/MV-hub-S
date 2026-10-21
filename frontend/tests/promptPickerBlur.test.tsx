// @vitest-environment jsdom
// 입력칸을 떠나면 @ 피커가 닫힌다 — 카드·그리드를 누른 뒤에도 피커가 남던 문제(Jay 10-22). 피커 안을 누르는 건 입력칸 초점을 빼앗지 않는다.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { installPromptBoundaryMocks, mountPrompt, required, settle } from "./seedanceRenderHarness";

let view: Awaited<ReturnType<typeof mountPrompt>> | undefined;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  const boundary = installPromptBoundaryMocks();
  (boundary.api as Record<string, unknown>).searchSources = vi.fn().mockResolvedValue([]);
});
afterEach(() => {
  view?.dispose();
  view = undefined;
  vi.unstubAllGlobals();
});

it("@ 로 연 피커는 입력칸을 떠나면 닫히고, 피커 안의 mousedown 은 초점을 지킨다", async () => {
  view = await mountPrompt();
  const editor = required(view.container, '[contenteditable="true"]');
  act(() => {
    // 실제처럼 입력칸을 눌러 초점을 얻는다(캔버스에선 누르지 않은 프로그램 초점을 바로 뺀다)
    editor.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    editor.focus();
    editor.textContent = "@";
    const range = document.createRange();
    range.setStart(editor.firstChild!, 1); // 글자 노드 안, @ 바로 뒤
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
  const picker = required(view.container, ".sl-mention"); // @ 피커가 떴다(소스 없음 안내)

  // 피커 머리글을 누르면 기본 동작(초점 이동)이 막힌다 — 그래서 입력칸이 blur 되지 않는다
  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  act(() => { required(picker, ".sl-mention-head").dispatchEvent(down); });
  expect(down.defaultPrevented).toBe(true);
  expect(view.container.querySelector(".sl-mention")).not.toBeNull();

  // 입력칸을 떠나면(카드·그리드 클릭 등) 닫힌다
  act(() => { editor.blur(); });
  await settle();
  expect(view.container.querySelector(".sl-mention")).toBeNull();
});
