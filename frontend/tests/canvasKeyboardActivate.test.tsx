// @vitest-environment jsdom
// 캔버스의 키보드 실행(조작 규칙 51 — 24회차, Codex 전수 검토): Tab 으로 닿은 단추는 그 단추가 실행되고, 그 단추의 키가 부모의 것이 되지 않는다.
//  · 복구 창('이 카드에 생성물 붙이기')의 후보 줄(div+role=button) 안에는 참조칩(단추)이 있다 — 칩에서 누른 Enter 가 줄의 onKeyDown 으로
//    올라가 그 후보를 카드에 **붙였다**(크게 보려던 것인데). 줄은 자기 자신에게 온 키만 받는다.
//  · Tab 노드 선택기의 항목은 mousedown 에만 걸려 있어 Tab 으로 닿은 뒤 Enter·Space 를 눌러도 아무 일이 없었다.
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  const boundary = installPromptBoundaryMocks();
  // 붙인 생성물을 보드가 바로 물어본다 — 서버 응답 모양 그대로(materials 가 빠지면 폴링이 던진다 — 틀의 기본 가짜는 items 만 준다)
  boundary.api.getGenerationsBatch.mockResolvedValue({ items: {}, materials: {}, missing: [] });
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
const key = (name: string, target: HTMLElement) => {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  act(() => { target.focus(); target.dispatchEvent(event); });
  return event;
};
type BoardProps = React.ComponentProps<typeof import("../src/components/scene/SceneBoard").SceneBoard>;
async function mountBoard(scene: Scene, props: Partial<BoardProps> = {}) {
  const { SceneBoard } = await import("../src/components/scene/SceneBoard");
  act(() => view.root.render(<SceneBoard scene={scene} onChange={noop} {...props} />));
  await settle();
}
const card = (id: string) => view.container.querySelector<HTMLElement>(`.scene-card[data-id="${id}"]`)!;
const board = () => view.container.querySelector<HTMLElement>(".scene-board")!;

const candidate = {
  id: "g1", job_id: "g1", status: "done", model: "hf-soul", params: {}, assets: [], created_at: "2026-10-12 01:00:00",
  prompt: "a @ref1 b", display_prompt: "a @ref1 b",
  references: [{ source: "ref1", role: "@ref1", type: "image", file_path: "refs/r1.png", thumbnail_path: "refs/r1.png" }],
} as unknown as Generation;

it("복구 창의 후보 줄: 안의 참조칩에서 누른 Enter 는 칩의 것이다 — 그 후보를 카드에 붙이지 않는다. 줄 자체의 Enter 는 붙인다", async () => {
  const claim = vi.fn(async () => {});
  await mountBoard({ id: "s", name: "s", created_at: 1, edges: [], cards: [{ id: "empty", kind: "generation", x: 0, y: 0 }] } as Scene,
    { onGenerateCard: noop, onCanvasRecoveryCandidates: async () => [candidate], onCanvasRecoveryClaim: claim, onPreview: noop });
  act(() => { // 카드를 고른다(누르고 뗀다) — 하나만 골랐을 때 카드 아래에 ⋮ 가 뜬다
    card("empty").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
  });
  act(() => q(".scene-cardgen-recover")!.click());
  await settle();
  const row = q(".scene-recovery-item")!;
  const chip = row.querySelector<HTMLElement>(".inline-ref-btn")!;
  expect(chip.title).toBe("ref1 — 크게 보기");

  const onChip = key("Enter", chip); // Tab 으로 칩에 가서 Enter — 크게 보기
  expect(onChip.defaultPrevented).toBe(false); // 막지 않아야 브라우저가 칩의 click(크게 보기)을 낸다 — 전엔 줄이 막고 후보를 붙였다
  await settle();
  expect(claim).not.toHaveBeenCalled();
  expect(row.textContent).not.toContain("붙이는 중");

  const onRow = key("Enter", row); // 줄 자체의 Enter 는 전과 같다
  expect(onRow.defaultPrevented).toBe(true);
  await settle();
  expect(claim).toHaveBeenCalledWith("g1", "s", "empty");
});

it("Tab 노드 선택기: Tab 으로 닿은 항목에서 Enter 를 누르면 그 노드가 만들어진다(전엔 mousedown 에만 걸려 아무 일도 없었다)", async () => {
  await mountBoard({ id: "s", name: "s", created_at: 1, edges: [], cards: [{ id: "t", kind: "text", x: 0, y: 0, text: "" }] } as Scene);
  act(() => { board().dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 50, clientY: 50 })); });
  act(() => { board().dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
  const items = [...view.container.querySelectorAll<HTMLElement>(".scene-nodepick-item")];
  expect(items.length).toBeGreaterThan(1);
  const textItem = items.find((item) => item.querySelector(".scene-nodepick-key")?.textContent?.toLowerCase() === "t") ?? items[0];
  const before = view.container.querySelectorAll(".scene-card").length;

  const event = key("Enter", textItem);
  expect(event.defaultPrevented).toBe(true);
  expect(q(".scene-nodepick")).toBeNull(); // 선택기는 닫히고
  expect(view.container.querySelectorAll(".scene-card").length).toBe(before + 1); // 노드가 하나 생겼다
});
