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

function Harness({ scope = "s1", doc = DOC, layout = LAYOUT, loop, range, speed, order }: {
  scope?: string; doc?: EditDoc; layout?: typeof LAYOUT; loop?: boolean; range?: { from: number; to: number } | null;
  speed?: number; order?: readonly string[];
}) {
  playback = useEditPlayback({ scope, layout, doc, sourceOf, videoRef, paint, loop, range, speed, order });
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

// 편집 탭 ⑤(Jay 2026-10-23) — 서 있던 반복 자리가 사라지면 직전 순서에서 그 다음으로. 다른 창은 순서 정리까지 된 최종 문서만 받는다
//  (문서의 순서엔 그 자리가 없다 — 이름순 보정이면 c1 바로 뒤라 c2 로 갔다). 시퀀스를 바꾸면 기억한 순서를 비운다.
it("사라진 반복 자리 — 다른 창의 최종 문서만 받아도 직전 순서의 다음 자리로 · 시퀀스를 오가면 기억한 순서가 섞이지 않는다", () => {
  const rep = "e070/c1//abc123";
  const withRep: EditDoc = { ...DOC, v: 3, clips: [...DOC.clips, { cut: "e070/c1", slot: "abc123", gen: "rep", track: 1, dur: 5, kind: "video" }],
    cutOrder: ["e070/c1", "e070/c2", rep, "e070/c3"] };
  const order0 = ["e070/c1", "e070/c2", rep, "e070/c3"];
  render({ scope: "slot", doc: withRep, layout: buildLayout(order0, withRep), order: order0 }); // c1 0~8 · c2 8~13 · c1② 13~18 · c3 18~23
  act(() => playback.seek(14));
  expect(playback.view.cut).toBe(rep);
  const gone: EditDoc = { ...DOC, v: 3 }; // 다른 창: 그 자리의 클립을 빼고 순서를 이름순으로 되돌렸다(죽은 열쇠까지 정리됨)
  const order1 = ["e070/c1", "e070/c2", "e070/c3"];
  render({ scope: "slot", doc: gone, layout: buildLayout(order1, gone), order: order1 });
  expect([playback.view.cut, playback.now()]).toEqual(["e070/c3", 13]);
  // 다른 시퀀스에 다녀오면 위치는 그 시퀀스의 것 — 앞 시퀀스의 순서로 보정하지 않는다
  render({ scope: "slot2", doc: withRep, layout: buildLayout(order0, withRep), order: order0 });
  expect(playback.now()).toBe(0);
  act(() => playback.seek(14));
  render({ scope: "slot", doc: gone, layout: buildLayout(order1, gone), order: order1 });
  expect(playback.view.cut).toBe("e070/c3");
});

// Jay 2026-10-13: "v1 이 5초 v2 가 3초면 3초 보여주다가 남은 v1 이 더 보인다. 하지만 v1 트랙이 꺼져 있다면 그 해당 폴더는 3초만 재생된다."
it("컷 길이는 켜진 클립만 센다 — 아래 트랙을 끄면 그 컷은 위 클립의 길이에서 다음 컷으로 넘어가고, 재생 중에 끄면 줄어든 끝에서 멈춘다", () => {
  const cuts = ["e070/c1", "e070/c2", "e070/c3"];
  const off: EditDoc = { ...DOC, tracksOff: [1] }; // V1(low 8초)을 껐다 → c1 은 top 의 3초
  const short = buildLayout(cuts, off);
  expect(short.cuts.map((cut) => [cut.start, cut.len])).toEqual([[0, 3], [3, 5], [8, 5]]);
  // 꺼 둔 채 재생: 3초에서 꺼진 low 가 드러나지 않고 다음 컷(빈 컷)으로 넘어간다
  render({ doc: off, layout: short });
  act(() => playback.seek(0)); // 재생헤드의 마지막 자리는 시험 사이에 남는다 — 처음에서 시작한다
  video.emit("loadedmetadata");
  video.emit("seeked");
  act(() => playback.toggle());
  video.currentTime = 2.9;
  frame(16);
  expect([playback.view.cut, playback.view.clip?.gen]).toEqual(["e070/c1", "top"]);
  video.currentTime = 3.05;
  frame(16);
  expect([playback.view.cut, playback.view.clip]).toEqual(["e070/c2", null]);
  expect(video.src).toBe(""); // low 를 올리지 않았다
  act(() => playback.toggle());
  // 켜 둔 채 6.5초(아래 클립)를 보다가 재생 중에 V1 을 끈다 → 줄어든 끝 직전에서 멈춘다(영상의 옛 시각으로 되덮지 않는다)
  render();
  act(() => playback.seek(6));
  video.emit("loadedmetadata");
  video.emit("seeked");
  act(() => playback.toggle());
  video.currentTime = 6.5;
  frame(16);
  expect(playback.view.clip?.gen).toBe("low");
  render({ doc: off, layout: short });
  expect(playback.view.playing).toBe(false);
  expect(playback.now()).toBeLessThan(3);
  expect(playback.now()).toBeGreaterThan(2.9);
  expect([playback.view.cut, playback.view.clip?.gen]).toEqual(["e070/c1", "top"]);
});

// 길이 조절(Jay 2026-10-13 — 뒤를 자른다): 줄인 위 클립은 줄인 길이에서 끝나고 아래 클립이 그 시각부터 이어진다.
it("줄인 클립은 줄인 길이에서 끝난다 — 영상의 실제 끝까지 틀지 않고 아래 클립으로 넘어간다", () => {
  const cut: EditDoc = { ...DOC, clips: DOC.clips.map((clip) => (clip.gen === "top" ? { ...clip, trim: 1.5 } : clip)) };
  render({ doc: cut, layout: buildLayout(["e070/c1", "e070/c2", "e070/c3"], cut) });
  act(() => playback.seek(0)); // 재생헤드의 마지막 자리는 시험 사이에 남는다 — 처음에서 시작한다
  video.emit("loadedmetadata");
  video.emit("seeked");
  act(() => playback.toggle());
  video.currentTime = 1.4;
  frame(16);
  expect(playback.view.clip?.gen).toBe("top");
  video.currentTime = 1.55; // top 의 영상은 3초까지 있지만 줄인 길이(1.5초)를 넘었다
  frame(16);
  expect([playback.view.cut, playback.view.clip?.gen]).toEqual(["e070/c1", "low"]);
  expect(video.src).toBe("/v/low");
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

// 재생헤드·시각은 시계가 그릴 때만 맞춰진다 — 멈춘 자리도 그려야 한다(Codex 코드 리뷰).
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

// 영상 요소 둘을 묶은 것(editVideoPair)의 가짜 — 엔진이 청한 '미리 받기'를 적고, 받아 둔 것을 앞으로 내놓으면 받지 않는다(loads 가
// 늘지 않는다). 실제 요소 둘의 동작은 editVideoPair.test.ts 가 본다.
class FakePair extends FakeVideo {
  readyState = 0;
  prepared: [string | null, number][] = []; // 같은 것을 거듭 청한 것은 한 번만 적는다
  backRate = 1; // 마지막으로 청한 '미리 굴릴 배속'(그 클립의 속도 × 배속)
  backSeeking = false; // 뒤의 것이 아직 그 자리로 가는 중이다
  rolls: boolean[] = []; // 미리 굴리기를 켜고 끈 기록(바뀔 때만)
  rolling = false;
  roll(on: boolean) {
    if (on === this.rolling) return;
    this.rolling = on;
    this.rolls.push(on);
  }
  prepare(url: string | null, time: number, rate = 1) {
    this.backRate = rate;
    const last = this.prepared[this.prepared.length - 1];
    if (!last || last[0] !== url || last[1] !== time) this.prepared.push([url, time]);
  }
  swap(url: string) {
    const last = this.prepared[this.prepared.length - 1];
    if (!last || last[0] !== url) return false;
    this.src = url;
    this.currentTime = last[1];
    this.readyState = 4;
    this.seeking = this.backSeeking;
    if (this.rolling) { // 미리 굴려 둔 것 — 이미 돌고 있고, 세워 둔 자리를 조금 지나 있다
      this.currentTime = last[1] + 0.1;
      this.paused = false;
    }
    this.rolling = false;
    return true;
  }
}
const usePair = () => {
  const pair = new FakePair();
  video = pair;
  videoRef.current = pair;
  return pair;
};

it("정방향 재생 중에는 다음에 보일 영상을 미리 받아 두고, 넘어갈 때 받지 않고 바꾼다 — 받느라 서던 시간이 없다", () => {
  const pair = usePair();
  render({ scope: "pair" });
  video.emit("loadedmetadata");
  expect(pair.prepared).toEqual([]); // 멈춰 있을 때는 받지 않는다(훑을 때마다 받지 않게)
  act(() => playback.toggle());
  expect(pair.prepared).toEqual([["/v/low", 3]]); // 위 클립(3초)이 끝나면 같은 컷의 아래 클립이 그 시각부터 보인다
  const loads = video.loads;
  video.currentTime = 3.02;
  frame(16);
  expect(playback.view.clip?.gen).toBe("low");
  expect(video.src).toBe("/v/low");
  expect(video.loads).toBe(loads); // 다시 받지 않았다
  expect(video.paused).toBe(false); // 메타데이터·탐색을 기다리지 않고 바로 이어 튼다
  video.currentTime = 3.2;
  frame(16);
  expect(playback.now()).toBeCloseTo(3.2); // 시계도 서지 않았다
  expect(pair.prepared[pair.prepared.length - 1]).toEqual([null, 0]); // 다음은 빈 컷 — 받아 둘 영상이 없다
});

it("미리 세워 둔 영상이 아직 그 자리로 가는 중이면 seeked 뒤에 시계를 맡긴다 — 시각이 목표를 가리킨다고 도착한 것이 아니다", () => {
  const pair = usePair();
  pair.backSeeking = true;
  render({ scope: "pair-seeking" });
  video.emit("loadedmetadata");
  act(() => playback.toggle());
  video.currentTime = 3.02;
  frame(16);
  expect(video.src).toBe("/v/low");
  expect(video.paused).toBe(true); // 아직 틀지 않는다
  frame(500);
  expect(playback.now()).toBeCloseTo(3.02); // 시간도 서 있다
  video.seeking = false;
  video.emit("seeked");
  expect(video.paused).toBe(false);
  video.currentTime = 3.5;
  frame(16);
  video.currentTime = 4.5; // 다음 프레임이 돌기 전에 영상은 한참 갔다(느린 프레임)
  video.emit("loadedmetadata"); // 늦게 온 메타데이터 — 시계로 도는 영상을 엔진이 아는 자리(3.5초)로 되감지 않는다
  expect(video.currentTime).toBe(4.5);
});

it("미리 받기: 구간의 끝이 클립 경계와 같으면 다음 클립이 아니라 되돌아갈 자리의 것을 본다 — 반복이면 끝에서 처음의 영상", () => {
  const pair = usePair();
  render({ scope: "pair-range", range: { from: 1, to: 3 } }); // 위 클립(0~3초)의 끝이 구간의 끝이다
  video.emit("loadedmetadata");
  act(() => playback.seek(2));
  video.emit("seeked");
  act(() => playback.toggle());
  expect(pair.prepared).toEqual([[null, 1]]); // 구간 처음(1초)은 지금 트는 그 영상이다 — 아래 클립(/v/low)을 받지 않는다
  act(() => playback.stop());

  render({ scope: "pair-loop", loop: true });
  act(() => playback.seek(14)); // 마지막 컷(이미지)
  act(() => playback.toggle());
  expect(pair.prepared[pair.prepared.length - 1]).toEqual(["/v/top", 0]); // 끝에 닿으면 처음으로 돌아간다
  const loads = video.loads;
  frame(4500); // 끝(18초)을 넘어 처음으로
  expect(playback.now()).toBe(0);
  expect(video.src).toBe("/v/top");
  expect(video.loads).toBe(loads);
  expect(video.paused).toBe(false);
});

it("배속: 재생·L 은 고른 배속으로 시작하고, 재생 중에 바꾸면 바로 따른다 — L 로 올린 속도는 다른 렌더가 되돌리지 않는다", () => {
  render({ scope: "speed", speed: 2 });
  video.emit("loadedmetadata");
  act(() => playback.toggle());
  expect(playback.view.rate).toBe(2);
  expect(video.playbackRate).toBe(2);
  render({ scope: "speed", speed: 4 }); // 재생 중에 배속을 바꾼다
  expect(playback.view.playing).toBe(true);
  expect(playback.view.rate).toBe(4);
  expect(video.playbackRate).toBe(4);
  act(() => playback.shuttle(1)); // L — 지금의 2배
  expect(playback.view.rate).toBe(8);
  render({ scope: "speed", speed: 4, loop: true }); // 배속이 아닌 것이 바뀐 렌더
  expect(playback.view.rate).toBe(8);
  act(() => playback.shuttle(-1)); // J — 방향을 바꾸면 1배
  expect(playback.view.rate).toBe(-1);
  render({ scope: "speed", speed: 1.5, loop: true }); // 역방향에는 배속을 걸지 않는다
  expect(playback.view.rate).toBe(-1);
  act(() => playback.shuttle(1)); // 다시 L — 고른 배속으로
  expect(playback.view.rate).toBe(1.5);
  act(() => playback.stop());
  act(() => playback.seek(8.5)); // 빈 컷 — rAF 시계도 배속으로 간다
  act(() => playback.toggle());
  frame(1000);
  expect(playback.now()).toBeCloseTo(10);
  act(() => playback.playRange({ from: 9, to: 12 })); // 구간 반복 재생도 고른 배속으로
  expect(playback.view.rate).toBe(1.5);
});

it("넘어가기 직전에는 받아 둔 영상을 미리 굴리고, 넘어온 뒤에는 되감지 않는다 — 멈추면 굴리던 것을 세운다", () => {
  const pair = usePair();
  render({ scope: "pair-roll" });
  video.emit("loadedmetadata");
  act(() => playback.toggle());
  video.currentTime = 2.5;
  frame(16);
  expect(pair.rolls).toEqual([]); // 아직 멀다
  video.currentTime = 2.95; // 경계(3초)까지 0.05초
  frame(16);
  expect(pair.rolls).toEqual([true]);
  act(() => playback.stop());
  expect(pair.rolls).toEqual([true, false]); // 멈추면 세운다(가려진 채 혼자 돌지 않게)
  act(() => playback.toggle());
  expect(pair.rolls).toEqual([true, false, true]);
  video.currentTime = 3.01;
  frame(16);
  expect(video.src).toBe("/v/low");
  expect(video.currentTime).toBeCloseTo(3.1); // 이미 돌던 영상이다 — 목표(3.01초)로 되감지 않는다
  expect(video.paused).toBe(false);
  frame(16);
  expect(playback.now()).toBeCloseTo(3.1); // 그 영상이 시계다
});

// 미리 굴리던 영상은 돌고 있다 — 그것을 앞으로 내놓는 길이 '재생 중'만은 아니다(Codex 코드 리뷰).
it("미리 굴리는 중에 멈추면, 멈춘 자리가 경계를 넘었어도 넘어온 영상은 서 있다", () => {
  const pair = usePair();
  render({ scope: "pair-roll-stop" });
  video.emit("loadedmetadata");
  act(() => playback.toggle());
  video.currentTime = 2.95;
  frame(16);
  expect(pair.rolling).toBe(true);
  video.currentTime = 3.01; // 다음 프레임이 돌기 전에 앞 영상은 경계(3초)를 넘었다
  act(() => playback.stop()); // 멈춘다 — 멈춘 자리에 보이는 것은 아래 클립이다
  expect(playback.view.playing).toBe(false);
  expect(video.src).toBe("/v/low");
  expect(video.paused).toBe(true);
  expect(video.currentTime).toBeCloseTo(3.01); // 굴러간 자리(3.1초)가 아니라 멈춘 자리로
});

// ── 앞 자르기(Jay 2026-10-14) — 클립은 원본의 head 초에서 시작한다: 영상 시각 = 컷 안 시각 + head ──
const CUTS3 = ["e070/c1", "e070/c2", "e070/c3"];
const headDoc = (gen: string, head: number): { doc: EditDoc; layout: typeof LAYOUT } => {
  const doc: EditDoc = { ...DOC, clips: DOC.clips.map((clip) => (clip.gen === gen ? { ...clip, head } : clip)) };
  return { doc, layout: buildLayout(CUTS3, doc) };
};

it("앞을 자른 클립은 원본의 그 시각에서 시작한다 — 재생헤드는 컷 안 시각, 영상은 거기에 시작점을 더한 시각", () => {
  render({ scope: "head-play", ...headDoc("top", 1) }); // top: 원본 3초의 앞 1초를 잘랐다 → 컷 안 0~2초 = 영상 1~3초
  expect(playback.view.clip?.gen).toBe("top");
  video.emit("loadedmetadata");
  expect(video.currentTime).toBe(1); // 컷 안 0초 = 영상 1초
  video.emit("seeked");
  act(() => playback.seek(0.5)); // 멈춘 채 훑는다
  expect(video.currentTime).toBe(1.5);
  video.emit("seeked");
  act(() => playback.toggle());
  video.currentTime = 2.2;
  frame(16);
  expect(playback.now()).toBeCloseTo(1.2); // 영상이 시계 — 영상 2.2초는 컷 안 1.2초다
  video.currentTime = 2.6;
  act(() => playback.toggle()); // 멈추면 영상의 그 프레임이 위치다(시작점을 뺀다)
  expect(playback.now()).toBeCloseTo(1.6);
  expect(paint.mock.lastCall![0]).toBeCloseTo(1.6);
  act(() => playback.toggle());
  video.currentTime = 3.05; // 컷 안 2.05초 — 쓰는 길이(2초)가 끝났다
  frame(16);
  expect([playback.view.clip?.gen, video.src]).toEqual(["low", "/v/low"]);
  video.emit("loadedmetadata");
  expect(video.currentTime).toBeCloseTo(2.05); // 아래 클립은 앞을 자르지 않았다 — 제 시각(컷 안 시각)이고, 위 클립의 시작점을 물려받지 않는다
});

it("같은 영상의 시작점만 바뀌면(길이 조절 창) 영상을 새 자리로 보내고, 닿기 전에는 시계를 넘기지 않는다 — 재생헤드가 튀지 않는다", () => {
  render({ scope: "head-change", ...headDoc("top", 1) });
  video.emit("loadedmetadata");
  video.emit("seeked");
  act(() => playback.seek(0.5));
  video.emit("seeked");
  expect(video.currentTime).toBe(1.5);
  render({ scope: "head-change", ...headDoc("top", 1.5) }); // 멈춘 채 시작점을 0.5초 뒤로
  expect(playback.now()).toBeCloseTo(0.5); // 재생헤드는 그대로
  expect(video.currentTime).toBe(2); // 영상만 새 자리로
  expect(video.loads).toBe(1); // 같은 영상이다 — 다시 받지 않는다
  video.emit("seeked");
  act(() => playback.toggle());
  video.currentTime = 2.3;
  frame(16);
  expect(playback.now()).toBeCloseTo(0.8);
  const plays = video.plays;
  render({ scope: "head-change", ...headDoc("top", 1) }); // 재생 중에 시작점을 앞으로
  frame(16);
  expect(playback.now()).toBeCloseTo(0.8); // 도는 영상의 시각(2.3초)을 새 시작점으로 읽지 않는다 — 읽으면 1.3초로 튄다
  expect(video.currentTime).toBeCloseTo(1.8); // 컷 안 0.8초 + 새 시작점 1초
  expect(video.plays).toBe(plays); // 아직 닿지 않았다
  video.emit("seeked"); // 닿았다 — 그때부터 영상이 시계다
  expect(video.plays).toBe(plays + 1);
  video.currentTime = 1.9;
  frame(16);
  expect(playback.now()).toBeCloseTo(0.9);
});

it("앞을 자른 영상의 실제 끝은 컷 안 시각으로 '길이 − 시작점'이다 — 그 뒤로는 보내지 않고 넘긴다", () => {
  render({ scope: "head-end", ...headDoc("top", 1) }); // top: 적힌 길이 3초 · 앞 1초 자름 → 컷 안 0~2초
  Object.assign(video, { duration: 2.5 }); // 실제 영상은 2.5초뿐이다 — 컷 안 1.5초가 실제 끝
  video.emit("loadedmetadata");
  video.emit("seeked");
  act(() => playback.seek(1.8)); // 실제 끝 뒤
  expect(video.currentTime).toBe(2.5); // 끝으로만 보낸다(그 뒤로 보내면 브라우저가 자르고, 같은 자리로 거듭 보내게 된다)
  video.emit("seeked");
  act(() => playback.toggle()); // 틀 것이 없다 — 그 클립을 넘겨 아래 클립으로
  frame(16);
  expect(playback.view.clip?.gen).toBe("low");
});

it("미리 받아 세워 두는 자리도 영상 시각이다 — 다음 클립이 앞을 잘랐으면 그 시작점을 더한 자리", () => {
  const pair = usePair();
  render({ scope: "pair-head", ...headDoc("low", 2) }); // low: 원본 8초의 앞 2초를 잘랐다
  video.emit("loadedmetadata");
  act(() => playback.toggle());
  expect(pair.prepared).toEqual([["/v/low", 5]]); // 위 클립이 끝나는 컷 안 3초 = low 의 영상 5초
  video.currentTime = 3.02;
  frame(16);
  expect([playback.view.clip?.gen, video.src]).toEqual(["low", "/v/low"]);
  expect(playback.now()).toBeCloseTo(3.02); // 바꾼 직후에도 재생헤드는 컷 안 시각이다(받아 둔 영상의 5초가 아니다)
  video.currentTime = 5.3; // low 의 영상 5.3초 = 컷 안 3.3초
  frame(16);
  expect(playback.now()).toBeCloseTo(3.3);
});

// ── 속도(Jay 2026-10-23 Ctrl+R) — 영상 시각 = head + 컷 안 시각 × speed · playbackRate = 배속 × speed · rAF 시계는 그대로 ──
const speedDoc = (gen: string, speed: number, head?: number): { doc: EditDoc; layout: typeof LAYOUT } => {
  const doc: EditDoc = {
    ...DOC, v: 2, clips: DOC.clips.map((clip) => (clip.gen === gen ? { ...clip, speed, ...(head !== undefined ? { head } : {}) } : clip)),
  };
  return { doc, layout: buildLayout(CUTS3, doc) };
};

it("속도 클립은 영상 시각 = 시작점 + 컷 안 시각 × 속도 — 재생헤드는 컷 안 시각, 재생률은 배속 × 속도", () => {
  const { doc, layout } = speedDoc("top", 2, 1); // top: 원본 3초 · 앞 1초 자름 → 쓰는 원본 2초 ÷ 2배 = 컷 안 0~1초
  expect(layout.cuts[0].clips.find((clip) => clip.gen === "top")!.len).toBe(1);
  render({ scope: "speed-play", doc, layout });
  video.emit("loadedmetadata");
  expect(video.currentTime).toBe(1); // 컷 안 0초 = 영상 1초
  video.emit("seeked");
  act(() => playback.seek(0.5)); // 멈춘 채 훑는다
  expect(video.currentTime).toBe(2); // 1 + 0.5 × 2
  video.emit("seeked");
  act(() => playback.toggle());
  expect(video.playbackRate).toBe(2);
  video.currentTime = 2.4;
  frame(16);
  expect(playback.now()).toBeCloseTo(0.7); // 영상이 시계 — (2.4 − 1) ÷ 2
  video.currentTime = 2.6;
  act(() => playback.toggle()); // 멈추면 영상의 그 프레임이 위치다
  expect(playback.now()).toBeCloseTo(0.8);
  act(() => playback.toggle());
  video.currentTime = 3.05; // 컷 안 1.025초 — 쓰는 길이(1초)가 끝났다
  frame(16);
  expect([playback.view.clip?.gen, video.src]).toEqual(["low", "/v/low"]);
  expect(video.playbackRate).toBe(1); // 아래 클립은 속도가 없다 — 위 클립의 속도를 물려받지 않는다
});

it("느린 속도(25%)는 재생률에 바닥을 걸지 않는다 — 배속에만 건다(2배속 × 25% = 0.5)", () => {
  const { doc, layout } = speedDoc("top", 0.25);
  render({ scope: "speed-slow", doc, layout, speed: 2 });
  video.emit("loadedmetadata");
  video.emit("seeked");
  act(() => playback.toggle());
  expect(video.playbackRate).toBe(0.5);
  frame(16);
  expect(playback.now()).toBe(0); // 영상이 시계다(도착 전에는 선다) — rAF 시계에 속도를 곱하지 않는다
  video.currentTime = 0.25; // 영상 0.25초 = 컷 안 1초
  frame(16);
  expect(playback.now()).toBeCloseTo(1);
});

it("같은 영상의 속도만 바뀌면(속도 막대) 새 식으로 영상을 다시 보낸다 — 재생헤드는 그대로", () => {
  render({ scope: "speed-change", ...speedDoc("top", 1.5) });
  video.emit("loadedmetadata");
  video.emit("seeked");
  act(() => playback.seek(1));
  video.emit("seeked");
  expect(video.currentTime).toBe(1.5);
  render({ scope: "speed-change", ...speedDoc("top", 0.5) });
  expect(playback.now()).toBeCloseTo(1); // 재생헤드는 그대로
  expect(video.currentTime).toBe(0.5); // 영상만 새 자리로(1 × 0.5)
  expect(video.loads).toBe(1); // 같은 영상이다 — 다시 받지 않는다
});

it("미리 받기·미리 굴리기는 다음 클립의 시작점·속도로 — 세워 둘 영상 시각과 굴릴 배속", () => {
  const pair = usePair();
  render({ scope: "pair-speed", ...speedDoc("low", 0.5, 2) }); // low: 앞 2초 자름 · 50%
  video.emit("loadedmetadata");
  act(() => playback.toggle());
  expect(pair.prepared).toEqual([["/v/low", 3.5]]); // 위 클립이 끝나는 컷 안 3초 = low 의 영상 2 + 3 × 0.5
  expect(pair.backRate).toBe(0.5); // 지금 도는 top(100%)의 배속이 아니다
  video.currentTime = 3.02;
  frame(16);
  expect([playback.view.clip?.gen, video.playbackRate]).toEqual(["low", 0.5]);
  expect(playback.now()).toBeCloseTo(3.02);
  video.currentTime = 3.6; // low 의 영상 3.6초 = 컷 안 (3.6 − 2) ÷ 0.5 = 3.2초
  frame(16);
  expect(playback.now()).toBeCloseTo(3.2);
});
