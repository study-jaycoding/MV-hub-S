// @vitest-environment jsdom
// 편집 탭 비디오 클린 피드(Jay 2026-10-23, 다빈치) — 싱글/듀얼 단추 왼쪽의 단추 · 모니터 메뉴 · 고른 모니터의 창에 보이는 클립만.
//  jsdom 에는 창 관리 API 가 없다 — getScreenDetails 와 window.open 은 시험이 대신한다(연 창 = 빈 문서 하나).
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubFeed, type CleanFeedHubInput, type FeedScreen } from "../src/components/timeline/EditCleanFeed";
import type { EditCardMenu } from "../src/components/timeline/EditTab";
import { BUFFER_LIMIT, FEED_CLIENT, STATUS_GIVE_UP_MS } from "../src/lib/cleanFeedProtocol";
import { clipKey } from "../src/lib/editTimeline";
import { setAuthToken } from "../src/lib/http";
import type { EditTree } from "../src/lib/useEditSequence";
import type { Generation } from "../src/types";

const gen = (id: string, cut: string) => ({
  id, job_id: `job-${id}`, status: "done", params: {}, prompt: `prompt ${id}`, folder_path: `e070/${cut}`, project_id: "p1",
  shared: true, is_final: false, is_held: false, is_mine: false, tags: [], creator_name: "리버", model: "seedance",
  assets: [{ id: `a-${id}`, generation_id: id, type: "image", file_path: `/media/${id}.png`, thumbnail_path: null, source_url: null, cached: true }],
} as unknown as Generation);

const world = vi.hoisted(() => ({ gens: [] as unknown[] }));
vi.mock("../src/lib/resolveTransfer", async () => ({
  ...(await vi.importActual<typeof import("../src/lib/resolveTransfer")>("../src/lib/resolveTransfer")),
  getResolveConnectionStatus: () => Promise.reject(new Error("안 물었다")),
}));
vi.mock("../src/lib/useEditSequence", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/useEditSequence")>("../src/lib/useEditSequence");
  const counts = { final: 0, held: 0, shared: 2 };
  const tree = { state: "ready", complete: true, note: null, roots: [{
    name: "e070", path: "e070", count: 2, newCount: 0, reviewCounts: counts, children: ["c1"].map((name) => (
      { name, path: `e070/${name}`, count: 2, newCount: 0, reviewCounts: counts })) }] } as unknown as EditTree;
  return {
    ...actual,
    useEditProjects: () => ({
      projects: [{ id: "p1", name: "P1" }], projectsState: "ok", tree, reload: () => {}, reloadCounts: () => {}, freshByProject: {},
    }),
    useEditGenerations: () => ({ state: "ok", gens: world.gens, error: null, complete: true, known: true, reload: () => {} }),
  };
});
vi.mock("../src/lib/useDisabledFolders", () => ({ useDisabledFolders: () => ({}) }));

import { EditTab } from "../src/components/timeline/EditTab";

let host: HTMLDivElement;
let root: Root;
const flashed: string[] = [];
const cardMenuRef: { current: EditCardMenu | null } = { current: null };
const mount = () => {
  act(() => root.render(
    <EditTab authKey="auth" authReady workspace={{ scope: "team", id: "w1", name: "W" }} keysActive
      flash={(message: string) => { flashed.push(message); }} onOpenCutFolder={() => {}} reloadSignal={0}
      peekPath={null} onPeekMarks={() => {}} cardMenuRef={cardMenuRef} onPreview={() => {}} onCompare={() => {}}
      resolve={{ send: () => {}, sendTimeline: () => new Promise<never>(() => {}), busy: false, pendingCount: 0, timelineBusy: false }}
      onFolderAction={() => {}} />,
  ));
  act(() => [...document.querySelectorAll<HTMLButtonElement>(".ed-cutcell")].find((cell) => cell.textContent === "c1")!.click());
};
const screen = (left: number, top: number, width: number, height: number, isPrimary = false) =>
  ({ label: "Generic PnP Monitor", left, top, width, height, availLeft: left, availTop: top, availWidth: width, availHeight: height, isPrimary });
