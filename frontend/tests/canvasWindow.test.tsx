// @vitest-environment jsdom
// 캔버스 탭 휠 클릭 → 캔버스를 새 창으로(2026-10-30, docs/status/캔버스_탭_새창_2026-10-30.md). Assets 창과 같은 openEmbedWindow 로
//  앱 전체를 이름 붙은 팝업 창에 띄우고, 그 창은 캔버스 탭으로 시작한다(창 이름으로 안다). 왼쪽 클릭은 지금처럼 탭만 바꾼다.
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
import { closeEmbedWindow, EMBED_MODES, isCanvasWindow, openEmbedWindow } from "../src/lib/popupWindows";
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
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.name = "";
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
  it("휠 클릭은 새 창만 열고 탭을 바꾸지 않는다 · 왼쪽 클릭은 지금처럼 탭만 · 오른쪽 단추는 아무 일 없음", () => {
    const onTab = vi.fn(), onOpenCanvas = vi.fn();
    act(() => root.render(
      <TopBar filters={{ tab: "my" } as never} onTab={onTab} onSearch={noop} onWorkspaceSwitched={noop}
        workspaceContext={{ scope: "personal", id: null, name: null } as never} onWorkspaceContextChange={noop} onImported={noop}
        onOpenAssets={noop} onOpenCanvas={onOpenCanvas} onOpenAdmin={noop} hasUnreadComments={false}
        onOpenNotificationComment={noop} onNotificationsChanged={noop} />,
    ));
    wheelClick(canvasTab());
    expect([onOpenCanvas.mock.calls.length, onTab.mock.calls.length]).toEqual([1, 0]);
    wheelClick(canvasTab(), 2);
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
