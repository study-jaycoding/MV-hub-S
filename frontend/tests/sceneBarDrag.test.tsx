// @vitest-environment jsdom
// 씬 탭 순서 끌기 — 포인터를 놓은 것을 놓쳐도(단추를 뗀 채 온 움직임) 삽입선이 뗀 마우스를 따라오지 않고, 나중의 pointerup 이 순서를 바꾸지 않는다.
// 2026-10-11 격리 실측(dist_b46) 2/2: lostpointercapture 로 끝낸 끌기를 바로 뒤의 pointermove 가 다시 켰다(다시 그리기 전이라 옛 값을 읽었다).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { SceneBar } from "../src/components/scene/SceneBar";
import type { Scene } from "../src/lib/scenes";
import type { WorkspaceContext } from "../src/types";

const scene = (id: string): Scene => ({ id, name: id, cards: [], edges: [], created_at: 0 });
const personal: WorkspaceContext = { scope: "personal", id: null, name: null };
const onReorder = vi.fn();
const onSelect = vi.fn();
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onReorder.mockClear();
  onSelect.mockClear();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  act(() => root.render(
    <SceneBar scenes={[scene("s1"), scene("s2"), scene("s3")]} activeId="s1" workspaceContext={personal} onSelect={onSelect} onAdd={vi.fn()}
      onRename={vi.fn()} onDelete={vi.fn()} onReorder={onReorder} onAssignWorkspace={vi.fn()} />,
  ));
  // jsdom 은 자리를 재 주지 않는다 — 탭 셋을 가로 한 줄(폭 100)로 둔다
  [...host.querySelectorAll<HTMLElement>(".scene-tab-wrap")].forEach((wrap, index) => {
    const left = index * 100;
    vi.spyOn(wrap, "getBoundingClientRect").mockReturnValue(
      { left, right: left + 100, top: 0, bottom: 30, width: 100, height: 30, x: left, y: 0, toJSON: () => ({}) } as DOMRect);
  });
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const tab = (index: number) => host.querySelectorAll<HTMLElement>(".scene-tab")[index];
// jsdom 의 MouseEvent 에는 pointerId·isPrimary 가 없다 — 붙여서 쏜다
const pointer = (type: string, target: EventTarget, init: MouseEventInit) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "isPrimary", { value: true });
  act(() => { target.dispatchEvent(event); });
};
const line = () => host.querySelector(".scene-drop-line");

it("끌어 놓으면 순서가 바뀐다", () => {
  pointer("pointerdown", tab(2), { clientX: 250, clientY: 15 });
  pointer("pointermove", tab(2), { clientX: 20, clientY: 15, buttons: 1 }); // 맨 앞으로
  expect(line()).not.toBeNull();
  pointer("pointerup", tab(2), { clientX: 20, clientY: 15 });
  expect(onReorder).toHaveBeenCalledExactlyOnceWith({ id: "s3", beforeId: "s1" });
  expect(line()).toBeNull();
});

it("포인터를 놓은 것을 놓치면 끝난다 — 단추를 뗀 채 온 움직임에 삽입선이 따라오지 않고, 나중의 pointerup 이 순서를 바꾸지 않는다", () => {
  pointer("pointerdown", tab(2), { clientX: 250, clientY: 15 });
  pointer("pointermove", tab(2), { clientX: 120, clientY: 15, buttons: 1 }); // s2 앞
  expect(line()).not.toBeNull();
  pointer("pointermove", tab(2), { clientX: 20, clientY: 15, buttons: 0 }); // 놓친 뒤의 움직임
  expect(line()).toBeNull();
  pointer("pointermove", tab(2), { clientX: 30, clientY: 15, buttons: 0 });
  expect(line()).toBeNull();
  pointer("pointerup", tab(2), { clientX: 30, clientY: 15 });
  expect(onReorder).not.toHaveBeenCalled();
});