const SCREENS = [screen(0, 0, 2560, 1440, true), screen(2560, 0, 1440, 2560), screen(-1440, 0, 1440, 2560)];
const feedButton = () => document.querySelector<HTMLButtonElement>(".ed-feedbtn")!;
const items = () => [...document.querySelectorAll<HTMLButtonElement>(".ed-feedpop .ed-pop-item")];
const openMenu = async () => {
  await act(async () => { feedButton().click(); });
  await act(async () => {}); // getScreenDetails 가 돌려준 뒤
};
// 연 창 — 빈 문서 하나와 닫기·이벤트(blur·keydown·message)·권한 넘기기(postMessage). focused = 그 창의 초점, full = 전체 화면 요청
type FakeWin = EventTarget & {
  features: string; doc: Document; closed: boolean; focused: boolean; close: () => void;
  postMessage: ReturnType<typeof vi.fn>; full: ReturnType<typeof vi.fn>;
};
let opened: FakeWin[] = [];
let blocked = false; // 팝업 차단(누름 없이 연 것)
let appFocused = true; // 앱 창의 초점(document.hasFocus)
const chip = () => document.querySelector(".ed-feedchip")?.textContent ?? null;
const pickMonitor2 = async () => {
  (window as { getScreenDetails?: unknown }).getScreenDetails = () => Promise.resolve({ screens: SCREENS, currentScreen: SCREENS[0] });
  mount();
  await openMenu();
  act(() => items()[2].click());
};
// 다른 프로그램으로 간다 — 두 창 모두 초점을 잃고, 앱 창의 blur
const leaveApp = () => {
  appFocused = false;
  opened.forEach((win) => { win.focused = false; });
  act(() => { window.dispatchEvent(new Event("blur")); });
  act(() => { vi.advanceTimersByTime(200); });
  act(() => { vi.advanceTimersByTime(1); }); // 창은 다음 틱에 닫힌다
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem("ch.editTimeline.last:local", JSON.stringify({ projectId: "p1", seq: "e070" }));
  localStorage.setItem("mvhub.editDoc:local:p1:e070", JSON.stringify({ v: 1, tracksOff: [], tracksLocked: [], clips: [
    { cut: "e070/c1", gen: "a", track: 1, kind: "image", dur: 5 },
    { cut: "e070/c1", gen: "b", track: 2, kind: "image", dur: 5 },
  ] }));
  for (const method of ["load", "pause"] as const) vi.spyOn(HTMLMediaElement.prototype, method).mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  world.gens = [gen("a", "c1"), gen("b", "c1")];
  flashed.length = 0;
  opened = [];
  blocked = false;
  appFocused = true;
  vi.spyOn(window, "open").mockImplementation(((_url?: string, _target?: string, features?: string) => {
    if (blocked) return null;
    const doc = document.implementation.createHTMLDocument("feed");
    const full = vi.fn(() => Promise.resolve());
    (doc.documentElement as unknown as { requestFullscreen: unknown }).requestFullscreen = full;
    const win = Object.assign(new EventTarget(), {
      features: features ?? "", doc, document: doc, closed: false, focused: false, close() { win.closed = true; }, postMessage: vi.fn(), full,
    });
    vi.spyOn(doc, "hasFocus").mockImplementation(() => win.focused);
    opened.push(win);
    return win as unknown as Window;
  }) as typeof window.open);
  vi.spyOn(window, "focus").mockImplementation(() => {}); // jsdom 에 없다
  vi.spyOn(document, "hasFocus").mockImplementation(() => appFocused);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as { getScreenDetails?: unknown }).getScreenDetails;
  vi.unstubAllGlobals();
  setAuthToken(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("단추는 싱글/듀얼 단추 바로 왼쪽 — 창 관리 API 가 없으면 '사용 안 함'과 안내 한 줄", async () => {
  mount();
  const top = feedButton().closest(".ed-vtop")!;
  const kids = [...top.children];
  expect(kids.indexOf(feedButton().closest(".ed-feed")!) + 1).toBe(kids.indexOf(top.querySelector(".ed-dual")!));
  await openMenu();
  expect(document.querySelector(".ed-feedpop .ed-pop-head")!.textContent).toBe("비디오 클린 피드");
  expect(items().map((item) => item.textContent)).toEqual(["✓사용 안 함"]);
  expect(document.querySelector(".ed-feedpop .ed-pop-note")!.textContent).toContain("지원하지 않습니다");
});

it("모니터를 고르면 그 자리에 창을 열고 보이는 클립(위 트랙)을 보여 준다 — 사용 안 함·창 닫힘·탭 떠남이면 끈다", async () => {
  (window as { getScreenDetails?: unknown }).getScreenDetails = () => Promise.resolve({ screens: SCREENS, currentScreen: SCREENS[0] });
  mount();
  await openMenu();
  expect(items().map((item) => [item.textContent, item.disabled])).toEqual([
    ["✓사용 안 함", false],
    ["모니터 1 — Generic PnP Monitor이 창 · 주 모니터", true], // 앱 창이 있는 모니터는 고를 수 없다
    ["모니터 2 — Generic PnP Monitor1440×2560", false],
    ["모니터 3 — Generic PnP Monitor1440×2560", false],
  ]);
  act(() => items()[2].click());
  expect(opened).toHaveLength(1);
  expect(opened[0].features).toContain("left=2560,top=0,width=1440,height=2560");
  expect(feedButton().classList.contains("ed-on")).toBe(true);
  expect(document.querySelector(".ed-feedchip")!.textContent).toBe("클린 피드 · 모니터 2");
  act(() => { vi.advanceTimersByTime(50); }); // 따라가기는 프레임마다
  const feed = opened[0].doc;
  expect(feed.querySelector("video")!.muted).toBe(true); // 소리는 없다
  expect(feed.querySelector("img")!.getAttribute("src")).toBe("/media/b.png"); // V1(a) 위의 V2(b)가 보인다

  await openMenu();
  act(() => items()[0].click()); // 사용 안 함
  act(() => { vi.advanceTimersByTime(1); }); // 창은 다음 틱에 닫는다(StrictMode 의 거짓 정리에 닫히지 않게 — 아래 시험)
  expect([opened[0].closed, document.querySelector(".ed-feedchip")]).toEqual([true, null]);

  await openMenu();
  act(() => items()[3].click()); // 모니터 3
  opened[1].closed = true; // 사람이 그 창을 닫았다
  act(() => { vi.advanceTimersByTime(600); });
  expect([feedButton().classList.contains("ed-on"), document.querySelector(".ed-feedchip")]).toEqual([false, null]);

  await openMenu();
  act(() => items()[2].click());
  act(() => root.unmount()); // 편집 탭을 떠남
  root = createRoot(host);
  act(() => { vi.advanceTimersByTime(1); });
  expect(opened[2].closed).toBe(true);
  expect(flashed).toEqual([]);
});

// Jay 2026-10-23 "화면이 뜨는거 같더니 갑자기 사라진다" — 개발 화면은 StrictMode 라 효과가 '붙임 → 뗌 → 다시 붙임'으로 한 번 더 돈다. 떼는 순간 창을
//  닫으면 뜨자마자 닫히고, 다시 붙은 감시(0.5초)가 '닫힘'을 보고 껐다.
it("StrictMode(개발 화면)에서도 고른 모니터의 창이 뜬 채 남는다 — 끄면 닫힌다", async () => {
  (window as { getScreenDetails?: unknown }).getScreenDetails = () => Promise.resolve({ screens: SCREENS, currentScreen: SCREENS[0] });
  act(() => root.render(
    <StrictMode>
      <EditTab authKey="auth" authReady workspace={{ scope: "team", id: "w1", name: "W" }} keysActive
        flash={(message: string) => { flashed.push(message); }} onOpenCutFolder={() => {}} reloadSignal={0}
        peekPath={null} onPeekMarks={() => {}} cardMenuRef={cardMenuRef} onPreview={() => {}} onCompare={() => {}}
        resolve={{ send: () => {}, sendTimeline: () => new Promise<never>(() => {}), busy: false, pendingCount: 0, timelineBusy: false }}
        onFolderAction={() => {}} />
    </StrictMode>,
  ));
  act(() => [...document.querySelectorAll<HTMLButtonElement>(".ed-cutcell")].find((cell) => cell.textContent === "c1")!.click());
  await openMenu();
  act(() => items()[2].click()); // 모니터 2
  act(() => { vi.advanceTimersByTime(600); }); // 감시가 한 번 넘게 돈 뒤
  expect([opened.length, opened[0].closed, document.querySelector(".ed-feedchip")?.textContent]).toEqual([1, false, "클린 피드 · 모니터 2"]);
  expect(opened[0].doc.querySelector("img")!.getAttribute("src")).toBe("/media/b.png");
  await openMenu();
  act(() => items()[0].click()); // 사용 안 함
  act(() => { vi.advanceTimersByTime(1); });
  expect([opened[0].closed, document.querySelector(".ed-feedchip")]).toEqual([true, null]);
});

// Jay 2026-10-23 "우리 프로그램을 선택했을때만 나와야한다 … 다빈치를 벗어나면 화면이 사라진다" — 웹 창은 숨길 수 없어 닫고, 돌아오면 같은 모니터에 다시 연다.
it("다른 프로그램으로 가면 창을 닫되 모니터는 기억하고, 돌아오면 같은 모니터에 다시 연다 — 두 창 사이를 옮기는 것은 떠난 것이 아니다", async () => {
  await pickMonitor2();
  appFocused = false; // 피드 창으로 옮겼다 — 앱 창은 초점을 잃었지만 피드 창이 가졌다
  opened[0].focused = true;
  act(() => { window.dispatchEvent(new Event("blur")); });
  act(() => { vi.advanceTimersByTime(200); });
  expect(opened[0].closed).toBe(false);
  opened[0].focused = false; // 피드 창에서 다른 프로그램으로
  act(() => { opened[0].dispatchEvent(new Event("blur")); });
  act(() => { vi.advanceTimersByTime(200); });
  act(() => { vi.advanceTimersByTime(1); });
  expect([opened[0].closed, chip(), feedButton().classList.contains("ed-on")]).toEqual([true, "클린 피드 · 모니터 2", true]); // 켜 둔 채

  appFocused = true; // 돌아왔다(Alt+Tab — 누름 없음. 사이트의 팝업 허용이 있으면 바로 열린다)
  act(() => { window.dispatchEvent(new Event("focus")); });
  act(() => { vi.advanceTimersByTime(1); }); // 다시 연다(그 처리 뒤)
  act(() => { vi.advanceTimersByTime(50); }); // 따라가기는 프레임마다
  expect(opened).toHaveLength(2);
  expect(opened[1].features).toContain("left=2560,top=0,width=1440,height=2560");
  expect(opened[1].doc.querySelector("img")!.getAttribute("src")).toBe("/media/b.png");

  leaveApp();
  blocked = true; // 팝업 허용이 없으면 누름 없이 돌아온 것으로는 못 연다 — 첫 누름에 연다
  appFocused = true;
  act(() => { window.dispatchEvent(new Event("focus")); });
  act(() => { vi.advanceTimersByTime(1); });
  expect(opened).toHaveLength(2);
  blocked = false;
  act(() => { document.body.dispatchEvent(new Event("pointerup", { bubbles: true })); });
  act(() => { vi.advanceTimersByTime(1); });
  expect([opened.length, opened[2].closed, chip()]).toEqual([3, false, "클린 피드 · 모니터 2"]);
  expect(flashed).toEqual([]); // 다시 열기가 막힌 것은 알리지 않는다(고를 때만)
});

// Codex 묶음 검토 R1(2026-10-23) — 돌아와 누른 첫 클릭이 다른 탭으로 가는 클릭이면, 그 누름이 건 다시 열기보다 편집 탭이 먼저 사라진다.
//  사라진 뒤에 창이 열리면 화면도 감시도 없는 빈 창이 남는다.
it("돌아와 누른 첫 클릭이 편집 탭을 떠나게 하면 — 걸어 둔 다시 열기는 창을 열지 않는다", async () => {
  await pickMonitor2();
  leaveApp();
  expect([opened.length, opened[0].closed]).toEqual([1, true]);
  appFocused = true;
  act(() => { document.body.dispatchEvent(new Event("pointerup", { bubbles: true })); }); // 다시 열기가 걸린다(그 처리 뒤)
  act(() => root.unmount()); // 그 클릭이 다른 탭을 골랐다 — 편집 탭이 사라짐(걸어 둔 것은 아직 안 돌았다)
  root = createRoot(host);
  act(() => { vi.advanceTimersByTime(5); });
  expect(opened).toHaveLength(1);
});

it("열 때 전체 화면을 시도하고, 안 됐으면 다음 누름(그 처리 뒤)에 전체 화면 권한을 넘긴다", async () => {
  await pickMonitor2();
  expect(opened[0].full).toHaveBeenCalledTimes(1); // 사이트의 '자동 전체 화면' 허용이면 이것으로 된다
  expect(opened[0].postMessage).not.toHaveBeenCalled(); // 창을 연 누름은 권한을 써 버렸다(크롬 실측) — 그 누름으로는 넘기지 않는다
  act(() => { document.body.dispatchEvent(new Event("pointerup", { bubbles: true })); });
  expect(opened[0].postMessage).not.toHaveBeenCalled(); // 그 누름의 처리가 먼저
  act(() => { vi.advanceTimersByTime(1); });
  expect(opened[0].postMessage).toHaveBeenCalledWith("mvhub-clean-feed-fullscreen", { targetOrigin: window.location.origin, delegate: "fullscreen" });
  act(() => { document.body.dispatchEvent(new Event("pointerup", { bubbles: true })); });
  act(() => { vi.advanceTimersByTime(1); });
  expect(opened[0].postMessage).toHaveBeenCalledTimes(1); // 창마다 한 번 — 넘길 때마다 앱 창의 누름 권한을 써 버린다
  act(() => { opened[0].dispatchEvent(new MessageEvent("message", { data: "mvhub-clean-feed-fullscreen", origin: window.location.origin })); });
  expect(opened[0].full).toHaveBeenCalledTimes(2); // 넘겨받은 권한으로
  act(() => { opened[0].dispatchEvent(new MessageEvent("message", { data: "mvhub-clean-feed-fullscreen", origin: "http://other.test" })); });
  expect(opened[0].full).toHaveBeenCalledTimes(2); // 다른 곳의 글은 듣지 않는다
});

it("피드 창에 초점이 가도 편집 키는 앱이 받는다 — Esc 는 피드를 끈다, 사람이 창을 닫으면 다시 열지 않는다", async () => {
  await pickMonitor2();
  const got: string[] = [];
  const listen = (event: KeyboardEvent) => got.push(`${event.code}${event.shiftKey ? "+shift" : ""}`);
  document.body.addEventListener("keydown", listen);
  act(() => { opened[0].dispatchEvent(new KeyboardEvent("keydown", { key: "M", code: "KeyM", shiftKey: true })); });
  document.body.removeEventListener("keydown", listen);
  expect(got).toEqual(["KeyM+shift"]); // 앱 창의 본문으로(편집 키는 window 에서 듣는다)

  act(() => { opened[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape" })); });
  act(() => { vi.advanceTimersByTime(1); });
  expect([opened[0].closed, chip()]).toEqual([true, null]);

  await openMenu();
  act(() => items()[2].click());
  opened[1].closed = true; // 사람이 그 창을 닫았다 — 초점은 앱 창으로 돌아온다
  act(() => { window.dispatchEvent(new Event("focus")); });
  act(() => { vi.advanceTimersByTime(600); });
  expect([opened.length, chip()]).toEqual([2, null]);
});

// ── 허브 방식(로컬 허브가 띄우는 전용 창 — Jay 'd') ────────────────────────────────────────────────────────
//  계약 docs/status/편집탭_클린피드_전용창_구현_2026-10-23.md 'app-hub-mode'. 허브의 HTTP 는 가짜 fetch(응답 순서를 시험이 정한다),
//  WS 는 가짜 소켓(시험이 열고·거절하고·글을 넣는다).
class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  lazyClose = false; // 막힌 소켓 — close() 뒤 닫기 절차가 끝나지 않아 onclose 가 오지 않는다
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    if (this.readyState >= 2) return;
    this.readyState = this.lazyClose ? 2 : 3;
    if (!this.lazyClose) this.onclose?.();
  }
  open() {
    this.readyState = 1;
    act(() => this.onopen?.());
  }
  refuse() { // 핸드셰이크 거절(열린 적 없이 닫힘)
    this.readyState = 3;
    act(() => this.onclose?.());
  }
  hub(message: object) {
    act(() => this.onmessage?.({ data: JSON.stringify(message) }));
  }
  kinds() {
    return this.sent.map((message) => message.t);
  }
}
type Call = { url: string; method: string; body: Record<string, unknown> | null; done: boolean;
  reply: (status: number, body?: unknown) => Promise<void>; fail: () => Promise<void> };
let calls: Call[] = [];
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const stubHub = () => {
  calls = [];
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", vi.fn((url: string | URL, init?: RequestInit) => new Promise((resolve, reject) => {
    const call: Call = {
      url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null, done: false,
      reply: async (status, body = {}) => {
        call.done = true;
        // 허브는 클린 피드 POST 를 라이브러리 변경으로 알리지 않는다(빈 도메인)
        resolve({ ok: status < 400, status, statusText: "", headers: new Headers({ "X-MVHub-Mutation-Domains": "" }), json: async () => body });
        await settle();
      },
      fail: async () => {
        call.done = true;
        reject(new TypeError("Failed to fetch"));
        await settle();
      },
    };
    calls.push(call);
  })));
};
const waiting = (path: string) => calls.filter((call) => !call.done && call.url.startsWith(path));
const opens = () => calls.filter((call) => call.url === "/api/clean-feed/open");
const closes = () => calls.filter((call) => call.url === "/api/clean-feed/close").map((call) => call.body);
const STATUS_OK = { supported: true, reason: null, instance: "i1", session: null, ended_reason: null };
const OPENED = (n: number) => ({ session: `s${n}`, key: `k${n}`, instance: "i1", reused: false });

