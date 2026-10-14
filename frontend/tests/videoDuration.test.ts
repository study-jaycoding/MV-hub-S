// @vitest-environment jsdom
// 영상 길이 재기 — 동시에 4개까지만 받고, 화면을 떠나면 줄 서 있던 것은 버린다.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dropQueuedVideoMeasures, measureVideoSeconds } from "../src/lib/videoDuration";

let videos: HTMLVideoElement[] = [];
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
// 메타데이터가 왔다 — jsdom 의 duration 은 NaN 이라 '길이 모름(null)'로 끝난다(자리만 비운다).
const finish = (video: HTMLVideoElement) => video.onloadedmetadata?.(new Event("loadedmetadata"));

// 서버의 그림 길이(/api/media-picture) — 시험마다 답을 정한다. 기본은 옛 서버(404 — 그 길이 없음)
let picture: (url: string) => Response = () => new Response("", { status: 404 });
const asked: string[] = [];

beforeEach(() => {
  videos = [];
  asked.length = 0;
  picture = () => new Response("", { status: 404 });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    asked.push(url);
    return picture(url);
  }));
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  const create = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    const element = create(tag);
    if (tag === "video") videos.push(element as HTMLVideoElement);
    return element;
  }) as typeof document.createElement);
});
afterEach(async () => {
  dropQueuedVideoMeasures();
  videos.forEach(finish); // 받던 것을 끝내 다음 시험에 자리가 남지 않게
  await settle();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// 2026-10-14 — video.duration 은 소리까지 친 파일 길이라 Seedance 원본(그림 97프레임, 소리 4.087초)에서 클립이 그림보다 길게 적혔다.
it("서버가 읽은 그림 길이를 쓴다 — 영상 요소를 만들지 않고, 편집 눈금(24fps)의 프레임으로 내린다", async () => {
  picture = (url) => new Response(JSON.stringify(url.includes("c30") ? { frames: 121, fps: 30 } : { frames: 97, fps: 24 }));
  expect(await measureVideoSeconds("/media/c24.mp4")).toBe(97 / 24);
  expect(await measureVideoSeconds("https://cdn.example/c30.mp4")).toBe(96 / 24); // 4.0333초 = 96.8프레임 → 96
  expect(videos).toHaveLength(0);
  expect(asked).toEqual(["/api/media-picture?src=%2Fmedia%2Fc24.mp4", "/api/media-picture?src=https%3A%2F%2Fcdn.example%2Fc30.mp4"]);
});

it("서버가 못 읽으면(옛 서버·분할 MP4·이상한 답) 예전처럼 video.duration 을 쓰되 프레임으로 내린다", async () => {
  picture = (url) => (url.includes("odd") ? new Response(JSON.stringify({ frames: 0, fps: 24 })) : new Response("", { status: 422 }));
  for (const name of ["old", "odd"]) {
    const result = measureVideoSeconds(`/media/${name}.mp4`);
    await settle();
    const video = videos[videos.length - 1];
    Object.defineProperty(video, "duration", { value: 4.087 });
    finish(video);
    expect(await result).toBe(98 / 24); // 98.09프레임 → 98
  }
  expect(videos).toHaveLength(2);
});

// Codex 37회차 — 서버가 잠깐 못 읽었거나 옛 서버를 새로 켠 뒤에도 새로 고칠 때까지 소리까지 친 길이로 굳어 있었다.
it("video.duration 으로 잰 것은 1분 뒤 다시 물으면 그림 길이만 다시 묻는다 — 영상은 다시 받지 않는다", async () => {
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const first = measureVideoSeconds("/media/retry.mp4");
  await settle();
  Object.defineProperty(videos[0], "duration", { value: 4.087 });
  finish(videos[0]);
  expect(await first).toBe(98 / 24);
  now += 30_000;
  expect(await measureVideoSeconds("/media/retry.mp4")).toBe(98 / 24); // 1분 안 — 묻지 않는다
  expect(asked).toHaveLength(1);
  now += 31_000;
  expect(await measureVideoSeconds("/media/retry.mp4")).toBe(98 / 24); // 서버가 아직 못 읽으면 전에 잰 값 그대로
  expect([asked.length, videos.length]).toEqual([2, 1]);
  now += 61_000;
  picture = () => new Response(JSON.stringify({ frames: 97, fps: 24 })); // 새 서버
  expect(await measureVideoSeconds("/media/retry.mp4")).toBe(97 / 24);
  now += 600_000;
  expect(await measureVideoSeconds("/media/retry.mp4")).toBe(97 / 24); // 그림 길이는 다시 묻지 않는다
  expect([asked.length, videos.length]).toEqual([3, 1]);
});

it("한꺼번에 스무 개를 물어도 동시에 받는 것은 4개 — 하나가 끝나야 다음이 시작한다", async () => {
  const results = Array.from({ length: 20 }, (_, i) => measureVideoSeconds(`/v/a${i}.mp4`));
  await settle();
  expect(videos).toHaveLength(4);
  finish(videos[0]);
  await settle();
  expect(videos).toHaveLength(5);
  expect(await results[0]).toBeNull();
  expect(measureVideoSeconds("/v/a5.mp4")).toBe(results[5]); // 같은 주소는 받는 중인 것에 합류한다
});

// Codex 37회차 — 소스 판이 방금 띄운 영상이 타임라인이 한꺼번에 줄 세운 클립들 뒤로 밀렸다.
it("first = 줄의 맨 앞에 선다 — 이미 줄 서 있던 주소면 그 자리를 앞으로 옮긴다", async () => {
  const backlog = Array.from({ length: 8 }, (_, i) => measureVideoSeconds(`/v/q${i}.mp4`));
  await settle();
  expect(videos).toHaveLength(4); // q0~q3 받는 중 · q4~q7 줄
  const src = measureVideoSeconds("/v/src.mp4", true);
  expect(measureVideoSeconds("/v/q6.mp4", true)).toBe(backlog[6]); // 줄 서 있던 q6 도 앞으로
  finish(videos[0]);
  await settle();
  finish(videos[1]);
  await settle();
  expect(videos.slice(4).map((video) => video.getAttribute("src"))).toEqual(["/v/q6.mp4", "/v/src.mp4"]);
  videos.slice(2).forEach(finish);
  await settle();
  expect(await src).toBeNull();
});

it("화면을 떠나면 줄 서 있던 것은 버리고, 받던 것만 끝까지 간다", async () => {
  const results = Array.from({ length: 10 }, (_, i) => measureVideoSeconds(`/v/b${i}.mp4`));
  await settle();
  expect(videos).toHaveLength(4);
  dropQueuedVideoMeasures();
  expect(await results[9]).toBeNull();
  videos.forEach(finish);
  await settle();
  expect(videos).toHaveLength(4); // 버린 것은 시작하지 않는다
  const again = measureVideoSeconds("/v/b9.mp4"); // 버린 주소는 다시 물을 수 있다
  await settle();
  expect(videos).toHaveLength(5);
  finish(videos[4]);
  expect(await again).toBeNull();
});
