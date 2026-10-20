// @vitest-environment jsdom
// 28회차(Jay 결정 — 요청 시작 직후 표시 없던 네 곳, 모의 그림 승인): 보드가 그리는 둘 — 캔버스에 놓은 파일의 자리 표시 · 복구 창 '더 보기'의 잠금과 글.
//  (✎ 는 tests/adminWindowTabs, Comfy 카드 덮개는 tests/comfyLoadOrder, 놓기 훅의 상태 자체는 tests/failureFeedback.)
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CardHistoryLink } from "../src/lib/canvasDetached";
import type { Scene } from "../src/lib/scenes";
import type { Generation } from "../src/types";
import { createRenderRoot, installPromptBoundaryMocks, settle } from "./seedanceRenderHarness";

vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return { Virtualizer: forwardRef((props: { data: unknown[]; children: (row: unknown) => React.ReactNode }, ref) => {
    useImperativeHandle(ref, () => ({ scrollToIndex: () => {} }));
    return <>{props.data.map(props.children)}</>;
  }) };
});

let view: ReturnType<typeof createRenderRoot>;
let boundary: ReturnType<typeof installPromptBoundaryMocks>;
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  boundary = installPromptBoundaryMocks();
  boundary.api.getGenerationsBatch.mockResolvedValue({ items: {}, materials: {}, missing: [] });
  Object.assign(boundary.api, {
    assetThumbUrl: (project: string, path: string) => `/thumb/${project}/${path}`,
    assetFileUrl: (project: string, path: string) => `/file/${project}/${path}`,
  });
  boundary.fetch.mockImplementation((...args: unknown[]) => {
    const [url, options] = args as [string, RequestInit | undefined];
    if (url.startsWith("/api/generation-views") && !options?.method) {
      return Promise.resolve(new Response(JSON.stringify({ card: {}, last_card_id: null }))) as never;
    }
    return Promise.reject(new Error(`예상 밖 HTTP 요청: ${url}`));
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} unobserve() {} });
  for (const name of ["pause", "load"] as const) vi.spyOn(HTMLMediaElement.prototype, name).mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(console, "warn").mockImplementation(() => {});
  Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  view = createRenderRoot();
});
afterEach(() => {
  view?.dispose();
  vi.restoreAllMocks();
  delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
  vi.unstubAllGlobals();
});

const q = (selector: string) => view.container.querySelector<HTMLElement>(selector);
const noop = () => {};
type BoardProps = React.ComponentProps<typeof import("../src/components/scene/SceneBoard").SceneBoard>;
async function mountBoard(scene: Scene, props: Partial<BoardProps> = {}) {
  const { SceneBoard } = await import("../src/components/scene/SceneBoard");
  act(() => view.root.render(<SceneBoard scene={scene} onChange={noop} {...props} />));
  await settle();
}
const board = () => view.container.querySelector<HTMLElement>(".scene-board")!;
const card = (id: string) => view.container.querySelector<HTMLElement>(`.scene-card[data-id="${id}"]`)!;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
type Saved = { saved: Array<{ project: string; path: string; name: string; type: string }>; skipped: string[] };
const dropVideo = () => act(() => {
  const file = new File(["x"], "clip_0412.mp4", { type: "video/mp4" });
  board().dispatchEvent(Object.assign(new Event("drop", { bubbles: true, cancelable: true }), {
    clientX: 300, clientY: 200, dataTransfer: { types: ["Files"], files: [file], items: [] },
  }));
});

it("캔버스에 놓은 파일 — 올라가는 동안 놓은 자리에 점선 자리 표시가 있고, 끝나면 그 자리가 카드로 바뀐다; 실패하면 까닭이 남고 ✕ 로 치운다", async () => {
  const upload = deferred<Saved>();
  const uploadReferenceFiles = vi.fn(() => upload.promise);
  Object.assign(boundary.api, { uploadReferenceFiles });
  await mountBoard({ id: "s", name: "s", created_at: 1, edges: [], cards: [] } as unknown as Scene);
  const ghost = () => q(".scene-canvas .scene-import-ghost");
  dropVideo();
  expect(uploadReferenceFiles).toHaveBeenCalledTimes(1);
  expect(ghost()).not.toBeNull(); // 캔버스 층 안(카드와 같은 좌표계)
  expect(ghost()!.textContent).toContain("가져오는 중…");
  expect(ghost()!.textContent).toContain("clip_0412.mp4");
  expect(ghost()!.querySelector(".busy-ring")).not.toBeNull();
  expect(view.container.querySelectorAll(".scene-card")).toHaveLength(0);
  await act(async () => { upload.resolve({ saved: [{ project: "p", path: "imports/clip_0412.mp4", name: "clip_0412.mp4", type: "video" }], skipped: [] }); });
  await settle();
  expect(ghost()).toBeNull(); // 자리 표시가 카드로 바뀌었다
  expect(view.container.querySelectorAll(".scene-card")).toHaveLength(1);

  const failed = deferred<Saved>();
  uploadReferenceFiles.mockImplementation(() => failed.promise);
  dropVideo();
  expect(ghost()).not.toBeNull();
  await act(async () => { failed.reject(new Error("offline")); });
  await settle();
  expect(ghost()!.classList.contains("err")).toBe(true);
  expect(ghost()!.textContent).toContain("넣지 못했습니다 — 다시 놓아 주세요");
  expect(ghost()!.querySelector(".busy-ring")).toBeNull();
  act(() => ghost()!.querySelector<HTMLButtonElement>(".scene-import-ghost-x")!.click());
  expect(ghost()).toBeNull();
  expect(view.container.querySelectorAll(".scene-card")).toHaveLength(1); // 실패한 것은 카드가 되지 않았다
});

