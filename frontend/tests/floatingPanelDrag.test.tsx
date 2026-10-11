// @vitest-environment jsdom
// 떠 있는 패널(태그·코멘트)의 머리 끌기 — mouseup 을 놓쳐도 단추를 뗀 마우스를 따라오지 않는다.
// 2026-10-11 격리 실측(dist_b46): 단추 없는 움직임 5걸음을 전부 따라왔고 그 자리가 저장됐다(태그·코멘트 각 3/3, blur 뒤에도 3/3).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Store } from "../src/lib/storage";
import { useFloatingPanel } from "../src/lib/useFloatingPanel";

let host: HTMLDivElement;
let root: Root;
let saved: Record<string, unknown>;
const store = {
  loadJSON: (key: string) => saved[key] ?? null,
  setJSON: (key: string, value: unknown) => { saved[key] = value; },
} as unknown as Store;

function Panel() {
  const { pos, panelRef, onHeadMouseDown } = useFloatingPanel(store, "pos", "size", true);
  return (
    <div ref={panelRef} className="panel" style={{ left: pos?.x, top: pos?.y }}>
      <div className="head" onMouseDown={(e) => onHeadMouseDown(e)} />
    </div>
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Object.assign(window, { innerWidth: 1600, innerHeight: 900 });
  saved = { pos: { x: 300, y: 210 } };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(<Panel />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const mouse = (type: string, target: EventTarget, init: MouseEventInit) =>
  act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, ...init })); });
const at = () => {
  const panel = host.querySelector<HTMLElement>(".panel")!;
  return [parseFloat(panel.style.left), parseFloat(panel.style.top)];
};

it("끌면 따라오고 놓으면 멈춘다", () => {
  mouse("mousedown", host.querySelector(".head")!, { clientX: 320, clientY: 220 });
  mouse("mousemove", window, { clientX: 400, clientY: 260, buttons: 1 });
  expect(at()).toEqual([380, 250]);
  mouse("mouseup", window, { clientX: 400, clientY: 260 });
  mouse("mousemove", window, { clientX: 700, clientY: 500, buttons: 0 });
  expect(at()).toEqual([380, 250]);
  expect(saved.pos).toEqual({ x: 380, y: 250 });
});

it.each([
  ["단추를 뗀 채 온 움직임", () => mouse("mousemove", window, { clientX: 460, clientY: 200, buttons: 0 })],
  ["창을 떠남(blur)", () => act(() => { window.dispatchEvent(new Event("blur")); })],
])("mouseup 을 놓친 끌기는 뗀 마우스를 따라오지 않고 그 자리를 저장하지 않는다 — %s", (_name, lose) => {
  mouse("mousedown", host.querySelector(".head")!, { clientX: 320, clientY: 220 });
  mouse("mousemove", window, { clientX: 400, clientY: 260, buttons: 1 });
  lose();
  mouse("mousemove", window, { clientX: 900, clientY: 600, buttons: 1 }); // 곧바로 다른 것을 누른 채 움직여도 이 패널의 것이 아니다(끝나 있다)
  expect(at()).toEqual([380, 250]);
  for (const [clientX, clientY] of [[460, 200], [260, 340], [520, 380], [350, 310]]) mouse("mousemove", window, { clientX, clientY, buttons: 0 });
  expect(at()).toEqual([380, 250]);
  expect(saved.pos).toEqual({ x: 380, y: 250 });
});
