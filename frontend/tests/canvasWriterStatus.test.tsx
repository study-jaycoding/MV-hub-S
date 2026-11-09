// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ mode: "away", handed: false, localCount: 0, error: undefined as string | undefined, floating: false }));
const take = vi.hoisted(() => vi.fn());
const download = vi.hoisted(() => vi.fn(async () => 3));
vi.mock("../src/lib/sceneWriter", () => ({ useSceneWriter: () => state, takeSceneWriter: take }));
vi.mock("../src/lib/sceneArchive", () => ({ downloadSceneArchive: download }));
vi.mock("../src/components/TopBar", () => ({ CanvasFloatIcon: () => <svg data-testid="original-icon" /> }));
import { CanvasWriterStatus } from "../src/components/CanvasWriterStatus";
import { setLang } from "../src/lib/i18n";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; take.mockClear(); download.mockClear(); setLang("ko"); });
function render(mode = "away", handed = false, localCount = 0, error?: string, floating = false) {
  Object.assign(state, { mode, handed, localCount, error, floating });
  const el = document.createElement("div"); document.body.append(el); root = createRoot(el);
  act(() => root.render(<CanvasWriterStatus />)); return el;
}
describe("canvas writer screens", () => {
  it("keeps the away surface and icon and offers the lime opening button", () => {
    const el = render(); expect(el.querySelector(".canvas-away svg")).not.toBeNull();
    expect(el.textContent).toContain("캔버스는 다른 브라우저에서 열려 있습니다");
    expect(el.textContent).toContain("정상적으로 넘기면 그 브라우저의 마지막 편집까지 저장한 뒤 넘어옵니다");
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
  it.each(["checking", "syncing"])("describes %s as a notebook check rather than a browser handoff", (mode) => {
    const el = render(mode);
    expect(el.textContent).toContain("허브 공책을 맞추는 중");
    expect(el.textContent).not.toContain("다른 브라우저의 마지막 편집");
    expect(el.querySelector(".canvas-writer-spinner")).not.toBeNull();
    expect(el.querySelector("button")).toBeNull();
  });
  it("keeps a failed sync recoverable through export all and retry", async () => {
    const el = render("away", false, 0, "저장 응답을 확인하지 못했습니다");
    expect(el.textContent).toContain("저장 응답을 확인하지 못했습니다");
    const buttons = el.querySelectorAll("button");
    expect(Array.from(buttons, button => button.textContent)).toEqual(["전체 내보내기", "다시 시도"]);
    await act(async () => buttons[0].click());
    expect(download).toHaveBeenCalledOnce();
    expect(el.textContent).toContain("캔버스 3개를 파일로 내려받았습니다.");
    act(() => buttons[1].click());
    expect(take).toHaveBeenCalledOnce();
  });
  it("tells a paused floating window to return to its main window without claiming", () => {
    const el = render("away", false, 0, undefined, true);
    expect(el.textContent).toContain("이 캔버스 창의 편집이 멈췄습니다");
    expect(el.textContent).toContain("메인 창에서 캔버스를 다시 연 뒤 작업해 주세요");
    expect(el.querySelector("button")).toBeNull();
  });
  it("translates the writer screen and updates it when language changes", () => {
    const el = render("away", false, 2);
    act(() => setLang("en"));
    expect(el.textContent).toContain("The canvas is open in another browser");
    expect(el.textContent).toContain("A normal handoff saves that browser's latest edits before switching");
    expect(el.textContent).toContain("2 scenes remain only in this browser");
    expect(el.querySelector("button")?.textContent).toBe("Open here");
  });
});
