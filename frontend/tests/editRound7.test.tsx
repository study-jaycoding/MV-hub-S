// @vitest-environment jsdom
// 조작 점검 7회차 R21 — 적어 둔 길이보다 실제 영상이 짧을 때(길이를 재기 전 · 재지 못한 영상) 실제 끝 뒤의 자리(docs/EDIT_TAB.md §6).
//  브라우저는 길이를 넘는 currentTime 을 끝으로 자른다. 그 자리를 목표와 그대로 견주면 영영 '어긋남'이라, 재생 엔진은 seeked 마다,
//  한 트랙만 보는 판은 프레임마다 같은 자리로 다시 보냈고, 그 자리에서 재생하면 '재생 중인데 시간이 선' 채였다.
//  엔진(useEditPlayback)은 제품과 같게 영상 요소 둘을 묶은 것(pairVideo)으로, 한 트랙만 보기(useEditFollow)는 요소 그대로 본다.
//  실제 브라우저가 끝으로 자른 뒤의 currentTime·seeked 는 여기서 못 본다 — 격리 브라우저 실측 몫이다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildLayout, EDIT_FPS, emptyEditDoc, type EditClip, type EditDoc, type SlotClip } from "../src/lib/editTimeline";
import { pairVideo } from "../src/lib/editVideoPair";
import { useEditFollow } from "../src/lib/useEditFollow";
import { useEditPlayback, type EditSource } from "../src/lib/useEditPlayback";

// 실제 길이에서 자르는 영상 요소 — currentTime 을 적을 때마다 탐색 한 번으로 센다(seeked 는 시험이 낸다).
//  끝난 영상에 play() 를 걸면 브라우저처럼 처음부터 다시 튼다. 메타데이터는 받은 것으로 친다(readyState 1).
function shortVideo(duration: number) {
  const el = document.createElement("video");
  const state = { time: 0, paused: true, seeking: false, seeks: 0, plays: 0 };
  Object.defineProperty(el, "duration", { get: () => duration });
  Object.defineProperty(el, "readyState", { get: () => 1 });
  Object.defineProperty(el, "currentTime", {
    get: () => state.time,
    set: (time: number) => { state.time = Math.min(time, duration); state.seeks++; },
  });
  Object.defineProperty(el, "paused", { get: () => state.paused });
  Object.defineProperty(el, "seeking", { get: () => state.seeking });
  vi.spyOn(el, "play").mockImplementation(() => {
    if (state.time >= duration) state.time = 0;
    state.paused = false;
    state.plays++;
    return Promise.resolve();
  });
  vi.spyOn(el, "pause").mockImplementation(() => { state.paused = true; });
  vi.spyOn(el, "load").mockImplementation(() => { state.time = 0; });
  const emit = (type: string) => act(() => { el.dispatchEvent(new Event(type)); });
  return { el, state, emit };
}

const world = (clips: EditClip[], cuts: string[]) => {
  const doc: EditDoc = { ...emptyEditDoc(), clips };
  return { doc, layout: buildLayout(cuts, doc) };
};
const WRITTEN: EditClip = { cut: "e070/c1", gen: "v", track: 1, dur: 5, kind: "video" }; // 문서에 적힌 길이는 5초
const PIC: EditClip = { cut: "e070/c2", gen: "pic", track: 1, dur: 5, kind: "image" };
const TWO = world([WRITTEN, PIC], ["e070/c1", "e070/c2"]); // c1 0~5 · c2 5~10
const ONE = world([WRITTEN], ["e070/c1"]); // 영상 컷 하나뿐 — 그 컷의 끝이 전체 끝이다
// c1 0~8: 위 트랙 top 이 3초에서 끝나면 아래 low(적힌 길이 8초)가 드러난다 · c2 8~13
const STACK = world([
  { cut: "e070/c1", gen: "low", track: 1, dur: 8, kind: "video" }, { cut: "e070/c1", gen: "top", track: 2, dur: 3, kind: "video" }, PIC,
], ["e070/c1", "e070/c2"]);
const sourceOf = (clip: SlotClip): EditSource => ({ state: "ok", url: `/v/${clip.gen}`, type: clip.kind ?? "video", thumb: null });

