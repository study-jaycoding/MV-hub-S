// 탭 설명 창의 씬 단추(Jay 2026-11-02) — 창은 탭 밑에 붙어 누를 수 있고, 누른 단추는 그 씬이 열린 뒤 패널과 같은 동작을 한 번 부른다.
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SceneBar } from "../src/components/scene/SceneBar";
import { SceneBoard } from "../src/components/scene/SceneBoard";
import type { SceneIoAction } from "../src/components/scene/SceneIoButtons";
import { setHubFeatures } from "../src/lib/hubFeatures";
import type { Scene } from "../src/lib/scenes";
import type { SceneGenDataApi } from "../src/lib/useSceneGenData";
import type { WorkspaceContext } from "../src/types";

const fixture = vi.hoisted(() => ({ data: null as unknown as SceneGenDataApi }));
vi.mock("../src/lib/useSceneGenData", () => ({ useSceneGenData: () => fixture.data }));

const noop = () => {};
const personal: WorkspaceContext = { scope: "personal", id: null, name: null };
const scene = (id: string) => ({ id, name: id, cards: [], edges: [], groups: [], created_at: 0 }) as unknown as Scene;
const ALL: SceneIoAction[] = ["keep", "keeps", "import", "export", "find"];
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setHubFeatures([]);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("Unexpected socket in isolated UI test"); } });
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network in isolated UI test"))));
  fixture.data = {
    genData: {}, genDataRef: { current: {} }, setGenData: noop,
    missingIds: new Set(), disabledIds: new Set(), refParents: {},
  } as unknown as SceneGenDataApi;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("탭 설명 창", () => {
  const onTabAction = vi.fn();
  const tip = () => document.querySelector<HTMLElement>(".node-tip.tab");
  const labels = () => [...tip()!.querySelectorAll(".scene-io-btn")].map((el) => el.textContent);
  const hover = async (tab: HTMLElement) => {
    await act(async () => {
      tab.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: 500, clientY: 30 }));
      vi.advanceTimersByTime(450);
    });
  };
  const leave = (el: Element) => el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
  const enter = (el: Element) => el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
  const mount = (tabActions: SceneIoAction[] = ALL) => {
    vi.useFakeTimers();
    onTabAction.mockClear();
    act(() => {
      root.render(
        <SceneBar scenes={[scene("s1"), scene("s2")]} activeId="s1" workspaceContext={personal} onSelect={noop} onAdd={noop}
          onRename={noop} onDelete={noop} onReorder={noop} onAssignWorkspace={noop} tabActions={tabActions} onTabAction={onTabAction} />,
      );
    });
    const tab = host.querySelectorAll<HTMLElement>(".scene-tab")[1];
    tab.getBoundingClientRect = () => ({ left: 100, bottom: 40 }) as DOMRect;
    return tab;
  };

  it("탭 밑에 붙어 뜨고 단추는 패널과 같은 칸 묶음이다", async () => {
    await hover(mount());
    expect(tip()?.style.left).toBe("100px");
    expect(tip()?.style.top).toBe("46px");
    expect(tip()?.querySelector(".node-tip-head")?.textContent).toBe("s2");
    expect(labels()).toEqual(["보관", "불러오기", "Import", "Export", "레퍼런스 찾기"]);
    expect(tip()?.querySelectorAll(".scene-io-sep")).toHaveLength(2);
    expect(tip()?.querySelector(".node-tip-keys")).toBeNull(); // 조작 안내 줄은 없다
  });

  it("보관이 안 되는 허브는 그 칸이 없다", async () => {
    await hover(mount(["import", "export", "find"]));
    expect(labels()).toEqual(["Import", "Export", "레퍼런스 찾기"]);
  });

  it("마우스가 탭에서 창으로 건너가도 닫히지 않고, 눌러도 먼저 닫히지 않으며, 누르면 그 탭의 동작을 부르고 닫힌다", async () => {
    const tab = mount();
    await hover(tab);
    await act(async () => { leave(tab); vi.advanceTimersByTime(100); });
    await act(async () => { enter(tip()!); vi.advanceTimersByTime(400); });
    expect(tip()).not.toBeNull();
    const exportButton = [...tip()!.querySelectorAll<HTMLButtonElement>(".scene-io-btn")].find((el) => el.textContent === "Export")!;
    await act(async () => { exportButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(tip()).not.toBeNull();
    await act(async () => { exportButton.click(); });
    expect(onTabAction.mock.calls).toEqual([["s2", "export"]]);
    expect(tip()).toBeNull();
    expect(tab.getAttribute("title")).toBe("s2"); // 떼어 둔 글이 돌아온다
  });

  it("창에서도 벗어나면 잠시 뒤 닫히고, 그 틈에 탭으로 돌아오면 그대로다 · 바깥을 누르면 바로 닫힌다", async () => {
    const tab = mount();
    await hover(tab);
    await act(async () => { enter(tip()!); });
    await act(async () => { leave(tip()!); vi.advanceTimersByTime(100); });
    await act(async () => { tab.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); vi.advanceTimersByTime(400); });
    expect(tip()).not.toBeNull();
    await act(async () => { leave(tab); vi.advanceTimersByTime(200); });
    expect(tip()).toBeNull();
    await hover(tab);
    await act(async () => { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(tip()).toBeNull();
  });

  it("창이 뜨기 전에 벗어나면 뜨지 않는다", async () => {
    const tab = mount();
    await act(async () => {
      tab.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(200);
      leave(tab);
      vi.advanceTimersByTime(600);
    });
    expect(tip()).toBeNull();
  });
});

describe("SceneBoard 의 단추 요청", () => {
  it("그 씬이 열렸을 때 한 번만 실행한다 — 다른 씬의 요청은 기다린다", async () => {
    const save = vi.fn();
    const done = vi.fn();
    const request = { sceneId: "B", action: "export" as const };
    const draw = (current: Scene) => act(async () => {
      root.render(<SceneBoard scene={current} onChange={noop} onSaveScene={save} ioRequest={request} onIoRequestDone={done} />);
    });
    await draw(scene("A"));
    expect(save).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    await draw(scene("B"));
    expect(save).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
    await draw(scene("B")); // App 이 지우기 전에 다시 그려져도 다시 실행하지 않는다
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("보관·불러오기·레퍼런스 찾기도 패널과 같은 동작이고, 찾는 중에 다시 눌러도 중단되지 않는다", async () => {
    const keep = vi.fn();
    const keeps = vi.fn();
    let signal: AbortSignal | undefined;
    const find = vi.fn((_id: string, s: AbortSignal) => { signal = s; return new Promise<void>(noop); });
    const current = scene("A");
    const draw = (action: SceneIoAction) => act(async () => {
      root.render(<SceneBoard scene={current} onChange={noop} onKeepScene={keep} onOpenSceneKeeps={keeps} onFindRefs={find}
        ioRequest={{ sceneId: "A", action }} onIoRequestDone={noop} />);
    });
    await draw("keep");
    expect(keep).toHaveBeenCalledTimes(1);
    await draw("keeps");
    expect(keeps).toHaveBeenCalledTimes(1);
    await draw("find");
    await draw("find");
    expect(find).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
  });
});
