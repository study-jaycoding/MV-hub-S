// @vitest-environment jsdom
// 프롬프트의 @ 피커를 닫는 Esc 는 '쓴 것'으로 표시된다 — 같은 키가 뒤 화면의 Esc(선택 해제·폴더 창 닫기)까지 가지 않는다.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { installPromptBoundaryMocks, mountPrompt, required, settle } from "./seedanceRenderHarness";

let view: Awaited<ReturnType<typeof mountPrompt>> | undefined;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  const boundary = installPromptBoundaryMocks();
  // 피커가 열리면 소스 목록을 받는다 — 이 시험의 경계에는 없는 호출이라 빈 목록으로 답한다
  (boundary.api as Record<string, unknown>).searchSources = vi.fn().mockResolvedValue([
    { id: "s1", source_name: "소스", tags: ["숲"], assets: [], references: [], auto_tags: [] },
  ]);
});
afterEach(() => {
  view?.dispose();
  view = undefined;
  vi.unstubAllGlobals();
});

it("피커를 닫는 Esc·태그 고정을 푸는 Esc 는 쓴 것으로 표시되고, 둘 다 없을 때의 Esc 는 뒤 화면이 받는다", async () => {
  const { isKeyHandled } = await import("../src/lib/keyHandled");
  view = await mountPrompt();
  const editor = required(view.container, '[contenteditable="true"]');
  act(() => {
    // 실제처럼 입력칸을 눌러 초점을 얻는다 — 캔버스(inCompose)에선 누르지 않은 프로그램 초점을 바로 빼고, 초점이 빠지면 피커가 닫힌다
    editor.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    editor.focus();
    editor.textContent = "#";
    const range = document.createRange();
    range.setStart(editor.firstChild!, 1); // 글자 노드 안, # 바로 뒤
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
  expect(view.container.querySelector(".sl-mention")).not.toBeNull(); // # 피커(태그 목록)가 떴다
  // 태그를 고른다 → 그 태그로 고정되고 @ 피커가 이어 열린다
  act(() => { required(view!.container, ".sl-tag-item").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); });
  await settle();
  expect(view.container.querySelector(".sl-mention")).not.toBeNull();

  const seen: boolean[] = [];
  const spy = (event: KeyboardEvent) => {
    if (event.key === "Escape") seen.push(isKeyHandled(event));
  };
  window.addEventListener("keydown", spy);
  const escape = () => act(() => {
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  escape();
  await settle();
  expect(view.container.querySelector(".sl-mention")).toBeNull();
  escape(); // 피커는 닫혔고 태그 고정이 남았다 — 이 Esc 가 고정을 푼다
  await settle();
  escape(); // 둘 다 없다 — 이 Esc 는 프롬프트가 쓰지 않는다
  window.removeEventListener("keydown", spy);
  expect(seen).toEqual([true, true, false]);
});
