// @vitest-environment jsdom
// 영상 길이 재기 — 동시에 4개까지만 받고, 화면을 떠나면 줄 서 있던 것은 버린다.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dropQueuedVideoMeasures, measureVideoSeconds } from "../src/lib/videoDuration";

let videos: HTMLVideoElement[] = [];
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
// 메타데이터가 왔다 — jsdom 의 duration 은 NaN 이라 '길이 모름(null)'로 끝난다(자리만 비운다).
const finish = (video: HTMLVideoElement) => video.onloadedmetadata?.(new Event("loadedmetadata"));

beforeEach(() => {
  videos = [];
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
