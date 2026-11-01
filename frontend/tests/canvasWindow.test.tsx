// @vitest-environment jsdom
// 캔버스 탭 휠 클릭 → 캔버스를 새 창으로(2026-10-30, docs/status/캔버스_탭_새창_2026-10-30.md). Assets 창과 같은 openEmbedWindow 로
//  앱 전체를 이름 붙은 팝업 창에 띄우고, 그 창은 캔버스 탭으로 시작한다(창 이름으로 안다). 왼쪽 클릭은 지금처럼 탭만 바꾼다.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 가짜는 바깥 경계(서버 호출)에만 — 머리줄 시험(topBarIconButtons)과 같은 가짜
vi.mock("../src/api", () => {
  const pending = () => new Promise(() => {});
  return { api: new Proxy({}, { get: () => pending }) };
});
// 알림 종이 부르는 곳들 — 실패로 돌려준다(머리줄 시험과 같은 가짜)
vi.mock("../src/lib/releaseUpdate", () => ({ getReleaseUpdateStatus: vi.fn(() => Promise.reject(new Error("없음"))) }));
vi.mock("../src/lib/sharedApi", () => ({ sharedApi: { sharedServerRelocation: vi.fn(() => Promise.reject(new Error("없음"))) } }));
vi.mock("../src/lib/updateNoticeApi", () => ({ updateNoticeApi: { list: vi.fn(() => Promise.reject(new Error("없음"))) } }));

import { TopBar } from "../src/components/TopBar";
import { t } from "../src/lib/i18n";
import { closeEmbedWindow, EMBED_MODES, isCanvasWindow, openEmbedWindow, retireCanvasWindow } from "../src/lib/popupWindows";
import type { Store } from "../src/lib/storage";
import { useLibraryFilters } from "../src/lib/useLibraryFilters";
import { FILTERS_KEY } from "../src/lib/useLibraryPersistence";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const noop = () => {};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  // 잠금이 없는 주소에서는 캔버스 창을 띄우지 않는다(아래 시험) — 이 시험의 창은 잠금이 풀리는 일이 없다
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: () => new Promise(() => {}), query: async () => ({ held: [], pending: [] }) } });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.name = "";
  Reflect.deleteProperty(navigator, "locks");
  vi.restoreAllMocks();
});

const canvasTab = () => [...host.querySelectorAll<HTMLButtonElement>(".tabs button")].find((b) => b.textContent === t("캔버스"))!;
const wheelClick = (el: Element, button = 1) =>
  act(() => { el.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button })); });

function fakeStore(data: Record<string, string>): Store {
  return {
    get: (key, fallback) => data[key] ?? fallback,
    set: (key, value) => void (data[key] = value),
    loadJSON: <T,>(key: string) => (key in data ? (JSON.parse(data[key]) as T) : null),
    setJSON: (key, value) => void (data[key] = JSON.stringify(value)),
    loadSet: (key) => new Set(key in data ? (JSON.parse(data[key]) as string[]) : []),
    setSet: (key, value) => void (data[key] = JSON.stringify([...value])),
  };
}

