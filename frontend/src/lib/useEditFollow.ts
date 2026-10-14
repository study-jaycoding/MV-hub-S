// 편집 탭의 '한 트랙만 보기' — 타임라인의 시계를 따라가며 그 트랙의 클립만 보여 주는 보기. 계약은 docs/EDIT_TAB.md.
//  시계에는 영향을 주지 않는다(못 받으면 썸네일로 서 있고, 시계는 그대로 간다). 프레임마다 타임라인의 시각을 읽는다.
//  · 타임라인이 정방향으로 '실제로 가고 있을' 때만 스스로 재생하고, 0.2초 넘게 어긋날 때만 맞춘다(프레임마다 탐색하면 끊긴다).
//    재생 중이어도 시각이 서 있으면(타임라인의 영상이 받는 중) 같이 선다 — 혼자 앞서 갔다 되감기를 되풀이하지 않게.
//  · 그 밖(정지·훑기·프레임 이동·역재생)에는 그 자리에 정확히 맞춘다(한 프레임 이동도 보인다).
//  · 탐색 중에는 새 탐색을 걸지 않는다 — 끝난 다음 프레임이 그때의 목표로 다시 본다(매 프레임 걸면 탐색이 쌓인다).
// ponytail: rAF 가 판이 떠 있는 내내 돈다(판 하나에 프레임당 배치 조회 한 번) — 트랙만 보는 판이 많아지면 시계 쪽에서 알리게.
import { useEffect, useRef, useState, type RefObject } from "react";
import { clipKey, posAt, trackClip, type EditLayout, type SlotClip } from "./editTimeline";
import { videoEnd, type EditSource, type EditVideo } from "./useEditPlayback";

export interface EditShown {
  clip: SlotClip | null;
  source: EditSource | null;
  failed: boolean; // 이 영상을 재생하지 못했다 — 썸네일 정지화면
}

const NOTHING: EditShown = { clip: null, source: null, failed: false };
const EXACT = 0.04; // 멈춰 있을 때의 허용 오차(한 프레임 = 1/24초보다 작게)
const DRIFT = 0.2; // 재생 중의 허용 오차
const STALL_MS = 150; // 이만큼 시각이 안 움직이면 타임라인이 서 있는 것으로 본다

