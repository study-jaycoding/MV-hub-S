// 영상 길이를 메타데이터만 받아 잰다 — 주소별로 한 번(성공한 것만 기억 · video.duration 으로 잰 것은 1분 뒤 그림 길이를 다시 묻는다), 동시에 4개까지.
//  길이는 **그림 트랙**의 길이다(2026-10-14): 서버가 파일 머리(moov)에서 프레임 수를 읽는다. video.duration 은 소리까지 친 파일
//  길이라 Seedance 원본에서 그림보다 약 1프레임 길었고, 그 길이로 넣은 클립이 Resolve 의 원본보다 길어 타임라인 만들기가 막혔다.
//  서버가 못 읽으면(옛 서버·분할 MP4 등) 예전처럼 video.duration 을 쓴다. 어느 쪽이든 편집 눈금(24fps)의 프레임으로 **내린다**.
import { EDIT_FPS } from "./editTimeline";

const known = new Map<string, number>();
const exact = new Set<string>(); // 서버가 읽은 그림 길이로 잰 주소 — 나머지(성공한 것)는 video.duration 으로 쟀다
// video.duration 으로 잰 주소 → 잰 때. RETRY_MS 가 지나 다시 물으면 그림 길이만 다시 묻는다(영상은 다시 받지 않는다) — 서버가
//  잠깐 못 읽었거나 옛 서버를 새로 켠 뒤에도 새로 고칠 때까지 소리까지 친 길이로 굳어 있었다(Codex 37회차).
const guessedAt = new Map<string, number>();
const RETRY_MS = 60000;
const inflight = new Map<string, Promise<number | null>>();
const queue: { url: string; run: () => void; drop: () => void }[] = [];
let active = 0;
const LIMIT = 4;
const TIMEOUT_MS = 20000;

export function knownVideoSeconds(url: string | null | undefined): number | null {
  return (url && known.get(url)) || null;
}

// 잰 길이가 그림 길이인가(서버가 읽었다). 아니면 소리까지 친 길이일 수 있어 그림 길이보다 1프레임쯤 길다 — 그 값으로 다른 창이
//  그림 길이로 적은 것을 덮으면 두 창이 서로 고쳐 쓴다(Codex 코드 리뷰 P1). 편집 탭이 덮을지 정할 때 본다.
export function measuredExactly(url: string): boolean {
  return exact.has(url);
}

// 원본을 넘지 않는 프레임 수로 내린다(올리면 원본에 없는 프레임을 쓴다). 한 프레임도 안 되면 그대로.
const wholeFrames = (seconds: number) => Math.floor(seconds * EDIT_FPS + 1e-6) / EDIT_FPS || seconds;

async function pictureSeconds(url: string): Promise<number | null> {
  const stop = new AbortController();
  const timer = window.setTimeout(() => stop.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`/api/media-picture?src=${encodeURIComponent(url)}`, { signal: stop.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { frames?: unknown; fps?: unknown };
    const seconds = Number(body.frames) / Number(body.fps);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

async function probe(url: string): Promise<number | null> {
  const picture = await pictureSeconds(url);
  if (picture) {
    exact.add(url);
    guessedAt.delete(url);
    return wholeFrames(picture);
  }
  const seconds = known.get(url) ?? (await probeVideo(url)); // 다시 묻는 길이면 전에 잰 값 그대로
  if (seconds) guessedAt.set(url, Date.now());
  return seconds ? wholeFrames(seconds) : null;
}

function probeVideo(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    let timer = 0;
    const done = (seconds: number | null) => {
      window.clearTimeout(timer);
      video.onloadedmetadata = video.onerror = null;
      video.removeAttribute("src");
      video.load(); // 받던 것을 놓는다
      resolve(seconds);
    };
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => done(Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null);
    video.onerror = () => done(null);
    timer = window.setTimeout(() => done(null), TIMEOUT_MS);
    video.src = url;
  });
}

// first = 줄의 맨 앞에 선다 — 소스 판이 방금 띄운 영상. 타임라인이 한꺼번에 줄 세운 클립들 뒤로 밀리면 그동안 기본 길이로
//  끝났다(Codex 37회차). 이미 줄 서 있던 주소면 그 자리를 앞으로 옮긴다.
export function measureVideoSeconds(url: string, first = false): Promise<number | null> {
  const cached = known.get(url);
  if (cached && (exact.has(url) || Date.now() - (guessedAt.get(url) ?? 0) < RETRY_MS)) return Promise.resolve(cached);
  const pending = inflight.get(url);
  if (pending) {
    const at = first ? queue.findIndex((item) => item.url === url) : -1;
    if (at > 0) queue.unshift(...queue.splice(at, 1));
    return pending;
  }
  const started = new Promise<number | null>((resolve) => {
    const run = () => {
      void probe(url).then((seconds) => {
        // 자리를 줄 선 다음 것에 그대로 넘긴다(없으면 비운다) — 넘기는 사이 다른 요청이 끼어들지 못한다.
        const next = queue.shift();
        if (next) next.run();
        else active--;
        inflight.delete(url);
        if (seconds) known.set(url, seconds);
        resolve(seconds);
      });
    };
    // 자리는 여기서 바로 잡는다 — 나중(마이크로태스크)에 세면 같은 루프의 요청이 전부 통과한다.
    if (active < LIMIT) {
      active++;
      run();
    } else {
      const item = { url, run, drop: () => { inflight.delete(url); resolve(null); } };
      if (first) queue.unshift(item);
      else queue.push(item);
    }
  });
  inflight.set(url, started);
  return started;
}

// 줄 서 있던 것(아직 시작 안 한 것)을 버린다 — 화면을 떠날 때. 이미 받는 중인 것(최대 4개)은 끝까지 간다.
export function dropQueuedVideoMeasures(): void {
  for (const item of queue.splice(0)) item.drop();
}
