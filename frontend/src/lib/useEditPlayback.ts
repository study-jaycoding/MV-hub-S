// 편집 탭의 재생 — 컷 순서대로, 위 트랙 우선으로 `<video>` 하나를 갈아 끼우며 이어 튼다. 계약은 docs/EDIT_TAB.md.
//  · 위치의 원천은 ref 하나((컷 경로, 컷 안 시각)). 프레임마다 고치는 것은 paint(재생헤드·타임코드)뿐이고,
//    React 에는 '보이는 것·재생 상태'가 바뀔 때만 알린다.
//  · 시계 주인은 항상 하나: 보이는 클립이 영상이고 정방향 재생이면 영상(받는 중·버퍼링이면 시간도 선다), 그 밖에는 rAF.
//  · '보이는 소스가 바뀜'은 컷이 바뀌는 것과 별개 사건 — 같은 컷에서 위 클립이 끝나 아래가 드러날 때도 일어난다.
// ponytail: 다음 클립을 미리 받지 않는다 — 컷이 넘어갈 때 받는 시간만큼 선다. 거슬리면 영상 둘을 교대로 쓴다.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  clipKey,
  EDIT_FPS,
  editPoints,
  posAt,
  settlePos,
  stepPoint,
  timeOf,
  visibleClip,
  type EditDoc,
  type EditLayout,
  type EditPos,
  type MediaState,
  type SlotClip,
} from "./editTimeline";

