// @vitest-environment jsdom
// 모달의 초점(lib/keyGate '모달의 초점') — 캔버스 안의 창들. 실제 창·실제 SceneBoard 로 본다.
//  모델 설정 · Comfy 워크플로우 · 재생 타임라인 · 텍스트 보기 · '이 카드에 생성물 붙이기'(복구 창).
//  캔버스의 Tab 은 노드 피커를 여닫는 키다 — 이 창들이 떠 있는 동안에는 보드가 키를 받지 않고(규칙 10) Tab 은 창 안에서 돈다.
import { act, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Scene } from "../src/lib/scenes";
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

const el = (id: string) => document.getElementById(id) as HTMLElement;
const q = (selector: string) => document.querySelector<HTMLElement>(selector);
const active = () => document.activeElement as HTMLElement;
const noop = () => {};
const key = (name: string, target: EventTarget = document.activeElement ?? document.body, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
};

// 브라우저의 Tab — keydown 을 보내고, 아무도 막지 않았으면 문서 순서의 다음(이전) 자리로 초점을 옮긴다(jsdom 에는 이 기본 동작이 없다).
const stops = () => [...document.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, summary, [tabindex]")]
  .filter((item) => item.tabIndex >= 0 && !item.matches(":disabled") && !item.closest("[inert]"));
function tab(shift = false): KeyboardEvent {
  const from = (document.activeElement ?? document.body) as HTMLElement;
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, bubbles: true, cancelable: true });
  act(() => { from.dispatchEvent(event); });
  if (event.defaultPrevented) return event;
  const all = stops();
  const at = all.indexOf(from);
  let next: HTMLElement | undefined;
  if (at >= 0) next = all[at + (shift ? -1 : 1)];
  else if (from === document.body) next = shift ? all[all.length - 1] : all[0];
  else if (shift) next = all.filter((item) => from.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_PRECEDING && !item.contains(from)).pop();
  else next = all.find((item) => from.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING);
  act(() => { if (next) next.focus(); else from.blur(); });
  return event;
}
const walk = (count: number, shift = false) => Array.from({ length: count }, () => { tab(shift); return active(); });
const outside = (visited: HTMLElement[], region: HTMLElement) => visited.filter((at) => !region.contains(at)).map((at) => at.id || at.className || at.tagName);

// 뒤 화면: 창을 연 단추 · (창) · 뒤 화면의 단추
const page = (window: ReactElement | null) => (
  <>
    <button id="opener">연 단추</button>
    {window}
    <button id="behind">Generate</button>
  </>
);

describe("캔버스의 창 — 따로 붙여 본다", () => {
  const windows: [string, () => Promise<(onClose: () => void) => ReactElement>, string][] = [
    ["모델 설정(SceneModelModal)", async () => {
      const { SceneModelModal } = await import("../src/components/scene/SceneModelModal");
      return (onClose) => <SceneModelModal onSave={noop} onClose={onClose} />;
    }, ".scene-modelmodal"],
    ["Comfy 워크플로우(SceneComfyModal)", async () => {
      const { SceneComfyModal } = await import("../src/components/scene/SceneComfyModal");
      return (onClose) => <SceneComfyModal onSave={noop} onClose={onClose} />;
    }, ".scene-comfymodal"],
    ["재생 타임라인(ViewTimeline)", async () => {
      const { ViewTimeline } = await import("../src/components/scene/ViewTimeline");
      return (onClose) => <ViewTimeline clips={[{ url: "/media/1.png", type: "image" }, { url: "/media/2.png", type: "image" }]} onClose={onClose} onDownload={async () => {}} />;
    }, ".vtl"],
  ];

  it.each(windows)("%s: 열면 초점이 창 안 · Tab 30번·Shift+Tab 10번이 창 안에서만 돈다 · 닫으면 연 단추로 돌아간다", async (_name, load, rootSelector) => {
    const render = await load();
    act(() => view.root.render(page(null)));
    act(() => el("opener").focus());
    act(() => view.root.render(page(render(noop))));
    await settle();
    const win = q(rootSelector)!;
    expect(win.contains(active())).toBe(true);
    expect(outside([...walk(30), ...walk(10, true)], win)).toEqual([]);
    act(() => view.root.render(page(null)));
    expect(active()).toBe(el("opener"));
  });
});

