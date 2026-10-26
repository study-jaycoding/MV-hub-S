// @vitest-environment jsdom
// 클린 피드 전용 창의 화면(CleanFeedApp — ?cleanfeed=<세션>&key=, 로컬 허브가 띄운 키오스크 크롬). 계약 'feed-app'.
//  허브 WS 는 가짜(FakeSocket — 시험이 열고 글을 넣는다). 시계는 가짜 타이머(performance 포함).
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CleanFeedApp } from "../src/components/timeline/CleanFeedApp";
import { nowMs, STANDBY_PROTOCOL } from "../src/lib/cleanFeedProtocol";
import { clipKey } from "../src/lib/editTimeline";

class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string, public protocols?: string[]) {
    FakeSocket.all.push(this);
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  hub(message: object) {
    act(() => this.onmessage?.({ data: JSON.stringify(message) }));
  }
}

const clipA = { cut: "e/c1", gen: "a", track: 1, kind: "image" as const, dur: 5, len: 5, full: 5, head: 0 };
const clipB = { cut: "e/c2", gen: "b", track: 1, kind: "image" as const, dur: 5, len: 5, full: 5, head: 0 };
const layout = { cuts: [{ path: "e/c1", name: "c1", start: 0, len: 5, clips: [clipA] }, { path: "e/c2", name: "c2", start: 5, len: 5, clips: [clipB] }],
  total: 10, tracks: 1 };
const doc = { v: 1, clips: [{ cut: "e/c1", gen: "a", track: 1, kind: "image", dur: 5 }, { cut: "e/c2", gen: "b", track: 1, kind: "image", dur: 5 }],
  tracksOff: [], tracksLocked: [] };
const media = (n: number) => `/api/clean-feed/media/s1/${n}?key=k1`;
const image = (n: number) => ({ state: "ok", type: "image", url: media(n), thumb: null });
const scene = (rev: number, sources: Record<string, unknown> = { [clipKey(clipA)]: image(1), [clipKey(clipB)]: image(2) }) =>
  ({ t: "scene", rev, layout, doc, sources });
const clock = (rev: number, time: number, over: Record<string, unknown> = {}) =>
  ({ t: "clock", rev, time, at: nowMs(), playing: false, moving: false, rate: 1, limit: 10, sync: 0, ...over });

let host: HTMLDivElement;
let root: Root;
let socket: FakeSocket;
const frames = (ms = 50) => act(() => { vi.advanceTimersByTime(ms); });
const shown = () => document.querySelector("img")?.getAttribute("src") ?? null;
const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, "visibilityState", { value: hidden ? "hidden" : "visible", configurable: true });
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  for (const method of ["load", "pause"] as const) vi.spyOn(HTMLMediaElement.prototype, method).mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<CleanFeedApp session="s1" keyValue="k1" />));
  socket = FakeSocket.all[0];
  act(() => socket.open());
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("허브가 찾는 제목·검은 바탕 · 피드 역할로 붙어 ready 를 보낸다 · 글·단추가 없다", () => {
  expect(Number.isFinite(nowMs())).toBe(true); // 가짜 타이머에서도 시계가 숫자다
  expect(document.title).toBe("MV hub Clean Feed s1");
  expect(document.body.style.background).toContain("rgb(0, 0, 0)");
  const url = new URL(socket.url);
  expect([url.pathname, url.searchParams.get("session"), url.searchParams.get("key"), url.searchParams.get("role")])
    .toEqual(["/ws/clean-feed", "s1", "k1", "feed"]);
  expect(socket.sent).toEqual([{ t: "ready" }]);
  expect(host.textContent).toBe(host.querySelector("style")!.textContent); // 보이는 글은 없다(가린 영상 요소의 CSS 한 줄뿐)
  expect(host.querySelector("button")).toBeNull();
  const videos = [...host.querySelectorAll("video")];
  expect(videos).toHaveLength(2); // 앞 · 다음 영상을 미리 받는 뒤(editVideoPair)
  expect(videos.every((video) => video.muted)).toBe(true);
  expect(videos[1].dataset.spare).toBe("");
});

