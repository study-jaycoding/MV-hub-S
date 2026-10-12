// @vitest-environment jsdom
// 태그 편집기의 키보드(조작 규칙 51 — 24회차, Codex 전수 검토): 입력칸의 blur 에 닫으면 Tab 으로 편집기 **안의** 단추(전역 태그·#+ 워크스페이스)에
//  가는 순간 사라졋다. 초점이 편집기 밖으로 나갈 때만 닫는다. 워크스페이스 단추는 mousedown 에만 걸려 있어 Tab 으로 닿은 뒤 Enter 를 눌러도
//  아무 일이 없었다 — Enter·Space 로도 적용한다. 마우스 쪽(mousedown 이 blur 를 막는다)은 그대로다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TagEditor } from "../src/components/TagEditor";

const options = [{ id: "w1", name: "WS1" }];
vi.mock("../src/lib/workspaceOptionsCache", () => ({ cachedWorkspaceOptions: () => options, fetchWorkspaceOptions: async () => options }));

let host: HTMLDivElement;
let root: Root;
let outside: HTMLButtonElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  outside = document.createElement("button"); outside.textContent = "바깥"; document.body.append(outside);
});
afterEach(() => { act(() => root.unmount()); host.remove(); outside.remove(); vi.unstubAllGlobals(); });

const q = (selector: string) => host.querySelector<HTMLElement>(selector)!;
// 초점이 from 에서 to 로 옮겨 간다(Tab·클릭). React 의 onBlur 는 focusout 이다 — jsdom 의 focus() 는 relatedTarget 을 채우지 않을 수 있어 직접 보낸다.
const moveFocus = (from: HTMLElement, to: HTMLElement | null) => act(() => {
  from.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: to }));
  to?.focus();
});
const key = (target: HTMLElement, name: string) => {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  act(() => { target.dispatchEvent(event); });
  return event;
};
const type = (input: HTMLInputElement, value: string) => act(() => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

it("Tab 으로 편집기 안의 단추(전역 태그 칩·워크스페이스 칩)에 가도 닫히지 않는다 — 밖으로 나가면 닫힌다", async () => {
  const onClose = vi.fn();
  const command = vi.fn(async () => true);
  await act(async () => root.render(
    <TagEditor tags={["a"]} onChange={() => {}} global={{ all: ["g1"], assigned: [], onChange: () => {} }} forcedGlobalMode
      onWorkspaceCommand={command} onClose={onClose} />,
  ));
  const input = q(".cs-tag-input") as HTMLInputElement;
  act(() => input.focus());
  moveFocus(input, q(".te-gchip")); // 전역 태그 칩으로 Tab
  expect(onClose).not.toHaveBeenCalled(); // 전엔 입력칸의 blur 가 바로 닫았다

  act(() => input.focus());
  type(input, "#+"); // 워크스페이스 적용 목록
  await act(async () => {});
  const chip = q(".te-wchip");
  expect(chip.textContent).toContain("WS1");
  moveFocus(input, chip);
  expect(onClose).not.toHaveBeenCalled();

  key(chip, "a"); // 다른 키는 아무 것도 아니다
  expect(command).not.toHaveBeenCalled();
  expect(key(chip, "Enter").defaultPrevented).toBe(true); // 키보드로 적용 — 전엔 mousedown 에만 걸려 아무 일도 없었다
  await act(async () => {});
  expect(command).toHaveBeenCalledWith("assign", options[0]);
  expect(q(".te-wchip")).toBeNull(); // 적용되면 초안이 비워져 목록은 닫힌다(전과 같다) — 편집기는 남는다
  expect(onClose).not.toHaveBeenCalled();

  moveFocus(q(".te-gchip"), outside); // 편집기 밖으로
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("처리 중(워크스페이스 적용이 끝나기 전)에는 밖으로 나가도 닫지 않는다 — 전과 같다", async () => {
  const onClose = vi.fn();
  let finish!: (ok: boolean) => void;
  const command = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  await act(async () => root.render(
    <TagEditor tags={[]} onChange={() => {}} global={{ all: [], assigned: [], onChange: () => {} }} forcedGlobalMode
      onWorkspaceCommand={command} onClose={onClose} />,
  ));
  const input = q(".cs-tag-input") as HTMLInputElement;
  type(input, "#+");
  await act(async () => {});
  key(q(".te-wchip"), " ");
  expect(command).toHaveBeenCalledTimes(1);
  key(q(".te-wchip"), "Enter"); // 처리 중의 Enter 는 무시된다(마우스와 같다)
  expect(command).toHaveBeenCalledTimes(1);
  moveFocus(q(".te-wchip"), outside);
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => { finish(false); }); // 적용 실패 — 목록은 남는다
  key(q(".te-wchip"), "Enter"); // 끝난 뒤의 Enter 는 다시 적용한다
  expect(command).toHaveBeenCalledTimes(2);
});

it("입력칸 없는 비포커스 카드(칩 띠)는 초점이 나가도 닫기를 부르지 않는다 — 닫기는 포커스 카드의 것", () => {
  const onClose = vi.fn();
  act(() => root.render(<TagEditor tags={["a"]} onChange={() => {}} showInput={false} onClose={onClose} />));
  moveFocus(q(".te-x"), outside);
  expect(onClose).not.toHaveBeenCalled();
});