it("끝난 끌기는 다시 그리기 전에 온 움직임에도 다시 켜지지 않는다 — 포인터 잡기를 잃은 직후의 움직임", () => {
  pointer("pointerdown", tab(2), { clientX: 250, clientY: 15 });
  pointer("pointermove", tab(2), { clientX: 120, clientY: 15, buttons: 1 });
  act(() => { // 같은 묶음 안에서: 잡기를 잃음 → 곧바로 (단추가 눌린 것으로 보이는) 움직임
    tab(2).dispatchEvent(new Event("lostpointercapture", { bubbles: true }));
    const move = new MouseEvent("pointermove", { bubbles: true, clientX: 20, clientY: 15, buttons: 1 });
    Object.defineProperty(move, "pointerId", { value: 1 });
    tab(2).dispatchEvent(move);
  });
  expect(line()).toBeNull();
  pointer("pointerup", tab(2), { clientX: 20, clientY: 15 });
  expect(onReorder).not.toHaveBeenCalled();
});

// 9회차: 끈 뒤의 click 삼키기가 타이머에만 기대면, click 이 오지 않은 끌기 바로 뒤의 누름이 타이머가 돌기 전이라 삼켜진다(입력은 타이머보다 먼저 처리된다).
it("끈 뒤에 삼키는 click 은 그 끌기에 딸린 한 번이다 — 딸린 click 은 씬을 열지 않고, 새로 누른 탭은 타이머가 돌기 전이어도 열린다", () => {
  pointer("pointerdown", tab(2), { clientX: 250, clientY: 15 });
  pointer("pointermove", tab(2), { clientX: 20, clientY: 15, buttons: 1 });
  pointer("pointerup", tab(2), { clientX: 20, clientY: 15 });
  act(() => { tab(2).click(); }); // 놓기에 딸린 click — 끌어 놓은 탭의 씬은 열리지 않는다
  expect(onSelect).not.toHaveBeenCalled();
  act(() => { tab(0).click(); }); // 삼킨 것은 한 번뿐이다(키보드로 누른 탭 — 누름 없이 click 만)
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("s1");

  onSelect.mockClear();
  pointer("pointerdown", tab(2), { clientX: 250, clientY: 15 });
  pointer("pointermove", tab(2), { clientX: 20, clientY: 15, buttons: 1 });
  pointer("pointerup", tab(2), { clientX: 20, clientY: 15 }); // 이번에는 click 이 딸려 오지 않았다(뗀 자리가 탭 밖)
  pointer("pointerdown", tab(1), { clientX: 150, clientY: 15 }); // 곧바로 다른 탭을 누른다 — 타이머는 아직 안 돌았다
  pointer("pointerup", tab(1), { clientX: 150, clientY: 15 });
  act(() => { tab(1).click(); });
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("s2");
});

it("앞 끌기가 예약해 둔 억제 해제가 다음 끌기의 억제를 풀지 않는다 — 곧바로 다시 끌다 Esc 로 취소하고 놓아도 씬이 열리지 않는다", async () => {
  pointer("pointerdown", tab(2), { clientX: 250, clientY: 15 }); // 끌기 A
  pointer("pointermove", tab(2), { clientX: 20, clientY: 15, buttons: 1 });
  pointer("pointerup", tab(2), { clientX: 20, clientY: 15 }); // 억제 해제가 예약됐다(아직 안 돌았다)
  pointer("pointerdown", tab(1), { clientX: 150, clientY: 15 }); // 끌기 B — 그 타이머가 돌기 전에 시작한다
  pointer("pointermove", tab(1), { clientX: 20, clientY: 15, buttons: 1 });
  expect(line()).not.toBeNull();
  act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); }); // 취소 — 단추는 누른 채
  expect(line()).toBeNull();
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); }); // A 의 타이머가 돌 시간이 지났다
  pointer("pointerup", tab(1), { clientX: 20, clientY: 15 });
  act(() => { tab(1).click(); }); // 놓을 때 딸려 오는 click — 취소한 끌기가 씬을 열면 안 된다
  expect(onSelect).not.toHaveBeenCalled();
  expect(onReorder).toHaveBeenCalledTimes(1); // A 만 순서를 바꿨다
});