// 훅이 쓰는 `<video>` 의 부분 — 시험에서 가짜로 갈아 끼울 수 있게 좁혀 둔다.
export interface EditVideo {
  src: string;
  currentTime: number;
  playbackRate: number;
  readonly paused: boolean;
  readonly seeking: boolean;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface EditSource {
  state: MediaState;
  url: string | null;
  type: "video" | "image" | null;
  thumb: string | null;
}

export interface EditView {
  cut: string | null; // 재생헤드가 있는 컷
  clip: SlotClip | null; // 지금 보이는 클립(없으면 빈 화면)
  source: EditSource | null;
  playing: boolean;
  rate: number; // 음수 = 역방향
  failed: boolean; // 이 영상을 재생하지 못했다 — 썸네일 정지화면으로 넘어간다
}

// 시퀀스별 마지막 재생헤드 자리 — 다른 탭에 다녀와도 보던 자리로 돌아온다(새로고침하면 사라진다).
const lastPos = new Map<string, EditPos>();

const STOPPED: EditView = { cut: null, clip: null, source: null, playing: false, rate: 1, failed: false };
const SEEK_SLOP = 0.04;

export function useEditPlayback({
  scope,
  layout,
  doc,
  sourceOf,
  videoRef,
  paint,
  loop = false,
}: {
  scope: string; // 시퀀스(문서) — 바뀌면 위치를 처음으로 돌린다(옛 시퀀스의 컷 이름으로 새 자리를 짐작하지 않는다)
  layout: EditLayout;
  doc: EditDoc;
  sourceOf: (clip: SlotClip) => EditSource; // 값이 같으면 같은 함수여야 한다(useCallback)
  videoRef: RefObject<EditVideo | null>;
  paint: (time: number) => void;
  loop?: boolean; // 반복 — 정방향으로 끝에 닿으면 처음부터 이어 튼다(역방향은 처음에서 멈춘다)
}) {
  const [view, setView] = useState<EditView>(STOPPED);
  const live = useRef({ layout, doc, sourceOf, paint, loop });
  live.current = { layout, doc, sourceOf, paint, loop };
  const pos = useRef<EditPos | null>(null);
  const run = useRef({
    playing: false,
    rate: 1,
    owner: "raf" as "raf" | "video",
    token: 0, // 소스를 갈거나 다시 탐색할 때마다 오른다 — 늦게 온 영상 이벤트를 버리는 기준
    arrived: -1, // 영상이 목표 위치까지 온 token. token 과 같아야 영상이 시계를 맡는다
    loaded: false, // 지금 소스의 메타데이터를 받았다(그 전에는 탐색하지 않는다 — loadedmetadata 가 최신 목표로 보낸다)
    shown: "", // 지금 올려 둔 소스의 열쇠(클립 열쇠 + 주소). 빈 문자열 = 영상 없음
    failed: new Set<string>(), // 재생하지 못한 클립 열쇠
    frame: 0,
    last: 0,
  });

  const published = useRef<EditView>(STOPPED);
  const scoped = useRef(scope);
  // 돌아갈 자리 — 그 컷이 배치에 나타나면 한 번 옮긴다. 그 전에 사용자가 위치를 옮기면 버린다.
  const wanted = useRef<EditPos | null>(lastPos.get(scope) ?? null);

  // 아래 함수들은 ref 만 읽는다 — 한 번 만든 것을 계속 써도 낡지 않는다.
  const api = useRef<ReturnType<typeof build> | null>(null);
  function build() {
    const state = run.current;
    const slotOf = (cut: string | undefined) => live.current.layout.cuts.find((slot) => slot.path === cut) ?? null;
    const now = () => timeOf(live.current.layout, pos.current);
    const visible = () => {
      const slot = slotOf(pos.current?.cut);
      const clip = slot && pos.current ? visibleClip(live.current.doc, slot, pos.current.local) : null;
      return { slot, clip, source: clip ? live.current.sourceOf(clip) : null };
    };

    const publish = () => {
      const { slot, clip, source } = visible();
      const next: EditView = {
        cut: slot?.path ?? null, clip, source, playing: state.playing, rate: state.rate,
        failed: !!clip && state.failed.has(clipKey(clip)),
      };
      const prev = published.current; // 프레임마다 불리므로 같으면 React 를 건드리지 않는다
      if (prev.cut === next.cut && prev.clip?.gen === next.clip?.gen && prev.clip?.track === next.clip?.track &&
        prev.source?.url === next.source?.url && prev.source?.state === next.source?.state &&
        prev.playing === next.playing && prev.rate === next.rate && prev.failed === next.failed) return;
      published.current = next;
      setView(next);
    };

    const startVideo = () => {
      const token = state.token;
      videoRef.current?.play().catch((error: unknown) => {
        // 그 사이 소스가 갈렸거나 우리가 멈춘 것(AbortError)은 실패가 아니다.
        if (token !== state.token || !state.playing || (error as { name?: string } | null)?.name === "AbortError") return;
        fail(token);
      });
    };

    // 이 영상은 재생하지 못한다 — 썸네일 정지화면으로 두고 rAF 시계로 길이만큼 지나간다.
    const fail = (token: number) => {
      if (token !== state.token || !state.shown) return;
      state.failed.add(state.shown.slice(0, state.shown.lastIndexOf("\n")));
      sync(false);
    };

    // 보이는 소스를 지금 위치에 맞춘다 — 바뀌었으면 갈아 끼우고, 같으면 필요할 때만 탐색한다.
    // jump = 사용자가 위치를 옮겼다(영상이 시계여도 그 위치로 보낸다).
    const sync = (jump: boolean) => {
      const video = videoRef.current;
      const { clip, source } = visible();
      const key = clip ? clipKey(clip) : "";
      const playable = !!clip && source?.state === "ok" && source.type === "video" && !!source.url && !state.failed.has(key);
      const shown = playable ? `${key}\n${source!.url}` : "";
      const owner = playable && state.playing && state.rate > 0 ? "video" : "raf";
      if (owner !== state.owner) {
        state.owner = owner;
        state.last = performance.now(); // 주인이 바뀌는 순간 기준을 다시 잡는다
      }
      if (video && shown !== state.shown) {
        state.shown = shown;
        state.token++;
        state.loaded = false;
        video.pause();
        if (playable) video.src = source!.url!;
        else video.removeAttribute("src");
        video.load(); // loadedmetadata → 목표 위치로 탐색 → seeked → (재생 중이면) play
      } else if (video && playable) {
        const local = pos.current!.local;
        const off = Math.abs(video.currentTime - local) > SEEK_SLOP;
        if (jump) {
          // 위치를 옮겼다 — 최신 목표에 닿기 전에는 영상에 시계를 넘기지 않는다. 진행 중이던 옛 탐색의 도착은 믿지 않고,
          // 그것이 끝나면 seeked 처리부가 최신 목표로 다시 보낸 뒤에 도착을 선언한다.
          state.token++;
          if (state.loaded && !video.seeking) {
            if (off) video.currentTime = local;
            else state.arrived = state.token;
          }
        } else if (owner === "raf" && state.arrived === state.token && !video.seeking && off) {
          video.currentTime = local; // 정지·역방향 — 영상을 위치에 맞춘다
        }
        if (owner === "video" && state.arrived === state.token && video.paused) startVideo();
        if (owner === "raf" && !video.paused) video.pause();
      }
      if (video && playable) video.playbackRate = Math.max(1, Math.abs(state.rate));
      publish();
    };

    // adopt=false — 배치가 바뀌어 위치를 방금 보정했다. 영상의 옛 시각으로 그 보정을 덮지 않는다.
    const stop = (adopt = true) => {
      if (!state.playing) return;
      state.playing = false;
      cancelAnimationFrame(state.frame);
      // 영상이 시계였으면 멈춘 그 프레임을 위치로 삼는다(마지막 tick 과 한 프레임 어긋나 다시 탐색하지 않게).
      const video = videoRef.current;
      if (adopt && video && pos.current && state.owner === "video" && state.arrived === state.token) {
        const slot = slotOf(pos.current.cut);
        if (slot) pos.current = { cut: slot.path, local: Math.min(video.currentTime, slot.len) };
      }
      sync(!adopt);
    };

    const tick = (stamp: number) => {
      if (!state.playing || !pos.current) return;
      const { cuts } = live.current.layout;
      let slot = slotOf(pos.current.cut);
      if (!slot) return stop();
      let local = pos.current.local;
      if (state.owner === "video") {
        // 영상이 시계 — 아직 목표 위치에 못 왔거나 버퍼링 중이면 시간도 선다.
        const video = videoRef.current;
        if (video && state.arrived === state.token) local = video.currentTime;
      } else {
        local += (Math.max(0, stamp - state.last) / 1000) * state.rate;
      }
      state.last = stamp;
      if (state.rate > 0 && local >= slot.len) {
        const next = cuts[cuts.indexOf(slot) + 1];
        if (!next && live.current.loop) {
          // 반복 — 처음으로 돌아가 이어 튼다. 위치를 옮긴 것과 같게 다룬다: 영상이 그 자리에 닿을 때까지 시간이 선다
          //  (같은 영상으로 되돌아오는 한 클립짜리도 같은 길 — 끝난 영상의 옛 시각을 시계로 읽지 않는다).
          pos.current = { cut: cuts[0].path, local: 0 };
          sync(true);
          live.current.paint(now());
          state.frame = requestAnimationFrame(tick);
          return;
        }
        if (!next) {
          pos.current = { cut: slot.path, local: slot.len }; // 전체 끝 = 정지점
          live.current.paint(now());
          return stop();
        }
        slot = next;
        local = 0;
      } else if (state.rate < 0 && local < 0) {
        const prev = cuts[cuts.indexOf(slot) - 1];
        if (!prev) {
          pos.current = { cut: slot.path, local: 0 };
          live.current.paint(now());
          return stop();
        }
        slot = prev;
        local = Math.max(0, prev.len - 1 / EDIT_FPS);
      }
      pos.current = { cut: slot.path, local };
      sync(false);
      live.current.paint(now());
      state.frame = requestAnimationFrame(tick);
    };

    const play = (rate: number) => {
      if (!pos.current || !live.current.layout.cuts.length) return;
      wanted.current = null;
      // 끝에서 정방향으로 누르면 처음부터.
      if (rate > 0 && now() >= live.current.layout.total) pos.current = posAt(live.current.layout, 0);
      cancelAnimationFrame(state.frame);
      state.playing = true;
      state.rate = rate;
      state.last = performance.now();
      sync(true);
      state.frame = requestAnimationFrame(tick);
    };

    const seek = (time: number) => {
      wanted.current = null;
      pos.current = posAt(live.current.layout, time);
      sync(true);
      live.current.paint(now());
    };

    // 영상 이벤트 — 올려 둔 소스가 없으면(빈 화면·이미지) 늦게 온 이벤트다.
    const arrive = () => {
      if (!state.shown || state.arrived === state.token) return;
      state.arrived = state.token;
      if (state.playing && state.owner === "video") startVideo();
      publish();
    };
    const onMeta = () => {
      const video = videoRef.current;
      if (!state.shown || !pos.current || !video) return;
      state.loaded = true;
      const target = pos.current.local; // 받는 동안 위치가 또 바뀌었을 수 있다 — 항상 최신 목표로
      if (target > SEEK_SLOP) video.currentTime = target;
      else arrive();
    };
    const onSeeked = () => {
      const video = videoRef.current;
      if (!state.shown || !pos.current || !video) return;
      // 탐색하는 동안 목표가 또 바뀌었으면(끌어서 훑기) 한 번 더 간다. 영상이 시계로 돌고 있을 때는 건드리지 않는다.
      const clock = state.owner === "video" && state.arrived === state.token;
      if (!clock && Math.abs(video.currentTime - pos.current.local) > SEEK_SLOP) video.currentTime = pos.current.local;
      else arrive();
    };
    const onEnded = () => {
      // 적어 둔 길이보다 영상이 먼저 끝났다 — 그 클립의 끝으로 보내 다음으로 넘어가게 한다.
      const { slot, clip } = visible();
      if (state.owner !== "video" || state.arrived !== state.token || !slot || !clip) return;
      pos.current = { cut: slot.path, local: clip.len };
      state.owner = "raf";
      state.last = performance.now();
    };
    const events: [string, () => void][] = [
      ["loadedmetadata", onMeta], ["seeked", onSeeked], ["ended", onEnded], ["error", () => fail(state.token)],
    ];

    return { now, publish, sync, stop, play, seek, events };
  }
  if (!api.current) api.current = build();
  const { now, sync, stop, play, seek, events } = api.current;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    for (const [type, listener] of events) video.addEventListener(type, listener);
    return () => {
      for (const [type, listener] of events) video.removeEventListener(type, listener);
    };
  }, [events, videoRef]);

  // 배치·문서가 바뀌면 위치를 유효한 자리로 맞추고(못 맞추면 정지) 보이는 소스를 다시 고른다 — 넣자마자 보이는 길이 여기다.
  useEffect(() => {
    const fresh = scoped.current !== scope;
    if (fresh) {
      if (pos.current) lastPos.set(scoped.current, pos.current);
      scoped.current = scope;
      pos.current = null;
      wanted.current = lastPos.get(scope) ?? null;
      run.current.failed.clear();
    }
    const back = wanted.current;
    if (back && layout.cuts.some((slot) => slot.path === back.cut)) {
      pos.current = back;
      wanted.current = null;
    }
    const settled = settlePos(layout, pos.current);
    pos.current = settled.pos;
    if ((settled.moved || fresh) && run.current.playing) stop(false);
    else sync(settled.moved || fresh);
    paint(timeOf(layout, pos.current));
    // paint 는 매 렌더 새 함수여도 된다 — 위치가 바뀌는 것은 배치·문서·소스가 바뀔 때뿐이다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, layout, doc, sourceOf, stop, sync]);

  // 가려지면 멈춘다(숨은 동안 rAF 가 서 있다가 큰 시간을 한 번에 더하거나 소리만 나는 일 방지). 떠날 때 정리.
  useEffect(() => {
    const state = run.current;
    const onVisibility = () => {
      if (document.visibilityState !== "visible") stop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const video = videoRef.current;
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (pos.current) lastPos.set(scoped.current, pos.current);
      state.playing = false;
      state.token++;
      state.shown = "";
      cancelAnimationFrame(state.frame);
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
    };
  }, [stop, videoRef]);

  return {
    view,
    now,
    seek,
    seekPos: useCallback((next: EditPos) => seek(timeOf(live.current.layout, next)), [seek]),
    stop: useCallback(() => stop(), [stop]),
    toggle: useCallback(() => (run.current.playing ? stop() : play(1)), [play, stop]),
    // L / J — 같은 방향으로 다시 누르면 2·4·8배, 방향을 바꾸거나 멈춘 상태면 1배.
    shuttle: useCallback((dir: 1 | -1) => {
      const { playing, rate } = run.current;
      play(playing && Math.sign(rate) === dir ? dir * Math.min(8, Math.abs(rate) * 2) : dir);
    }, [play]),
    stepFrames: useCallback((frames: number) => {
      stop();
      seek(now() + frames / EDIT_FPS);
    }, [now, seek, stop]),
    stepEdit: useCallback((dir: 1 | -1) => {
      seek(stepPoint(editPoints(live.current.layout), now(), dir));
    }, [now, seek]),
  };
}
