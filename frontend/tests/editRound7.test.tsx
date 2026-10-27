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
//  길이는 요소마다 하나지만, lengths 에 주소별 길이를 적어 두면 그 주소를 올린 동안은 그 길이다(컷마다 길이가 다른 시퀀스).
let lengths: Record<string, number> = {};
function shortVideo(base: number) {
  const el = document.createElement("video");
  const state = { time: 0, paused: true, seeking: false, seeks: 0, plays: 0 };
  const duration = () => lengths[el.getAttribute("src") ?? ""] ?? base;
  Object.defineProperty(el, "duration", { get: duration });
  Object.defineProperty(el, "readyState", { get: () => 1 });
  Object.defineProperty(el, "currentTime", {
    get: () => state.time,
    set: (time: number) => { state.time = Math.min(time, duration()); state.seeks++; },
  });
  Object.defineProperty(el, "paused", { get: () => state.paused });
  Object.defineProperty(el, "seeking", { get: () => state.seeking });
  vi.spyOn(el, "play").mockImplementation(() => {
    if (state.time >= duration()) state.time = 0;
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
let painted: number[] = []; // 엔진이 그린 재생헤드 시각(그린 순서대로)
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
  world0: typeof TWO, seconds: number, spareSeconds = seconds, range: { from: number; to: number } | null = null, loop = false,
  speed = 1,
) {
  const front = shortVideo(seconds);
  const spare = shortVideo(spareSeconds);
  const videoRef = { current: pairVideo(front.el, spare.el) };
  const scope = `r21-${++mounts}`;
  let lap = { at: world0, range, loop };
  function Engine() {
    const paint = (time: number) => { painted.push(time); };
    const { at, ...rest } = lap;
    playback = useEditPlayback({ scope, layout: at.layout, doc: at.doc, sourceOf, videoRef, paint, speed, ...rest });
    return null;
  }
  act(() => root.render(<Engine />));
  front.emit("loadedmetadata");
  // 구간·반복·배치를 바꿔 다시 그린다 — 화면이 구간 반복을 켜고 끄거나 인/아웃을 옮긴 것, 컷이 배치에서 빠진 것
  const rerender = (next: Partial<typeof lap>) => {
    lap = { ...lap, ...next };
    act(() => root.render(<Engine />));
  };
  return { front, spare, rerender };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clock = 1000;
  frames = [];
  painted = [];
  lengths = {};
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

it("짧은 영상이 연달아 있어도 넘긴 자리를 그리지 않고 같은 프레임에 다음으로 간다 — 틀 수 있는 것은 틀고, 마지막 컷에서는 멈춘다", () => {
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
  painted = [];
  frame(16); // 드러난 low 는 3초 자리에 틀 것이 없다(실제 0.02초) — 넘기고, 그 자리(c1 의 끝)를 그리지 않고 다음 컷으로 간다
  expect(two.state.plays).toBe(0);
  expect(playback.view.cut).toBe("e070/c2"); // v 는 처음부터 튼다
  expect(playback.view.clip?.gen).toBe("v");
  expect(playback.now()).toBe(8);
  expect(painted).toEqual([8]); // 이 프레임에 한 번 그렸다
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
//  멈추는 자리는 돌아간 자리(바퀴의 처음 — 구간 반복이면 인)다. 넘긴 클립의 끝에 서면 구간 반복이 켜진 채 재생헤드가 구간 밖에 남는다.
it("구간 반복: 구간 전체가 실제 끝 뒤면 틀 것이 없다 — 프레임마다 되돌아가 넘기기를 되풀이하지 않고 인에서 멈춘다", () => {
  const range = { from: 3, to: 4.5 };
  const { front: video } = mountEngine(TWO, 2, 2, range);
  act(() => playback.playRange(range));
  for (let i = 0; i < 3; i++) frame(16);
  expect(video.state.plays).toBe(0);
  expect(playback.view.playing).toBe(false);
  expect(playback.now()).toBe(3); // 인 — 넘긴 그 클립의 끝(5초)이 아니다
  expect(painted[painted.length - 1]).toBe(3);
  expect(painted).not.toContain(5); // 멈추기 전에 넘긴 자리(아웃 너머)를 한 번도 그리지 않았다
  expect(playback.view.clip?.gen).toBe("v"); // 그 자리의 클립이 보인다(영상은 끝 프레임)
  expect(video.state.time).toBe(2);
});

it("반복: 틀 것이 없는 영상(0초) 하나뿐이면 처음에서 멈춘다 — 프레임마다 처음과 끝을 오가지 않는다", () => {
  const { front: video } = mountEngine(ONE, 0, 0, null, true);
  act(() => playback.toggle());
  for (let i = 0; i < 3; i++) frame(16);
  expect(video.state.plays).toBe(0);
  expect(playback.view.playing).toBe(false);
  expect(playback.now()).toBe(0);
  expect(painted).not.toContain(5); // 멈추기 전에 넘긴 자리(전체 끝)를 한 번도 그리지 않았다
});

// Codex 재검토(2026-10-11): 틀 것이 없는 컷이 여럿이면, 돌아간 자리의 첫 컷만 넘긴 위치가 바퀴의 끝보다 앞이라 '빈 바퀴'로
//  보지 못했다 — 프레임마다 끝까지 넘기고 돌아오기만 되풀이해 '재생 중'인 채 화면의 시간이 고정됐다. 위치가 아니라 '그 바퀴에
//  흐른 시간이 있나'로 본다(영상이 시계로 돌았거나, rAF 시계가 흐를 자리를 지났거나).
const videoCuts = (count: number) => world(
  Array.from({ length: count }, (_, i): EditClip => ({ cut: `e070/c${i + 1}`, gen: `v${i + 1}`, track: 1, dur: 5, kind: "video" })),
  Array.from({ length: count }, (_, i) => `e070/c${i + 1}`),
);
for (const count of [2, 3]) {
  it(`전체 반복: 틀 것이 없는 컷(0초 영상)이 ${count}개여도 돌아간 처음에서 멈춘다 — '재생 중'인 채 서지 않는다`, () => {
    const { front, spare } = mountEngine(videoCuts(count), 0, 0, null, true);
    act(() => playback.toggle());
    frame(16); // 처음에서 시작한 한 바퀴 — 넘기기만 하고 끝에 닿는다
    expect(playback.view.playing).toBe(false);
    expect(playback.now()).toBe(0);
    expect(painted.filter((time) => time !== 0)).toEqual([]); // 넘긴 자리(컷의 끝)는 한 번도 그리지 않았다
    expect(front.state.plays + spare.state.plays).toBe(0);
    for (let i = 0; i < 4; i++) frame(16);
    expect(playback.view.playing).toBe(false);
  });
}

it("구간 반복: 구간이 여러 컷에 걸쳐 있어도 그 안에 틀 것이 하나도 없으면 인에서 멈춘다", () => {
  lengths = { "/v/v1": 2, "/v/v2": 0 }; // c1 은 실제 2초(구간은 그 뒤 3초부터) · c2 는 0초
  const range = { from: 3, to: 8 };
  const { front, spare } = mountEngine(videoCuts(2), 0, 0, range);
  act(() => playback.playRange(range));
  frame(16); // 인에서 시작한 한 바퀴 — 두 컷을 넘기기만 하고 아웃에 닿는다
  expect(playback.view.playing).toBe(false);
  expect(playback.now()).toBe(3);
  expect(painted.filter((time) => time !== 0 && time !== 3)).toEqual([]); // 넘긴 자리는 그리지 않았다(처음 그린 0초와 인뿐)
  expect(front.state.plays + spare.state.plays).toBe(0);
});

// 재생을 바퀴의 중간에서 눌렀으면 첫 바퀴는 판정하지 않는다(아래) — 그래도 돌아간 처음에서 시작한 다음 바퀴가 비면 멈춘다.
it("전체 반복: 틀 것이 없는 컷들의 중간에서 재생을 눌러도, 처음부터 돈 다음 바퀴가 비면 처음에서 멈춘다", () => {
  mountEngine(videoCuts(2), 0, 0, null, true);
  act(() => playback.seek(2.5)); // 첫 컷의 중간
  act(() => playback.toggle());
  for (let i = 0; i < 4; i++) frame(16);
  expect(playback.view.playing).toBe(false);
  expect(playback.now()).toBe(0);
});

it("구간 반복: 틀 것 없는 구간의 중간에서 재생을 눌러도 인에서 멈춘다 — 돌아간 자리에서 넘긴 자리(아웃 너머)를 그리지 않는다", () => {
  const range = { from: 3, to: 4.5 };
  const { front: video } = mountEngine(TWO, 2, 2, range);
  act(() => playback.seek(4)); // 구간 안, 인보다 뒤 — 실제 끝(2초) 뒤라 틀 것이 없다
  video.emit("seeked");
  painted = [];
  act(() => playback.toggle());
  for (let i = 0; i < 3; i++) frame(16);
  expect(playback.view.playing).toBe(false);
  expect(playback.now()).toBe(3);
  expect(painted).not.toContain(5); // 그 클립의 끝
  expect(painted[painted.length - 1]).toBe(3);
});

// 빈 바퀴 판정은 돌아간 자리에서 시작한 바퀴에만 한다 — 재생을 누른 첫 바퀴는 바퀴의 처음에서 시작한 것이 아닐 수 있다.
it("아웃 뒤의 틀 것 없는 자리에서 재생을 눌러도, 돌아 들어간 구간에 틀 것이 있으면 멈추지 않는다", () => {
  lengths = { "/v/v1": 5, "/v/v2": 0 }; // c1 은 평범한 영상(구간 1~3초가 그 안) · c2 는 0초
  const range = { from: 1, to: 3 };
  const { front, spare } = mountEngine(videoCuts(2), 0, 0, range);
  act(() => playback.seek(7)); // c2 — 아웃 뒤, 틀 것이 없는 자리
  front.emit("loadedmetadata");
  act(() => playback.toggle());
  frame(16); // c2 를 넘겨 전체 끝 → 구간 처음(인)으로 들어온다
  expect(playback.view.playing).toBe(true);
  expect(playback.now()).toBe(1);
  const running = [front, spare].find((item) => item.el.dataset.spare === undefined)!; // 앞의 요소
  expect(running.el.getAttribute("src")).toBe("/v/v1"); // 구간을 튼다
  expect(running.state.paused).toBe(false);
});

it("틀 것이 없는 컷 사이에 틀 수 있는 컷(그림)이 하나 있으면 계속 돈다 — 그 컷에서 시간이 흐른다", () => {
  const at = world([
    { cut: "e070/c1", gen: "v1", track: 1, dur: 5, kind: "video" }, { cut: "e070/c2", gen: "pic", track: 1, dur: 5, kind: "image" },
    { cut: "e070/c3", gen: "v3", track: 1, dur: 5, kind: "video" },
  ], ["e070/c1", "e070/c2", "e070/c3"]);
  mountEngine(at, 0, 0, null, true);
  act(() => playback.toggle());
  const seen = new Set<number>();
  for (let i = 0; i < 60; i++) { // 30초 — 그림 컷(5초)을 여러 번 지난다
    frame(500);
    seen.add(Math.round(playback.now() * 2) / 2);
  }
  expect(playback.view.playing).toBe(true);
  expect(seen.size).toBeGreaterThan(5); // 시간이 흐른다(5.0 ~ 10.0 사이의 여러 자리)
});

it("틀 것이 없는 컷 사이에 틀 수 있는 영상 컷이 하나 있어도 계속 돈다", () => {
  lengths = { "/v/v2": 2 }; // c2 만 실제 2초 — c1·c3 은 0초
  const { front, spare } = mountEngine(videoCuts(3), 0, 0, null, true);
  act(() => playback.toggle());
  for (let lap = 0; lap < 3; lap++) {
    for (let i = 0; i < 8 && playback.view.clip?.gen !== "v2"; i++) frame(16);
    expect(playback.view.clip?.gen).toBe("v2"); // 바퀴마다 c2 에 온다
    const running = [front, spare].find((item) => item.el.dataset.spare === undefined)!; // 앞의 요소
    expect(running.state.paused).toBe(false); // 튼다
    running.state.time = 1;
    frame(16);
    expect(playback.now()).toBe(6);
    running.state.time = 2; // 실제 끝
    running.state.paused = true;
    running.emit("ended");
    frame(16); // c3 을 넘기고 처음으로 돌아간다
    expect(playback.view.playing).toBe(true);
  }
});

// 한 프레임에 넘기는 클립 수에는 상한이 있다 — 미리 받아 둔 것이 전부 틀 수 없는 것이어도 한 프레임이 끝없이 길어지지 않는다.
it("틀 것이 없는 컷이 아주 많아도 한 프레임에 넘기는 수는 정해져 있다 — 나머지는 다음 프레임이 잇고, 끝에서 멈춘다", () => {
  mountEngine(videoCuts(12), 0);
  act(() => playback.toggle());
  expect(playback.now()).toBe(5); // 재생을 누른 순간 첫 컷을 넘겼다(프레임 밖의 일이다)
  const seen: number[] = [];
  for (let i = 0; i < 3; i++) {
    frame(16);
    seen.push(playback.now());
  }
  expect(seen).toEqual([25, 45, 60]); // 프레임마다 정확히 네 컷씩(5초짜리) — 마지막 프레임은 남은 셋을 넘기고 끝에 닿는다
  expect(playback.view.playing).toBe(false);
});

// Codex 재검토(2026-10-11): 처음에서 재생해 시간이 흐르기 전(버퍼링)에 자리를 옮기면, 그 바퀴는 더 이상 '처음부터 돈 바퀴'가
//  아니다 — 지나온 것이 없다고 빈 바퀴로 보면 틀 수 있는 앞부분을 확인하지도 않고 멈춘다.
const jumps: [string, () => void][] = [
  ["훑기(seek)", () => playback.seek(4)],
  ["컷 안 자리로(seekPos)", () => playback.seekPos({ cut: "e070/c1", local: 4 })],
  ["다음 편집점으로(stepEdit)", () => playback.stepEdit(1)],
];
for (const [name, jump] of jumps) {
  it(`전체 반복: 시간이 흐르기 전에 재생 중 자리를 옮겨도(${name}) 멈추지 않는다 — 처음으로 돌아가 틀 수 있는 것을 튼다`, () => {
    const { front, spare } = mountEngine(ONE, 2, 2, null, true); // 적힌 길이 5초 · 실제 2초
    const plays = () => front.state.plays + spare.state.plays;
    act(() => playback.toggle());
    frame(16); // 받는 중 — 영상의 시각이 가지 않는다
    frame(16);
    expect(playback.now()).toBe(0);
    act(jump); // 실제 끝 뒤(4초) 또는 전체 끝으로
    const before = plays();
    front.emit("seeked");
    frame(16); // 넘기고 전체 끝 → 처음으로 돌아간다
    expect(playback.view.playing).toBe(true);
    expect(playback.now()).toBe(0);
    front.emit("seeked");
    spare.emit("seeked");
    frame(16);
    expect(playback.view.playing).toBe(true);
    expect(plays()).toBeGreaterThan(before); // 처음으로 돌아가 0~2초를 튼다
  });
}

// 재생 중에 되풀이할 구간이 달라져도 바퀴의 처음이 달라진다 — 구간 반복을 끄면 바퀴는 전체가 되고, 지금 자리는 그 중간이다.
it("재생 중에 구간 반복을 꺼도(바퀴가 전체로 바뀜) 그 바퀴는 판정하지 않는다 — 처음으로 돌아가 틀 수 있는 것을 튼다", () => {
  lengths = { "/v/v1": 2, "/v/v2": 0 }; // c1 은 0~2초만 틀 수 있다 · c2 는 0초
  const range = { from: 3, to: 8 }; // 구간 안에는 틀 것이 없다
  const { front, spare, rerender } = mountEngine(videoCuts(2), 0, 0, range, true);
  const plays = () => front.state.plays + spare.state.plays;
  act(() => playback.playRange(range)); // 인에서 시작 — 온전한 바퀴라 판정 대상이다
  rerender({ range: null }); // 구간 반복을 껐다 — 재생은 그대로다
  const before = plays();
  frame(16); // 남은 것을 넘기고 전체 끝 → 맨 처음으로
  expect(playback.view.playing).toBe(true);
  expect(playback.now()).toBe(0);
  front.emit("seeked");
  spare.emit("seeked");
  frame(16);
  expect(plays()).toBeGreaterThan(before); // c1 의 0~2초를 튼다
});

// 화면이 구간 반복을 켜는 순서 — 먼저 엔진에 틀라고 하고(playRange), 뒤따르는 렌더로 그 구간이 속성으로 온다. 같은 구간이
//  다시 온 것은 바뀐 것이 아니다(바뀐 것으로 치면 인에서 시작한 온전한 바퀴를 판정하지 않게 된다).
it("구간 반복을 켠 뒤따르는 렌더로 같은 구간이 와도 판정은 그대로다 — 빈 구간은 한 바퀴에 멈춘다", () => {
  lengths = { "/v/v1": 2, "/v/v2": 0 };
  const range = { from: 3, to: 8 };
  const { rerender } = mountEngine(videoCuts(2), 0);
  act(() => playback.playRange(range));
  rerender({ range: { ...range } });
  frame(16);
  expect(playback.view.playing).toBe(false);
  expect(playback.now()).toBe(3);
});

// 바퀴의 범위는 처음과 끝을 다 견준다 — 아래 둘은 한쪽만 달라지는 경우다. 틀 것 없는 두 컷을 돌다가(둘째 컷의 영상이 아직
//  도착하지 않아 서 있는 사이) 범위가 달라진다.
it("재생 중에 지나온 쪽에 틀 수 있는 컷이 생기면(전체 길이가 달라진다) 그 바퀴는 판정하지 않는다 — 다음 바퀴에 그 컷을 튼다", () => {
  const grown = world([
    { cut: "e070/c0", gen: "pic", track: 1, dur: 5, kind: "image" },
    { cut: "e070/c1", gen: "v1", track: 1, dur: 5, kind: "video" }, { cut: "e070/c2", gen: "v2", track: 1, dur: 5, kind: "video" },
  ], ["e070/c0", "e070/c1", "e070/c2"]);
  const { spare, rerender } = mountEngine(videoCuts(2), 0, 0, null, true);
  act(() => playback.toggle()); // 처음에서 시작 — 첫 컷을 넘긴다
  spare.state.seeking = true; // 둘째 컷의 영상은 아직 도착하지 않는다
  frame(16);
  expect(playback.now()).toBe(5);
  rerender({ at: grown }); // 숨겨 두었던 그림 컷이 앞에 생겼다 — 전체가 10초에서 15초로
  spare.state.seeking = false;
  spare.emit("seeked"); // 도착 — 0초 영상이라 넘긴다
  frame(16); // 전체 끝 → 처음(새로 생긴 그림 컷)으로
  expect(playback.view.playing).toBe(true);
  expect(playback.now()).toBe(0);
  frame(500);
  expect(playback.now()).toBeCloseTo(0.5); // 그림 컷에서 시간이 흐른다
});

it("재생 중에 인을 앞으로 옮기면(구간의 처음이 달라진다) 그 바퀴는 판정하지 않는다 — 새로 든 앞부분을 튼다", () => {
  lengths = { "/v/v1": 2, "/v/v2": 0 }; // c1 은 0~2초만 틀 수 있다 · c2 는 0초
  const { front, spare, rerender } = mountEngine(videoCuts(2), 0, 0, { from: 3, to: 8 }, true);
  const plays = () => front.state.plays + spare.state.plays;
  act(() => playback.playRange({ from: 3, to: 8 })); // 인(3초)에서 시작 — c1 의 실제 끝 뒤라 넘긴다
  spare.state.seeking = true; // c2 의 영상은 아직 도착하지 않는다
  frame(16);
  expect(playback.now()).toBe(5);
  rerender({ range: { from: 1, to: 8 } }); // 인을 1초로 — 아웃은 그대로다
  spare.state.seeking = false;
  spare.emit("seeked");
  const before = plays();
  frame(16); // 아웃 → 새 인(1초)으로
  expect(playback.view.playing).toBe(true);
  expect(playback.now()).toBe(1);
  front.emit("seeked");
  spare.emit("seeked");
  frame(16);
  expect(plays()).toBeGreaterThan(before); // c1 의 1~2초를 튼다
});

// 흐른 시간은 바퀴마다 새로 센다 — 앞서 튼 것이 다음 재생의 빈 바퀴를 가리지 않는다.
it("앞서 틀었던 뒤에 틀 것 없는 구간을 반복해도 한 바퀴에 멈춘다 — 흐른 시간은 바퀴를 열 때 0 에서 시작한다", () => {
  lengths = { "/v/v1": 2, "/v/v2": 0 }; // c1 은 0~2초만 틀 수 있다 · c2 는 0초
  const range = { from: 3, to: 8 }; // 그 안에는 틀 것이 없다
  const { front } = mountEngine(videoCuts(2), 0, 0, range);
  act(() => playback.seek(0));
  act(() => playback.toggle()); // 구간 앞(0초)에서 튼다
  front.state.time = 1;
  frame(16);
  expect(playback.now()).toBe(1); // 1초가 흘렀다
  act(() => playback.stop());
  act(() => playback.playRange(range));
  frame(16);
  expect(playback.view.playing).toBe(false);
  expect(playback.now()).toBe(3);
});

// 틀 영상이 보이는 자리에서 rAF 로 버틴 걸음은 흐른 것이 아니다 — 위 영상을 넘긴 자리(3초)에는 아래 영상이 보인다.
it("전체 반복: 같은 컷에 겹친 틀 것 없는 영상들(위 3초 · 아래 8초)도 한 바퀴에 멈춘다", () => {
  const stack = world([
    { cut: "e070/c1", gen: "low", track: 1, dur: 8, kind: "video" }, { cut: "e070/c1", gen: "top", track: 2, dur: 3, kind: "video" },
  ], ["e070/c1"]);
  const { front, spare } = mountEngine(stack, 0, 0, null, true);
  act(() => playback.toggle()); // 위 영상(0초)을 넘긴다 — 3초로
  frame(16); // 아래 영상이 드러난다 — 받는 동안 rAF 가 한 걸음 갔다(3.016초)
  expect(playback.now()).toBeCloseTo(3.016);
  front.emit("loadedmetadata"); // 받았다 — 아래 영상도 0초라 넘긴다
  frame(16); // 전체 끝 → 빈 바퀴였다
  expect(playback.view.playing).toBe(false);
  expect(playback.now()).toBe(0);
  expect(front.state.plays + spare.state.plays).toBe(0);
});

//  ② 흐른 시간은 '직전에 넘겼나'가 아니라 그 걸음이 지난 자리에 무엇이 있었나로 센다 — 넘긴 뒤 드러난 그림은 실제로 흐른 것이다.
it("넘긴 뒤 드러난 그림에서 흐른 시간은 센다 — 한 걸음에 지나가는 짧은 그림이어도 빈 바퀴가 아니다", () => {
  const tail = 5 + 1 / EDIT_FPS;
  const at = world([
    { cut: "e070/c1", gen: "pic", track: 1, dur: tail, kind: "image" }, // 아래: 그림(5초 + 한 프레임)
    { cut: "e070/c1", gen: "v", track: 2, dur: 5, kind: "video" }, // 위: 영상(적힌 5초·실제 2초)
  ], ["e070/c1"]);
  const range = { from: 3, to: tail }; // 영상의 실제 끝 뒤 ~ 그림의 끝
  const { front: video } = mountEngine(at, 2, 2, range, false, 4); // 4배속 — 한 걸음(16ms)이 그림의 한 프레임보다 길다
  act(() => playback.playRange(range));
  for (let i = 0; i < 6; i++) {
    video.emit("seeked");
    frame(16);
  }
  expect(playback.view.playing).toBe(true);
});

// Codex 재리뷰(2026-10-11) 두 건 — '세는 시간'의 경계. rAF 한 걸음은 출발 자리가 아니라 **지난 구간**으로 센다: 걸음이 크면
//  그 안에서 보이는 것이 바뀌고, 걸음의 끝이 바퀴의 끝(아웃)을 넘을 수도 있다.
it("큰 걸음 중간에 나타나는 그림도 센다 — 걸음이 영상이 보이는 자리에서 출발했어도, 그 뒤의 그림 조각은 흐른 시간이다", () => {
  const frames = (count: number) => 5 + count / EDIT_FPS;
  const at = world([
    { cut: "e070/c1", gen: "pic", track: 1, dur: frames(2), kind: "image" }, // 맨 아래: 그림(5초 + 두 프레임)
    { cut: "e070/c1", gen: "b", track: 2, dur: frames(1), kind: "video" }, // 가운데: 영상 B(5초 + 한 프레임)
    { cut: "e070/c1", gen: "a", track: 3, dur: 5, kind: "video" }, // 맨 위: 영상 A(5초) — 영상의 실제 길이는 모두 2초
  ], ["e070/c1"]);
  const range = { from: 3, to: frames(2) }; // 3초 ~ 그림의 끝
  const { front, spare } = mountEngine(at, 2, 2, range, false, 4); // 4배속
  act(() => playback.playRange(range)); // A 를 넘긴다 — 5초로
  expect(playback.now()).toBe(5);
  for (let i = 0; i < 6; i++) {
    frame(33); // 다음 프레임이 33ms 뒤에 온다 — 한 걸음(0.13초)이 B 의 한 프레임을 지나 그림까지 간다
    front.emit("seeked");
    spare.emit("seeked");
  }
  expect(playback.view.playing).toBe(true);
});

it("아웃 뒤에서 흐른 시간은 세지 않는다 — 구간 안에 틀 것이 없으면, 넘긴 자리(아웃 뒤)에 그림이 있어도 멈춘다", () => {
  const at = world([
    { cut: "e070/c1", gen: "pic", track: 1, dur: 16, kind: "image" }, // 맨 아래: 그림 16초
    { cut: "e070/c1", gen: "c", track: 2, dur: 15, kind: "video" }, // 그 위로 영상 15 · 10 · 5초(실제 길이는 모두 2초)
    { cut: "e070/c1", gen: "b", track: 3, dur: 10, kind: "video" },
    { cut: "e070/c1", gen: "a", track: 4, dur: 5, kind: "video" },
  ], ["e070/c1"]);
  const range = { from: 3, to: 14 }; // 그 안에서 보이는 것은 영상뿐이고, 전부 실제 끝 뒤다
  const { front, spare } = mountEngine(at, 2, 2, range);
  act(() => playback.playRange(range)); // A 를 넘긴다 — 5초로
  expect(playback.now()).toBe(5);
  // 영상을 받고 탐색을 마치는 일이 프레임 사이에 온다 — 넘기는 것이 프레임 밖(이벤트)에서 일어난다
  frame(16); // B 가 드러난다 — 받는 중
  front.emit("loadedmetadata");
  front.emit("seeked"); // B 도착 — 실제 끝 뒤라 넘긴다(10초로)
  expect(playback.now()).toBe(10);
  spare.state.seeking = true; // C(미리 받아 둔 것)는 아직 탐색 중이다
  frame(16); // C 가 드러난다 — 앞뒤를 바꾼다
  spare.state.seeking = false;
  spare.emit("seeked"); // C 도착 — 넘긴다(15초로: 아웃 뒤, 그림이 보이는 자리)
  expect(playback.now()).toBe(15);
  frame(16); // 그림 위에서 rAF 가 한 걸음 가고 되돌아간다 — 그 걸음은 아웃 뒤다
  expect(playback.view.playing).toBe(false);
  expect(playback.now()).toBe(3);
  expect(front.state.plays + spare.state.plays).toBe(0);
});

// 같은 일이 영상이 시계일 때도 난다 — 아웃 뒤에 드러난 것이 틀 수 있는 영상이고, 다음 프레임 전에 그것이 도착해 돌기 시작하면
//  (그 사이 문서가 다시 그려져 소스를 맞춘다) 그 영상의 시각이 간 만큼이 '흐른 시간'으로 잡혔다.
//  구간 3~14초에 틀 것이 없는 채로, 아웃 뒤(15초)의 영상 D 가 시계로 돌기 시작한 데까지 간다 — 돌고 있는 그 요소를 돌려준다.
function rollingPastOut() {
  const clips: EditClip[] = [
    { cut: "e070/c1", gen: "d", track: 1, dur: 16, kind: "video" }, // 맨 아래: 15초부터 틀 수 있는 영상(실제 15.5초)
    { cut: "e070/c1", gen: "c", track: 2, dur: 15, kind: "video" }, // 그 위로 15 · 10 · 5초(실제 길이는 모두 2초)
    { cut: "e070/c1", gen: "b", track: 3, dur: 10, kind: "video" },
    { cut: "e070/c1", gen: "a", track: 4, dur: 5, kind: "video" },
  ];
  const range = { from: 3, to: 14 };
  const { front, spare, rerender } = mountEngine(world(clips, ["e070/c1"]), 2, 2, range);
  lengths = { "/v/d": 15.5 };
  act(() => playback.playRange(range)); // A 를 넘긴다 — 5초로
  frame(16);
  front.emit("loadedmetadata");
  front.emit("seeked"); // B 를 넘긴다 — 10초로
  spare.state.seeking = true;
  frame(16);
  spare.state.seeking = false;
  spare.emit("seeked"); // C 를 넘긴다 — 15초로(아웃 뒤, D 가 보이는 자리)
  expect(playback.now()).toBe(15);
  rerender({ at: world(clips, ["e070/c1"]) }); // 문서가 다시 그려진다(내용은 같다) — 보이는 소스를 맞춘다: D 를 받는다
  for (const video of [front, spare]) {
    video.emit("loadedmetadata");
    video.emit("seeked"); // D 도착 — 돈다
  }
  const rolling = [front, spare].find((video) => !video.state.paused)!;
  expect(rolling.state.time).toBe(15);
  return rolling;
}

it("아웃 뒤에서 영상이 돈 시간도 세지 않는다 — 넘긴 자리(아웃 뒤)에 틀 수 있는 영상이 있어도, 구간 안에 틀 것이 없으면 멈춘다", () => {
  const rolling = rollingPastOut();
  rolling.state.time = 15.05; // 다음 프레임 전에 영상이 그만큼 갔다 — 아웃 뒤다
  frame(16);
  expect(playback.view.playing).toBe(false);
  expect(playback.now()).toBe(3);
});

it("아웃 뒤에서 돌다 끝난 영상(ended)도 세지 않는다 — 프레임이 보기 전에 끝나도 그 시간은 이 바퀴의 것이 아니다", () => {
  const rolling = rollingPastOut();
  rolling.state.time = 15.5; // 다음 프레임 전에 영상이 실제 끝까지 갔다
  rolling.emit("ended"); // 그 클립의 끝(16초)으로 넘긴다
  frame(16);
  expect(playback.view.playing).toBe(false);
  expect(playback.now()).toBe(3);
});

// 영상의 도착이 늘 프레임 사이에 오게 한다 — 프레임 동안은 탐색 중으로 두고, 돌려준 함수를 부를 때만 풀어 도착을 알린다.
//  넘기는 것이 프레임 밖(이벤트)에서 일어나고, 다음 프레임은 넘긴 자리에서 한 걸음 간다(되돌아간 자리에서 곧바로 넘기지 않는다).
const lateArrival = (videos: ReturnType<typeof shortVideo>[]) => {
  const hold = (seeking: boolean) => videos.forEach((video) => { video.state.seeking = seeking; });
  hold(true);
  return () => {
    hold(false);
    for (const video of videos) {
      video.emit("loadedmetadata");
      video.emit("seeked");
    }
    hold(true);
  };
};

it("걸음보다 앞에 있는 그림 조각은 세지 않는다 — 같은 컷의 앞쪽에 그림이 있어도, 구간 안에 틀 것이 없으면 멈춘다", () => {
  const at = world([
    { cut: "e070/c1", gen: "v", track: 1, dur: 5, kind: "video" }, // 아래: 영상(적힌 5초 · 실제 2초)
    { cut: "e070/c1", gen: "pic", track: 2, dur: 1, kind: "image" }, // 위: 그림 1초 — 구간(3~5초)보다 앞에서 끝난다
  ], ["e070/c1"]);
  const range = { from: 3, to: 5 }; // 영상의 실제 끝 뒤뿐이다
  const { front, spare } = mountEngine(at, 2, 2, range);
  const arrive = lateArrival([front, spare]);
  act(() => playback.playRange(range));
  for (let i = 0; i < 4; i++) {
    arrive(); // 영상 도착 — 실제 끝 뒤라 넘긴다(5초로)
    frame(16);
  }
  expect(playback.view.playing).toBe(false);
  expect(playback.now()).toBe(3);
});

// 아웃을 넘었는지는 타임라인 시각(컷의 시작 + 컷 안 시각)으로 본다 — 되돌아가기 판정과 같은 식이다. 컷 안 시각으로 빼서 자르면
//  (아웃 − 컷의 시작) 끝자리 오차만큼 아웃 뒤가 샌다: 아웃이 클립의 끝과 같은 자리일 때, 그 뒤의 그림이 오차만큼 '흐른' 것이 된다.
it("아웃이 영상 클립의 끝(편집점)과 같은 자리면 그 뒤의 그림은 세지 않는다 — 끝자리 오차만큼도 새지 않는다", () => {
  const at = world([
    { cut: "e070/c1", gen: "lead", track: 1, dur: 1 / EDIT_FPS, kind: "video" }, // c1 은 한 프레임 — c2 가 1/24초에서 시작한다
    { cut: "e070/c2", gen: "pic", track: 1, dur: 5, kind: "image" }, // c2 아래: 그림
    { cut: "e070/c2", gen: "v", track: 2, dur: 2 / EDIT_FPS, kind: "video" }, // c2 위: 영상 두 프레임(실제 길이 0초 — 틀 것이 없다)
  ], ["e070/c1", "e070/c2"]);
  const from = at.layout.cuts[1].start;
  const range = { from, to: from + 2 / EDIT_FPS }; // c2 의 처음 ~ 위 영상의 끝
  expect(range.to - from).toBeGreaterThan(2 / EDIT_FPS); // 이 숫자에서는 (아웃 − 컷의 시작)이 클립 길이보다 끝자리 하나만큼 크다
  const { front, spare } = mountEngine(at, 0, 0, range);
  const arrive = lateArrival([front, spare]);
  act(() => playback.playRange(range));
  for (let i = 0; i < 4; i++) {
    arrive(); // 영상 도착 — 실제 길이가 0초라 넘긴다(아웃과 같은 자리로)
    frame(16); // 그 자리에서 한 걸음 — 아웃 뒤다
  }
  expect(playback.view.playing).toBe(false);
  expect(playback.now()).toBe(from);
});

// 클립을 넘긴 표시가 멈춘 뒤에도 남아 있으면, 다시 재생한 첫 걸음(rAF)을 '넘긴 직후'로 보고 세지 않는다.
it("구간 반복(그림): 넘기고 멈춘 뒤 다시 재생해도 첫 걸음을 센다 — 한 걸음에 도는 짧은 구간이 빈 바퀴로 멈추지 않는다", () => {
  const range = { from: 6, to: 6.09 }; // c2(그림) 안의 두 프레임 남짓
  const { front: video } = mountEngine(TWO, 2, 2, range);
  act(() => playback.seek(4)); // c1 의 실제 끝 뒤
  video.emit("seeked");
  act(() => playback.toggle()); // 그 클립을 넘긴다
  act(() => playback.stop());
  act(() => playback.playRange(range));
  for (let i = 0; i < 4; i++) frame(100); // 한 프레임이 길다 — 한 걸음에 아웃을 넘는다
  expect(playback.view.playing).toBe(true);
});

// 격리 브라우저 실측(2026-10-11): 구간 반복 중 가끔 한 프레임 동안 재생헤드가 아웃 너머 그 클립의 끝을 가리키고 판의 영상이 가려졌다.
//  영상이 실제 끝에 닿은 것을 ended 이벤트보다 프레임이 먼저 보면, 그 프레임이 클립을 넘긴 자리를 그리고 다음 프레임에야 되돌아갔다.
it("구간 반복: 영상이 실제 끝에 닿은 것을 프레임이 먼저 봐도(ended 전) 아웃 너머를 그리지 않는다 — 같은 프레임에 인으로 돌아간다", () => {
  const range = { from: 3, to: 4 };
  const { front: video } = mountEngine(TWO, 3.085, 3.085, range);
  act(() => playback.playRange(range));
  for (let lap = 0; lap < 3; lap++) {
    video.emit("seeked"); // 인에 닿았다 — 튼다
    video.state.time = 3.085; // 실제 끝. 브라우저가 세웠지만 ended 는 아직 오지 않았다
    video.state.paused = true;
    painted = [];
    frame(16);
    expect(painted).toEqual([3]); // 그 클립의 끝(5초)을 그리지 않는다 — 인만 그렸다
    expect(playback.view.clip?.gen).toBe("v"); // 보이는 클립이 비지 않는다(비면 판의 영상이 가려지고 표에서 트랙이 빠진다)
    expect(playback.view.playing).toBe(true);
    expect(playback.now()).toBe(3);
  }
});

it("전체 반복도 같다 — 실제 끝에 닿은 프레임이 전체 끝을 그리지 않고 곧바로 처음으로 돌아간다", () => {
  const { front: video } = mountEngine(ONE, 3.085, 3.085, null, true);
  act(() => playback.toggle());
  for (let lap = 0; lap < 3; lap++) {
    video.state.time = 3.085;
    video.state.paused = true;
    painted = [];
    frame(16);
    expect(painted).toEqual([0]); // 전체 끝(5초)을 그리지 않는다
    expect(playback.view.clip?.gen).toBe("v");
    expect(playback.view.playing).toBe(true);
    video.emit("seeked"); // 처음에 닿았다 — 튼다
  }
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
  // 받기 전에 그 자리를 처음 자리로 적는 한 번(2026-10-26 — 탐색이 아니다: 받는 대로 그리로 간다. 이 가짜는 그것도 센다)
  const atLoad = video.state.seeks;
  expect(atLoad).toBeLessThanOrEqual(1);
  video.emit("loadedmetadata");
  for (let i = 0; i < 10; i++) {
    time += 0.016;
    frame(16);
  }
  expect(video.state.plays).toBe(0);
  expect(video.state.seeks).toBe(atLoad);
});