it("업로드 자리 표시는 원래 씬에만 보이고, A→B→A 뒤 옛 업로드가 끝나도 새 문서에는 카드를 넣지 않는다", async () => {
  const upload = deferred<Saved>();
  const uploadReferenceFiles = vi.fn(() => upload.promise);
  Object.assign(boundary.api, { uploadReferenceFiles });
  const scene = (id: string) => ({ id, name: id, created_at: 1, edges: [], cards: [] }) as unknown as Scene;
  await mountBoard(scene("s"));
  dropVideo();
  expect(q(".scene-canvas .scene-import-ghost")).not.toBeNull();
  await mountBoard(scene("t"));
  expect(q(".scene-canvas .scene-import-ghost")).toBeNull();
  await mountBoard(scene("s"));
  expect(q(".scene-canvas .scene-import-ghost")).not.toBeNull();
  await act(async () => { upload.resolve({ saved: [{ project: "p", path: "imports/clip_0412.mp4", name: "clip_0412.mp4", type: "video" }], skipped: [] }); });
  await settle();
  expect(uploadReferenceFiles).toHaveBeenCalledTimes(1);
  expect(q(".scene-canvas .scene-import-ghost")).toBeNull();
  expect(view.container.querySelectorAll(".scene-card")).toHaveLength(0);
});

const gen = (id: string) => ({
  id, job_id: id, status: "done", model: "hf-soul", params: {}, assets: [], created_at: "2026-10-12 01:00:00",
  prompt: `p ${id}`, display_prompt: `p ${id}`, references: [], tags: [], auto_tags: [],
}) as unknown as Generation;

it("복구 창 '더 보기' — 받아 둔 재료의 본문을 더 받는 동안 단추가 '불러오는 중… (받은 수 / 전체)'로 잠기고(또 눌러도 조회 1), 끝나면(실패해도) 풀린다", async () => {
  // 위 칸 상한(30)의 두 배보다 하나 많은 떨어진 생성물 — '더 보기 (31개 남음)' → 한 번 더 펴도 '더 보기 (1개 남음)'. 본문(onLoadGenerations)은 더 받아 와야 한다.
  const links: CardHistoryLink[] = Array.from({ length: 61 }, (_, index) => ({ generation_id: `g${index + 1}`, scene_id: "s", card_id: "empty" }));
  const scene = { id: "s", name: "s", created_at: 1, edges: [], cards: [{ id: "empty", kind: "generation", x: 0, y: 0 }] } as unknown as Scene;
  const onLoadGenerations = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, gen(id)])));
  await mountBoard(scene, {
    onGenerateCard: noop, onPreview: noop, onCanvasRecoveryCandidates: async () => [], onCanvasRecoveryClaim: async () => {},
    onCanvasCardHistory: async () => ({ links, next: null }), readLocalScenes: () => [scene], onLoadGenerations,
  });
  act(() => { // 카드를 고른다(누르고 뗀다) — 하나만 골랐을 때 카드 아래에 ⋮ 가 뜬다
    card("empty").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
  });
  act(() => q(".scene-cardgen-recover")!.click());
  await settle();
  const rows = () => view.container.querySelectorAll(".scene-recovery-from").length; // 위 칸의 줄(어디에 있었나 표식이 붙는다)
  const more = () => q(".scene-recovery-more")!;
  expect(onLoadGenerations).toHaveBeenCalledTimes(1);
  expect(rows()).toBe(30);
  expect(more().textContent).toBe("더 보기 (31개 남음)");
  expect(more().disabled).toBe(false);

  const failing = deferred<Record<string, Generation>>();
  onLoadGenerations.mockImplementationOnce(() => failing.promise);
  act(() => more().click());
  expect(onLoadGenerations).toHaveBeenCalledTimes(2);
  expect(more().disabled).toBe(true);
  expect(more().textContent).toBe("불러오는 중… (30 / 61)");
  expect(more().querySelector(".busy-ring")).not.toBeNull();
  act(() => more().click()); // 잠긴 단추 — 같은 본문을 두 번 받지 않는다(전엔 단추가 그대로라 또 눌렸다)
  expect(onLoadGenerations).toHaveBeenCalledTimes(2);
  await act(async () => { failing.reject(new Error("offline")); }); // 실패 — 잠금이 풀리고 글이 돌아온다(다시 누를 수 있다)
  await settle();
  expect(rows()).toBe(30);
  expect(more().disabled).toBe(false);
  expect(more().textContent).toBe("더 보기 (31개 남음)");

  const held = deferred<Record<string, Generation>>();
  onLoadGenerations.mockImplementationOnce(() => held.promise);
  act(() => more().click());
  expect(more().textContent).toBe("불러오는 중… (30 / 61)");
  await act(async () => { held.resolve(Object.fromEntries(links.map((link) => [link.generation_id, gen(link.generation_id)]))); });
  await settle();
  expect(rows()).toBe(60);
  expect(more().disabled).toBe(false);
  expect(more().textContent).toBe("더 보기 (1개 남음)");
});