const clipA = { cut: "e/c1", gen: "a", track: 1, kind: "image" as const, dur: 5, len: 5, full: 5, head: 0 };
const feedScreen = (key: string, left: number): FeedScreen => ({
  key, index: 2, label: "", size: "1440×2560", primary: false, here: false,
  screen: { left, top: 0, width: 1440, height: 2560, availLeft: left, availTop: 0, availWidth: 1440, availHeight: 2560, isPrimary: false,
    devicePixelRatio: 1.25 } as unknown as FeedScreen["screen"],
});
const M2 = feedScreen("m2", 2560);
const M3 = feedScreen("m3", -1440);

describe("HubFeed — 앱(main) 쪽 허브 방식", () => {
  let live: CleanFeedHubInput;
  let shownLog: (string | null)[];
  let fallbacks: number;
  let hub: HubFeed;
  beforeEach(() => {
    stubHub();
    shownLog = [];
    fallbacks = 0;
    live = {
      layout: { cuts: [{ path: "e/c1", name: "c1", start: 0, len: 5, clips: [clipA] }], total: 5, tracks: 1 },
      doc: { v: 1, clips: [{ cut: "e/c1", gen: "a", track: 1, kind: "image", dur: 5 }], tracksOff: [], tracksLocked: [] },
      sourceOf: () => ({ state: "ok", type: "image", url: "/media/a.png", thumb: null }),
      now: () => 1, playing: false, rate: 1, limit: 5, authKey: "auth", flash: (message) => { flashed.push(message); },
    };
    hub = new HubFeed({ input: () => live, shown: (screen) => { shownLog.push(screen?.key ?? null); }, fallback: () => { fallbacks += 1; } });
  });
  const opened = async (n = 1) => {
    await waiting("/api/clean-feed/open")[0].reply(200, OPENED(n));
    const socket = FakeSocket.all[FakeSocket.all.length - 1];
    socket.open();
    return socket;
  };

  it("고르면 open(그 화면의 DIP 자리·크기·배율·주 모니터·takeover·탭 id·순번) → main WS → 장면·표본·active 를 보낸다", async () => {
    vi.spyOn(document, "hasFocus").mockImplementation(() => true);
    hub.pick(M2);
    expect(shownLog).toEqual(["m2"]);
    const body = opens()[0].body!;
    expect(body).toMatchObject({ screen: { left: 2560, top: 0, width: 1440, height: 2560, dpr: 1.25, primary: false }, takeover: true,
      client: FEED_CLIENT });
    expect(Number.isInteger(body.seq)).toBe(true);
    const socket = await opened();
    const url = new URL(socket.url);
    expect([url.pathname, url.searchParams.get("session"), url.searchParams.get("key"), url.searchParams.get("role")])
      .toEqual(["/ws/clean-feed", "s1", "k1", "main"]);
    expect(socket.kinds()).toEqual(["scene", "clock", "active"]);
    expect(socket.sent[0]).toMatchObject({ rev: 0, layout: live.layout, doc: live.doc,
      sources: { [clipKey(clipA)]: { state: "ok", type: "image", url: "/media/a.png", thumb: null } } });
    expect(socket.sent[1]).toMatchObject({ t: "clock", rev: 0, time: 1, playing: false, moving: false, rate: 1, limit: 5, sync: 0 });
    expect(socket.sent[2]).toEqual({ t: "active", active: true });
    expect(flashed).toEqual([]);
  });

  it("표본 — 재생 중엔 프레임마다(앞 표본에서 16ms 안이면 건너뜀), 멈춤이면 바뀔 때만 · 버퍼가 차면 최신만 들고 2초 넘으면 다시 붙는다", async () => {
    hub.pick(M2);
    const socket = await opened();
    socket.sent = [];
    let t = 1;
    live = { ...live, playing: true, now: () => t };
    for (let ms = 0; ms < 1000; ms += 8) {
      t += 0.008;
      hub.frame();
      vi.advanceTimersByTime(8);
    }
    const clocks = socket.sent.filter((message) => message.t === "clock");
    expect(clocks.length).toBeGreaterThanOrEqual(55);
    expect(clocks.length).toBeLessThanOrEqual(60); // 1초 60개까지(16ms 간격만으로는 62개)
    expect(clocks.every((message) => message.moving === true)).toBe(true);
    live = { ...live, playing: false };
    hub.frame();
    socket.sent = [];
    for (let i = 0; i < 20; i++) {
      hub.frame();
      vi.advanceTimersByTime(16);
    }
    expect(socket.sent).toEqual([]); // 멈춰 있고 안 바뀌었다
    t = 3;
    hub.frame();
    expect(socket.sent).toHaveLength(1); // 이동
    // 송신 버퍼가 64 KB 넘게 차 있다 — 보내지 않고 최신 하나만 든다
    live = { ...live, playing: true };
    socket.sent = [];
    socket.bufferedAmount = BUFFER_LIMIT + 1;
    for (let i = 0; i < 10; i++) {
      t += 0.016;
      hub.frame();
      vi.advanceTimersByTime(16);
    }
    expect(socket.sent).toEqual([]);
    socket.bufferedAmount = 0;
    hub.frame();
    expect(socket.sent[0]).toMatchObject({ t: "clock", time: t }); // 줄면 든 것(최신)부터
    // 2초 넘게 차 있다 — 연결을 닫고 즉시 다시 붙는다(허브가 최신 장면·표본으로 맞춘다)
    socket.bufferedAmount = BUFFER_LIMIT + 1;
    let ms = 0;
    while (FakeSocket.all.length === 1 && ms < 3000) {
      t += 0.016;
      hub.frame();
      vi.advanceTimersByTime(16);
      ms += 16;
    }
    expect(FakeSocket.all).toHaveLength(2);
    expect(ms).toBeLessThan(2200);
    FakeSocket.all[1].open();
    expect(FakeSocket.all[1].kinds()).toEqual(["scene", "clock", "active"]);
  });

  it("표본은 어느 1초에도 60개를 넘지 않는다(빠른 화면 — 4ms 프레임)", async () => {
    hub.pick(M2);
    const socket = await opened();
    socket.sent = [];
    let t = 1;
    live = { ...live, playing: true, now: () => t };
    const at: number[] = [];
    for (let ms = 0; ms < 3000; ms += 4) {
      t += 0.004;
      const before = socket.sent.length;
      hub.frame();
      if (socket.sent.length > before) at.push(ms);
      vi.advanceTimersByTime(4);
    }
    const worst = Math.max(...at.map((start) => at.filter((x) => x >= start && x < start + 1000).length));
    expect(worst).toBeLessThanOrEqual(60);
    expect(worst).toBeGreaterThanOrEqual(55);
  });

  it("멈춘 화면에서도 송신이 2초 넘게 막히면 다시 붙는다 · 막혀 못 보낸 장면은 줄면 보낸다", async () => {
    hub.pick(M2);
    const socket = await opened();
    socket.sent = [];
    socket.bufferedAmount = BUFFER_LIMIT + 1;
    hub.sceneChanged();
    vi.advanceTimersByTime(150); // 장면 묶음 시한이 지났지만 막혀서 못 보냈다
    expect(socket.kinds()).not.toContain("scene");
    socket.bufferedAmount = 0;
    hub.frame();
    expect(socket.kinds()).toContain("scene"); // 줄자 보낸다
    socket.bufferedAmount = BUFFER_LIMIT + 1;
    socket.lazyClose = true; // 막힌 소켓의 close() 는 onclose 를 늦게(또는 안) 준다 — 기다리지 않고 새로 붙어야 한다
    let ms = 0;
    while (FakeSocket.all.length === 1 && ms < 3000) { // 시각·재생 그대로 — 새 표본이 없다
      hub.frame();
      vi.advanceTimersByTime(16);
      ms += 16;
    }
    expect(FakeSocket.all).toHaveLength(2);
    expect(ms).toBeLessThan(2200);
    expect([socket.readyState, socket.onclose, socket.onmessage]).toEqual([2, null, null]); // 옛 연결은 떼어 냈다
    FakeSocket.all[1].open();
    expect(FakeSocket.all[1].kinds()).toEqual(["scene", "clock", "active"]);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("새 세션은 재동기 번호 0 부터 — 옛 세션의 번호를 싣지 않는다", async () => {
    hub.pick(M2);
    const first = await opened(1);
    first.hub({ t: "resync", sync: 5 });
    expect(first.sent.filter((message) => message.t === "clock").pop()).toMatchObject({ sync: 5 });
    hub.pick(M3);
    const second = await opened(2);
    expect(second.sent.find((message) => message.t === "clock")).toMatchObject({ sync: 0 });
  });

  it("옛 세션의 status 가 늦게 실패해도(10초 넘김) 그사이 새로 고른 것을 끄지 않는다", async () => {
    hub.pick(M2);
    const socket = await opened(1);
    socket.close();
    FakeSocket.all[1].refuse();
    const late = waiting("/api/clean-feed/status")[0]; // 답이 오지 않은 채
    await act(async () => { await vi.advanceTimersByTimeAsync(STATUS_GIVE_UP_MS + 1000); });
    hub.pick(M3);
    await late.fail(); // 옛 status 의 늦은 실패
    await opened(2);
    expect(hub.session?.session).toBe("s2");
    expect(shownLog).toEqual(["m2", "m3"]);
    expect(flashed).toEqual([]);
  });

  it("장면을 보내면 바로 그 rev 의 표본도 — 멈춘 화면에서 장면만 고쳐도 허브가 늦게 붙은 피드에 시각을 준다", async () => {
    hub.pick(M2);
    const socket = await opened();
    live = { ...live, now: () => 6 };
    hub.frame();
    socket.sent = [];
    hub.sceneChanged();
    hub.frame(); // 묶음 시한 전 — rev 가 오른 표본이 먼저 간다
    vi.advanceTimersByTime(120);
    const kinds = socket.kinds();
    expect(kinds.slice(-2)).toEqual(["scene", "clock"]); // 장면 바로 뒤에 같은 rev 의 표본
    expect(socket.sent[socket.sent.length - 1]).toMatchObject({ rev: 1, time: 6 });
  });

  // 2026-10-26 Jay "재생하는데 딜레이" — 목록을 다시 받으면 내용이 같아도 함수·배열이 새것이다. 번호를 올리면 피드가 그 장면을 기다리며 선다
  it("장면 내용(배치·문서·소스)이 같으면 번호를 올리지도 다시 보내지도 않는다 — 바뀌면 보낸다", async () => {
    hub.pick(M2);
    const socket = await opened();
    hub.sceneChanged(); // 처음 — 번호 1
    vi.advanceTimersByTime(120);
    socket.sent = [];
    live = { ...live, layout: { ...live.layout }, doc: { ...live.doc }, sourceOf: () => ({ state: "ok", type: "image", url: "/media/a.png", thumb: null }) };
    hub.sceneChanged();
    vi.advanceTimersByTime(120);
    hub.frame();
    expect(socket.kinds()).not.toContain("scene");
    live = { ...live, playing: true, now: () => 2 };
    hub.frame();
    expect(socket.sent[socket.sent.length - 1]).toMatchObject({ t: "clock", rev: 1 }); // 번호 그대로 — 피드가 서지 않는다
    live = { ...live, sourceOf: () => ({ state: "ok", type: "image", url: "/media/b.png", thumb: null }) };
    hub.sceneChanged();
    vi.advanceTimersByTime(120);
    expect(socket.sent.filter((message) => message.t === "scene")).toMatchObject([{ rev: 2 }]);
  });

  it("resync{n} 을 받으면 바로 표본(rev 가 바뀌었으면 장면 먼저), 그 뒤 표본에 sync:n", async () => {
    hub.pick(M2);
    const socket = await opened();
    socket.sent = [];
    hub.sceneChanged(); // 0.1초 묶음 전에 resync
    socket.hub({ t: "resync", sync: 3 });
    expect(socket.kinds()).toEqual(["scene", "clock"]);
    expect(socket.sent[1]).toMatchObject({ rev: 1, sync: 3 });
    socket.sent = [];
    live = { ...live, now: () => 2 };
    hub.frame();
    expect(socket.sent[0]).toMatchObject({ t: "clock", sync: 3 });
  });

  it("taken·closed 를 받으면 끈다(다시 열지 않는다) · focus-lost(초점 못 돌려줌 — 창을 찾은 뒤 허브가 알림)는 한 줄 알림 · 키 글은 본문에 같은 키로", async () => {
    hub.pick(M2);
    const socket = await opened();
    expect(flashed).toHaveLength(0);
    socket.hub({ t: "focus-lost" });
    expect(flashed).toHaveLength(1);
    const got: string[] = [];
    const listen = (event: KeyboardEvent) => got.push(`${event.code}${event.repeat ? "+repeat" : ""}${event.altKey ? "+alt" : ""}`);
    document.body.addEventListener("keydown", listen);
    for (const extra of [{}, { repeat: true }, { altKey: true }]) {
      socket.hub({ t: "key", key: " ", code: "Space", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false, ...extra });
    }
    document.body.removeEventListener("keydown", listen);
    expect(got).toEqual(["Space", "Space+repeat", "Space+alt"]);
    socket.hub({ t: "taken", reason: "taken" });
    await settle();
    expect(shownLog).toEqual(["m2", null]);
    expect(flashed[1]).toContain("다른 창에서");
    expect([opens().length, FakeSocket.all.length]).toEqual([1, 1]);
  });

  it("open 이 답한 뒤 창을 못 찾음·다른 모니터(closed 또는 status 의 ended_reason)는 open 실패처럼 — 알리고 다음 고르기는 팝업 방식", async () => {
    hub.pick(M2);
    let socket = await opened(1);
    socket.hub({ t: "closed", reason: "window-not-found" });
    await settle();
    expect([fallbacks, shownLog]).toEqual([1, ["m2", null]]);
    expect(flashed[0]).toContain("뜨지 않았습니다");
    hub.pick(M3);
    socket = await opened(2);
    socket.close(); // 허브가 끝내며 연결을 닫았다 — closed 글을 못 받음
    FakeSocket.all[FakeSocket.all.length - 1].refuse();
    await waiting("/api/clean-feed/status")[0].reply(200, { ...STATUS_OK, session: "ended", ended_reason: "wrong-monitor" });
    expect([fallbacks, shownLog]).toEqual([2, ["m2", null, "m3", null]]);
    expect(flashed[1]).toContain("고른 모니터에 뜨지 않았습니다");
    expect(opens()).toHaveLength(2); // 다시 열지 않는다
    hub.pick(M2);
    const old = await opened(3);
    hub.pick(M3); // 옛 세션의 늦은 실패는 새 선택을 끄지 않는다
    old.hub({ t: "closed", reason: "window-not-found" });
    await opened(4);
    expect([hub.session?.session, fallbacks]).toEqual(["s4", 2]);
  });

  it("켜 둔 채 다른 모니터로 — 옛 세션을 먼저 닫아, 허브가 옛 연결에 보내는 taken 에 새 선택이 꺼지지 않는다", async () => {
    hub.pick(M2);
    const first = await opened(1);
    hub.pick(M3);
    expect(closes()).toEqual([{ session: "s1", key: "k1" }]); // 먼저 닫는다
    first.hub({ t: "taken", reason: "taken" }); // 늦게 온 옛 연결의 글 — 이미 놓았다
    const second = await opened(2);
    expect(hub.session?.session).toBe("s2");
    expect(new URL(second.url).searchParams.get("session")).toBe("s2");
    expect(flashed).toEqual([]);
    expect(shownLog).toEqual(["m2", "m3"]);
  });

  it("끊기면 즉시 다시 붙고, 거절되면 status 로 — ① 같은 허브의 live = 다시 붙음 ② ended(taken) = 알리고 끔(다시 안 엶)", async () => {
    hub.pick(M2);
    const socket = await opened();
    socket.close(); // 끊김
    expect(FakeSocket.all).toHaveLength(2); // 즉시
    FakeSocket.all[1].refuse();
    await waiting("/api/clean-feed/status")[0].reply(200, { ...STATUS_OK, session: "live" });
    expect(waiting("/api/clean-feed/status")).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(FakeSocket.all).toHaveLength(3); // ① 0.5초 뒤 다시
    FakeSocket.all[2].refuse();
    const status = waiting("/api/clean-feed/status")[0];
    expect(status.url).toContain("session=s1");
    await status.reply(200, { ...STATUS_OK, session: "ended", ended_reason: "taken" });
    expect(shownLog).toEqual(["m2", null]);
    expect(flashed[0]).toContain("다른 창에서");
    expect(opens()).toHaveLength(1); // ② 다시 열지 않는다
  });

  it("③ main-gone·허브 재시작이면 takeover:false 로 다시 연다 — 다른 live 세션이 있으면(409 busy) 끈다 · 같은 허브의 unknown 은 끈다", async () => {
    hub.pick(M2);
    let socket = await opened(1);
    socket.close();
    FakeSocket.all[1].refuse();
    await waiting("/api/clean-feed/status")[0].reply(200, { ...STATUS_OK, session: "ended", ended_reason: "main-gone" });
    expect(opens()[1].body).toMatchObject({ takeover: false });
    expect(opens()[1].body!.seq as number).toBeGreaterThan(opens()[0].body!.seq as number);
    socket = await opened(2);
    socket.close();
    FakeSocket.all[FakeSocket.all.length - 1].refuse();
    await waiting("/api/clean-feed/status")[0].reply(200, { ...STATUS_OK, instance: "i2", session: "unknown" }); // 허브가 다시 떴다
    expect(opens()[2].body).toMatchObject({ takeover: false });
    await waiting("/api/clean-feed/open")[0].reply(409, { detail: "busy" });
    expect(shownLog).toEqual(["m2", null]);
    expect(flashed[0]).toContain("다른 창에서 클린 피드를 쓰고 있어");
    expect(fallbacks).toBe(0);
    // 같은 허브의 unknown(끝난 기록이 밀려남) — 재시작으로 보지 않는다
    hub.pick(M2);
    socket = await opened(3);
    socket.close();
    FakeSocket.all[FakeSocket.all.length - 1].refuse();
    await waiting("/api/clean-feed/status")[0].reply(200, { ...STATUS_OK, session: "unknown" });
    expect(opens()).toHaveLength(4);
    expect(flashed[1]).toContain("다시 찾지 못해");
  });

  it("status 자체가 실패하면 0.5초 간격으로 10초까지 묻고, 그래도 안 되면 끄고 알린다", async () => {
    hub.pick(M2);
    const socket = await opened();
    socket.close();
    FakeSocket.all[1].refuse();
    let asked = 0;
    while (waiting("/api/clean-feed/status").length && asked < 40) {
      await waiting("/api/clean-feed/status")[0].fail();
      asked += 1;
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    }
    expect(asked).toBeGreaterThanOrEqual(STATUS_GIVE_UP_MS / 500 - 1);
    expect(asked).toBeLessThanOrEqual(STATUS_GIVE_UP_MS / 500 + 2);
    expect(shownLog).toEqual(["m2", null]);
    expect(flashed[0]).toContain("허브에 닿지 않아");
  });

  it("로그인 토큰이 open 때와 다르면(같은 계정의 재로그인 포함) 1초 점검에서 끈다", async () => {
    setAuthToken("token-1");
    hub.pick(M2);
    await opened();
    hub.second();
    expect(closes()).toEqual([]);
    setAuthToken("token-2");
    hub.second();
    expect(closes()).toEqual([{ session: "s1", key: "k1" }]);
    expect(flashed[0]).toContain("로그인이 바뀌어");
    expect(shownLog).toEqual(["m2", null]);
  });

  it("작업 번호 — 자동 다시 열기를 기다리는 동안 사람이 새 모니터: 옛 자동 open 의 409·성공 어느 쪽이 와도 새 선택이 이긴다", async () => {
    for (const late of [409, 200]) {
      calls = [];
      FakeSocket.all = [];
      flashed.length = 0;
      hub.pick(M2);
      const socket = await opened(1);
      socket.close();
      FakeSocket.all[FakeSocket.all.length - 1].refuse();
      await waiting("/api/clean-feed/status")[0].reply(200, { ...STATUS_OK, session: "ended", ended_reason: "main-gone" });
      expect(waiting("/api/clean-feed/open")[0].body).toMatchObject({ takeover: false }); // 자동 open 이 진행 중
      hub.pick(M3); // 사람의 새 선택 — 앞 open 이 끝난 뒤에 보낸다
      expect(waiting("/api/clean-feed/open")).toHaveLength(1);
      await waiting("/api/clean-feed/open")[0].reply(late, late === 200 ? OPENED(9) : { detail: "busy" });
      if (late === 200) expect(closes()).toContainEqual({ session: "s9", key: "k9" }); // 옛 작업의 늦은 성공 — 그 세션만 닫고 버린다
      const manual = waiting("/api/clean-feed/open")[0];
      expect(manual.body).toMatchObject({ takeover: true, screen: { left: -1440 } });
      await opened(2);
      expect(hub.session?.session).toBe("s2");
      expect(flashed).toEqual([]); // 늦은 409 는 무시
      hub.off();
    }
  });

  it("작업 번호 — '사용 안 함' 뒤에 도착한 옛 open 의 성공은 그 세션만 닫고 버린다 · 진행 중 고르기는 마지막 것만 이어서", async () => {
    hub.pick(M2);
    hub.off();
    await waiting("/api/clean-feed/open")[0].reply(200, OPENED(1));
    expect(closes()).toEqual([{ session: "s1", key: "k1" }]);
    expect([hub.session, FakeSocket.all.length]).toEqual([null, 0]);
    hub.pick(M2);
    hub.pick(M3);
    hub.pick(M2);
    expect(waiting("/api/clean-feed/open")).toHaveLength(1);
    const first = waiting("/api/clean-feed/open")[0];
    await first.reply(200, OPENED(2));
    expect(closes()).toContainEqual({ session: "s2", key: "k2" });
    const next = waiting("/api/clean-feed/open");
    expect(next).toHaveLength(1); // 가운데(M3)는 건너뛴다
    expect(next[0].body).toMatchObject({ screen: { left: 2560 } });
    expect(next[0].body!.seq as number).toBeGreaterThan(first.body!.seq as number);
  });

  it("허브 open 이 실패하면(사용 중·정리 중 포함) 알리고 다음 고르기는 팝업 방식", async () => {
    hub.pick(M2);
    await waiting("/api/clean-feed/open")[0].reply(409, { detail: "profile-in-use" });
    expect([fallbacks, shownLog]).toEqual([1, ["m2", null]]);
    expect(flashed[0]).toContain("다른 크롬");
    for (const detail of ["cleanup-failed", "no-monitor"]) {
      hub.pick(M2);
      await waiting("/api/clean-feed/open")[0].reply(409, { detail });
    }
    hub.pick(M2);
    await waiting("/api/clean-feed/open")[0].fail();
    expect(fallbacks).toBe(4);
    expect(flashed[1]).toContain("닫히는 중");
  });

  it("편집 탭이 사라지면 close · 창을 닫을 때는 sendBeacon", async () => {
    const beacon = vi.fn(() => true);
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });
    hub.pick(M2);
    await opened();
    hub.beacon();
    expect(beacon).toHaveBeenCalledWith("/api/clean-feed/close", expect.any(Blob));
    hub.dispose();
    expect(closes()).toEqual([{ session: "s1", key: "k1" }]);
  });
});

