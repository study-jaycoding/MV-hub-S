import { describe, expect, it } from "vitest";
import {
  bindSynchronizedVideos,
  synchronizedVideoTime,
  type SynchronizableVideo,
} from "../src/lib/synchronizedVideos";

class FakeVideo extends EventTarget implements SynchronizableVideo {
  paused = true;
  ended = false;
  duration: number;
  private time = 0;
  seekAssignments = 0;

  constructor(duration: number) {
    super();
    this.duration = duration;
  }

  get currentTime() {
    return this.time;
  }

  set currentTime(value: number) {
    this.time = value;
    this.ended = Number.isFinite(this.duration) && value >= this.duration;
    this.seekAssignments++;
    this.dispatchEvent(new Event("seeked"));
  }

  play(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    this.paused = false;
    this.ended = false;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }

  userSeek(value: number) {
    this.time = value;
    this.ended = Number.isFinite(this.duration) && value >= this.duration;
    this.dispatchEvent(new Event("seeked"));
  }

  finish() {
    this.time = this.duration;
    this.paused = true;
    this.ended = true;
    this.dispatchEvent(new Event("ended"));
  }

  loadDuration(value: number) {
    this.duration = value;
    this.dispatchEvent(new Event("loadedmetadata"));
  }
}

describe("synchronizedVideos", () => {
  it("상대 영상 길이를 넘지 않는 같은 초 위치로 제한한다", () => {
    expect(synchronizedVideoTime(6, 10)).toBe(6);
    expect(synchronizedVideoTime(6, 4)).toBe(4);
    expect(synchronizedVideoTime(-2, 4)).toBe(0);
    expect(synchronizedVideoTime(2, Number.NaN)).toBeNull();
  });

  it("사용자 seek를 다른 영상에 한 번만 전파하고 프로그램적 seek 피드백을 막는다", () => {
    const source = new FakeVideo(10);
    const short = new FakeVideo(4);
    const cleanup = bindSynchronizedVideos([source, short], { autoPlay: false });

    source.userSeek(6);

    expect(source.currentTime).toBe(6);
    expect(short.currentTime).toBe(4);
    expect(short.seekAssignments).toBe(1);
    expect(source.seekAssignments).toBe(0);
    cleanup();
  });

  it("메타데이터가 늦은 영상은 길이를 안 뒤 대기 중인 seek를 적용한다", () => {
    const source = new FakeVideo(10);
    const pending = new FakeVideo(Number.NaN);
    const cleanup = bindSynchronizedVideos([source, pending], { autoPlay: false });

    source.userSeek(7);
    expect(pending.currentTime).toBe(0);
    pending.loadDuration(5);
    expect(pending.currentTime).toBe(5);
    cleanup();
  });

  it("재생·정지 동기화를 유지하고 cleanup 뒤에는 이벤트를 전파하지 않는다", async () => {
    const left = new FakeVideo(10);
    const right = new FakeVideo(10);
    const cleanup = bindSynchronizedVideos([left, right], { autoPlay: false });

    await left.play();
    expect(right.paused).toBe(false);
    left.pause();
    expect(right.paused).toBe(true);

    cleanup();
    left.userSeek(3);
    expect(right.currentTime).toBe(0);
  });

  it("가장 긴 영상 종료 시 짧은 영상까지 0초로 되감아 다시 재생한다", () => {
    const short = new FakeVideo(4);
    const longest = new FakeVideo(10);
    const cleanup = bindSynchronizedVideos([short, longest], { autoPlay: false });
    short.finish();
    expect(short.ended).toBe(true); // 긴 영상은 아직 남아 있으므로 마지막 프레임에서 대기

    longest.finish();

    expect(short.currentTime).toBe(0);
    expect(longest.currentTime).toBe(0);
    expect(short.paused).toBe(false);
    expect(longest.paused).toBe(false);
    cleanup();
  });
});
