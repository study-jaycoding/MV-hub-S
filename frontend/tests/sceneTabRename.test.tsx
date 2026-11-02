// 탭·탭 설명 창의 이름을 더블클릭해 바꾼다(Jay 2026-11-02 A안) — 저장 규칙은 우클릭 메뉴의 이름 칸과 같고, 고치는 동안 창은 닫히지 않는다.
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneBar } from "../src/components/scene/SceneBar";
import type { Scene } from "../src/lib/scenes";
import type { WorkspaceContext } from "../src/types";

const noop = () => {};
const personal: WorkspaceContext = { scope: "personal", id: null, name: null };
const scene = (id: string) => ({ id, name: id, cards: [], edges: [], created_at: 0 }) as unknown as Scene;
const onRename = vi.fn();
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network in isolated UI test"))));
  vi.useFakeTimers();
  onRename.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root.render(
      <SceneBar scenes={[scene("s1"), scene("s2")]} activeId="s1" workspaceContext={personal} onSelect={noop} onAdd={noop}
        onRename={onRename} onDelete={noop} onReorder={noop} onAssignWorkspace={noop} tabActions={["import"]} onTabAction={noop} />,
    );
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const tabEl = (index: number) => host.querySelectorAll<HTMLElement>("[data-scene-tab]")[index];
const button = (index: number) => tabEl(index).querySelector<HTMLElement>("button.scene-tab");
const input = () => document.querySelector<HTMLInputElement>(".scene-name-input");
const tip = () => document.querySelector<HTMLElement>(".node-tip.tab");
const dbl = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
const type = (value: string) => act(async () => {
  const el = input()!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
const key = (name: string) => act(async () => { input()!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); });
const blur = () => act(async () => { input()!.blur(); });

it("탭을 더블클릭하면 그 자리가 글칸이고 이름이 골라져 있다 · Enter 는 저장하고 한 번만 보낸다", async () => {
  await dbl(button(1)!);
  expect(input()?.value).toBe("s2");
  expect(document.activeElement).toBe(input());
  expect([input()!.selectionStart, input()!.selectionEnd]).toEqual([0, 2]);
  expect(button(1)).toBeNull(); // 고치는 동안은 단추가 아니라 끌기가 시작되지 않는다
  await type("새 이름");
  await key("Enter");
  expect(onRename.mock.calls).toEqual([["s2", "새 이름"]]);
  expect(input()).toBeNull();
  expect(button(1)).not.toBeNull();
});

it("Esc 는 취소, 바깥 누르기는 저장, 빈 이름·같은 이름은 보내지 않는다", async () => {
  await dbl(button(0)!);
  await type("버릴 이름");
  await key("Escape");
  expect(onRename).not.toHaveBeenCalled();
  await dbl(button(0)!);
  await type("   ");
  await key("Enter");
  expect(onRename).not.toHaveBeenCalled();
  await dbl(button(0)!);
  await key("Enter");
  expect(onRename).not.toHaveBeenCalled();
  await dbl(button(0)!);
  await type("바깥 저장");
  await blur();
  expect(onRename.mock.calls).toEqual([["s1", "바깥 저장"]]);
});

const openTip = async () => {
  await act(async () => {
    button(1)!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    vi.advanceTimersByTime(450);
  });
};

it("창의 이름을 더블클릭해 고치는 동안은 글을 쳐도, 마우스가 나가도, 바깥을 눌러도 먼저 닫히지 않고 끝나면 닫힌다", async () => {
  await openTip();
  await dbl(tip()!.querySelector(".node-tip-head")!);
  expect(input()?.value).toBe("s2");
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" })); });
  await act(async () => { tip()!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })); vi.advanceTimersByTime(500); });
  await act(async () => { button(1)!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })); vi.advanceTimersByTime(500); });
  await act(async () => { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  expect(tip()).not.toBeNull();
  await type("창에서 바꿈");
  await blur(); // 바깥을 누르면 글칸이 초점을 잃는다
  expect(onRename.mock.calls).toEqual([["s2", "창에서 바꿈"]]);
  expect(tip()).toBeNull();
  expect(button(1)!.getAttribute("title")).toBe("s2");
});

it("창의 글칸에서 Esc 는 취소하고 창을 닫는다 · 다음 호버는 평소대로다", async () => {
  await openTip();
  await dbl(tip()!.querySelector(".node-tip-head")!);
  await type("버릴 이름");
  await key("Escape");
  expect(onRename).not.toHaveBeenCalled();
  expect(tip()).toBeNull();
  await openTip();
  expect(tip()?.querySelector(".node-tip-head")?.textContent).toBe("s2");
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" })); });
  expect(tip()).toBeNull(); // 붙들림이 풀렸다
});