it("처음 붙기 전의 거절(허브가 아직 세션을 안 받음)은 0.05초 뒤 다시 붙는다 — 붙은 뒤의 끊김은 0.5초", () => {
  act(() => root.unmount());
  FakeSocket.all = [];
  root = createRoot(host);
  act(() => root.render(<CleanFeedApp session="s1" keyValue="k1" />));
  act(() => FakeSocket.all[0].close()); // 핸드셰이크 거절 — 열린 적 없이 닫힘
  frames(50);
  expect(FakeSocket.all).toHaveLength(2);
  act(() => FakeSocket.all[1].close());
  frames(50);
  expect(FakeSocket.all).toHaveLength(3);
  act(() => FakeSocket.all[2].open());
  act(() => FakeSocket.all[2].close()); // 붙은 뒤의 끊김
  frames(50);
  expect(FakeSocket.all).toHaveLength(3);
  frames(450);
  expect(FakeSocket.all).toHaveLength(4);
});

it("처음 붙기 전의 거절도 5초가 지나면 0.5초 간격으로 늦춘다", () => {
  act(() => root.unmount());
  FakeSocket.all = [];
  root = createRoot(host);
  act(() => root.render(<CleanFeedApp session="s1" keyValue="k1" />));
  frames(5000);
  act(() => FakeSocket.all[FakeSocket.all.length - 1].close());
  const count = FakeSocket.all.length;
  frames(50);
  expect(FakeSocket.all).toHaveLength(count);
  frames(450);
  expect(FakeSocket.all).toHaveLength(count + 1);
});

it("장면을 받으면 그 시각의 보이는 클립을 그리고, 표본으로 따라간다 — 낮은 번호의 늦은 표본은 최신을 덮지 않는다", () => {
  socket.hub(scene(1));
  socket.hub(clock(1, 1));
  frames();
  expect(shown()).toBe(media(1));
  socket.hub(clock(1, 6, { sync: 1 }));
  frames();
  expect(shown()).toBe(media(2));
  socket.hub(clock(1, 1, { sync: 0 })); // 늦게 온 옛 번호
  frames();
  expect(shown()).toBe(media(2));
});

it("새 rev 의 표본은 그 장면이 올 때까지 들고(지금 그림 그대로), 장면이 오면 맞춘다", () => {
  socket.hub(scene(1));
  socket.hub(clock(1, 6));
  frames();
  expect(shown()).toBe(media(2));
  socket.hub(clock(2, 1)); // 장면 2 보다 표본이 먼저
  frames();
  expect(shown()).toBe(media(2));
  socket.hub(scene(2));
  frames();
  expect(shown()).toBe(media(1));
});

it("숨김 → (숨은 동안 멈춘 채 탐색) → visible → 재동기 전에는 재생하지 않고, resync 표본(sync ≥ n)으로 맞춰 재생한다", async () => {
  const video = { state: "ok", type: "video", url: media(3), thumb: null };
  socket.hub(scene(1, { [clipKey(clipA)]: video, [clipKey(clipB)]: image(2) }));
  socket.hub(clock(1, 1));
  frames();
  const element = host.querySelector("video")!;
  act(() => { element.dispatchEvent(new Event("loadedmetadata")); });
  const play = vi.mocked(HTMLMediaElement.prototype.play);
  setHidden(true);
  socket.hub(clock(1, 2, { playing: true, moving: true })); // 숨은 동안 받은 재생 표본 — 재생을 시작하지 않는다
  frames();
  setHidden(false); // 크롬이 보임을 알려도 허브의 visible 전에는
  play.mockClear();
  socket.hub({ t: "visible", sync: 1 });
  socket.hub(clock(1, 2.1, { playing: true, moving: true, sync: 0 })); // 재동기 전 번호
  frames(30);
  expect(play).not.toHaveBeenCalled();
  socket.hub(clock(1, 2.2, { playing: true, moving: true, sync: 1 })); // resync 응답
  frames(30);
  expect(play).toHaveBeenCalled();
  expect(element.getAttribute("src")).toBe(media(3));
});

