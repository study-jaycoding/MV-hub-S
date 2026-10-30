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