it("편집 탭 — status 가 되면 허브 방식(팝업 없이 open) · 사용 안 함·인증 바뀜·편집 탭 떠남이면 close", async () => {
  stubHub();
  (window as { getScreenDetails?: unknown }).getScreenDetails = () => Promise.resolve({ screens: SCREENS, currentScreen: SCREENS[0] });
  const tab = (authKey: string) => (
    <EditTab authKey={authKey} authReady workspace={{ scope: "team", id: "w1", name: "W" }} keysActive
      flash={(message: string) => { flashed.push(message); }} onOpenCutFolder={() => {}} reloadSignal={0}
      peekPath={null} onPeekMarks={() => {}} cardMenuRef={cardMenuRef} onPreview={() => {}} onCompare={() => {}}
      resolve={{ send: () => {}, sendTimeline: () => new Promise<never>(() => {}), busy: false, pendingCount: 0, timelineBusy: false }}
      onFolderAction={() => {}} />
  );
  act(() => root.render(tab("auth")));
  act(() => [...document.querySelectorAll<HTMLButtonElement>(".ed-cutcell")].find((cell) => cell.textContent === "c1")!.click());
  await act(async () => { feedButton().click(); }); // 메뉴를 열 때 status 를 묻는다
  await waiting("/api/clean-feed/status")[0].reply(200, STATUS_OK);
  act(() => items()[2].click()); // 모니터 2
  expect(opened).toHaveLength(0); // 팝업을 열지 않는다
  expect(opens()[0].body).toMatchObject({ screen: { left: 2560, top: 0, width: 1440, height: 2560, primary: false }, takeover: true });
  expect(chip()).toBe("클린 피드 · 모니터 2");
  await waiting("/api/clean-feed/open")[0].reply(200, OPENED(1));
  FakeSocket.all[0].open();
  expect(FakeSocket.all[0].kinds()).toContain("scene");
  expect(FakeSocket.all[0].sent[0]).toMatchObject({ t: "scene", layout: { total: 5 } });
  await openMenu();
  await settle();
  act(() => items()[0].click()); // 사용 안 함
  expect(closes()).toEqual([{ session: "s1", key: "k1" }]);
  expect(chip()).toBeNull();

  await openMenu();
  act(() => items()[2].click());
  await waiting("/api/clean-feed/open")[0].reply(200, OPENED(2));
  FakeSocket.all[FakeSocket.all.length - 1].open();
  act(() => root.render(tab("auth-2"))); // 다른 탭 로그아웃·다른 계정
  expect(closes()).toContainEqual({ session: "s2", key: "k2" });
  expect(flashed.some((message) => message.includes("로그인이 바뀌어"))).toBe(true);

  await openMenu();
  act(() => items()[2].click());
  await waiting("/api/clean-feed/open")[0].reply(200, OPENED(3));
  FakeSocket.all[FakeSocket.all.length - 1].open();
  act(() => root.unmount()); // 편집 탭을 떠남
  root = createRoot(host);
  expect(closes()).toContainEqual({ session: "s3", key: "k3" });
  expect(opened).toHaveLength(0);
});

