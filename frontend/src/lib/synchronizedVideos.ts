// 비교 모달의 영상 재생·정지·종료·탐색 동기화. React와 분리해 두 모달이 같은 규칙을 쓰고,
// 프로그램적으로 발생한 seek/play/pause 이벤트의 피드백 루프를 순수 DOM 경계에서 차단한다.

export interface SynchronizableVideo extends EventTarget {
  readonly paused: boolean;
  readonly ended: boolean;
  readonly duration: number;
  currentTime: number;
  play(): Promise<void>;
  pause(): void;
}

export const VIDEO_SEEK_TOLERANCE_SECONDS = 0.04;

export function synchronizedVideoTime(sourceTime: number, targetDuration: number): number | null {
  if (!Number.isFinite(sourceTime)) return null;
  if (!Number.isFinite(targetDuration) || targetDuration <= 0) return null;
  return Math.min(Math.max(0, sourceTime), targetDuration);
}

export function bindSynchronizedVideos(
  inputVideos: SynchronizableVideo[],
  options: { autoPlay?: boolean } = {},
): () => void {
  const videos = [...new Set(inputVideos)];
  if (!videos.length) return () => {};

  const ignoredPlayback = new Set<SynchronizableVideo>();
  const expectedSeeks = new Map<SynchronizableVideo, number>();
  const pendingSeeks = new Map<SynchronizableVideo, number>();
  const seekTimers = new Map<SynchronizableVideo, ReturnType<typeof setTimeout>>();
  let restarting = false;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;

  const clearExpectedSeek = (video: SynchronizableVideo) => {
    expectedSeeks.delete(video);
    const timer = seekTimers.get(video);
    if (timer !== undefined) clearTimeout(timer);
    seekTimers.delete(video);
  };

  const setVideoTime = (video: SynchronizableVideo, sourceTime: number) => {
    const target = synchronizedVideoTime(sourceTime, video.duration);
    if (target == null) {
      pendingSeeks.set(video, sourceTime);
      return;
    }
    pendingSeeks.delete(video);
    if (Math.abs(video.currentTime - target) <= VIDEO_SEEK_TOLERANCE_SECONDS) return;
    clearExpectedSeek(video);
    expectedSeeks.set(video, target);
    seekTimers.set(
      video,
      setTimeout(() => clearExpectedSeek(video), 1000),
    );
    try {
      video.currentTime = target;
    } catch {
      clearExpectedSeek(video);
    }
  };

  const playAll = (except?: SynchronizableVideo, includeEnded = false) =>
    videos.forEach((video) => {
      // 짧은 영상이 마지막 프레임에서 기다리는 중이면 긴 영상이 끝날 때까지 다시 시작하지 않는다.
      if (video !== except && video.paused && (includeEnded || !video.ended)) {
        ignoredPlayback.add(video);
        video.play().catch(() => ignoredPlayback.delete(video));
      }
    });

  const pauseAll = (except?: SynchronizableVideo) =>
    videos.forEach((video) => {
      if (video !== except && !video.paused) {
        ignoredPlayback.add(video);
        video.pause();
      }
    });

  const onPlay = (event: Event) => {
    const source = event.target as SynchronizableVideo;
    if (ignoredPlayback.delete(source)) return;
    playAll(source);
  };

  const onPause = (event: Event) => {
    const source = event.target as SynchronizableVideo;
    if (ignoredPlayback.delete(source)) return;
    if (source.ended) return;
    pauseAll(source);
  };

  const onSeeked = (event: Event) => {
    const source = event.target as SynchronizableVideo;
    const expected = expectedSeeks.get(source);
    if (expected !== undefined) {
      clearExpectedSeek(source);
      if (Math.abs(source.currentTime - expected) <= VIDEO_SEEK_TOLERANCE_SECONDS) return;
      // 사용자가 프로그램적 이동을 중간에 덮었다면 현재 사용자 위치를 다른 영상에 전파한다.
    }
    videos.forEach((video) => {
      if (video !== source) setVideoTime(video, source.currentTime);
    });
  };

  const onLoadedMetadata = (event: Event) => {
    const video = event.target as SynchronizableVideo;
    const pending = pendingSeeks.get(video);
    if (pending !== undefined) setVideoTime(video, pending);
  };

  const onEnded = (event: Event) => {
    if (restarting) return;
    const source = event.target as SynchronizableVideo;
    const maxDuration = Math.max(...videos.map((video) => video.duration || 0));
    if ((source.duration || 0) < maxDuration - 0.05 && !videos.every((video) => video.ended)) {
      return;
    }
    restarting = true;
    videos.forEach((video) => setVideoTime(video, 0));
    playAll(undefined, true);
    restartTimer = setTimeout(() => {
      restarting = false;
      restartTimer = undefined;
    }, 120);
  };

  videos.forEach((video) => {
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("ended", onEnded);
  });
  if (options.autoPlay !== false) playAll();

  return () => {
    if (restartTimer !== undefined) clearTimeout(restartTimer);
    for (const timer of seekTimers.values()) clearTimeout(timer);
    seekTimers.clear();
    expectedSeeks.clear();
    pendingSeeks.clear();
    videos.forEach((video) => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("ended", onEnded);
    });
  };
}