let host: HTMLDivElement;
let root: Root;
let playback: ReturnType<typeof useEditPlayback>;
let mounts = 0;
let clock = 0;
let frames: ((stamp: number) => void)[] = [];
const frame = (ms: number) => act(() => {
  clock += ms;
  const due = frames;
  frames = [];
  due.forEach((callback) => callback(clock));
});

// 재생 엔진을 띄운다 — 영상 요소 둘(앞의 것의 실제 길이 seconds · 뒤의 것 spareSeconds)을 제품처럼 묶어 넘긴다.
//  시퀀스 이름은 매번 새로 준다 — 엔진이 시퀀스별 마지막 자리를 기억해, 같은 이름이면 앞 시험이 멈춘 자리에서 시작한다.
function mountEngine(
  at: typeof TWO, seconds: number, spareSeconds = seconds, range: { from: number; to: number } | null = null, loop = false,
) {
  const front = shortVideo(seconds);
  const spare = shortVideo(spareSeconds);
  const videoRef = { current: pairVideo(front.el, spare.el) };
  const scope = `r21-${++mounts}`;
  function Engine() {
    playback = useEditPlayback({ scope, layout: at.layout, doc: at.doc, sourceOf, videoRef, paint: () => {}, range, loop });
    return null;
  }
  act(() => root.render(<Engine />));
  front.emit("loadedmetadata");
  return { front, spare };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clock = 1000;
  frames = [];
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

it("실제 끝(2초) 뒤인 4초로 훑으면 영상은 끝 프레임에 서고, seeked 가 와도 다시 보내지 않는다 — 탐색 중에 바뀐 목표는 끝난 뒤 그대로 간다", () => {
  const { front: video } = mountEngine(TWO, 2);
  act(() => playback.seek(4));
  expect(playback.now()).toBe(4); // 재생헤드는 놓은 자리 그대로
  expect(video.state.time).toBe(2); // 영상은 실제 끝(마지막 프레임)
  const sent = video.state.seeks;
  expect(sent).toBe(1);
  for (let i = 0; i < 25; i++) video.emit("seeked");
  expect(video.state.seeks).toBe(sent); // 같은 자리로 또 보내지 않는다(전에는 seeked 마다 한 번씩 — 끝이 없었다)
  video.emit("ended"); // 끝으로 보낸 영상이 '끝남'을 알려도, 멈춘 채로는 재생헤드를 옮기지 않는다
  expect(playback.now()).toBe(4);
  act(() => playback.seek(4.5)); // 끝 뒤에서 끝 뒤로 — 영상은 이미 그 끝에 있다
  expect(video.state.seeks).toBe(sent);

  // 빠른 훑기의 보장은 그대로다 — 탐색하는 동안 목표가 바뀌면 끝난 뒤 최신 목표로 한 번 더 간다
  video.state.seeking = true;
  act(() => playback.seek(3));
  act(() => playback.seek(1));
  expect(video.state.seeks).toBe(sent);
  video.state.seeking = false;
  video.emit("seeked");
  expect(video.state.time).toBe(1);
  expect(video.state.seeks).toBe(sent + 1);
  video.emit("seeked");
  expect(video.state.seeks).toBe(sent + 1);
});

it("그 자리에서 재생하면 끝난 영상에 play() 를 걸지 않고 그 클립의 끝으로 넘긴다 — 시간이 서지 않고, 길이 교정을 기다리지 않는다", () => {
  const { front: video } = mountEngine(TWO, 2);
  act(() => playback.seek(4));
  video.emit("seeked");
  act(() => playback.toggle());
  frame(16);
  expect(video.state.plays).toBe(0); // 끝난 영상을 틀면 브라우저가 처음부터 다시 튼다
  expect(playback.view.playing).toBe(true);
  expect(playback.view.cut).toBe("e070/c2"); // 재생 중에 영상이 먼저 끝난 것(ended)과 같은 길 — 다음 컷으로
  frame(1000);
  expect(playback.now()).toBeCloseTo(6); // 시간이 간다(전에는 '재생 중'인 채 4초에 서 있었다)
});

it("재생 중에 실제 끝 뒤로 훑어도 같다 — 영상이 그 끝에 닿으면 다음으로 넘어간다", () => {
  const { front: video } = mountEngine(TWO, 2);
  act(() => playback.toggle());
  expect(video.state.plays).toBe(1);
  video.state.time = 1; // 영상이 1초까지 갔다
  frame(16);
  expect(playback.now()).toBe(1);
  act(() => playback.seek(4));
  video.emit("seeked");
  frame(16);
  expect(video.state.plays).toBe(1); // 끝에 선 영상에 다시 걸지 않는다
  expect(playback.view.playing).toBe(true);
  expect(playback.view.cut).toBe("e070/c2");
});

// 넘어가기(영상 요소 둘) — 위 클립이 끝나 드러난 아래 영상이 그 시각(3초)보다 짧다(2초). 미리 세워 둔 요소는 이미 그 끝에 서 있다.
it("위 클립이 끝나 드러난 아래 영상이 그 시각보다 짧으면, 미리 세워 둔 요소를 다시 보내지 않고 그 클립의 끝으로 넘긴다", () => {
  const { front: top, spare: low } = mountEngine(STACK, 10, 2);
  act(() => playback.toggle());
  expect(low.el.getAttribute("src")).toBe("/v/low"); // 다음에 보일 것을 뒤의 요소에 미리 받아 3초에 세워 둔다 — 2초에서 잘린다
  expect(low.state.time).toBe(2);
  const sent = low.state.seeks;
  top.state.time = 3.05; // 위 클립이 끝났다 — 아래 영상이 드러난다(앞뒤를 바꾼다)
  frame(16);
  expect(low.el.dataset.spare).toBeUndefined(); // 앞으로 나왔다
  expect(low.state.seeks).toBe(sent); // 다시 보내지 않고(seeked 를 기다리지 않고)
  expect(low.state.plays).toBe(0); // 끝난 영상을 틀지도 않는다
  frame(16);
  expect(playback.view.playing).toBe(true);
  expect(playback.view.cut).toBe("e070/c2"); // 그 클립의 끝(8초)을 지나 다음 컷으로
});

// 길이 교정은 차이가 한 프레임(1/24초) 미만이면 건너뛰고, 탐색은 0.04초 넘게 어긋나면 다시 보낸다 — 그 사이의 틈.
it("실제 길이가 적힌 길이보다 0.04초~한 프레임 짧은 영상: 적힌 끝 바로 앞에서도 되풀이하지 않고, 재생해도 처음으로 돌아가지 않는다", () => {
  const { front: video } = mountEngine(ONE, 4.959);
  expect(5 - 4.959).toBeGreaterThan(0.04); // 탐색 허용 오차보다 크고
  expect(5 - 4.959).toBeLessThan(1 / EDIT_FPS); // 길이 교정 문턱보다 작다 — 적힌 길이는 5초로 남는다
  act(() => playback.seek(4.9995)); // 적힌 끝 바로 앞 — 실제 끝과 0.04초 넘게 벌어지는 자리
  expect(video.state.time).toBe(4.959);
  const sent = video.state.seeks;
  for (let i = 0; i < 25; i++) video.emit("seeked");
  expect(video.state.seeks).toBe(sent);

  act(() => playback.toggle()); // 실제 끝과 적힌 끝 사이에서 재생
  frame(16);
  expect(video.state.plays).toBe(0); // 끝난 영상을 처음부터 다시 틀지 않는다
  expect(playback.view.playing).toBe(false); // 넘어갈 다음이 없다 — 전체 끝에서 멈춘다
  expect(playback.now()).toBe(5);
});

// ── Codex 코드 리뷰(2026-10-11)의 두 건과, 같은 뿌리로 더 훑은 길 ──
it("실제 길이가 0초인 영상도 '끝'이 있다 — 그 뒤로 훑어도 다시 보내지 않고, 재생하면 그 클립을 넘긴다(처음 자리에서도)", () => {
  const { front: video } = mountEngine(TWO, 0);
  act(() => playback.seek(4));
  video.emit("seeked");
  const sent = video.state.seeks;
  for (let i = 0; i < 4; i++) video.emit("seeked");
  expect(video.state.seeks).toBe(sent); // 0 을 '길이를 모름'으로 치면 4초로 계속 다시 보낸다
  act(() => playback.toggle());
  frame(16);
  expect(video.state.plays).toBe(0);
  expect(playback.view.playing).toBe(true);
  expect(playback.view.cut).toBe("e070/c2");

  act(() => playback.stop());
  act(() => playback.seek(0)); // 처음 자리 — 틀 것이 없는 영상이다
  video.emit("loadedmetadata");
  act(() => playback.toggle());
  frame(16);
  expect(video.state.plays).toBe(0);
  expect(playback.view.cut).toBe("e070/c2");
});

it("실제 끝 바로 앞(허용 오차 안)에 서 있던 영상: 끝 뒤로 훑고 재생해도 재생헤드가 영상의 시각으로 되돌아가지 않는다", () => {
  const { front: video } = mountEngine(TWO, 2);
  act(() => playback.seek(1.97));
  video.emit("seeked");
  act(() => playback.seek(4)); // 영상은 1.97초 — 끝(2초)과 0.04초 안이라 다시 보내지 않는다
  expect(video.state.time).toBe(1.97);
  act(() => playback.toggle());
  frame(16);
  expect(video.state.plays).toBe(0); // 틀면 영상이 시계가 되어 재생헤드가 4초에서 1.97초로 돌아간다
  expect(playback.now()).toBeGreaterThanOrEqual(4);
  expect(playback.view.cut).toBe("e070/c2");
});

it("재생 중인 영상이 실제 끝 바로 앞일 때 끝 뒤로 훑어도 같다 — 이미 돌고 있어도 시계를 맡기지 않는다", () => {
  const { front: video } = mountEngine(TWO, 2);
  act(() => playback.toggle());
  video.state.time = 1.97; // 영상이 1.97초까지 갔다
  frame(16);
  expect(playback.now()).toBe(1.97);
  act(() => playback.seek(4)); // 탐색 없이 도착으로 친다(끝과 0.04초 안) — 영상은 돌고 있는 채다
  frame(16);
  expect(playback.now()).toBeGreaterThanOrEqual(4);
  expect(playback.view.cut).toBe("e070/c2");
  expect(video.state.plays).toBe(1);
});

// 끝에 선 영상은 그대로 틀 수 없다(브라우저가 0초부터 다시 튼다). 자리가 끝보다 앞이면 허용 오차 안이어도 '도착'이 아니다.
it("실제 끝에 선 영상: 끝 바로 앞(허용 오차 안)으로 훑으면 그 자리로 되감는다 — 재생하면 마지막 조각을 틀고 넘어간다", () => {
  const { front: video } = mountEngine(TWO, 2);
  act(() => playback.seek(4));
  video.emit("seeked");
  const sent = video.state.seeks;
  act(() => playback.seek(1.97)); // 영상은 2초(끝)에 서 있다 — 0.03초 차이여도 그 자리로 보낸다
  expect(video.state.time).toBe(1.97);
  expect(video.state.seeks).toBe(sent + 1);
  video.emit("seeked");
  act(() => playback.toggle());
  frame(16);
  expect(video.state.plays).toBe(1); // 넘기지 않고 튼다 — 틀 수 있는 0.03초가 남아 있다
  expect(playback.now()).toBe(1.97);
  expect(playback.view.cut).toBe("e070/c1");
  video.state.time = 2; // 그 조각을 틀고 끝났다
  video.state.paused = true;
  video.emit("ended");
  frame(16);
  expect(playback.view.cut).toBe("e070/c2");
});

// Codex 재검토(2026-10-11): 적힌 길이 5초·실제 2.02초·구간 2~3초. 끝난 영상(2.02초)과 인(2초)의 차이가 허용 오차 안이라
//  되감지 않고 '도착'으로 치면, 끝에 선 영상을 넘기고 '빈 바퀴'로 멈춘다 — 틀 수 있는 0.02초가 있는데도.
it("구간 반복: 인이 실제 끝 바로 앞(허용 오차 안)이어도 돈다 — 끝난 영상을 인으로 되감아 마지막 조각을 튼다", () => {
  const range = { from: 2, to: 3 };
  const { front: video } = mountEngine(TWO, 2.02, 2.02, range);
  act(() => playback.playRange(range));
  expect(video.state.plays).toBe(1);
  for (let lap = 2; lap <= 3; lap++) {
    video.state.time = 2.02; // 실제 끝
    video.state.paused = true;
    video.emit("ended");
    frame(16); // 그 클립의 끝(5초)을 거쳐 인으로 돌아간다
    expect(playback.view.playing).toBe(true);
    expect(video.state.time).toBe(2); // 되감았다
    video.emit("seeked");
    expect(video.state.plays).toBe(lap);
    expect(playback.now()).toBe(2);
  }
});

// 되감기는 자리를 옮길 때와 넘어올 때만 한다. 탐색이 끝난 자리(seeked)에서는 허용 오차만 본다 — 거기서도 되감으면, 되감아도
//  끝을 못 벗어나는 영상에서 seeked 마다 다시 보내 끝이 없다. 그렇게 끝에 선 채 도착한 영상은 틀지 않고 넘긴다.
it("탐색 중에 목표가 끝 바로 앞으로 바뀌어 영상이 끝에 선 채 도착하면, 다시 보내지 않고 넘긴다 — 끝난 영상을 처음부터 틀지 않는다", () => {
  const { front: video } = mountEngine(TWO, 2);
  act(() => playback.toggle());
  video.state.time = 1;
  frame(16);
  video.state.seeking = true; // 끝으로 가는 탐색이 진행 중이다
  act(() => playback.seek(4));
  video.state.time = 2; // 그 탐색이 닿은 자리(실제 끝)
  act(() => playback.seek(1.97)); // 그 사이 목표가 끝 바로 앞으로 바뀌었다
  const sent = video.state.seeks;
  video.state.seeking = false;
  for (let i = 0; i < 5; i++) video.emit("seeked");
  expect(video.state.seeks).toBe(sent);
  frame(16);
  expect(video.state.plays).toBe(1); // 처음의 재생 한 번뿐 — 끝난 영상에 다시 걸지 않았다
  expect(playback.view.cut).toBe("e070/c2");
});

// 같은 일이 맞바꾸는 순간에도 — 미리 굴린 아래 영상이 넘어오기 직전에 자기 실제 끝(3.02초)에 닿아 서 있다.
it("넘어온 영상이 실제 끝에 서 있어도, 자리가 그 앞이면 되감아 튼다 — 넘기지 않는다", () => {
  const { front: top, spare: low } = mountEngine(STACK, 10, 3.02);
  act(() => playback.toggle());
  expect(low.state.time).toBe(3);
  top.state.time = 2.95; // 넘어가기 직전 — 아래 영상을 미리 굴린다(3초는 실제 끝 앞이다)
  frame(16);
  expect(low.state.plays).toBe(1);
  low.state.time = 3.02; // 굴리다 실제 끝에 닿았다 — 브라우저가 세운다
  low.state.paused = true;
  top.state.time = 3.01; // 경계를 넘는다
  frame(16);
  expect(low.state.time).toBe(3.01); // 0.01초 차이여도 그 자리로 되감는다
  expect(playback.view.clip?.gen).toBe("low");
  low.emit("seeked");
  frame(16);
  expect(low.state.plays).toBe(2);
  expect(playback.now()).toBe(3.01);
  expect(playback.view.clip?.gen).toBe("low");
});

// 미리 굴리기 — 드러날 아래 영상(적힌 길이 8초)의 실제 길이가 0.02초다. 3초에 세워 두려 한 뒤의 요소는 0.02초(끝)에 서 있다.
it("넘어가기 직전: 실제 끝에 세워 둔 뒤 요소는 미리 굴리지 않는다 — 굴리면 처음부터 다시 돌고, 넘어온 뒤 재생헤드가 뒤로 간다", () => {
  const { front: top, spare: low } = mountEngine(STACK, 10, 0.02);
  act(() => playback.toggle());
  expect(low.state.time).toBe(0.02);
  top.state.time = 2.95; // 경계(3초)까지 0.05초 — 미리 굴릴 때다
  frame(16);
  expect(low.state.plays).toBe(0);
  expect(low.state.time).toBe(0.02);
  top.state.time = 3.01; // 경계를 넘는다 — 앞뒤를 바꾼다
  frame(16);
  expect(low.el.dataset.spare).toBeUndefined();
  expect(playback.now()).toBeGreaterThanOrEqual(3); // 아래 영상의 시각(0초쯤)으로 돌아가 위 클립이 다시 보이지 않는다
  frame(16);
  expect(low.state.plays).toBe(0);
  expect(playback.view.playing).toBe(true);
  expect(playback.view.cut).toBe("e070/c2");
});

it("짧은 영상이 연달아 있어도 한 프레임에 한 클립씩만 넘긴다 — 틀 수 있는 것은 틀고, 마지막 컷에서는 멈춘다", () => {
  // c1: top(적힌 3초) 아래 low(적힌 8초) · c2: v(적힌 5초) — 영상은 모두 실제 0.02초다
  const at = world([
    { cut: "e070/c1", gen: "low", track: 1, dur: 8, kind: "video" }, { cut: "e070/c1", gen: "top", track: 2, dur: 3, kind: "video" },
    { cut: "e070/c2", gen: "v", track: 1, dur: 5, kind: "video" },
  ], ["e070/c1", "e070/c2"]);
  const { front: one, spare: two } = mountEngine(at, 0.02);
  const ends = (video: typeof one) => { // 영상이 실제 끝에 닿았다 — 브라우저가 세우고 알린다
    video.state.time = 0.02;
    video.state.paused = true;
    video.emit("ended");
  };
  act(() => playback.toggle());
  expect(one.state.plays).toBe(1); // top 은 처음부터 튼다(0.02초짜리여도)
  ends(one);
  expect(playback.now()).toBe(3); // top 의 끝으로
  frame(16); // 드러난 low 는 3초 자리에 틀 것이 없다(실제 0.02초) — 이 프레임에 low 하나만 넘긴다
  expect(playback.now()).toBe(8);
  expect(playback.view.cut).toBe("e070/c1");
  expect(two.state.plays).toBe(0);
  frame(16); // 다음 컷 — v 는 처음부터 튼다
  expect(playback.view.cut).toBe("e070/c2");
  expect(playback.view.clip?.gen).toBe("v");
  expect(playback.now()).toBe(8);
  expect(one.el.dataset.spare).toBeUndefined(); // 앞뒤를 다시 바꿔 그 요소가 v 를 튼다(미리 굴린 것을 그대로 잇는다)
  expect(one.state.paused).toBe(false);
  ends(one);
  frame(16);
  expect(playback.view.playing).toBe(false); // 마지막 컷의 끝 — 멈춘다
  expect(playback.now()).toBe(13);
});

it("역재생으로 실제 끝 뒤 구간에 들어오면 끝 프레임에 선 채 시간이 뒤로 흐른다 — 실제 길이 안에 들어오면 다시 그 자리에 맞춘다", () => {
  const { front: video } = mountEngine(TWO, 2);
  act(() => playback.seek(5.5)); // c2(그림)
  act(() => playback.shuttle(-1));
  frame(600); // c1 의 끝 직전으로 넘어온다 — 영상을 다시 받는다
  expect(playback.view.cut).toBe("e070/c1");
  video.emit("loadedmetadata");
  video.emit("seeked");
  expect(video.state.time).toBe(2);
  const sent = video.state.seeks;
  for (let i = 0; i < 3; i++) frame(500); // 4.96 → 3.46초 — 실제 끝 뒤
  expect(playback.now()).toBeCloseTo(5 - 1 / EDIT_FPS - 1.5);
  expect(video.state.seeks).toBe(sent);
  expect(video.state.plays).toBe(0);
  frame(2000); // 1.46초 — 실제 길이 안
  expect(video.state.time).toBeCloseTo(5 - 1 / EDIT_FPS - 3.5);
  expect(playback.view.playing).toBe(true);
});

it("구간 반복의 아웃이 실제 끝 뒤여도 돈다 — 영상이 끝나면 인으로 돌아가 다시 튼다", () => {
  const range = { from: 1, to: 4 };
  const { front: video } = mountEngine(TWO, 2, 2, range);
  act(() => playback.playRange(range));
  expect(video.state.plays).toBe(1);
  video.state.time = 2; // 실제 끝 — 아웃(4초)에 못 미친다
  video.state.paused = true;
  video.emit("ended");
  frame(16);
  video.emit("seeked");
  expect(playback.now()).toBe(1);
  expect(video.state.time).toBe(1);
  expect(video.state.plays).toBe(2);
  expect(playback.view.playing).toBe(true);
});

// 되돌아간 자리의 영상을 곧바로 넘겨 바퀴의 끝까지 가 버리면, 다음 프레임에 또 되돌아가 또 넘긴다 — '재생 중'인 채 시간이 선다.
it("구간 반복: 구간 전체가 실제 끝 뒤면 틀 것이 없다 — 프레임마다 되돌아가 넘기기를 되풀이하지 않고 멈춘다", () => {
  const range = { from: 3, to: 4.5 };
  const { front: video } = mountEngine(TWO, 2, 2, range);
  act(() => playback.playRange(range));
  for (let i = 0; i < 3; i++) frame(16);
  expect(video.state.plays).toBe(0);
  expect(playback.view.playing).toBe(false);
  expect(playback.now()).toBe(5); // 넘긴 그 클립의 끝
});

it("반복: 틀 것이 없는 영상(0초) 하나뿐이면 끝에서 멈춘다 — 프레임마다 처음과 끝을 오가지 않는다", () => {
  const { front: video } = mountEngine(ONE, 0, 0, null, true);
  act(() => playback.toggle());
  for (let i = 0; i < 3; i++) frame(16);
  expect(video.state.plays).toBe(0);
  expect(playback.view.playing).toBe(false);
  expect(playback.now()).toBe(5);
});

// 위 규칙들이 평범한 영상을 건드리지 않는지 — 실제 길이를 아는 채로(기존 시험의 가짜 video 는 길이를 모른다).
it("평범한 영상(실제 길이 = 적힌 길이): 마지막 프레임에서 틀면 틀고 끝에서 멈춘다 — 끝에 선 채 그 앞으로 가도 되감아 튼다", () => {
  const { front: video } = mountEngine(ONE, 5);
  const ends = () => {
    video.state.time = 5;
    video.state.paused = true;
    video.emit("ended");
  };
  act(() => playback.seek(5 - 1 / EDIT_FPS)); // 마지막 프레임
  video.emit("seeked");
  act(() => playback.toggle());
  expect(video.state.plays).toBe(1);
  expect(playback.view.playing).toBe(true);
  ends();
  frame(16);
  expect(playback.view.playing).toBe(false);
  expect(playback.now()).toBe(5);

  act(() => playback.seek(4.97)); // 끝에서는 보이는 클립이 없어 영상을 내렸다 — 돌아오면 다시 받는다
  video.emit("loadedmetadata");
  video.emit("seeked");
  video.state.time = 5; // 영상이 끝에 서 있던 경우
  act(() => playback.seek(4.98)); // 끝 바로 앞(0.02초)
  expect(video.state.time).toBe(4.98); // 끝난 영상은 허용 오차 안이어도 그 자리로 보낸다
  video.emit("seeked");
  act(() => playback.toggle());
  expect(video.state.plays).toBe(2);
  expect(playback.now()).toBe(4.98);
});

it("평범한 영상의 전체 반복: 끝에 닿으면 처음으로 돌아가 다시 튼다", () => {
  const { front: video } = mountEngine(ONE, 5, 5, null, true);
  act(() => playback.toggle());
  expect(video.state.plays).toBe(1);
  for (let lap = 2; lap <= 3; lap++) {
    video.state.time = 5;
    video.state.paused = true;
    video.emit("ended");
    frame(16);
    expect(playback.view.playing).toBe(true);
    expect(video.state.time).toBe(0);
    video.emit("seeked");
    expect(video.state.plays).toBe(lap);
    expect(playback.now()).toBe(0);
  }
});

// ── 한 트랙만 보기(useEditFollow) — seeked 가 아니라 프레임마다 본다 ──
function mountFollow(seconds: number, now: () => number) {
  const video = shortVideo(seconds);
  const videoRef = { current: video.el };
  function Follow({ playing }: { playing: boolean }) {
    useEditFollow({ videoRef, layout: ONE.layout, track: 1, sourceOf, now, playing, rate: 1 });
    return null;
  }
  const render = (playing: boolean) => act(() => root.render(<Follow playing={playing} />));
  return { video, render };
}

it("한 트랙만 보기: 실제 끝 뒤에서는 끝 프레임에 서 있다 — 프레임마다 다시 보내지 않고, 타임라인이 가는 동안에도 끝난 영상을 틀지 않는다", () => {
  let time = 4;
  const { video, render } = mountFollow(2, () => time);
  render(false);
  frame(16);
  video.emit("loadedmetadata");
  frame(16);
  expect(video.state.time).toBe(2);
  const sent = video.state.seeks;
  for (let i = 0; i < 30; i++) frame(16);
  expect(video.state.seeks).toBe(sent); // 멈춘 채(전에는 프레임마다 한 번씩)

  render(true);
  for (let i = 0; i < 30; i++) {
    time += 0.016;
    frame(16);
  }
  expect(video.state.seeks).toBe(sent);
  expect(video.state.plays).toBe(0);
  expect(video.state.paused).toBe(true);
  expect(video.state.time).toBe(2);

  time = 1; // 실제 길이 안으로 돌아오면 다시 따라간다
  frame(16);
  expect(video.state.time).toBe(1);
  expect(video.state.plays).toBe(1);
});

it("한 트랙만 보기: 따라가던 영상이 먼저 끝나면 끝 프레임에 둔다 — 끝난 영상에 play() 를 다시 걸어 처음으로 돌리지 않는다", () => {
  let time = 1.9;
  const { video, render } = mountFollow(2, () => time);
  render(true);
  frame(16);
  video.emit("loadedmetadata");
  time = 1.916;
  frame(16);
  expect(video.state.plays).toBe(1);
  expect(video.state.paused).toBe(false);
  const sent = video.state.seeks;
  video.state.time = 2; // 영상이 타임라인보다 조금 앞서 가다 실제 끝에 닿았다 — 브라우저가 세운다(ended)
  video.state.paused = true;
  for (let i = 0; i < 20; i++) { // 타임라인은 적힌 길이(5초)를 향해 계속 간다 — 1.93 → 2.24
    time += 0.016;
    frame(16);
  }
  expect(video.state.plays).toBe(1);
  expect(video.state.time).toBe(2);
  expect(video.state.seeks).toBe(sent);
});

it("한 트랙만 보기: 실제 길이가 0초인 영상은 틀지도 보내지도 않는다", () => {
  let time = 1;
  const { video, render } = mountFollow(0, () => time);
  render(true);
  frame(16);
  video.emit("loadedmetadata");
  for (let i = 0; i < 10; i++) {
    time += 0.016;
    frame(16);
  }
  expect(video.state.plays).toBe(0);
  expect(video.state.seeks).toBe(0);
});