describe("캔버스의 창 — 보드에서 연다", () => {
  type BoardProps = React.ComponentProps<typeof import("../src/components/scene/SceneBoard").SceneBoard>;
  async function mountBoard(scene: Scene, props: Partial<BoardProps> = {}) {
    const { SceneBoard } = await import("../src/components/scene/SceneBoard");
    act(() => view.root.render(<SceneBoard scene={scene} onChange={noop} {...props} />));
    await settle();
  }
  const card = (id: string) => view.container.querySelector<HTMLElement>(`.scene-card[data-id="${id}"]`)!;
  const board = () => view.container.querySelector<HTMLElement>(".scene-board")!;

  it("텍스트 보기: 초점이 창 안에 있고 Tab 은 창 안에서 돈다 — 그 Tab 에 보드의 노드 피커가 열리지 않는다. 닫으면 보드의 키가 돌아온다", async () => {
    await mountBoard({
      id: "s", name: "s", created_at: 1,
      cards: [{ id: "text", kind: "text", x: 0, y: 0, text: "보여 줄 글" }, { id: "viewer", kind: "view", x: 400, y: 0 }],
      edges: [{ id: "e", from: "text", to: "viewer" }],
    } as Scene);
    act(() => { board().dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 50, clientY: 50 })); }); // 피커는 마우스 자리에 뜬다
    expect(key("Tab", board()).defaultPrevented).toBe(true); // 전제: 창이 없으면 Tab 은 노드 피커를 연다
    expect(q(".scene-nodepick")).not.toBeNull();
    key("Tab", board());
    expect(q(".scene-nodepick")).toBeNull();

    act(() => { card("viewer").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    const win = q(".scene-textview")!;
    expect(win.textContent).toContain("보여 줄 글");
    expect(win.contains(active())).toBe(true);
    expect(outside([...walk(12), ...walk(6, true)], win)).toEqual([]);
    expect(q(".scene-nodepick")).toBeNull(); // 창이 가린 보드는 키를 받지 않는다(규칙 10) — Tab 은 창의 것
    key("Escape");
    expect(q(".scene-textview")).toBeNull();
    key("Tab", board());
    expect(q(".scene-nodepick")).not.toBeNull();
  });

  it("복구 창('이 카드에 생성물 붙이기'): 초점이 창 안에 있고 Tab 은 창 안에서 돈다. 닫으면 연 단추(⋮)로 돌아간다", async () => {
    await mountBoard({
      id: "s", name: "s", created_at: 1, edges: [],
      cards: [{ id: "empty", kind: "generation", x: 0, y: 0 }],
    } as Scene, { onGenerateCard: noop, onCanvasRecoveryCandidates: () => new Promise(() => {}), onCanvasRecoveryClaim: async () => {} });
    act(() => { // 카드를 고른다(누르고 뗀다) — 하나만 골랐을 때 카드 아래에 Generate 줄과 ⋮ 가 뜬다
      card("empty").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    });
    const opener = view.container.querySelector<HTMLElement>(".scene-cardgen-recover")!;
    act(() => opener.focus());
    act(() => opener.click());
    const win = q(".scene-recoverymodal")!;
    expect(win.contains(active())).toBe(true);
    expect(outside([...walk(12), ...walk(6, true)], win)).toEqual([]);
    expect(q(".scene-nodepick")).toBeNull();
    key("Escape");
    expect(q(".scene-recoverymodal")).toBeNull();
    expect(active()).toBe(opener);
  });
});
