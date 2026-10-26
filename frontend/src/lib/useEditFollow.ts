// 편집 탭의 '한 트랙만 보기' — 타임라인의 시계를 따라가며 그 트랙의 클립만 보여 주는 보기. 계약은 docs/EDIT_TAB.md.
//  시계에는 영향을 주지 않는다(못 받으면 썸네일로 서 있고, 시계는 그대로 간다). 프레임마다 타임라인의 시각을 읽는다.
//  · 타임라인이 정방향으로 '실제로 가고 있을' 때만 스스로 재생하고, 0.2초 넘게 어긋날 때만 맞춘다(프레임마다 탐색하면 끊긴다).
//    재생 중이어도 시각이 서 있으면(타임라인의 영상이 받는 중) 같이 선다 — 혼자 앞서 갔다 되감기를 되풀이하지 않게.
//  · 그 밖(정지·훑기·프레임 이동·역재생)에는 그 자리에 정확히 맞춘다(한 프레임 이동도 보인다).
//  · 탐색 중에는 새 탐색을 걸지 않는다 — 끝난 다음 프레임이 그때의 목표로 다시 본다(매 프레임 걸면 탐색이 쌓인다).
//  · 영상이 둘을 묶은 것(editVideoPair — 클린 피드)이면 정방향 재생 중 다음에 보일 영상을 그 시작 자리에 미리 받아 세워 두고, 넘어갈 때
//    바꿔 끼워 그 프레임에 바로 튼다(받는 동안 검은 화면·멈칫이 없게, Jay 2026-10-26 "클립 넘어갈 때 딜레이"). 타임라인 판처럼 미리 굴리지는
//    않는다 — 받아 세워 둔 영상은 바로 돌기 시작해, 0.08초 앞서 굴리면 그만큼 앞서 갔다(격리 실측: 굴림 +40ms · 안 굴림 ±10ms).
//  · catchUp(클린 피드 — 소리 없음)이면 재생 중 어긋남을 재생률로 메운다 — 영상의 재생 시작 시간만큼 뒤처진 채 가지 않게.
// ponytail: rAF 가 판이 떠 있는 내내 돈다(판 하나에 프레임당 배치 조회 한 번) — 트랙만 보는 판이 많아지면 시계 쪽에서 알리게.
// ponytail: 미리 받는 것은 지금 클립 바로 다음 하나뿐 — 사이에 빈 자리가 있으면 그다음 것은 넘어갈 때 받는다(타임라인 판과 같다).
import { useEffect, useRef, useState, type RefObject } from "react";
import { clipKey, clipSpeed, localAt, mediaAt, posAt, trackClip, type CutSlot, type EditLayout, type SlotClip } from "./editTimeline";
import { playRate, videoEnd, type EditSource, type EditVideo } from "./useEditPlayback";

export interface EditShown {
  clip: SlotClip | null;
  source: EditSource | null;
  failed: boolean; // 이 영상을 재생하지 못했다 — 썸네일 정지화면
}

const NOTHING: EditShown = { clip: null, source: null, failed: false };
const EXACT = 0.04; // 멈춰 있을 때의 허용 오차(한 프레임 = 1/24초보다 작게)
const DRIFT = 0.2; // 재생 중의 허용 오차
const STALL_MS = 150; // 이만큼 시각이 안 움직이면 타임라인이 서 있는 것으로 본다
// catchUp — 반 프레임 넘게 어긋나면 재생률을 ±8%, 세 프레임 넘게면 ±25% 바꿔 붙는다(탐색은 생성 영상이 키프레임 하나라 처음부터 디코딩한다)
const NEAR = 0.5 / 24;
const FAR = 3 / 24;
const steer = (lag: number) => 1 + Math.sign(lag) * (Math.abs(lag) > FAR ? 0.25 : Math.abs(lag) > NEAR ? 0.08 : 0);

