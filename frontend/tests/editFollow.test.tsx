// @vitest-environment jsdom
// 편집 탭의 '한 트랙만 보기'(useEditFollow) — 타임라인의 시계를 따라가는 보기를 가짜 video 로 본다(docs/EDIT_TAB.md).
// 실제 탐색·디코딩은 여기서 못 본다 — 그것은 격리 브라우저 실측 몫이다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildLayout, emptyEditDoc, type EditDoc, type SlotClip } from "../src/lib/editTimeline";
import { useEditFollow, type EditShown } from "../src/lib/useEditFollow";
import type { EditSource, EditVideo } from "../src/lib/useEditPlayback";

class FakeVideo implements EditVideo {
  src = "";
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  seeking = false;
  plays = 0;
  private listeners = new Map<string, Set<() => void>>();
  play() { this.paused = false; this.plays++; return Promise.resolve(); }
  pause() { this.paused = true; }
  load() { this.currentTime = 0; }
  removeAttribute(name: string) { if (name === "src") this.src = ""; }
  addEventListener(type: string, listener: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: () => void) { this.listeners.get(type)?.delete(listener); }
  emit(type: string) { act(() => { this.listeners.get(type)?.forEach((listener) => listener()); }); }
  count() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}

// c1 0~8(V1 low 8초 — 꺼 둠 · V2 top 3초 · V3 hold 8초 — 타임라인에서는 위 트랙이 low 를 가린다) · c2(빈 컷) 8~13 · c3 13~18(V1 그림)
//  컷 길이는 켜진 클립만 센다(2026-10-13) — 꺼 둔 low 만으로는 c1 이 8초가 되지 않아, 켜진 hold 가 그 길이를 잡는다.
const DOC: EditDoc = {
  ...emptyEditDoc(),
  clips: [
    { cut: "e070/c1", gen: "low", track: 1, dur: 8, kind: "video", off: true },
    { cut: "e070/c1", gen: "top", track: 2, dur: 3, kind: "video" },
    { cut: "e070/c1", gen: "hold", track: 3, dur: 8, kind: "video" },
    { cut: "e070/c3", gen: "pic", track: 1, dur: 5, kind: "image" },
  ],
  tracksOff: [1],
};
const LAYOUT = buildLayout(["e070/c1", "e070/c2", "e070/c3"], DOC);
const sourceOf = (clip: SlotClip): EditSource => ({ state: "ok", url: `/v/${clip.gen}`, type: clip.kind ?? "video", thumb: null });

let host: HTMLDivElement;
let root: Root;
let video: FakeVideo;
let videoRef: { current: FakeVideo };
let shown: EditShown;
let time = 0; // 타임라인의 지금 시각
let clock = 0;
let frames: ((stamp: number) => void)[] = [];