describe("캔버스 탭 휠 클릭 → 새 창", () => {
  it("휠 클릭은 새 창만 열고 탭을 바꾸지 않는다 · 왼쪽 클릭은 지금처럼 탭만 · 오른쪽 단추는 아무 일 없음", async () => {
    const onTab = vi.fn(), onOpenCanvas = vi.fn();
    act(() => root.render(
      <TopBar filters={{ tab: "my" } as never} onTab={onTab} onSearch={noop} onWorkspaceSwitched={noop}
        workspaceContext={{ scope: "personal", id: null, name: null } as never} onWorkspaceContextChange={noop} onImported={noop}
        onOpenAssets={noop} onOpenCanvas={onOpenCanvas} onOpenAdmin={noop} hasUnreadComments={false}
        onOpenNotificationComment={noop} onNotificationsChanged={noop} />,
    ));
    wheelClick(canvasTab());
    // 휠 클릭 처리 안에서 열면 크롬이 새 탭으로 연다(실측) — 처리가 끝난 뒤에 연다
    expect(onOpenCanvas).not.toHaveBeenCalled();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect([onOpenCanvas.mock.calls.length, onTab.mock.calls.length]).toEqual([1, 0]);
    wheelClick(canvasTab(), 2);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(onOpenCanvas).toHaveBeenCalledTimes(1);
    act(() => canvasTab().click());
    expect(onTab).toHaveBeenCalledWith("compose");
    expect(onOpenCanvas).toHaveBeenCalledTimes(1);
  });

  it("탭 글자 옆 겹친 두 창은 캔버스가 떠 있을 때만", () => {
    const bar = (canvasFloating: boolean) => (
      <TopBar filters={{ tab: "my" } as never} onTab={noop} onSearch={noop} onWorkspaceSwitched={noop}
        workspaceContext={{ scope: "personal", id: null, name: null } as never} onWorkspaceContextChange={noop} onImported={noop}
        onOpenAssets={noop} onOpenCanvas={noop} canvasFloating={canvasFloating} onOpenAdmin={noop} hasUnreadComments={false}
        onOpenNotificationComment={noop} onNotificationsChanged={noop} />
    );
    act(() => root.render(bar(false)));
    expect(canvasTab().querySelector(".tab-float-ic")).toBeNull();
    act(() => root.render(bar(true)));
    expect(canvasTab().querySelector("svg.tab-float-ic")).not.toBeNull();
    expect(canvasTab().title).toBe(t("캔버스가 별도 창에 떠 있습니다"));
    act(() => root.render(bar(false))); // 창을 끄면 사라진다
    expect(canvasTab().querySelector(".tab-float-ic")).toBeNull();
  });

  it("잠금이 없는 주소에서는 캔버스 창을 열지 않는다 — 창의 끝을 확인할 근거가 없다 · Assets 창은 그대로", () => {
    Reflect.deleteProperty(navigator, "locks");
    const popup = { closed: false, focus: vi.fn(), close: vi.fn(() => { popup.closed = true; }), addEventListener: vi.fn() };
    const open = vi.spyOn(window, "open").mockImplementation((() => popup) as never);
    openEmbedWindow(EMBED_MODES.canvas);
    expect(open).not.toHaveBeenCalled();
    openEmbedWindow(EMBED_MODES.assets);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][1]).toBe("contenthub-assets");
    closeEmbedWindow(EMBED_MODES.assets);
  });

  it("잠금이 없는 주소에 남은 캔버스 창은 알리기 전에 물러나고 저장소를 열지 않는다(main.tsx)", () => {
    Reflect.deleteProperty(navigator, "locks");
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    expect(retireCanvasWindow()).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request: () => new Promise(() => {}), query: async () => ({ held: [], pending: [] }) } });
    expect(retireCanvasWindow()).toBe(false);
    expect(close).toHaveBeenCalledOnce();
    // 분기 자체 — 물러나는 판단이 announce·저장소 부팅보다 앞에 있다. main.tsx 는 불러오는 순간 앱을 띄워 파일로 본다
    const main = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");
    const retire = main.indexOf("isCanvasWindow() && retireCanvasWindow()");
    expect(retire).toBeGreaterThan(0);
    expect(retire).toBeLessThan(main.indexOf("announceCanvasWindow();"));
    expect(retire).toBeLessThan(main.indexOf("await bootSceneStore()"));
    expect(readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8")).toMatch(/const openCanvasWindow = async \(\) => \{\s+if \(!canFloatCanvas\(\)\) return flash\(/);
  });

  it("Assets 처럼 이름 붙은 팝업 창으로 열고, 떠 있으면 다시 열지 않고 앞으로 · 그 창 안에서는 제 창을 다시 읽지 않는다", () => {
    const popup = { closed: false, focus: vi.fn(), close: vi.fn(() => { popup.closed = true; }), addEventListener: vi.fn() };
    const open = vi.spyOn(window, "open").mockImplementation((() => popup) as never);
    openEmbedWindow(EMBED_MODES.canvas);
    expect(open).toHaveBeenCalledTimes(1);
    const [url, name, features] = open.mock.calls[0];
    expect(url).toMatch(/^\/\?embed=canvas&v=\d+$/);
    expect(name).toBe("contenthub-canvas");
    expect(features).toContain("popup=yes");
    openEmbedWindow(EMBED_MODES.canvas); // 다시 휠 클릭
    expect(open).toHaveBeenCalledTimes(1);
    expect(popup.focus).toHaveBeenCalledTimes(2); // 열 때 한 번 + 다시 누름
    closeEmbedWindow(EMBED_MODES.canvas);

    expect(isCanvasWindow()).toBe(false);
    window.name = "contenthub-canvas"; // 그 창 안
    expect(isCanvasWindow()).toBe(true);
    openEmbedWindow(EMBED_MODES.canvas);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("캔버스 창은 저장된 탭과 무관하게 캔버스로 시작하고 탭 기억을 쓰지 않는다 — 보통 창은 저장된 탭 그대로 쓰고 저장한다", () => {
    let latest: ReturnType<typeof useLibraryFilters> | null = null;
    let store: Store;
    function Probe() {
      latest = useLibraryFilters(store);
      return null;
    }
    const saved = JSON.stringify({ tab: "my" }); // 형식 표식 없음 — 저장하면 붙는다

    window.name = "contenthub-canvas";
    const canvasData = { [FILTERS_KEY]: saved };
    store = fakeStore(canvasData);
    act(() => root.render(<Probe />));
    expect(latest!.filters.tab).toBe("compose");
    expect(canvasData[FILTERS_KEY]).toBe(saved);
    act(() => root.unmount());

    window.name = "";
    root = createRoot(host);
    const mainData = { [FILTERS_KEY]: saved };
    store = fakeStore(mainData);
    act(() => root.render(<Probe />));
    expect(latest!.filters.tab).toBe("my");
    expect(JSON.parse(mainData[FILTERS_KEY])).toMatchObject({ tab: "my", __v: "2" });
  });
});

