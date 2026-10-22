// @vitest-environment jsdom
// 프롬프트 열기·닫기 칸(Jay 10-22) — Host 상태줄 오른쪽 끝 칸 하나가 Ctrl+K 와 같은 상태를 뒤집는다(프롬프트 창 안에는 단추가 없다).
//  설명 글은 지금 상태를 따르고, 뒤집는 동작을 넘기지 않는 화면(편집 탭 — 프롬프트 없음)에는 칸이 없다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: {} }));

import { ServerConsolePanel } from "../src/components/spotlight/ServerConsolePanel";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const render = (props: { promptOpen?: boolean; onTogglePrompt?: () => void }) =>
  act(() => root.render(<ServerConsolePanel hubOk agentOn account={null} onCheckAccount={() => {}} {...props} />));
const toggle = () => host.querySelector<HTMLButtonElement>(".sl-status .sl-status-toggle");

it("상태줄 끝 칸이 프롬프트를 접고 연다 — 설명은 지금 상태를 따른다", () => {
  const onTogglePrompt = vi.fn();
  render({ promptOpen: true, onTogglePrompt });
  const button = toggle()!;
  expect(button.parentElement!.lastElementChild).toBe(button); // 상태줄의 맨 끝(모서리 안쪽)
  expect(button.getAttribute("aria-label")).toMatch(/^프롬프트 접기 \(.*K\)$/);
  expect(button.classList.contains("open")).toBe(true); // 열려 있으면 회색(.open), 접혔을 때만 라임
  act(() => button.click());
  expect(onTogglePrompt).toHaveBeenCalledTimes(1);
  render({ promptOpen: false, onTogglePrompt });
  expect(toggle()!.getAttribute("aria-label")).toMatch(/^프롬프트 열기 \(.*K\)$/);
  expect(toggle()!.classList.contains("open")).toBe(false);
  expect(toggle()!.title).toBe(toggle()!.getAttribute("aria-label"));
});

it("뒤집는 동작이 없으면(편집 탭) 칸을 그리지 않는다", () => {
  render({});
  expect(toggle()).toBeNull();
  expect(host.querySelector(".sl-status")).not.toBeNull(); // 상태줄 자체는 그대로
});