it("resync 표본이 visible 보다 먼저 와도 재동기된다", () => {
  const video = { state: "ok", type: "video", url: media(3), thumb: null };
  socket.hub(scene(1, { [clipKey(clipA)]: video, [clipKey(clipB)]: image(2) }));
  socket.hub(clock(1, 1));
  frames();
  act(() => { host.querySelector("video")!.dispatchEvent(new Event("loadedmetadata")); });
  setHidden(true);
  setHidden(false);
  const play = vi.mocked(HTMLMediaElement.prototype.play);
  play.mockClear();
  socket.hub(clock(1, 1.5, { playing: true, moving: true, sync: 1 })); // 순서 뒤집힘
  frames(30);
  expect(play).not.toHaveBeenCalled(); // 숨김 뒤 아직 visible 없음
  socket.hub({ t: "visible", sync: 1 });
  socket.hub(clock(1, 1.55, { playing: true, moving: true, sync: 1 }));
  frames(30);
  expect(play).toHaveBeenCalled();
});

it("키 — 편집 키는 막고 앱으로 넘긴다(repeat 보존, Space 두 번이 두 번) · Esc·F11 은 막기만 · Alt+F4·Win 은 OS 몫", () => {
  const press = (init: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    act(() => { window.dispatchEvent(event); });
    return event.defaultPrevented;
  };
  socket.sent = [];
  expect(press({ key: " ", code: "Space" })).toBe(true);
  expect(press({ key: " ", code: "Space", repeat: true })).toBe(true);
  expect(press({ key: "z", code: "KeyZ", ctrlKey: true })).toBe(true);
  expect(press({ key: "Escape", code: "Escape" })).toBe(true);
  expect(press({ key: "F11", code: "F11" })).toBe(true);
  expect(press({ key: "F4", code: "F4", altKey: true })).toBe(false);
  expect(press({ key: "Meta", code: "MetaLeft", metaKey: true })).toBe(false);
  expect(socket.sent).toEqual([
    { t: "key", key: " ", code: "Space", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false },
    { t: "key", key: " ", code: "Space", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: true },
    { t: "key", key: "z", code: "KeyZ", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, repeat: false },
  ]);
});

it("끊기면 0.5초 뒤 다시 붙고, closed·taken 을 받으면 다시 붙지 않는다", () => {
  act(() => socket.close()); // 허브가 연결을 닫음(보내기 시한 등)
  frames(500);
  expect(FakeSocket.all).toHaveLength(2);
  const again = FakeSocket.all[1];
  act(() => again.open());
  again.hub({ t: "closed", reason: "closed" });
  expect(again.readyState).toBe(3);
  frames(2000);
  expect(FakeSocket.all).toHaveLength(2);
});

const TOKEN = "ab".repeat(24);

