// @vitest-environment jsdom
// 별도 창(Assets·관리)을 앱 창 위로(Jay 2026-10-26, docs/status/별도창_앞으로_2026-10-26.md) — 앱(앱 창·별도 창)을 떠났다가 앱 창으로
//  돌아올 때만 허브에 올려 달라고 한다. 앱 안에서 창을 옮긴 것(blur 바로 뒤 focus)에는 부르지 않는다.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { jsonFetch } = vi.hoisted(() => ({
  jsonFetch: vi.fn((_url: string, _init?: RequestInit): Promise<unknown> => Promise.resolve({ raised: 1 })),
}));
vi.mock("../src/lib/http", () => ({ jsonFetch }));

import { closeEmbedWindow, EMBED_MODES, openEmbedWindow } from "../src/lib/popupWindows";

const ASSETS = "Millionvolt Hub — Assets (구성)";
const MANAGE = "Millionvolt Hub — 프로젝트 관리";
let focused: "main" | "assets" | "manage" | "outside" = "main";

function fakePopup(name: "assets" | "manage", title: string) {
  const w = Object.assign(new EventTarget(), {
    closed: false,
    focus: vi.fn(),
    close: vi.fn(() => { w.closed = true; }),
    document: { title, hasFocus: () => focused === name },
  });
  return w;
}
const popups = { "contenthub-assets": fakePopup("assets", ASSETS), "contenthub-manage": fakePopup("manage", MANAGE) };

// 초점 옮기기 — 브라우저처럼 잃는 창의 blur 가 먼저, 얻는 창의 focus 가 다음
function move(to: typeof focused) {
  const target = (who: typeof focused) => (who === "main" ? window : who === "outside" ? null : popups[`contenthub-${who}`]);
  const from = target(focused);
  focused = to;
  from?.dispatchEvent(new Event("blur"));
  target(to)?.dispatchEvent(new Event("focus"));
}
const settle = () => vi.advanceTimersByTime(500); // 앱 밖에 머문 시간(가짜 타이머가 Date.now 도 움직인다)
const raised = () => jsonFetch.mock.calls.map(([url, init]) => [url, JSON.parse(init?.body as string)]);

beforeAll(() => {
  vi.useFakeTimers();
  document.title = "Millionvolt Hub";
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused === "main");
  vi.spyOn(window, "open").mockImplementation(((_url: string, name: keyof typeof popups) => popups[name]) as never);
});
afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("별도 창을 앱 창 위로", () => {
  it("다른 프로그램에 갔다가 앱 창으로 돌아오면 떠 있는 별도 창 제목으로 한 번 부른다 — 앱 안에서 옮긴 것에는 안 부른다", () => {
    openEmbedWindow(EMBED_MODES.assets);
    move("assets"); // 열린 창이 초점을 가져갔다
    settle();
    move("main"); // 별도 창 → 앱 창(앱 안)
    settle();
    expect(jsonFetch).not.toHaveBeenCalled();

    move("outside"); // 앱 창 → 다른 프로그램
    settle();
    move("main");
    settle();
    expect(raised()).toEqual([["/api/app-windows/raise", { main: "Millionvolt Hub", titles: [ASSETS] }]]);
    expect(jsonFetch.mock.calls[0][1]).toMatchObject({ method: "POST" });

    move("outside"); // 0.3초 안에 돌아왔다 — 떠난 것으로 치지 않는다
    vi.advanceTimersByTime(200);
    move("main");
    expect(jsonFetch).toHaveBeenCalledTimes(1);
  });

  it("별도 창에서 다른 프로그램으로 갔다가 앱 창으로 와도 부르고, 별도 창을 눌러 돌아온 뒤 앱 창으로 오면 안 부른다 — 떠 있는 창 모두", () => {
    jsonFetch.mockClear();
    openEmbedWindow(EMBED_MODES.manage);
    move("manage");
    settle();
    move("outside"); // 별도 창 → 다른 프로그램
    settle();
    move("main");
    settle();
    expect(raised()).toEqual([["/api/app-windows/raise", { main: "Millionvolt Hub", titles: [ASSETS, MANAGE] }]]);

    move("outside");
    settle();
    move("assets"); // 별도 창을 눌러 앱으로 돌아왔다
    settle();
    move("main"); // 그 뒤 앱 창 — 앱 안에서 옮긴 것
    settle();
    expect(jsonFetch).toHaveBeenCalledTimes(1);
  });

  it("떠 있는 별도 창이 없으면 부르지 않고, 허브가 실패해도 조용하다", async () => {
    jsonFetch.mockClear();
    jsonFetch.mockImplementationOnce(() => Promise.reject(new Error("404")));
    move("outside");
    settle();
    move("main");
    settle();
    await Promise.resolve(); // 거절이 잡히지 않으면 시험이 실패한다(처리 안 된 거절)
    expect(jsonFetch).toHaveBeenCalledTimes(1);

    closeEmbedWindow(EMBED_MODES.assets);
    closeEmbedWindow(EMBED_MODES.manage);
    move("outside");
    settle();
    move("main");
    settle();
    expect(jsonFetch).toHaveBeenCalledTimes(1);
  });
});
