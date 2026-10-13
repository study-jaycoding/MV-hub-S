// 영상 길이를 메타데이터만 받아 잰다 — 주소별로 한 번(성공한 것만 기억), 동시에 4개까지.
const known = new Map<string, number>();
const inflight = new Map<string, Promise<number | null>>();
const queue: { run: () => void; drop: () => void }[] = [];
let active = 0;
const LIMIT = 4;
const TIMEOUT_MS = 20000;

export function knownVideoSeconds(url: string | null | undefined): number | null {
  return (url && known.get(url)) || null;
}

function probe(url: string): Promise<number | null> {
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

export function measureVideoSeconds(url: string): Promise<number | null> {
  const cached = known.get(url);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(url);
  if (pending) return pending;
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
      queue.push({ run, drop: () => { inflight.delete(url); resolve(null); } });
    }
  });
  inflight.set(url, started);
  return started;
}

// 줄 서 있던 것(아직 시작 안 한 것)을 버린다 — 화면을 떠날 때. 이미 받는 중인 것(최대 4개)은 끝까지 간다.
export function dropQueuedVideoMeasures(): void {
  for (const item of queue.splice(0)) item.drop();
}