it("closed 에 대기 토큰이 오면 영상 받기를 멈추고 대기 화면 — 토큰은 주소가 아니라 하위 프로토콜로만 · assign 이면 새 세션 화면을 새로", () => {
  const video = { state: "ok", type: "video", url: media(3), thumb: null };
  socket.hub(scene(1, { [clipKey(clipA)]: video, [clipKey(clipB)]: image(2) }));
  socket.hub(clock(1, 1, { sync: 2 }));
  frames();
  expect(host.querySelector("video")!.getAttribute("src")).toBe(media(3));
  const videos = [...host.querySelectorAll("video")];
  socket.hub({ t: "closed", reason: "closed", standby: TOKEN });
  expect(videos.every((element) => !element.hasAttribute("src"))).toBe(true); // 내리기 전에 비웠다
  expect(host.querySelector("video")).toBeNull();
  const standby = FakeSocket.all[1];
  expect(standby.url).not.toContain(TOKEN);
  const url = new URL(standby.url);
  expect([url.pathname, url.searchParams.get("role"), url.searchParams.get("session"), url.searchParams.has("key")])
    .toEqual(["/ws/clean-feed", "standby", "standby", false]);
  expect(standby.protocols).toEqual([STANDBY_PROTOCOL + TOKEN]);
  frames(2000);
  expect(FakeSocket.all).toHaveLength(2); // 끝난 세션에 다시 붙지 않는다
  socket.hub(scene(2)); // 버린 연결의 늦은 글
  expect(host.querySelector("img")).toBeNull();
  standby.hub({ t: "assign", session: "s2", key: "k2" });
  expect(standby.readyState).toBe(3);
  expect(window.location.search).toBe("?cleanfeed=s2&key=k2");
  expect(document.title).toBe("MV hub Clean Feed s2");
  const fresh = FakeSocket.all[2];
  const next = new URL(fresh.url);
  expect([next.searchParams.get("session"), next.searchParams.get("key"), next.searchParams.get("role")]).toEqual(["s2", "k2", "feed"]);
  act(() => fresh.open());
  expect(fresh.sent).toEqual([{ t: "ready" }]);
  frames();
  expect(shown()).toBeNull(); // 앞 세션의 장면·표본이 없다 — 새 장면을 기다린다
  fresh.hub(scene(1)); // 앞 세션은 rev 1·sync 2 였다 — 새 세션의 rev 1·sync 0 표본을 버리지 않는다
  fresh.hub(clock(1, 6));
  frames();
  expect(shown()).toBe(media(2));
  window.history.replaceState(null, "", "/");
});

it("대기 토큰이 없거나 꼴이 틀리면 대기 화면으로 가지 않는다 · 대기 연결이 거절되면 다시 붙지 않는다", () => {
  socket.hub({ t: "taken", reason: "taken", standby: "../not-a-token" });
  frames(2000);
  expect(FakeSocket.all).toHaveLength(1);
  act(() => root.unmount());
  FakeSocket.all = [];
  root = createRoot(host);
  act(() => root.render(<CleanFeedApp session="s1" keyValue="k1" />));
  act(() => FakeSocket.all[0].open());
  FakeSocket.all[0].hub({ t: "taken", reason: "taken", standby: TOKEN });
  const standby = FakeSocket.all[1];
  act(() => standby.close()); // 허브가 거절(그 창은 허브가 끝낸다)
  frames(5000);
  expect(FakeSocket.all).toHaveLength(2);
  standby.hub({ t: "assign", session: "s9", key: "k9" }); // 닫은 연결의 늦은 글
  expect(FakeSocket.all).toHaveLength(2);
});
it("StrictMode(효과 두 번)에서도 — 대기 연결은 마지막 것만 살고, 버린 연결의 늦은 assign 은 무시, 새 세션 화면은 하나", () => {
  act(() => root.unmount());
  FakeSocket.all = [];
  root = createRoot(host);
  act(() => root.render(<StrictMode><CleanFeedApp session="s1" keyValue="k1" /></StrictMode>));
  const feed = FakeSocket.all[FakeSocket.all.length - 1];
  expect(FakeSocket.all.slice(0, -1).every((socket) => socket.readyState === 3)).toBe(true);
  act(() => feed.open());
  feed.hub({ t: "closed", reason: "closed", standby: TOKEN });
  const standbys = FakeSocket.all.filter((socket) => socket.protocols);
  expect(standbys).toHaveLength(2); // 효과 두 번 — 첫 연결은 정리에서 닫힘
  const live = standbys[standbys.length - 1];
  expect(standbys.slice(0, -1).every((socket) => socket.readyState === 3)).toBe(true);
  for (const old of standbys.slice(0, -1)) old.hub({ t: "assign", session: "s9", key: "k9" }); // 버린 연결의 늦은 글
  expect(FakeSocket.all.some((socket) => socket.url.includes("session=s9"))).toBe(false);
  live.hub({ t: "assign", session: "s2", key: "k2" });
  const fresh = FakeSocket.all.filter((socket) => socket.url.includes("session=s2"));
  expect(fresh.filter((socket) => socket.readyState !== 3)).toHaveLength(1);
  expect(document.title).toBe("MV hub Clean Feed s2");
  window.history.replaceState(null, "", "/");
});