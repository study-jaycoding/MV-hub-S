// @vitest-environment jsdom
// 편집 탭의 재생 훅 — 시계 주인(영상/rAF)과 '보이는 소스 변경'의 순서를 가짜 video 로 본다(docs/EDIT_TAB.md).
// 실제 탐색·디코딩은 여기서 못 본다 — 그것은 격리 브라우저 실측 몫이다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildLayout, emptyEditDoc, type EditDoc, type SlotClip } from "../src/lib/editTimeline";
import { useEditPlayback, type EditSource, type EditVideo } from "../src/lib/useEditPlayback";

class FakeVideo implements EditVideo {
  src = "";
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  seeking = false;
  loads = 0;
  plays = 0;
  private listeners = new Map<string, Set<() => void>>();
  play() { this.paused = false; this.plays++; return Promise.resolve(); }
  pause() { this.paused = true; }
  load() { this.loads++; this.currentTime = 0; }
  removeAttribute(name: string) { if (name === "src") this.src = ""; }
  addEventListener(type: string, listener: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: () => void) { this.listeners.get(type)?.delete(listener); }
  emit(type: string) { act(() => { this.listeners.get(type)?.forEach((listener) => listener()); }); }
  count() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}

const DOC: EditDoc = {
  ...emptyEditDoc(),
  clips: [
    { cut: "e070/c1", gen: "low", track: 1, dur: 8, kind: "video" },
    { cut: "e070/c1", gen: "top", track: 2, dur: 3, kind: "video" },
    { cut: "e070/c3", gen: "pic", track: 1, dur: 5, kind: "image" },
  ],
};
const LAYOUT = buildLayout(["e070/c1", "e070/c2", "e070/c3"], DOC); // c1 0~8 · c2(빈 컷) 8~13 · c3 13~18
const sourceOf = (clip: SlotClip): EditSource =>
  ({ state: "ok", url: `/v/${clip.gen}`, type: clip.kind ?? "video", thumb: null });

let host: HTMLDivElement;
let root: Root;
let video: FakeVideo;
let videoRef: { current: FakeVideo }; // 실제 화면의 useRef 처럼 같은 객체를 넘긴다
let playback: ReturnType<typeof useEditPlayback>;
let clock = 0;
let frames: ((stamp: number) => void)[] = [];
const paint = vi.fn();