// 새로 여는 캔버스 창이 메인 창에서 보던 그대로(2026-10-30, docs/status/캔버스_창_보던값_2026-10-30.md) — 저장 안 되는 화면 값을 여는 순간
// 한 칸에 넘기고 캔버스 창이 처음 그릴 때 한 번 읽는다. 창마다 모듈이 따로라 vi.resetModules 로 새 창을 흉내 낸다.
describe("캔버스 창에 넘기는 화면 값", () => {
  const KEY = "mvhub.canvasHandoff";
  const fresh = async () => {
    vi.resetModules();
    return import("../src/lib/popupWindows");
  };
  afterEach(() => localStorage.removeItem(KEY));

  it("캔버스 창만 한 번 읽고 지운다 · 옵션은 글자·숫자·참거짓만 · 메인 창은 읽지도 지우지도 않는다", async () => {
    const main = await fresh();
    main.leaveCanvasHandoff({
      promptVisible: false, batchCount: 3, prompt: { type: "video", model: "m1", params: { ratio: "16:9", n: 2, on: true, bad: { x: 1 } as never } },
      promptDraft: { key: "s1:none", draft: "[]" },
      selection: { sceneId: "s1", cardIds: ["c1", "c2"], groupIds: ["g1"] },
    });
    expect(main.takeCanvasHandoff()).toBeNull(); // window.name 이 비었다 = 메인 창
    expect(main.canvasHandoffSelection("s1")).toBeNull();
    expect(localStorage.getItem(KEY)).not.toBeNull();

    window.name = "contenthub-canvas";
    const canvas = await fresh();
    const taken = canvas.takeCanvasHandoff();
    expect(taken).toEqual({
      promptVisible: false, batchCount: 3, prompt: { type: "video", model: "m1", params: { ratio: "16:9", n: 2, on: true } },
      promptDraft: { key: "s1:none", draft: "[]" },
      selection: { sceneId: "s1", cardIds: ["c1", "c2"], groupIds: ["g1"] },
    });
    // 선택은 그 씬에만, 처음 그린 뒤 '썼다' 표시하면 다시 주지 않는다(SceneBoard 를 다시 그릴 때 되살아나지 않게)
    expect(canvas.canvasHandoffSelection("other")).toBeNull();
    expect(canvas.canvasHandoffSelection("s1")).toEqual({ sceneId: "s1", cardIds: ["c1", "c2"], groupIds: ["g1"] });
    canvas.markCanvasHandoffSelectionUsed();
    expect(canvas.canvasHandoffSelection("s1")).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(canvas.takeCanvasHandoff()).toBe(taken); // 여러 훅이 같은 값을 읽는다
  });

  it("60초 지난 값·모양이 틀린 값은 버린다 — 처음 값으로 뜬다", async () => {
    window.name = "contenthub-canvas";
    localStorage.setItem(KEY, JSON.stringify({ promptVisible: false, batchCount: 2, prompt: null, at: Date.now() - 61_000 }));
    expect((await fresh()).takeCanvasHandoff()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
    localStorage.setItem(KEY, JSON.stringify({ promptVisible: "no", batchCount: 2, at: Date.now() }));
    expect((await fresh()).takeCanvasHandoff()).toBeNull();
    localStorage.setItem(KEY, JSON.stringify({ promptVisible: true, batchCount: 1, prompt: { type: "3d", model: "m" },
      selection: { sceneId: "s1", cardIds: ["c1", 7], groupIds: [] }, at: Date.now() }));
    // 모르는 종류의 모델·글자가 아닌 id 가 섞인 선택은 버린다
    expect((await fresh()).takeCanvasHandoff()).toEqual({ promptVisible: true, batchCount: 1, prompt: null, promptDraft: null, selection: null });
  });

  it("캔버스 창의 프롬프트 창은 메인 창에서 숨겼으면 숨긴 채로 시작한다 — 넘긴 값이 없으면 지금처럼 보인다", async () => {
    window.name = "contenthub-canvas";
    const probe = async () => {
      vi.resetModules();
      const { usePromptDock } = await import("../src/lib/usePromptDock");
      const seen = { visible: true };
      function Probe() {
        seen.visible = usePromptDock(fakeStore({})).promptVisible;
        return null;
      }
      act(() => root.render(<Probe />));
      act(() => root.unmount());
      root = createRoot(host);
      return seen.visible;
    };
    localStorage.setItem(KEY, JSON.stringify({ promptVisible: false, batchCount: 1, prompt: null, at: Date.now() }));
    expect(await probe()).toBe(false);
    expect(await probe()).toBe(true); // 한 번 읽었으니 다음 창(새로 고침)은 처음 값
  });
});

// 캔버스 창이 떠 있는가(2026-10-30, docs/status/캔버스_떠있는창_2026-10-30.md) — 창끼리 BroadcastChannel 로 안다.
// 창마다 모듈이 따로라 vi.resetModules 로 새 창(또는 새로 고친 창)의 모듈을 흉내 낸다.
describe("캔버스 창이 떠 있음", () => {
  const CHANNEL = "mvhub-canvas-window";
  const sleep = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  async function until(check: () => boolean) {
    for (let waited = 0; !check(); waited += 10) {
      if (waited > 2000) throw new Error("기다린 값이 오지 않았다");
      await sleep(10);
    }
  }
  async function mainWindow() {
    vi.resetModules();
    const mod = await import("../src/lib/popupWindows");
    const seen = { floating: false };
    function Probe() {
      seen.floating = mod.useCanvasFloating();
      return null;
    }
    act(() => root.render(<Probe />));
    return { mod, seen };
  }

  it("메인 창을 새로 고친 뒤에도 물어서 안다 · 창이 닫혔다고 알리면 0.3초 뒤 캔버스가 돌아온다", async () => {
    const canvasSide = new BroadcastChannel(CHANNEL); // 이미 떠 있는 캔버스 창
    canvasSide.onmessage = (event) => { if (event.data === "ping") canvasSide.postMessage("open"); };
    try {
      const { seen } = await mainWindow();
      await until(() => seen.floating);
      canvasSide.postMessage("closed");
      await sleep(60);
      expect(seen.floating).toBe(true); // 새로 고침일 수도 있어 바로 내리지 않는다
      await until(() => !seen.floating);
    } finally {
      canvasSide.close();
    }
  });

  it("이 창이 연 창은 여는 순간 떠 있음 · 그 창이 살아 있으면(새로 고침) 'closed' 에도 그대로 · 참조를 잃은 뒤 다시 열면 그 창을 다시 읽지 않는다", async () => {
    const other = new BroadcastChannel(CHANNEL);
    try {
      const { mod, seen } = await mainWindow();
      const popup = { closed: false, focus: vi.fn(), close: vi.fn(), addEventListener: vi.fn(), location: { href: "http://localhost/?embed=canvas&v=1" } };
      const open = vi.spyOn(window, "open").mockImplementation((() => popup) as never);
      act(() => mod.openEmbedWindow(mod.EMBED_MODES.canvas));
      expect(seen.floating).toBe(true);

      other.postMessage("closed"); // 캔버스 창을 새로 고쳤다
      await sleep(450);
      expect(seen.floating).toBe(true);
      popup.closed = true; // 이번엔 닫았다
      other.postMessage("closed");
      await until(() => !seen.floating);

      other.postMessage("open"); // 메인 창을 새로 고친 뒤처럼 — 떠 있다는 것만 알고 그 창의 참조는 없다(위 참조는 닫힘)
      await until(() => seen.floating);
      const live = { closed: false, focus: vi.fn(), addEventListener: vi.fn(), location: { href: "http://localhost/?embed=canvas&v=1" } };
      open.mockImplementation((() => live) as never);
      act(() => mod.openEmbedWindow(mod.EMBED_MODES.canvas));
      expect(open.mock.calls.at(-1)?.[0]).toBe(""); // 빈 주소 — 같은 이름의 창만 잡는다
      expect(live.location.href).toBe("http://localhost/?embed=canvas&v=1"); // 다시 읽지 않았다
      expect(live.focus).toHaveBeenCalled();
    } finally {
      other.close();
    }
  });

  it("이 창이 연 캔버스 창이 닫히면 'closed' 신호가 없어도 캔버스가 돌아온다(머리줄 단추의 창 확인)", async () => {
    const { mod, seen } = await mainWindow();
    const popup = { closed: false, focus: vi.fn(), close: vi.fn(), addEventListener: vi.fn(), location: { href: "http://localhost/?embed=canvas&v=1" } };
    vi.spyOn(window, "open").mockImplementation((() => popup) as never);
    function Watch() {
      mod.useEmbedWindowOpen(mod.EMBED_MODES.assets); // 머리줄이 하는 것 — 창이 떠 있는 동안 0.5초마다 .closed 를 본다
      return null;
    }
    const watchHost = document.createElement("div");
    const watchRoot = createRoot(watchHost);
    act(() => watchRoot.render(<Watch />));
    try {
      act(() => mod.openEmbedWindow(mod.EMBED_MODES.canvas));
      expect(seen.floating).toBe(true);
      popup.closed = true; // 신호 없이 사라졌다(비정상 종료 등)
      await until(() => !seen.floating);
    } finally {
      act(() => watchRoot.unmount());
    }
  });

  // 캔버스 창 쪽 — 이 시험의 채널·pagehide 듣기는 남으므로 맨 끝에 둔다(뒤 시험의 ping 에 답하지 않게)
  it("캔버스 창은 켜질 때·물으면 'open', 닫히거나 새로 고칠 때 'closed' 를 알린다", async () => {
    vi.resetModules();
    const mod = await import("../src/lib/popupWindows");
    const heard: unknown[] = [];
    const listener = new BroadcastChannel(CHANNEL);
    listener.onmessage = (event) => heard.push(event.data);
    try {
      mod.announceCanvasWindow();
      await until(() => heard.includes("open"));
      heard.length = 0;
      listener.postMessage("ping");
      await until(() => heard.includes("open"));
      heard.length = 0;
      window.dispatchEvent(new Event("pagehide"));
      await until(() => heard.includes("closed"));
    } finally {
      listener.close();
    }
  });
});
