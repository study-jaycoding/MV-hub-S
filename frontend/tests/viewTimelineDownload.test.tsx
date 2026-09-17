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