function Harness({ scope = "s1", doc = DOC, layout = LAYOUT, loop, range }: {
  scope?: string; doc?: EditDoc; layout?: typeof LAYOUT; loop?: boolean; range?: { from: number; to: number } | null;
}) {
  playback = useEditPlayback({ scope, layout, doc, sourceOf, videoRef, paint, loop, range });
  return null;
}
const render = (props: Parameters<typeof Harness>[0] = {}) => act(() => root.render(<Harness {...props} />));
// 한 프레임 — 시계를 ms 만큼 보내고 걸려 있던 rAF 를 부른다.
const frame = (ms: number) => act(() => {
  clock += ms;
  const due = frames;
  frames = [];
  due.forEach((callback) => callback(clock));
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clock = 1000;
  frames = [];
  paint.mockClear();
  video = new FakeVideo();
  videoRef = { current: video };
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("requestAnimationFrame", (callback: (stamp: number) => void) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => { frames = []; });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("같은 컷에서 위 클립이 끝나면 아래 클립을 같은 시각으로 탐색해 이어 튼다", () => {
  render();
  expect(playback.view.clip?.gen).toBe("top"); // 위 트랙이 우선
  expect(video.src).toBe("/v/top");
  video.emit("loadedmetadata");
  act(() => playback.toggle());
  expect(video.paused).toBe(false);
  video.currentTime = 2.9;
  frame(16);
  expect(playback.now()).toBeCloseTo(2.9); // 영상이 시계
  video.currentTime = 3.05;
  frame(16);
  expect(playback.view.cut).toBe("e070/c1"); // 컷은 그대로인데
  expect(playback.view.clip?.gen).toBe("low"); // 보이는 소스만 바뀐다
  expect(video.src).toBe("/v/low");
  frame(500); // 새 소스를 받는 동안에는 시간이 서 있다(0 으로 되돌아가지도 않는다)
  expect(playback.now()).toBeCloseTo(3.05);
  video.emit("loadedmetadata");
  expect(video.currentTime).toBeCloseTo(3.05); // 0 이 아니라 보던 시각으로
  const plays = video.plays;
  video.emit("seeked");
  expect(video.plays).toBe(plays + 1);
  video.currentTime = 4;
  frame(16);
  expect(playback.now()).toBeCloseTo(4);
});

it("빈 컷과 이미지는 rAF 시계로 지나가고, 끝에 닿으면 멈춘다", () => {
  render();
  act(() => playback.seek(8.5)); // 빈 컷
  expect(playback.view.clip).toBeNull();
  expect(video.src).toBe("");
  act(() => playback.toggle());
  frame(1000);
  expect(playback.now()).toBeCloseTo(9.5);
  frame(4000); // 13.5 — 이미지 컷
  expect(playback.view.cut).toBe("e070/c3");
  expect(playback.view.source?.type).toBe("image");
  frame(5000);
  expect(playback.view.playing).toBe(false);
  expect(playback.now()).toBeCloseTo(LAYOUT.total);
  expect(frames).toHaveLength(0);
  act(() => playback.toggle()); // 끝에서 다시 누르면 처음부터
  expect(playback.now()).toBe(0);
});

it("멈춘 채 훑으면 영상을 그 시각으로 보내고, 탐색 중 목표가 바뀌면 끝난 뒤 한 번 더 간다", () => {
  render();
  video.emit("loadedmetadata");
  act(() => playback.seek(1));
  expect(video.currentTime).toBe(1);
  video.seeking = true;
  act(() => playback.seek(2)); // 탐색 중에는 새 탐색을 겹치지 않는다
  expect(video.currentTime).toBe(1);
  video.seeking = false;
  video.emit("seeked");
  expect(video.currentTime).toBe(2);
  expect(video.paused).toBe(true);
});

it("L 은 배속을 올리고 J 는 역방향(rAF 시계) — 처음에 닿으면 멈춘다", () => {
  render();
  video.emit("loadedmetadata");
  act(() => playback.seek(1));
  act(() => playback.shuttle(1));
  act(() => playback.shuttle(1));
  expect(playback.view.rate).toBe(2);
  expect(video.playbackRate).toBe(2);
  act(() => playback.shuttle(-1));
  expect(playback.view.rate).toBe(-1);
  expect(video.paused).toBe(true); // 역방향은 영상이 시계가 아니다
  frame(500);
  expect(playback.now()).toBeCloseTo(0.5);
  frame(2000);
  expect(playback.view.playing).toBe(false);
  expect(playback.now()).toBe(0);
});

it("재생하지 못하는 영상은 정지화면으로 두고 rAF 시계로 지나간다", () => {
  render();
  act(() => playback.toggle());
  video.emit("error");
  expect(playback.view.failed).toBe(true);
  expect(video.src).toBe("");
  frame(1000);
  expect(playback.now()).toBeCloseTo(1);
});

it("가려지면 멈추고, 떠날 때 영상·rAF·이벤트를 정리한다", () => {
  render();
  video.emit("loadedmetadata");
  act(() => playback.toggle());
  expect(playback.view.playing).toBe(true);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(playback.view.playing).toBe(false);
  expect(video.paused).toBe(true);
  visibility.mockRestore();
  act(() => playback.toggle());
  act(() => root.render(null));
  expect(video.src).toBe("");
  expect(video.paused).toBe(true);
  expect(video.count()).toBe(0);
  expect(frames).toHaveLength(0);
});

it("보던 컷이 짧아지면 재생을 멈추고, 시퀀스가 바뀌면 처음으로 — 돌아오면 보던 자리로", () => {
  render();
  act(() => playback.seek(6)); // c1 의 6초(아래 클립)
  video.emit("loadedmetadata");
  video.emit("seeked");
  act(() => playback.toggle());
  video.currentTime = 6.5; // 영상이 시계로 돌고 있다
  frame(16);
  expect(playback.now()).toBeCloseTo(6.5);
  const short: EditDoc = { ...DOC, clips: DOC.clips.filter((clip) => clip.gen !== "low") }; // 긴 클립을 뺐다 → c1 은 3초
  render({ doc: short, layout: buildLayout(["e070/c1", "e070/c2", "e070/c3"], short) });
  expect(playback.view.playing).toBe(false);
  expect(playback.now()).toBeLessThan(3); // 컷 끝 직전 — 영상의 옛 시각(6.5초)으로 되덮지 않는다
  expect(playback.now()).toBeGreaterThan(2.9);
  expect(playback.view.clip?.gen).toBe("top"); // 검은 화면이 아니다
  render({ scope: "s2" });
  expect(playback.now()).toBe(0);
  act(() => playback.seek(14));
  render({ scope: "s1" });
  render({ scope: "s2" });
  expect(playback.now()).toBeCloseTo(14);
});

it("훑는 도중에 재생을 눌러도 옛 탐색 자리가 아니라 마지막에 놓은 자리에서 시작한다", () => {
  render();
  video.emit("loadedmetadata");
  act(() => playback.seek(1));
  video.seeking = true; // 1초로 가는 중
  act(() => playback.seek(2));
  const plays = video.plays;
  act(() => playback.toggle());
  expect(video.plays).toBe(plays); // 아직 목표에 못 왔다 — 영상에 시계를 넘기지 않는다
  frame(300);
  expect(playback.now()).toBeCloseTo(2); // 기다리는 동안 시간은 서 있다
  video.seeking = false;
  video.emit("seeked"); // 1초 도착 → 최신 목표(2초)로 다시 보낸다
  expect(video.currentTime).toBe(2);
  expect(video.plays).toBe(plays);
  video.emit("seeked");
  expect(video.plays).toBe(plays + 1);
  video.currentTime = 2.2;
  frame(16);
  expect(playback.now()).toBeCloseTo(2.2);
});

// 반복 재생(Jay 2026-10-08) — 뷰어 아래 줄의 반복 단추. 소스 뷰어는 한 클립짜리 시퀀스를 같은 엔진으로 튼다.
it("반복: 정방향으로 끝에 닿으면 처음부터 이어 튼다 — 같은 영상으로 되돌아와도 그 자리(0)에 닿은 뒤에야 시계를 맡긴다", () => {
  const one: EditDoc = { ...emptyEditDoc(), clips: [{ cut: "s", gen: "only", track: 1, dur: 4, kind: "video" }] };
  const layout = buildLayout(["s"], one);
  render({ scope: "loop", doc: one, layout, loop: true });
  video.emit("loadedmetadata");
  act(() => playback.toggle());
  video.currentTime = 3.9;
  frame(16);
  expect(playback.now()).toBeCloseTo(3.9);
  paint.mockClear();
  video.currentTime = 4; // 끝에 닿았다
  frame(16);
  expect(playback.view.playing).toBe(true);
  expect(playback.now()).toBe(0);
  expect(video.currentTime).toBe(0); // 영상을 처음으로 보냈다
  expect(paint).toHaveBeenLastCalledWith(0);
  expect(frames).toHaveLength(1); // 다음 프레임은 한 번만 건다
  video.currentTime = 4; // 탐색이 끝나기 전 — 끝난 영상의 옛 시각을 시계로 읽지 않는다
  frame(500);
  expect(playback.now()).toBe(0);
  video.currentTime = 0;
  video.emit("seeked");
  video.currentTime = 1;
  frame(16);
  expect(playback.now()).toBeCloseTo(1);

  render({ scope: "loop", doc: one, layout, loop: false }); // 반복을 끄면 끝에서 멈춘다
  video.currentTime = 4;
  frame(16);
  expect(playback.view.playing).toBe(false);
  expect(playback.now()).toBe(4);
});

it("반복: 여러 컷이면 첫 컷으로 돌아가고, 역방향은 반복하지 않고 처음에서 멈춘다", () => {
  render({ scope: "loop2", loop: true });
  video.emit("loadedmetadata");
  act(() => playback.seek(17.9)); // c3(그림, rAF 시계)의 끝 직전
  act(() => playback.toggle());
  frame(200);
  expect(playback.view.playing).toBe(true);
  expect(playback.view.cut).toBe("e070/c1");
  expect(playback.now()).toBe(0);
  expect(video.src).toBe("/v/top");

  act(() => playback.stop());
  act(() => playback.seek(0.05));
  act(() => playback.shuttle(-1));
  frame(200);
  expect(playback.view.playing).toBe(false);
  expect(playback.now()).toBe(0);
});

// 구간 반복(Jay 2026-10-08) — 구간(range)을 주면 그 구간을 되풀이한다. 전체 반복(loop)과는 따로다.
it("구간 반복: 아웃을 넘으면 인으로 돌아간다 — 한 프레임에 구간을 통째로 지나가도. 아웃 뒤에서는 끝까지 간 뒤 들어온다", () => {
  const range = { from: 9, to: 11 }; // 빈 컷(c2 8~13, rAF 시계) 안
  render({ scope: "range", range }); // 전체 반복은 꺼져 있다
  act(() => playback.seek(10.5));
  act(() => playback.toggle());
  frame(400);
  expect(playback.now()).toBeCloseTo(10.9);
  frame(200); // 아웃(11)을 넘었다 → 인(9)으로
  expect(playback.now()).toBe(9);
  expect(playback.view.playing).toBe(true);
  expect(frames).toHaveLength(1); // 다음 프레임은 한 번만 건다
  frame(500);
  expect(playback.now()).toBeCloseTo(9.5);

  act(() => playback.seek(8.9)); // 구간 앞에서 — 한 프레임에 구간 전체(9~11)를 지나가도 잡는다
  frame(2500);
  expect(playback.now()).toBe(9);

  act(() => playback.seek(12)); // 아웃 뒤로 훑었다 — 되돌아가지 않고 끝까지 간다
  frame(500);
  expect(playback.now()).toBeCloseTo(12.5);
  frame(1000); // c3 로 넘어간다
  expect(playback.view.cut).toBe("e070/c3");
  frame(6000); // 전체 끝 → 구간 처음으로 들어온다(맨 처음이 아니다)
  expect(playback.now()).toBe(9);
  expect(playback.view.playing).toBe(true);

  render({ scope: "range", range: null }); // 구간 반복을 끄면 아웃을 지나 그대로 간다
  frame(3000);
  expect(playback.now()).toBeCloseTo(12);
  expect(playback.view.playing).toBe(true);
  frame(2000); // c3 로
  frame(6000); // 전체 반복도 꺼져 있다 — 끝에서 멈춘다
  expect(playback.view.playing).toBe(false);
  expect(playback.now()).toBeCloseTo(LAYOUT.total);
});

it("구간 반복: 영상이 끝나며 위치를 아웃으로 먼저 옮겨도 인으로 돌아간다 — 재생 직후 첫 프레임 전이어도", () => {
  const range = { from: 1, to: 3 }; // 아웃 = 위 클립(top, 3초)의 끝. 그 뒤로도 볼 것(low)이 남아 있다
  render({ scope: "range2", loop: true, range });
  video.emit("loadedmetadata");
  act(() => playback.seek(2.9));
  video.emit("seeked");
  act(() => playback.toggle());
  video.emit("ended"); // 첫 프레임이 돌기 전에 영상이 끝났다 — 위치가 3초(아웃)로 간다
  frame(16);
  expect(playback.now()).toBe(1);
  expect(playback.view.playing).toBe(true);
  expect(video.currentTime).toBe(1); // 영상도 인으로 보냈다
});

it("구간 반복: 아웃 뒤에서 시작해 전체 끝을 돌아 들어온 뒤에도 구간을 지킨다 — 다음 프레임 전에 영상이 끝나도", () => {
  const range = { from: 2.9, to: 3 }; // 아웃 = 위 클립(top, 3초)의 끝
  render({ scope: "range3", loop: true, range });
  act(() => playback.seek(17.9)); // 아웃 뒤(c3 — 그림, rAF 시계)의 끝 직전
  act(() => playback.toggle());
  frame(200); // 전체 끝 → 구간 처음(2.9)으로
  expect(playback.now()).toBeCloseTo(2.9);
  expect(video.src).toBe("/v/top");
  video.emit("loadedmetadata");
  video.emit("seeked");
  video.emit("ended"); // 프레임이 돌기 전에 영상이 끝났다 — 위치가 3초(아웃)로 간다
  frame(16);
  expect(playback.now()).toBeCloseTo(2.9); // 다음 컷으로 넘어가지 않고 다시 구간 처음으로
  expect(playback.view.playing).toBe(true);
});

// 구간 반복 재생 단추(Jay 2026-10-08) — 켜는 순간 구간을 엔진에 먼저 넣고 그 처음에서 정방향으로 튼다.
it("구간 반복 재생을 켜는 순간: 구간 처음으로 가서 정방향 1배로 튼다 — 역재생 중이어도, 첫 프레임 전에 영상이 끝나도", () => {
  const range = { from: 1, to: 3 }; // 아웃 = 위 클립(top, 3초)의 끝
  render({ scope: "range4" }); // 아직 구간이 없다
  video.emit("loadedmetadata");
  act(() => playback.seek(6));
  act(() => playback.shuttle(-1)); // 역재생 중
  act(() => playback.playRange(range));
  expect(playback.now()).toBe(1);
  expect(playback.view.playing).toBe(true);
  expect(playback.view.rate).toBe(1);
  render({ scope: "range4", range }); // 다음 렌더가 같은 구간을 넣는다
  video.emit("loadedmetadata");
  video.emit("seeked");
  video.emit("ended"); // 첫 프레임 전에 영상이 끝났다 — 위치가 3초(아웃)로 간다
  frame(16);
  expect(playback.now()).toBe(1); // 다음 클립으로 넘어가지 않고 구간 처음으로
  expect(playback.view.playing).toBe(true);
});

// 편집점 앞뒤 재생(Jay 2026-10-08 — 다이나믹 트림 모드의 Space) — 편집점의 앞 2초에서 뒤 2초까지. 구간은 엔진이 쥔다.
it("편집점 앞뒤 재생: 앞 2초로 가서 뒤 2초까지 틀고 그 편집점으로 돌아와 멈춘다 — 되풀이면 그 구간을 돌고, 다른 재생 명령이 오면 풀린다", () => {
  const point = { cut: "e070/c3", local: 0 }; // 13초 — 앞은 빈 컷, 뒤는 그림(둘 다 rAF 시계)
  render({ scope: "around" });
  act(() => playback.playAround(point, 2, true));
  expect(playback.now()).toBe(11);
  expect(playback.view.playing).toBe(true);
  expect(playback.view.rate).toBe(1);
  frame(1000);
  frame(1500); // 컷을 넘는다(13초)
  frame(1900);
  expect(playback.now()).toBeCloseTo(14.9);
  frame(200); // 뒤 2초(15초)를 넘었다 → 편집점으로 돌아와 멈춘다
  expect(playback.now()).toBe(13);
  expect(playback.view.playing).toBe(false);
  expect(playback.view.cut).toBe("e070/c3");
  expect(frames).toHaveLength(0);

  act(() => playback.playAround(point, 2, false)); // 되풀이(반복이 켜져 있을 때)
  frame(1000);
  frame(1500);
  frame(2100); // 15초를 넘었다 → 앞 2초(11초)로
  expect(playback.now()).toBe(11);
  expect(playback.view.playing).toBe(true);
  act(() => playback.shuttle(1)); // L — 다른 재생 명령이다(같은 방향이라 2배). 구간이 풀려 보통 재생이 된다
  frame(1300); // 컷을 넘는다(13초)
  frame(1500); // 16초 — 15초를 지나 그대로 간다
  expect(playback.now()).toBeCloseTo(16);
  expect(playback.view.playing).toBe(true);

  act(() => playback.playAround(point, 2, true));
  frame(500);
  act(() => playback.toggle()); // 중간에 멈추면 멈춘 자리에 남고, 구간도 풀린다
  expect(playback.now()).toBeCloseTo(11.5);
  act(() => playback.toggle());
  frame(1600); // 컷을 넘는다
  frame(2500); // 15.5초 — 멈추지 않는다
  expect(playback.view.playing).toBe(true);

  const range = { from: 9, to: 10 };
  act(() => playback.playAround(point, 2, true));
  act(() => playback.playRange(range)); // 그 사이에 구간 반복 재생을 켰다 — 옛 편집점 구간이 새 구간을 덮지 않는다
  render({ scope: "around", range });
  frame(1100); // 10초를 넘었다 → 9초로(13초로 가서 멈추지 않는다)
  expect(playback.now()).toBe(9);
  expect(playback.view.playing).toBe(true);
});

it("편집점 앞뒤 재생: 편집점은 컷 좌표로 쥔다 — 트는 동안 앞 컷의 길이가 바뀌어도 그 편집점의 앞뒤를 지킨다", () => {
  const point = { cut: "e070/c3", local: 0 };
  render({ scope: "around2" });
  act(() => playback.playAround(point, 2, true)); // 11초(c2 의 3초)에서
  frame(1000); // c2 의 4초
  const longer: EditDoc = { ...DOC, clips: DOC.clips.map((clip) => (clip.gen === "low" ? { ...clip, dur: 9 } : clip)) };
  render({ scope: "around2", doc: longer, layout: buildLayout(["e070/c1", "e070/c2", "e070/c3"], longer) }); // c3 가 14초에서 시작한다
  expect(playback.now()).toBe(13); // 보던 자리(c2 의 4초)는 그대로다
  expect(playback.view.playing).toBe(true);
  frame(1500); // c3 로 넘어간다(14초)
  frame(1900); // 15.9초 — 옛 구간의 끝(15초)을 지났지만 멈추지 않는다
  expect(playback.view.playing).toBe(true);
  frame(200); // 새 구간의 끝(16초) → 그 편집점(14초)으로 돌아와 멈춘다
  expect(playback.now()).toBe(14);
  expect(playback.view.playing).toBe(false);
});

// 다이나믹 트림 모드의 두 칸은 시계가 그릴 때만 맞춰진다 — 멈춘 자리도 그려야 한다(Codex 코드 리뷰).
it("멈추면 멈춘 자리를 그린다 — 마지막 프레임 뒤에 영상이 편집점을 넘었어도", () => {
  render({ scope: "stop-paint" });
  video.emit("loadedmetadata");
  act(() => playback.toggle());
  video.currentTime = 2.95; // 위 클립(top, 3초)의 끝 직전
  frame(16);
  expect(paint).toHaveBeenLastCalledWith(2.95);
  video.currentTime = 3.05; // 다음 프레임이 돌기 전에 영상은 편집점(3초)을 넘었다
  act(() => playback.toggle()); // 멈춘다 — 영상의 시각을 위치로 받는다
  expect(playback.now()).toBeCloseTo(3.05);
  expect(playback.view.clip?.gen).toBe("low"); // 보이는 클립이 바뀌었다
  expect(paint.mock.lastCall![0]).toBeCloseTo(3.05); // 그 자리를 그렸다(안 그리면 화면은 2.95초에 남는다)
});
