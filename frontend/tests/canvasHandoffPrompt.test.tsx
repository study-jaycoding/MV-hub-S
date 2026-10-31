// @vitest-environment jsdom
// 휠 클릭으로 연 캔버스 창의 프롬프트 — 메인 창 하단에 보이던 종류·모델·옵션으로 시작한다(2026-10-30, docs/status/캔버스_창_보던값_2026-10-30.md).
// 넘긴 값 한 칸 → SpotlightPrompt → useModels 의 초기값 길까지 실제 코드를 지난다(seedanceRenderHarness).
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPromptBoundaryMocks, mountPrompt, settle } from "./seedanceRenderHarness";

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

// 카드를 안 고른 캔버스의 글·모델 왕복(2026-10-31, docs/status/캔버스_닫는순간_2026-10-31.md)
describe("캔버스 창 왕복 — 글과 모델은 그 씬의 카드 없는 묶임에서 함께 놓인다", () => {
  const none = (sceneId: string) => ({ key: `${sceneId}:none`, promptKey: "none", refs: [], prompt: "", model: null }) as never;
  const card = (sceneId: string) => ({ key: `${sceneId}:c1`, promptKey: "card", refs: [], prompt: "[{\"t\":\"text\",\"v\":\"카드 글\"}]", model: null }) as never;
  const parts = (text: string) => JSON.stringify([{ t: "text", v: text }]);
  const video = { type: "video", model: "seedance_2_5", params: { duration: 5, aspect_ratio: "9:16", resolution: "1080p", mode: "t2v" } };
  let view: Awaited<ReturnType<typeof mountPrompt>> | undefined;
  const editorText = () => view!.container.querySelector(".sl-prompt")?.textContent ?? "";
  const adopt = (returned: Parameters<NonNullable<NonNullable<typeof view>["ref"]["current"]>["adoptCanvasPrompt"]>[0]) =>
    act(() => view!.ref.current!.adoptCanvasPrompt(returned));

  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    installPromptBoundaryMocks();
  });
  afterEach(() => {
    view?.dispose();
    view = undefined;
    window.name = "";
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("같은 묶임 키로 돌아오면 바로 놓이고 빈 글은 메인의 옛 글을 비운다", async () => {
    const onTrayBindingPromptChange = vi.fn();
    view = await mountPrompt({ expanded: false, trayBinding: none("s1"), onTrayBindingPromptChange });
    adopt({ key: "s1:none", model: null, draft: parts("창의 글") });
    await settle();
    expect(editorText()).toBe("창의 글");
    expect(view.ref.current?.canvasDraft()).toBe(parts("창의 글"));
    adopt({ key: "s1:none", model: null, draft: "" });
    await settle();
    expect(editorText()).toBe("");
    expect(onTrayBindingPromptChange).not.toHaveBeenCalled(); // 놓은 글을 편집으로 알아 카드에 저장하지 않는다
  });

  it("다른 씬으로 닫으면 그 키가 될 때 놓이고, 라이브러리 모델 보관값이 바뀌지 않는다", async () => {
    view = await mountPrompt({ expanded: false }); // 라이브러리 — 묶임 없음
    const library = view.ref.current!.currentModel();
    adopt({ key: "s2:none", model: video as never, draft: parts("창의 글") });
    await settle();
    expect(editorText()).toBe(""); // 묶임이 없으면 놓지 않는다
    expect(view.ref.current?.currentModel()).toMatchObject({ type: library?.type });
    await view.render({ trayBinding: none("s2") });
    await settle();
    expect(editorText()).toBe("창의 글");
    expect(view.ref.current?.currentModel()).toMatchObject({ type: "video", model: "seedance_2_5", params: { resolution: "1080p" } });
    await view.render({ trayBinding: undefined }); // 라이브러리로 돌아오면 원래 모델
    await settle();
    expect(view.ref.current?.currentModel()).toMatchObject({ type: library?.type, model: library?.model });
  });

  it("라이브러리 글은 넘어가지 않고 지워지지도 않는다 · 카드 글은 넘어가지 않는다", async () => {
    view = await mountPrompt({ expanded: false });
    const ed = view.container.querySelector<HTMLElement>(".sl-prompt")!;
    act(() => { ed.textContent = "라이브러리 글"; ed.dispatchEvent(new InputEvent("input", { bubbles: true })); });
    await settle();
    expect(view.ref.current?.canvasDraft()).toBe("");
    adopt({ key: "s1:none", model: null, draft: "" });
    await settle();
    expect(editorText()).toBe("라이브러리 글");
    await view.render({ trayBinding: card("s1") });
    await settle();
    expect(editorText()).toBe("카드 글");
    expect(view.ref.current?.canvasDraft()).toBe("");
  });

  it("키가 끝내 안 맞으면 나중에 옛 글이 나오지 않는다", async () => {
    view = await mountPrompt({ expanded: false, trayBinding: none("s1") });
    const now = Date.now();
    adopt({ key: "s9:none", model: null, draft: parts("옛 글") });
    await settle();
    vi.spyOn(Date, "now").mockReturnValue(now + 11_000);
    await view.render({ trayBinding: none("s9") });
    await settle();
    expect(editorText()).toBe("");
    vi.restoreAllMocks();
  });

  it("옵션을 읽는 중에 닫아도 종류·모델은 돌아오고 앞 모델의 옵션이 붙지 않는다 · 같은 모델이면 지금 옵션을 그대로 둔다", async () => {
    view = await mountPrompt({ expanded: false, trayBinding: none("s1") });
    adopt({ key: "s1:none", model: { ...video, params: {} } as never, draft: "" });
    await settle();
    expect(view.ref.current?.shownModel()).toMatchObject({ type: "video", model: "seedance_2_5" });
    const params = view.ref.current?.currentModel()?.params;
    expect(params).toMatchObject({ aspect_ratio: "16:9" }); // 기본값 — 앞 모델의 옵션이 아니다
    adopt({ key: "s1:none", model: video as never, draft: "" });
    await settle();
    expect(view.ref.current?.currentModel()?.params).toMatchObject({ aspect_ratio: "9:16" });
    adopt({ key: "s1:none", model: { ...video, params: {} } as never, draft: "" }); // 같은 모델·옵션 없음
    await settle();
    expect(view.ref.current?.currentModel()?.params).toMatchObject({ aspect_ratio: "9:16" });
  });

  it("캔버스 창은 넘겨받은 카드 없는 글로 시작한다", async () => {
    window.name = "contenthub-canvas";
    localStorage.setItem("mvhub.canvasHandoff", JSON.stringify({
      promptVisible: true, batchCount: 1, at: Date.now(), prompt: null, promptDraft: { key: "s1:none", draft: parts("넘긴 글") },
    }));
    view = await mountPrompt({ expanded: false, trayBinding: none("s1") });
    await settle();
    expect(editorText()).toBe("넘긴 글");
  });
});
