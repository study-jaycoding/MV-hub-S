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
  private rate = 1;
  get playbackRate() { return this.rate; }
  set playbackRate(value: number) { // 크롬처럼 1/16~16 밖이면 예외(릴리스 묶음 리뷰 B)
    if (!(value >= 1 / 16 && value <= 16)) throw new DOMException("playback rate out of range", "NotSupportedError");
    this.rate = value;
  }
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

function Harness({ track = 1, playing = false, rate = 1, layout = LAYOUT, catchUp }: {
  track?: number; playing?: boolean; rate?: number; layout?: typeof LAYOUT; catchUp?: boolean;
}) {
  shown = useEditFollow({ videoRef, layout, track, sourceOf, now: () => time, playing, rate, catchUp });
  return null;
}

// 영상 요소 둘을 묶은 것(editVideoPair)의 가짜 — 뒤에 미리 받아 세워 둔 주소·자리와 바꿔 끼움만 흉내 낸다(바꿔 끼운 것은 서 있다)
class FakePair extends FakeVideo {
  readyState = 0;
  loads = 0;
  back = { url: "", time: 0 };
  swaps: string[] = [];
  rolls = 0;
  load() { super.load(); this.loads++; }
  prepare(url: string | null, at: number) { this.back = { url: url ?? "", time: at }; }
  swap(url: string) {
    if (!url || url !== this.back.url) return false;
    this.swaps.push(url);
    [this.src, this.currentTime, this.paused, this.readyState] = [url, this.back.time, true, 1];
    this.back = { url: "", time: 0 };
    return true;
  }
  roll() { this.rolls++; }
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

// 컷 길이는 켜진 클립만 센다(2026-10-13) — 꺼 둔 클립은 컷보다 길 수 있다. 그 트랙을 보고 있어도 컷이 끝나면 다음 컷으로 넘어간다
//  (꺼 둔 8초 클립이 3초짜리 컷의 뒤 5초 동안 다음 컷 위에 남지 않는다).
it("꺼 둔 클립이 컷보다 길어도, 그 트랙의 보기는 컷의 끝에서 다음 컷의 것으로 넘어간다", () => {
  const doc: EditDoc = {
    ...emptyEditDoc(),
    clips: [
      { cut: "e070/c1", gen: "long", track: 1, dur: 8, kind: "video", off: true },
      { cut: "e070/c1", gen: "top", track: 2, dur: 3, kind: "video" },
      { cut: "e070/c2", gen: "after", track: 1, dur: 5, kind: "video" },
    ],
  };
  const layout = buildLayout(["e070/c1", "e070/c2"], doc); // c1 0~3(켜진 top 의 길이) · c2 3~8
  expect(layout.cuts.map((cut) => cut.len)).toEqual([3, 5]);
  time = 2;
  render({ track: 1, layout });
  frame();
  expect(shown.clip?.gen).toBe("long");
  time = 4; // c1 의 꺼 둔 클립은 8초까지지만, 여기는 이미 c2 다
  render({ track: 1, layout });
  frame();
  expect(shown.clip?.gen).toBe("after");
});

it("멈춰 있으면 그 자리에 정확히 맞춘다 — 한 프레임 이동도 보이고, 탐색 중에는 새 탐색을 걸지 않는다", () => {
  time = 1;
  render({ track: 1 });
  frame();
  expect(video.currentTime).toBe(1); // 받기 전에 그 자리를 '처음 자리'로 적어 둔다(탐색이 아니다 — 받는 대로 그리로 간다)
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
  expect(video.currentTime).toBe(1); // 받기 전에 적어 둔 처음 자리 그대로 — 0.016초는 허용 오차 안(다시 탐색하지 않는다)
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

// 앞 자르기(Jay 2026-10-14) — 영상 시각 = 컷 안 시각 + 그 클립의 시작점
it("앞을 자른 클립은 시작점을 더한 자리로 보낸다 — 같은 영상의 시작점이 조금만 바뀌어도(재생 중) 한 번 정확히 맞춘다", () => {
  const withHead = (head: number) => buildLayout(["e070/c1", "e070/c2", "e070/c3"],
    { ...DOC, clips: DOC.clips.map((clip) => (clip.gen === "low" ? { ...clip, head } : clip)) });
  time = 1;
  render({ track: 1, layout: withHead(2) }); // low: 원본 8초의 앞 2초를 잘랐다
  frame();
  video.emit("loadedmetadata");
  frame();
  expect(video.currentTime).toBe(3); // 컷 안 1초 = 영상 3초
  render({ track: 1, playing: true, layout: withHead(2) });
  time = 1.016;
  frame();
  expect(video.paused).toBe(false);
  video.currentTime = 3.05;
  time = 1.05;
  frame();
  expect(video.currentTime).toBe(3.05); // 맞는 자리다
  render({ track: 1, playing: true, layout: withHead(2 + 2 / 24) }); // 시작점을 2프레임(0.083초) 뒤로 — 재생 중의 허용 오차(0.2초) 안이다
  time = 1.1;
  frame();
  expect(video.currentTime).toBeCloseTo(1.1 + 2 + 2 / 24); // 그래도 새 시작점으로 맞춘다(그냥 두면 이 판만 옛 구간을 튼다)
  video.currentTime = 3.25;
  time = 1.13;
  frame();
  expect(video.currentTime).toBe(3.25); // 그 뒤의 작은 어긋남은 전처럼 그냥 둔다
});

it("앞을 자른 클립으로 바뀌면 새로 받은 영상을 시작점으로 한 번 정확히 보낸다 — 시작점이 0.2초 안이어도", () => {
  const layout = buildLayout(["e070/c1", "e070/c2", "e070/c3"],
    { ...DOC, clips: DOC.clips.map((clip) => (clip.gen === "low" ? { ...clip, head: 3 / 24 } : clip)) });
  time = 0.01;
  render({ track: 1, playing: true, layout });
  frame();
  expect(video.currentTime).toBeCloseTo(0.01 + 3 / 24); // 받기 전에 시작점(3프레임)을 건너뛴 자리를 처음 자리로 적어 둔다
  video.currentTime = 0; // 그래도 0초에 서 있으면(처음 자리를 못 받은 영상) — 컷 안 0.01초와 0.2초 안으로 가깝지만
  video.emit("loadedmetadata");
  time = 0.02;
  frame();
  expect(video.currentTime).toBeCloseTo(0.02 + 3 / 24); // 한 번 정확히 보낸다
});

// 클린 피드(Jay 2026-10-26 "재생하는데 딜레이") — 영상의 재생 시작 시간만큼 뒤처진 채 가지 않게 재생률로 붙는다. 소리 있는 판은 켜지 않는다.
it("catchUp 이면 재생 중 어긋남을 재생률로 메운다(반 프레임 넘게 ±8% · 세 프레임 넘게 ±25% · 안이면 원래) — 끄면 원래 재생률 그대로", () => {
  time = 1;
  render({ track: 1, playing: true, catchUp: true });
  frame();
  video.emit("loadedmetadata");
  const step = (lag: number) => {
    time += 0.016;
    video.currentTime = time - lag; // 영상이 시계보다 lag 초 뒤(음수면 앞)
    frame();
    return video.playbackRate;
  };
  step(0);
  expect(video.paused).toBe(false);
  expect(step(0.07)).toBeCloseTo(1.08);
  expect(step(0.15)).toBeCloseTo(1.25); // 0.2초(맞추는 탐색) 안 — 탐색하지 않는다
  expect(video.currentTime).toBeCloseTo(time - 0.15);
  expect(step(-0.05)).toBeCloseTo(0.92);
  expect(step(0.01)).toBe(1);
  render({ track: 1, playing: true, rate: 2, catchUp: true });
  expect(step(0.07)).toBeCloseTo(2.16); // 배속에 곱한다
  render({ track: 1, playing: true });
  expect(step(0.15)).toBe(1);
});

// 클린 피드(Jay 2026-10-26 "클립 넘어갈 때 딜레이") — 영상이 쌍이면 타임라인 판처럼 다음 것을 미리 받아 굴려 두었다가 바꿔 끼운다
it("영상이 쌍이면 정방향 재생 중 다음 클립을 그 시작 자리에 미리 받아 두고, 넘어갈 때 받지 않고 바꿔 끼워 그 프레임에 바로 튼다 · 멈추면 받지 않는다", () => {
  const doc: EditDoc = { ...emptyEditDoc(), clips: [
    { cut: "e070/c1", gen: "a", track: 1, dur: 2, kind: "video" },
    { cut: "e070/c2", gen: "b", track: 1, dur: 2, kind: "video" },
  ] };
  const layout = buildLayout(["e070/c1", "e070/c2"], doc); // c1 0~2 · c2 2~4
  const pair = new FakePair();
  video = pair;
  videoRef = { current: pair };
  time = 1;
  render({ track: 1, playing: true, layout });
  frame();
  expect(pair.src).toBe("/v/a");
  expect(pair.back).toEqual({ url: "/v/b", time: 0 }); // 다음 컷의 처음 자리
  pair.emit("loadedmetadata");
  time = 1.95; // 넘어가기 직전 — 미리 굴리지 않는다(받아 세워 둔 것은 바로 돈다 — 굴리면 그만큼 앞서 간다)
  frame();
  const loads = pair.loads;
  const plays = pair.plays;
  time = 2.01;
  frame();
  expect(pair.swaps).toEqual(["/v/b"]);
  expect(pair.loads).toBe(loads); // 받지 않았다
  expect(shown.clip?.gen).toBe("b");
  expect(pair.paused).toBe(false); // 바꿔 끼운 그 프레임에 튼다(한 프레임 늦게 틀면 그만큼 뒤처진다)
  expect(pair.plays).toBe(plays + 1);
  expect(pair.currentTime).toBe(0); // 다시 보내지 않는다(0.01초 — 허용 오차 안)
  expect(pair.back.url).toBe(""); // 그 뒤에는 없다
  expect(pair.rolls).toBe(0);
  render({ track: 1, playing: false, layout }); // 멈춤 — 미리 받지도 굴리지도 않는다
  time = 1.9;
  frame();
  expect(pair.back.url).toBe("");
  act(() => root.unmount());
  expect(pair.back).toEqual({ url: "", time: 0 });
  root = createRoot(host);
});

it("속도 클립(2026-10-23) — 영상 시각 = 시작점 + 컷 안 시각 × 속도, 재생률 = 배속 × 속도(25% 에 바닥을 걸지 않는다)", () => {
  const doc: EditDoc = { ...emptyEditDoc(), v: 2, clips: [{ cut: "e070/c1", gen: "slow", track: 1, dur: 4, kind: "video", head: 1, speed: 0.25 }] };
  const layout = buildLayout(["e070/c1"], doc); // 쓰는 원본 3초 ÷ 0.25 = 컷 안 0~12초
  expect(layout.cuts[0].len).toBe(12);
  time = 4;
  render({ track: 1, layout });
  frame();
  video.emit("loadedmetadata");
  frame();
  expect(video.currentTime).toBe(2); // 1 + 4 × 0.25
  render({ track: 1, layout, playing: true, rate: 2 });
  time = 4.1;
  frame();
  expect(video.playbackRate).toBe(0.5); // 2배속 × 25%
  expect(video.currentTime).toBe(2); // 어긋남(0.1초 — 타임라인 초)은 허용 오차 안이다
  video.currentTime = 1.5; // 영상 1.5초 = 컷 안 2초 — 2.1초 넘게 어긋났다
  time = 4.2;
  frame();
  expect(video.currentTime).toBeCloseTo(1 + 4.2 * 0.25);
});

it("재생률은 크롬 한도(16) 안 — 400% 클립을 8배로 따라가도(따라붙기 ×1.25 포함) 예외 없이 16(릴리스 묶음 리뷰 B)", () => {
  const doc: EditDoc = { ...emptyEditDoc(), v: 2, clips: [{ cut: "e070/c1", gen: "fast", track: 1, dur: 40, kind: "video", speed: 4 }] };
  const layout = buildLayout(["e070/c1"], doc); // 원본 40초 ÷ 4 = 컷 안 0~10초
  time = 1;
  render({ track: 1, layout, playing: true, rate: 8, catchUp: true });
  frame();
  video.emit("loadedmetadata");
  video.currentTime = 4 - 0.5; // 컷 안 1초 = 영상 4초 — 그보다 뒤처졌다(따라붙기 ×1.25)
  time = 1.016;
  frame();
  expect(video.playbackRate).toBe(16); // 8 × 4 × 1.25 = 40 → 한도
  expect(video.paused).toBe(false);
  time = 1.032;
  frame();
  expect(frames.length).toBeGreaterThan(0); // 대입 예외로 다음 프레임 예약이 멈추지 않았다
});