export function useEditFollow({
  videoRef,
  layout,
  track,
  sourceOf,
  now,
  playing,
  rate,
}: {
  videoRef: RefObject<EditVideo | null>;
  layout: EditLayout; // 타임라인의 배치 그대로(시간축이 같다)
  track: number;
  sourceOf: (clip: SlotClip) => EditSource;
  now: () => number; // 타임라인의 지금 시각
  playing: boolean;
  rate: number;
}): EditShown {
  const [shown, setShown] = useState<EditShown>(NOTHING);
  const live = useRef({ layout, track, sourceOf, now, playing, rate });
  live.current = { layout, track, sourceOf, now, playing, rate };

  useEffect(() => {
    const video = videoRef.current;
    const state = {
      shown: "", // React 에 알린 것의 열쇠
      video: "", // 올려 둔 영상의 열쇠(클립 열쇠 + 주소). 빈 문자열 = 영상 없음
      clip: "",
      head: 0, // 올려 둔 클립의 유효 시작(초) — 영상 시각 = 컷 안 시각 + head(앞 자르기)
      loaded: false,
      failed: new Set<string>(),
      lastTime: Number.NaN,
      rewound: false,
      movedAt: 0,
      frame: 0,
    };
    const onMeta = () => {
      state.loaded = true;
    };
    const onError = () => {
      if (state.video) state.failed.add(state.clip); // 다음 프레임이 영상을 내리고 썸네일로 바꾼다
    };
    // 탭이 가려지면 rAF 가 서서 아래 tick 의 정지가 돌지 않는다 — 여기서 바로 세운다(안 세우면 따라가던 영상이 숨은 탭에서
    //  혼자 계속 돈다). 다시 보여도 스스로 틀지 않는다: 타임라인이 가려질 때 멈췄고(useEditPlayback), 이 판은 그 시계를 따라갈 뿐이다.
    const onVisibility = () => {
      if (document.visibilityState !== "visible") video?.pause();
    };
    video?.addEventListener("loadedmetadata", onMeta);
    video?.addEventListener("error", onError);
    document.addEventListener("visibilitychange", onVisibility);

    const tick = (stamp: number) => {
      const { layout: cuts, track: lane, sourceOf: source, now: clock, playing: on, rate: speed } = live.current;
      const time = clock();
      const pos = posAt(cuts, time);
      const slot = pos ? cuts.cuts.find((item) => item.path === pos.cut) ?? null : null;
      const clip = slot && pos ? trackClip(slot, lane, pos.local) : null;
      const media = clip ? source(clip) : null;
      const key = clip ? clipKey(clip) : "";
      const failed = !!clip && state.failed.has(key);
      const playable = !!clip && media?.state === "ok" && media.type === "video" && !!media.url && !failed;

      const shownKey = `${key}\n${media?.url ?? ""}\n${media?.state ?? ""}\n${failed}`;
      if (shownKey !== state.shown) {
        state.shown = shownKey;
        setShown(clip ? { clip, source: media, failed } : NOTHING);
      }
      const videoKey = playable ? `${key}\n${media!.url}` : "";
      if (video && videoKey !== state.video) {
        state.video = videoKey;
        state.clip = key;
        state.head = playable ? clip!.head : 0;
        // 앞을 자른 클립은 새로 받은 영상(0초에 서 있다)을 한 번 정확히 보낸다 — 시작점이 0.2초 안이면 '작은 어긋남'으로 넘어간다
        state.rewound = state.head > 0;
        state.loaded = false;
        video.pause();
        if (playable) video.src = media!.url!;
        else video.removeAttribute("src");
        video.load();
      } else if (video && playable && state.loaded) {
        if (time !== state.lastTime) state.movedAt = stamp;
        // 시각이 뒤로 갔다(반복·구간 반복으로 되돌아감) — 어긋남 보정이 아니라 자리 옮김이라, 작은 차이여도 한 번 정확히 맞춘다
        //  (짧은 구간을 되풀이할 때 0.2초 안이라고 그냥 두면 이 판만 구간 밖을 튼다 — Codex 설계 검토).
        if (time < state.lastTime) state.rewound = true;
        // 가려진 동안에는 틀지 않는다 — 타임라인이 멈췄다는 소식(playing)이 닿기 전에 온 프레임이 방금 세운 영상을 다시 틀지 않게.
        const going = on && speed > 0 && stamp - state.movedAt < STALL_MS && document.visibilityState === "visible";
        // 영상을 보낼 자리 — 실제 끝 뒤로는 보낼 수 없다(적어 둔 길이보다 짧은 영상: 브라우저가 끝으로 자른다). 자르지 않은
        //  시각과 견주면 프레임마다 같은 자리로 다시 보낸다 — 그 뒤에서는 끝 프레임에 세워 둔다(2026-10-11 R21).
        // 같은 영상의 시작점이 바뀌었다(길이 조절 창에서 앞 손잡이를 옮김) — 자리 옮김이다. 재생 중의 작은 어긋남(DRIFT)으로 넘기지
        //  않고 한 번 정확히 맞춘다(탐색 중이면 끝난 뒤에 — rewound 가 남는다. Codex 설계 검토).
        const head = clip!.head;
        if (head !== state.head) {
          state.head = head;
          state.rewound = true;
        }
        const end = videoEnd(video) - head; // 컷 안 시각으로 본 실제 끝
        const target = Math.min(pos!.local, end);
        const off = Math.abs(video.currentTime - head - target);
        if (going) {
          video.playbackRate = Math.max(1, speed);
          if (!video.seeking) {
            if (off > (state.rewound ? EXACT : DRIFT)) video.currentTime = target + head;
            state.rewound = false;
          }
          // 소스가 갈리며 끊긴 재생 요청은 실패가 아니다. 실제 끝에 선 영상은 틀지 않는다 — 브라우저가 처음부터 다시 튼다.
          if (video.paused && video.currentTime - head < end) void video.play().catch(() => {}); // 방금 보낸 자리로 본다
        } else {
          if (!video.paused) video.pause();
          if (off > EXACT && !video.seeking) video.currentTime = target + head;
          state.rewound = false; // 서 있으면 어차피 정확히 맞춘다
        }
      }
      state.lastTime = time;
      state.frame = requestAnimationFrame(tick);
    };
    state.frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(state.frame);
      video?.removeEventListener("loadedmetadata", onMeta);
      video?.removeEventListener("error", onError);
      document.removeEventListener("visibilitychange", onVisibility);
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
    };
  }, [videoRef]);

  return shown;
}
