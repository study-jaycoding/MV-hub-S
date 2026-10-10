// @vitest-environment jsdom
// 조작 점검 7회차 — 하단 프롬프트.
//  R10: 빈 프롬프트에서 Enter 를 눌러도 줄이 늘지 않는다(글이 있을 때의 Enter·Shift+Enter·Alt+Enter 는 그대로).
//  R12: 폴더 창이 뜬 동안 상태 줄(Host 콘솔 단추 등)은 inert — 마우스만 막던 것을 Tab·Enter 로도 닿지 않게.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { installPromptBoundaryMocks, mountPrompt, required, settle } from "./seedanceRenderHarness";

let view: Awaited<ReturnType<typeof mountPrompt>> | undefined;
let boundary: ReturnType<typeof installPromptBoundaryMocks>;
// 제출 함수(유료 생성의 입구)를 통째로 감시자로 바꾼다 — 이 파일의 어떤 키도 실제 제출 흐름에 닿지 않는다.
const submit = vi.fn();
let execCommand: ReturnType<typeof vi.fn<(command: string) => boolean>>;

const editorOf = () => required(view!.container, '[contenteditable="true"]');
const lineBreaks = () => editorOf().querySelectorAll("br").length;
const pressEnter = (init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
  act(() => { editorOf().dispatchEvent(event); });
  return event;
};
// 글을 친 것처럼: 내용을 넣고 커서를 끝에 둔 뒤 input 을 보낸다
const type = (html: string) => act(() => {
  const editor = editorOf();
  editor.innerHTML = html;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
});

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  submit.mockClear();
  boundary = installPromptBoundaryMocks();
  vi.doMock("../src/components/spotlight/useSpotlightSubmit", async () => ({
    ...(await vi.importActual<typeof import("../src/components/spotlight/useSpotlightSubmit")>(
      "../src/components/spotlight/useSpotlightSubmit")),
    useSpotlightSubmit: () => submit,
  }));
  // 상태 줄의 단추 하나만 그린다(실제 패널은 서버 조회를 한다) — inert 가 그 단추를 품는지 본다
  vi.doMock("../src/components/spotlight/ServerConsolePanel", () => ({
    ServerConsolePanel: () => <button type="button" className="host-chip">Host</button>,
  }));
  // jsdom 에는 execCommand 가 없다 — 브라우저처럼 줄바꿈(<br>)을 하나 넣는 것만 흉내 낸다
  execCommand = vi.fn((command: string) => {
    if (command === "insertLineBreak") editorOf().appendChild(document.createElement("br"));
    return true;
  });
  Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
});
afterEach(() => {
  view?.dispose();
  view = undefined;
  delete (document as { execCommand?: unknown }).execCommand;
  expect(boundary.api.prepareCreate).not.toHaveBeenCalled(); // 생성 요청은 어떤 경우에도 나가지 않는다
  expect(boundary.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it.each([{}, { shiftKey: true }, { ctrlKey: true }])(
  "R10 빈 프롬프트의 Enter %j 는 줄을 늘리지 않는다 — 기본 동작만 막고 제출 함수는 불리지 않는다", async (keys) => {
    view = await mountPrompt();
    expect(editorOf().textContent).toBe("");
    for (let i = 0; i < 3; i++) expect(pressEnter(keys).defaultPrevented).toBe(true); // 브라우저가 스스로 줄(<div>)을 넣지도 않는다
    await settle();
    expect(execCommand).not.toHaveBeenCalled();
    expect(lineBreaks()).toBe(0);
    expect(submit).not.toHaveBeenCalled();
    expect(view.container.querySelector(".sl-error")).toBeNull();
  });

it("R10 공백·줄바꿈뿐인 프롬프트도 빈 것이다 — 제출이 '프롬프트를 입력하세요'로 막는 것과 같은 기준", async () => {
  view = await mountPrompt();
  type("&nbsp; <br>");
  expect(editorOf().hasAttribute("data-empty")).toBe(true); // 안내 글이 보이는 상태 = 빈 것
  expect(pressEnter().defaultPrevented).toBe(true);
  expect(execCommand).not.toHaveBeenCalled();
  expect(lineBreaks()).toBe(1);
  expect(submit).not.toHaveBeenCalled();
});

it("R10 글이 있으면 전과 같다 — Enter·Shift+Enter 는 줄바꿈 한 번씩, 제출은 Alt+Enter 한 번뿐", async () => {
  view = await mountPrompt();
  type("고양이");
  expect(pressEnter().defaultPrevented).toBe(true);
  expect(execCommand.mock.calls).toEqual([["insertLineBreak"]]);
  expect(pressEnter({ shiftKey: true }).defaultPrevented).toBe(true);
  expect(execCommand.mock.calls).toEqual([["insertLineBreak"], ["insertLineBreak"]]);
  expect(lineBreaks()).toBe(2);
  expect(submit).not.toHaveBeenCalled(); // 줄바꿈 키는 제출하지 않는다
  expect(pressEnter({ altKey: true }).defaultPrevented).toBe(true);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(pressEnter({ altKey: true, repeat: true }).defaultPrevented).toBe(true); // 누르고 있는 반복은 삼킨다
  expect(submit).toHaveBeenCalledTimes(1);
  expect(execCommand).toHaveBeenCalledTimes(2); // 제출 키는 줄을 넣지 않는다
});

it("R12 statusInert 를 받으면 상태 줄만 inert 다 — 프롬프트는 그대로 쓰고, 풀면 상태 줄의 단추가 다시 눌린다", async () => {
  view = await mountPrompt({ statusInert: true });
  const row = required(view.container, ".sl-status-row");
  const chip = required(view.container, ".host-chip");
  expect(row.hasAttribute("inert")).toBe(true);
  expect(chip.closest("[inert]")).toBe(row); // 상태 줄의 단추는 Tab·Enter 로 닿지 않는다
  expect(editorOf().closest("[inert]")).toBeNull();
  expect(required(view.container, "button.sl-gen").closest("[inert]")).toBeNull();
  await view.render({ statusInert: false });
  expect(row.isConnected).toBe(true); // 같은 줄이다(다시 만들지 않는다 — 열려 있던 콘솔이 닫히지 않는다)
  expect(row.hasAttribute("inert")).toBe(false);
  expect(chip.closest("[inert]")).toBeNull();
});
