// @vitest-environment jsdom
// 수정 창을 여는 쪽(PartialEditHost)의 알림 글 — 영상 요청에도 '이미지 수정'이 나오던 것(Jay 2026-11-05). 수정 창 자체는 가짜로 둔다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_EVENTS } from "../src/lib/appEvents";
import type { Generation, WorkspaceContext } from "../src/types";

const mocks = vi.hoisted(() => ({ getGeneration: vi.fn(), flashMsg: vi.fn() }));
vi.mock("../src/api", () => ({ api: { getGeneration: mocks.getGeneration } }));
vi.mock("../src/lib/flash", () => ({ flashMsg: mocks.flashMsg }));
vi.mock("../src/components/edit/PartialEditModal", () => ({
  PartialEditModal: ({ mode }: { mode: string }) => <div className="pe-stub" data-mode={mode} />,
}));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.getGeneration.mockReset();
  mocks.flashMsg.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function mount() {
  const { PartialEditHost } = await import("../src/components/edit/PartialEditHost");
  act(() => root.render(<PartialEditHost workspace={{} as WorkspaceContext} onQueued={() => {}} />));
}
const ask = (detail: unknown) => act(async () => {
  window.dispatchEvent(new CustomEvent(APP_EVENTS.partialEdit, { detail }));
  for (let i = 0; i < 5; i++) await Promise.resolve();
});
const openMode = () => host.querySelector(".pe-stub")?.getAttribute("data-mode");

describe("수정 창 여는 쪽의 알림 글", () => {
  it("생성물 조회 실패는 요청 종류대로 — 영상이면 '영상 수정', 이미지면 '이미지 수정'", async () => {
    mocks.getGeneration.mockRejectedValue(new Error("offline"));
    await mount();
    await ask({ genId: "g-video", mode: "video" });
    await ask({ genId: "g-image", mode: "image" });
    expect(mocks.flashMsg.mock.calls).toEqual([
      ["영상 수정: 생성물 정보를 불러오지 못했습니다."],
      ["이미지 수정: 생성물 정보를 불러오지 못했습니다."],
    ]);
    expect(openMode()).toBeUndefined();
  });

  it("이미 열려 있으면 종류를 가리지 않는 글 — 열린 영상 수정 창은 그대로 남는다", async () => {
    mocks.getGeneration.mockResolvedValue({ id: "g-video", status: "done", assets: [{ type: "video", file_path: "/v.mp4" }] } as unknown as Generation);
    await mount();
    await ask({ genId: "g-video", mode: "video" });
    expect(openMode()).toBe("video");
    await ask({ genId: "g-image", mode: "image" });
    expect(mocks.flashMsg.mock.calls).toEqual([["수정 창이 이미 열려 있습니다 — 닫은 뒤 다시 시도하세요."]]);
    expect(mocks.getGeneration).toHaveBeenCalledTimes(1);
    expect(openMode()).toBe("video");
  });
});
