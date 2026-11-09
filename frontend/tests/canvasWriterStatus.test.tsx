// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ mode: "away", handed: false, localCount: 0 }));
const take = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/sceneWriter", () => ({ useSceneWriter: () => state, takeSceneWriter: take }));
vi.mock("../src/components/TopBar", () => ({ CanvasFloatIcon: () => <svg data-testid="original-icon" /> }));
import { CanvasWriterStatus } from "../src/components/CanvasWriterStatus";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; take.mockClear(); });
function render(mode = "away", handed = false, localCount = 0) {
  Object.assign(state, { mode, handed, localCount });
  const el = document.createElement("div"); document.body.append(el); root = createRoot(el);
  act(() => root.render(<CanvasWriterStatus />)); return el;
}
describe("canvas writer screens", () => {
  it("keeps the away surface and icon and offers the lime opening button", () => {
    const el = render(); expect(el.querySelector(".canvas-away svg")).not.toBeNull();
    expect(el.textContent).toContain("캔버스는 다른 브라우저에서 열려 있습니다");
    expect(el.textContent).toContain("여기서 열면 그 브라우저의 마지막 편집까지 저장한 뒤 넘어옵니다");
    act(() => el.querySelector("button")!.click()); expect(take).toHaveBeenCalledOnce();
  });
  it("shows a spinner and the receiving text without a second action", () => {
    const el = render("taking"); expect(el.querySelector(".canvas-writer-spinner")).not.toBeNull();
    expect(el.textContent).toContain("넘겨받는 중"); expect(el.textContent).toContain("다른 브라우저의 마지막 편집을 저장하고 허브 공책을 받고 있습니다"); expect(el.querySelector("button")).toBeNull();
  });
  it("distinguishes the donor and counts local only scenes", () => {
    const el = render("away", true, 3); expect(el.textContent).toContain("다른 브라우저로 넘겼습니다");
    expect(el.textContent).toContain("이 브라우저에만 남는 씬 3개"); expect(el.querySelector("button")?.textContent).toBe("여기서 다시 열기");
    expect(el.textContent).not.toContain("...");
  });
});
