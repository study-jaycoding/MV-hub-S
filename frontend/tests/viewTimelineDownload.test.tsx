// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ViewTimeline } from "../src/components/scene/ViewTimeline";
import { flashMsg } from "../src/lib/flash";
import { HttpError } from "../src/lib/http";

vi.mock("../src/lib/flash", () => ({ flashMsg: vi.fn() }));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.clearAllMocks(); vi.unstubAllGlobals();
});
it.each([
  [new HttpError(400, "400: missing", "불러올 수 없는 항목이 있습니다(3번째)."), "불러올 수 없는 항목이 있습니다(3번째)."],
  [new Error("private internal path"), "영상 병합에 실패했습니다"],
])("병합 실패는 안내 1회와 버튼 복구", async (error, message) => {
  const download = vi.fn().mockRejectedValue(error);
  act(() => root.render(<ViewTimeline clips={[]} onClose={() => {}} onDownload={download} />));
  await act(async () => host.querySelector<HTMLButtonElement>(".vtl-dl")!.click());
  expect(download).toHaveBeenCalledTimes(1);
  expect(flashMsg).toHaveBeenCalledExactlyOnceWith(message);
  expect(host.querySelector<HTMLButtonElement>(".vtl-dl")!.disabled).toBe(false);
});
it("성공은 순서 유지, 중복 요청 금지, 실패 안내 없음", async () => {
  let finish!: () => void;
  const download = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const clips = [{ url: "/media/2.png", type: "image" as const }, { url: "/media/1.png", type: "image" as const }];
  act(() => root.render(<ViewTimeline clips={clips} onClose={() => {}} onDownload={download} />));
  act(() => host.querySelector<HTMLButtonElement>(".vtl-dl")!.click());
  const button = host.querySelector<HTMLButtonElement>(".vtl-dl")!;
  expect(button.disabled).toBe(true);
  act(() => button.click());
  expect(download).toHaveBeenCalledExactlyOnceWith(["/media/2.png", "/media/1.png"], "timeline");
  await act(async () => finish());
  expect(button.disabled).toBe(false);
  expect(flashMsg).not.toHaveBeenCalled();
});

// 8회차(2026-10-11 Codex 통합 검토): 창의 Space 처리가 무조건 재생/정지로 가져가, Tab 으로 찾아간 닫기·음소거 단추를 키보드로 못 눌렀다.
it("Tab 으로 찾아간 단추의 Space 는 그 단추의 키다 — 마우스로 누른 단추·음량 막대에 초점이 남아 있을 때는 여전히 재생/정지", () => {
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  const clips = [{ url: "/media/1.png", type: "image" as const }, { url: "/media/2.png", type: "image" as const }];
  act(() => root.render(<ViewTimeline clips={clips} onClose={() => {}} />));
  const shown = () => host.querySelector(".vtl-play")!.textContent;
  const space = (target: EventTarget) => {
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    act(() => { target.dispatchEvent(event); });
    return event.defaultPrevented;
  };
  const mute = host.querySelector<HTMLButtonElement>(".vtl-mute")!;
  const before = shown();
  act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })); mute.focus(); }); // Tab 으로 옮겨 온 초점
  expect(space(mute)).toBe(false); // 가져가지 않는다 — 브라우저가 그 단추를 누른다
  expect(shown()).toBe(before);
  act(() => { mute.dispatchEvent(new Event("pointerdown", { bubbles: true })); }); // 마우스로 눌러 남은 초점
  expect(space(mute)).toBe(true);
  expect(shown()).not.toBe(before);
  const volume = host.querySelector<HTMLInputElement>('input[type="range"]')!;
  const paused = shown();
  act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })); volume.focus(); });
  expect(space(volume)).toBe(true); // 막대는 Space 로 하는 일이 없다 — 재생/정지
  expect(shown()).not.toBe(paused);
  // 길게 눌린 Space(반복 keydown)는 막기만 한다 — 재생/정지가 반복마다 뒤집히지 않는다(조작 규칙 38)
  const now = shown();
  const held = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true, repeat: true });
  act(() => { volume.dispatchEvent(held); });
  expect([held.defaultPrevented, shown()]).toEqual([true, now]);
  raf.mockRestore();
});

// 55회차(Codex): 숨긴 탭에서는 rAF 가 멈춘다 — 돌아온 첫 틱이 숨어 있던 시간을 한 번에 더해 이미지 클립이 곧바로 넘어갔다.
it("탭을 숨겼다 돌아온 첫 틱은 숨어 있던 시간을 더하지 않는다(이미지 클립이 넘어가지 않는다)", () => {
  const ticks: FrameRequestCallback[] = [];
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => ticks.push(callback));
  const clips = [{ url: "/media/1.png", type: "image" as const }, { url: "/media/2.png", type: "image" as const }];
  act(() => root.render(<ViewTimeline clips={clips} onClose={() => {}} />));
  act(() => { ticks[ticks.length - 1](performance.now() + 10 * 60_000); }); // 10분 숨겼다 돌아온 첫 틱
  expect(parseFloat(host.querySelector<HTMLElement>(".vtl-playhead")!.style.left)).toBeLessThan(10); // 둘째 클립(50%)으로 넘어가지 않았다
  raf.mockRestore();
});

it("mouseup 을 놓친 타임라인 끌기는 단추를 뗀 마우스를 따라오지 않는다", () => {
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  const clips = [{ url: "/media/1.png", type: "image" as const }, { url: "/media/2.png", type: "image" as const }];
  act(() => root.render(<ViewTimeline clips={clips} onClose={() => {}} />));
  const track = host.querySelector<HTMLElement>(".vtl-track")!;
  vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 40, width: 1000, height: 40, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
  const at = () => host.querySelector<HTMLElement>(".vtl-playhead")!.style.left;
  const move = (clientX: number, buttons: number) => act(() => { window.dispatchEvent(new MouseEvent("mousemove", { clientX, buttons })); });
  act(() => { track.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 100 })); });
  move(300, 1);
  const kept = at();
  expect(kept).toBe("30%");
  move(800, 0); // mouseup 을 놓쳤다
  move(900, 0);
  move(700, 1); // 다른 것을 누른 채의 움직임도
  expect(at()).toBe(kept);
  raf.mockRestore();
});