export function useEditFollow({
  videoRef,
  layout,
  track = 1,
  pick,
  sourceOf,
  now,
  playing,
  rate,
  catchUp = false,
}: {
  videoRef: RefObject<EditVideo | null>;
  layout: EditLayout; // 타임라인의 배치 그대로(시간축이 같다)
  track?: number;
  // 그 순간 보여 줄 클립을 고르는 다른 규칙(클린 피드 = 보이는 클립, Jay 2026-10-23). 없으면 그 트랙의 클립(trackClip)
  pick?: (slot: CutSlot, local: number) => SlotClip | null;
  sourceOf: (clip: SlotClip) => EditSource;
  now: () => number; // 타임라인의 지금 시각
  playing: boolean;
  rate: number;
  catchUp?: boolean; // 재생 중 어긋남을 재생률로 메운다 — 소리 없는 판만(소리가 있으면 소리 빠르기가 바뀐다)
}): EditShown {
  const [shown, setShown] = useState<EditShown>(NOTHING);
  const live = useRef({ layout, track, pick, sourceOf, now, playing, rate, catchUp });
  live.current = { layout, track, pick, sourceOf, now, playing, rate, catchUp };

  useEffect(() => {
    const video = videoRef.current;
    const state = {
      shown: "", // React 에 알린 것의 열쇠
      video: "", // 올려 둔 영상의 열쇠(클립 열쇠 + 주소). 빈 문자열 = 영상 없음
      clip: "",
      head: 0, // 올려 둔 클립의 유효 시작(초) — 영상 시각 = head + 컷 안 시각 × speed(앞 자르기·속도 — mediaAt)
      speed: 1, // 올려 둔 클립의 속도 배율
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
      const { layout: cuts, track: lane, pick: choose, sourceOf: source, now: clock, playing: on, rate: speed, catchUp: steering } = live.current;
      const time = clock();
      // 배치의 끝 이상이면 아무것도 보이지 않는다 — posAt 은 끝으로 잘라 마지막 화면을 남긴다(편집 공유의 V0 꼬리에서 내 배치를 따라가는 판, 설계 §6)
      const pos = time < cuts.total ? posAt(cuts, time) : null;
      const slot = pos ? cuts.cuts.find((item) => item.path === pos.cut) ?? null : null;
      const clip = slot && pos ? (choose ? choose(slot, pos.local) : trackClip(slot, lane, pos.local)) : null;
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
        state.speed = playable ? clipSpeed(clip!) : 1;
        state.loaded = false;
        video.pause();
        if (playable && video.swap?.(media!.url!)) {
          // 미리 받아 그 클립의 시작 자리에 세워 둔 것을 앞으로 내놓았다 — 받지도 다시 보내지도 않는다. 그 메타데이터 이벤트는 지나갔다.
          //  메타데이터가 있으면 아래에서 이 프레임에 바로 맞춘다(재생 중이면 바로 튼다 — 한 프레임 늦게 틀면 그만큼 뒤처진다)
          state.rewound = false;
          state.loaded = (video.readyState ?? 0) >= 1;
        } else {
          // 앞을 자른 클립은 새로 받은 영상(0초에 서 있다)을 한 번 정확히 보낸다 — 시작점이 0.2초 안이면 '작은 어긋남'으로 넘어간다
          state.rewound = state.head > 0;
          if (playable) video.src = media!.url!;
          else video.removeAttribute("src");
          video.load();
          // 받기 전에 적은 시각은 '처음 자리'가 되어 받는 대로 그리로 간다(HTML 표준 — 탐색이 아니다). 첫 프레임을 0초에서 한 번, 그 자리에서
          //  또 한 번 디코딩하지 않는다(생성 영상은 키프레임 하나라 그 자리까지 처음부터 디코딩한다)
          if (playable) video.currentTime = mediaAt(clip!, pos!.local);
        }
      }
      if (video && playable && state.loaded) {
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
        //  속도만 바뀌어도(속도 막대) 같다.
        if (clip!.head !== state.head || clipSpeed(clip!) !== state.speed) {
          state.head = clip!.head;
          state.speed = clipSpeed(clip!);
          state.rewound = true;
        }
        const shownClip = { head: state.head, speed: state.speed };
        const end = localAt(shownClip, videoEnd(video)); // 컷 안 시각으로 본 실제 끝
        const target = Math.min(pos!.local, end);
        const off = Math.abs(localAt(shownClip, video.currentTime) - target); // 허용 오차는 타임라인 초로 본다
        if (going) {
          const base = Math.max(1, speed) * state.speed; // 바닥은 배속에만(곱에 걸면 25% 가 사라진다)
          if (!video.seeking) {
            if (off > (state.rewound ? EXACT : DRIFT)) video.currentTime = mediaAt(shownClip, target);
            state.rewound = false;
          }
          video.playbackRate = playRate(steering ? base * steer(target - localAt(shownClip, video.currentTime)) : base);
          // 소스가 갈리며 끊긴 재생 요청은 실패가 아니다. 실제 끝에 선 영상은 틀지 않는다 — 브라우저가 처음부터 다시 튼다.
          if (video.paused && localAt(shownClip, video.currentTime) < end) void video.play().catch(() => {}); // 방금 보낸 자리로 본다
        } else {
          if (!video.paused) video.pause();
          if (off > EXACT && !video.seeking) video.currentTime = mediaAt(shownClip, target);
          state.rewound = false; // 서 있으면 어차피 정확히 맞춘다
        }
      }
      // 다음에 보일 영상을 뒤 요소에 그 시작 자리로 미리 받아 둔다 — 정방향 재생 중에만(useEditPlayback.prepare 와 같은 규칙 — 멈춘 채 훑을
      //  때마다 받으면 요청이 두 배가 된다). 그 밖에는 받아 둔 것을 그대로 둔다.
      if (video?.prepare && on && speed > 0 && slot && clip) {
        const edge = Math.min(clip.len, slot.len); // 이 클립이 안 보이게 되는 자리 — 그 뒤는 같은 컷의 아래 클립이거나 다음 컷의 처음
        const after = edge < slot.len ? slot : cuts.cuts[cuts.cuts.indexOf(slot) + 1];
        const at = edge < slot.len ? edge : 0;
        const next = after ? (choose ? choose(after, at) : trackClip(after, lane, at)) : null;
        const nextMedia = next ? source(next) : null;
        const ok = !!next && nextMedia?.state === "ok" && nextMedia.type === "video" && !!nextMedia.url && !state.failed.has(clipKey(next));
        const url = ok && `${clipKey(next!)}\n${nextMedia!.url}` !== state.video ? nextMedia!.url : null;
        video.prepare(url, url ? mediaAt(next!, at) : 0);
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
        video.prepare?.(null, 0); // 미리 받던 것도 내려놓는다
      }
    };
  }, [videoRef]);

  return shown;
}