function Harness({ track = 1, playing = false, rate = 1 }: { track?: number; playing?: boolean; rate?: number }) {
  shown = useEditFollow({ videoRef, layout: LAYOUT, track, sourceOf, now: () => time, playing, rate });
  return null;
}
const render = (props: Parameters<typeof Harness>[0] = {}) => act(() => root.render(<Harness {...props} />));
const frame = (ms = 16) => act(() => {
  clock += ms;
  const due = frames;
  frames = [];
  due.forEach((callback) => callback(clock));
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clock = 1000;
  time = 0;
  frames = [];
  video = new FakeVideo();
  videoRef = { current: video };
  vi.stubGlobal("requestAnimationFrame", (callback: (stamp: number) => void) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => { frames = []; });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("그 트랙의 클립만 보인다 — 위 트랙에 가려져 있어도, 꺼 둔 클립·트랙이어도. 그 트랙에 없으면 빈 화면", () => {
  time = 1;
  render({ track: 1 });
  frame();
  expect(shown.clip?.gen).toBe("low"); // 타임라인에서는 위 트랙이 보이는 자리
  expect(video.src).toBe("/v/low");
  time = 5; // V2 의 top 은 3초에서 끝났다
  render({ track: 2 });
  frame();
  expect(shown.clip).toBeNull();
  expect(video.src).toBe("");
  time = 14; // 그림 — 영상 요소에는 올리지 않는다
  render({ track: 1 });
  frame();
  expect(shown.clip?.gen).toBe("pic");
  expect(shown.source?.type).toBe("image");
  expect(video.src).toBe("");
});

it("멈춰 있으면 그 자리에 정확히 맞춘다 — 한 프레임 이동도 보이고, 탐색 중에는 새 탐색을 걸지 않는다", () => {
  time = 1;
  render({ track: 1 });
  frame();
  expect(video.currentTime).toBe(0); // 메타데이터를 받기 전에는 탐색하지 않는다
  video.emit("loadedmetadata");
  frame();
  expect(video.currentTime).toBe(1);
  time = 1 + 1 / 24; // 한 프레임 앞으로
  frame();
  expect(video.currentTime).toBeCloseTo(1 + 1 / 24);
  expect(video.paused).toBe(true);

  video.seeking = true; // 탐색이 아직 안 끝났다 — 훑는 동안 목표가 계속 바뀐다
  time = 2;
  frame();
  time = 3;
  frame();
  expect(video.currentTime).toBeCloseTo(1 + 1 / 24);
  video.seeking = false; // 끝나면 그때의 목표로 간다
  frame();
  expect(video.currentTime).toBe(3);
});

it("타임라인이 정방향으로 가는 동안에는 스스로 재생하고, 많이 어긋날 때만 맞춘다 — 타임라인이 서면 같이 선다", () => {
  time = 1;
  render({ track: 1, playing: true });
  frame();
  video.emit("loadedmetadata");
  time = 1.016;
  frame();
  expect(video.paused).toBe(false);
  expect(video.plays).toBe(1);
  expect(video.currentTime).toBeCloseTo(1.016); // 처음에는 그 자리로(1초 어긋나 있었다)
  video.currentTime = 1.1; // 조금 앞서 간다 — 그냥 둔다(프레임마다 탐색하면 끊긴다)
  time = 1.05;
  frame();
  expect(video.currentTime).toBe(1.1);
  video.currentTime = 1.5; // 많이 어긋났다
  time = 1.1;
  frame();
  expect(video.currentTime).toBe(1.1);

  frame(100); // 타임라인의 시각이 안 움직인다(그쪽 영상이 받는 중) — 잠깐은 기다리고
  expect(video.paused).toBe(false);
  frame(100); // 계속 서 있으면 같이 서서 그 자리에 맞춘다(혼자 앞서 갔다 되감기를 되풀이하지 않는다)
  expect(video.paused).toBe(true);
  time = 1.2; // 다시 가면 다시 튼다
  frame();
  expect(video.paused).toBe(false);

  render({ track: 1, playing: true, rate: -1 }); // 역재생 — 재생하지 않고 프레임마다 그 자리에 맞춘다
  time = 1.0;
  frame();
  expect(video.paused).toBe(true);
  expect(video.currentTime).toBe(1.0);
  render({ track: 1, playing: true, rate: 2 }); // 배속
  time = 1.1;
  frame();
  expect(video.playbackRate).toBe(2);
});

it("재생하지 못한 영상은 내리고 썸네일 정지화면으로 알린다. 떠날 때 영상을 정리한다", () => {
  time = 1;
  render({ track: 1 });
  frame();
  expect(video.src).toBe("/v/low");
  video.emit("error");
  frame();
  expect(shown.failed).toBe(true);
  expect(shown.clip?.gen).toBe("low");
  expect(video.src).toBe("");
  act(() => root.unmount());
  expect(video.count()).toBe(0);
  expect(frames).toHaveLength(0);
  root = createRoot(host);
});

// 구간 반복(Jay 2026-10-08) — 짧은 구간을 되풀이하면 되돌아가는 폭이 재생 중 허용 오차(0.2초)보다 작을 수 있다.
it("타임라인의 시각이 뒤로 가면(반복) 작은 차이여도 그 자리로 맞춘다 — 그 뒤의 작은 어긋남은 다시 그냥 둔다", () => {
  time = 1;
  render({ track: 1, playing: true });
  frame();
  video.emit("loadedmetadata");
  time = 1.016;
  frame();
  video.currentTime = 1.1;
  time = 1.1;
  frame();
  time = 1.0; // 구간 끝(1.1)에서 처음(1.0)으로 돌아갔다
  frame();
  expect(video.currentTime).toBe(1.0);
  expect(video.paused).toBe(false);
  video.currentTime = 1.08;
  time = 1.03;
  frame();
  expect(video.currentTime).toBe(1.08);
});

// 숨은 탭(조작 점검 7회차 R20) — 세우는 일이 rAF 안에만 있으면, rAF 가 서는 숨은 탭에서는 따라가던 영상이 혼자 계속 돈다.
it("탭이 가려지면 따라가던 영상을 바로 세운다 — 프레임을 기다리지 않고, 가려진 동안에는 프레임이 와도 다시 틀지 않는다", () => {
  time = 1;
  render({ track: 1, playing: true });
  frame();
  video.emit("loadedmetadata");
  time = 1.016;
  frame();
  expect(video.paused).toBe(false);
  video.currentTime = 1.3; // 가려지는 순간 영상이 가 있던 자리
  const hide = () => vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  let visibility = hide();
  act(() => { document.dispatchEvent(new Event("visibilitychange")); }); // 프레임(rAF)은 오지 않는다
  expect(video.paused).toBe(true);
  expect(video.currentTime).toBe(1.3); // 세우기만 한다 — 자리는 건드리지 않는다
  time = 1.4; // 타임라인이 멈췄다는 소식(playing=false)이 닿기 전에 프레임이 하나 왔다
  frame();
  expect(video.paused).toBe(true);
  expect(video.plays).toBe(1);

  // 다시 보여도 스스로 틀지 않는다 — 타임라인이 가려질 때 멈췄고(useEditPlayback), 이 판은 그 시계를 따라갈 뿐이다
  visibility.mockRestore();
  render({ track: 1, playing: false });
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  frame();
  expect(video.paused).toBe(true);
  expect(video.plays).toBe(1);
  expect(video.currentTime).toBe(1.4); // 멈춘 자리에 정확히 맞춰 서 있다
  render({ track: 1, playing: true }); // 타임라인을 다시 틀면 다시 따라간다
  time = 1.5;
  frame();
  expect(video.paused).toBe(false);
  expect(video.plays).toBe(2);

  act(() => root.unmount()); // 떠난 뒤에는 가려짐을 듣지 않는다
  const pause = vi.spyOn(video, "pause");
  visibility = hide();
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(pause).not.toHaveBeenCalled();
  visibility.mockRestore();
  root = createRoot(host);
});