it("편집 탭 — 허브로 못 열면 바로 다음 고르기 한 번은 팝업, 그 뒤 메뉴를 열면 다시 허브에 묻는다", async () => {
  stubHub();
  (window as { getScreenDetails?: unknown }).getScreenDetails = () => Promise.resolve({ screens: SCREENS, currentScreen: SCREENS[0] });
  mount();
  await act(async () => { feedButton().click(); });
  await waiting("/api/clean-feed/status")[0].reply(200, STATUS_OK);
  act(() => items()[2].click());
  await waiting("/api/clean-feed/open")[0].reply(409, { detail: "wrong-monitor" });
  expect(flashed.some((message) => message.includes("크롬 창 방식"))).toBe(true);
  const statusCalls = () => calls.filter((call) => call.url.startsWith("/api/clean-feed/status")).length;
  await openMenu();
  expect(statusCalls()).toBe(1); // 한 번은 묻지 않고 팝업
  act(() => items()[2].click());
  expect([opened.length, opens().length]).toEqual([1, 1]);
  await openMenu();
  expect(statusCalls()).toBe(2); // 한 번을 썼다 — 그 뒤로는 다시 허브에 묻는다
  await waiting("/api/clean-feed/status")[0].reply(200, STATUS_OK);
  act(() => items()[3].click()); // 모니터 3 — 허브 방식(팝업 창은 닫는다)
  act(() => { vi.advanceTimersByTime(1); });
  expect([opened.length, opened[0].closed, opens().length]).toEqual([1, true, 2]);
});

it("편집 탭 — status 가 '안 됨'이면 지금 팝업 방식 그대로", async () => {
  stubHub();
  (window as { getScreenDetails?: unknown }).getScreenDetails = () => Promise.resolve({ screens: SCREENS, currentScreen: SCREENS[0] });
  mount();
  await act(async () => { feedButton().click(); });
  await waiting("/api/clean-feed/status")[0].reply(200, { ...STATUS_OK, supported: false, reason: "team-server" });
  act(() => items()[2].click());
  expect([opened.length, opens().length]).toEqual([1, 0]);
});
