// @vitest-environment jsdom
// 휠 클릭으로 연 캔버스 창의 프롬프트 — 메인 창 하단에 보이던 종류·모델·옵션으로 시작한다(2026-10-30, docs/status/캔버스_창_보던값_2026-10-30.md).
// 넘긴 값 한 칸 → SpotlightPrompt → useModels 의 초기값 길까지 실제 코드를 지난다(seedanceRenderHarness).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPromptBoundaryMocks, mountPrompt } from "./seedanceRenderHarness";

const leave = () => localStorage.setItem("mvhub.canvasHandoff", JSON.stringify({
  promptVisible: true, batchCount: 2, at: Date.now(),
  prompt: { type: "video", model: "seedance_2_5", params: { mode: "t2v", duration: 5, aspect_ratio: "9:16", resolution: "1080p" } },
}));

describe("캔버스 창 프롬프트가 넘겨받은 모델·옵션으로 시작한다", () => {
  let view: Awaited<ReturnType<typeof mountPrompt>> | undefined;
  beforeEach(() => {
    vi.resetModules(); // 넘긴 값을 한 번 읽어 두는 곳(popupWindows)·카탈로그 캐시가 모듈 전역이다
    localStorage.clear();
    installPromptBoundaryMocks();
  });
  afterEach(() => {
    view?.dispose();
    view = undefined;
    window.name = "";
    vi.unstubAllGlobals();
  });

  it("캔버스 창은 Seedance 2.5 와 고른 비율·해상도로 시작한다", async () => {
    window.name = "contenthub-canvas";
    leave();
    view = await mountPrompt({ expanded: false });
    expect(view.ref.current?.currentModel()).toMatchObject({
      type: "video", model: "seedance_2_5", params: { aspect_ratio: "9:16", resolution: "1080p" },
    });
  });

  it("메인 창은 넘긴 값을 쓰지 않는다 — 지금처럼 이미지로 시작한다", async () => {
    leave();
    view = await mountPrompt({ expanded: false });
    expect(view.ref.current?.currentModel()).toMatchObject({ type: "image" });
    expect(localStorage.getItem("mvhub.canvasHandoff")).not.toBeNull(); // 캔버스 창 몫이라 지우지도 않는다
  });
});
