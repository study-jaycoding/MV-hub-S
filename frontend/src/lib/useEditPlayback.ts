// 편집 탭의 재생 — 컷 순서대로, 위 트랙 우선으로 `<video>` 하나를 갈아 끼우며 이어 튼다. 계약은 docs/EDIT_TAB.md.
//  · 위치의 원천은 ref 하나((컷 경로, 컷 안 시각)). 프레임마다 고치는 것은 paint(재생헤드·타임코드)뿐이고,
//    React 에는 '보이는 것·재생 상태'가 바뀔 때만 알린다.
//  · 시계 주인은 항상 하나: 보이는 클립이 영상이고 정방향 재생이면 영상(받는 중·버퍼링이면 시간도 선다), 그 밖에는 rAF.
//  · '보이는 소스가 바뀜'은 컷이 바뀌는 것과 별개 사건 — 같은 컷에서 위 클립이 끝나 아래가 드러날 때도 일어난다.
//  · 다음에 보일 영상은 미리 받아 둔다(정방향 재생 중) — 영상 요소가 둘이면(editVideoPair) 넘어갈 때 받지 않고 자리만 바꾼다.
//  · 클립은 원본의 중간에서 시작할 수 있고(앞 자르기 — SlotClip.head) 속도가 있을 수 있다(2026-10-23 — SlotClip.speed):
//    **영상 시각 = 올려 둔 클립의 head + 컷 안 시각 × 그 속도**(mediaAt·localAt). 엔진은 컷 안 시각만 안다 — 영상의 시각을 읽고
//    쓰는 것은 build() 안의 clipTime·send·endOf 셋으로만 한다. 시계(rAF)는 컷 안 시각으로 흐르므로 속도를 곱하지 않는다 —
//    영상 쪽은 playbackRate = 배속 × 클립 속도로 같은 빠르기가 된다.
// ponytail: 미리 받는 것은 '바로 다음 하나'뿐이다 — 역방향·훑기와, 다 받기 전에 경계에 닿은 때는 받는 시간만큼 선다.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  clipKey,
  clipSpeed,
  EDIT_FPS,
  editPoints,
  localAt,
  mediaAt,
  posAt,
  settlePos,
  stepPoint,
  timeOf,
  visibleClip,
  visibleSegments,
  type CutSlot,
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
  readonly duration?: number; // 영상의 실제 길이(메타데이터를 받기 전에는 NaN) — 없으면(시험의 가짜) 실제 끝을 모르는 옛 길 그대로다
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  // 아래 셋은 영상 요소 둘을 묶은 것(editVideoPair)만 가진다 — 없으면 주소를 갈아 끼우는 옛 길 그대로다.
  readonly readyState?: number;
  prepare?(url: string | null, time: number, rate?: number): void; // 다음에 보일 영상을 미리 받아 그 시각에 세워 둔다(null = 비운다). rate = 미리 굴릴 배속
  swap?(url: string): boolean; // 미리 받아 둔 그 영상을 앞으로 내놓는다(받지 않는다). 없으면 false
  roll?(on: boolean): void; // 미리 받아 둔 영상을 소리 없이 미리 굴린다 / 세워 제자리로 돌린다
}

// 올려 둔 영상의 실제 끝(초). 적어 둔 길이(dur)보다 짧을 수 있다 — 길이를 재기 전이거나 재지 못한 영상. 브라우저는 그 뒤로
//  보낸 currentTime 을 끝으로 자르므로, 영상을 보낼 자리와 '끝났는지'는 이것으로 본다. 모르는 것은 NaN(메타데이터 전)과
//  Infinity(스트림)뿐이다 — 그때는 상한이 없다. 0초도 길이다(틀 것이 없는 영상): 모른다고 치면 0초로 잘린 자리를 계속 다시 보낸다.
export function videoEnd(video: EditVideo | null | undefined): number {
  const length = video?.duration ?? NaN;
  return Number.isFinite(length) ? length : Infinity;
}

// 영상에 주는 재생률 — 크롬 한도 1/16~16 안으로. 넘기면 대입이 예외를 던져 재생 갱신·다음 프레임 예약이 멈춘다
//  (클립 400% × 셔틀 8배 = 32 · 클린 피드 4배 × 따라붙기 1.25 = 20 — 릴리스 묶음 리뷰 B).
export function playRate(rate: number): number {
  return Math.min(16, Math.max(1 / 16, rate));
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
// 자리를 적는다 — 재생용으로만 붙인 자리(tail)에 서 있었으면 그 배치(from)의 실제 끝으로, 실제 자리가 없으면 적지 않는다(지운다).
function rememberPos(key: string, at: EditPos | null, from: EditLayout, tail: string | undefined) {
  if (!at) return;
  if (!tail || at.cut !== tail) return void lastPos.set(key, at);
  const real = [...from.cuts].reverse().find((slot) => slot.path !== tail);
  if (real) lastPos.set(key, { cut: real.path, local: real.len });
  else lastPos.delete(key);
}

const STOPPED: EditView = { cut: null, clip: null, source: null, playing: false, rate: 1, failed: false };
const SEEK_SLOP = 0.04;
// 다 받아 둔 영상도 play() 뒤 화면이 움직이기까지 시간이 든다(격리 실측 약 0.05초 — 그동안 첫 프레임에 서 있다). 그래서
//  넘어가기 ROLL_LEAD 초(실제 시간) 전부터 뒤의 것을 미리 굴려, 넘어가는 순간에는 이미 돌고 있게 한다. 대신 뒤 영상의 첫
//  한두 프레임을 건너뛸 수 있다 — 컷이 바뀌는 자리라 눈에 띄지 않고, 멈춘 채로는 언제나 정확한 프레임이다.
const ROLL_LEAD = 0.08;
const ROLL_SLOP = 0.3; // 미리 굴린 영상이 목표를 이만큼(실제 시간 — 배속을 곱한다)까지 지나 있어도 되감지 않는다
// 한 프레임(tick)에 넘기는 클립 수의 상한. 브라우저에서는 보통 둘을 넘지 않는다(지금 것 + 미리 받아 둔 다음 것 — 넘긴 뒤에 받기
//  시작한 영상은 같은 프레임에 준비되지 않는다). 틀 수 없는 것이 길게 이어져도 한 프레임이 끝없이 길어지지 않게 못 박아 둔다.
const PASS_MAX = 4;
// '바퀴의 처음에서 시작했다'의 허용 오차 — 시각을 컷 좌표로 바꿨다 되돌리면 끝자리가 달라질 수 있다
const LAP_SLOP = 1e-9;

export function useEditPlayback({
  scope,
  layout,
  doc,
  sourceOf,
  videoRef,
  paint,
  loop = false,
  range = null,
  speed = 1,
  order,
  ephemeral,
}: {
  // 재생용으로만 붙인 자리의 열쇠(편집 공유의 빈 꼬리 — lib/editShare.withTail). 적어 두는 재생 위치(lastPos)에는 그 자리 대신 그 배치의
  //  실제 끝(마지막 실제 자리·그 길이)을 적고, 실제 자리가 없으면 적지 않는다 — 다시 열었을 때 없는 자리로 가지 않게.
  ephemeral?: string;
  // 타임라인의 전체 컷 순서(숨긴 컷 포함 — cutPaths). 보던 컷이 배치에서 빠졌을 때 '그다음 컷'을 여기서 찾는다(settlePos).
  //  안 주면 배치의 순서다(소스 판). 배치·문서가 바뀔 때만 읽는다 — 이것만 바뀌는 일은 없다(순서는 문서에서 나온다).
  order?: readonly string[];
  scope: string; // 시퀀스(문서) — 바뀌면 위치를 처음으로 돌린다(옛 시퀀스의 컷 이름으로 새 자리를 짐작하지 않는다)
  layout: EditLayout;
  doc: EditDoc;
  sourceOf: (clip: SlotClip) => EditSource; // 값이 같으면 같은 함수여야 한다(useCallback)
  videoRef: RefObject<EditVideo | null>;
  paint: (time: number) => void;
  loop?: boolean; // 반복 — 정방향으로 끝에 닿으면 처음부터 이어 튼다(역방향은 처음에서 멈춘다)
  range?: { from: number; to: number } | null; // 되풀이할 구간(전체 시각) — 있으면 loop 와 무관하게 이 구간을 돈다(구간 반복 재생)
  speed?: number; // 재생 배속(1 이상) — 정방향 재생(재생 단추·Space·L·구간 반복)이 이 배속으로 시작한다
}) {
  const [view, setView] = useState<EditView>(STOPPED);
  const live = useRef({ layout, doc, sourceOf, paint, loop, range, speed });
  live.current = { layout, doc, sourceOf, paint, loop, range, speed };
  const pos = useRef<EditPos | null>(null);
  // 직전에 위치를 맞춘 때의 전체 순서 — 서 있던 반복 자리가 실제로 사라지면(이 창의 빼기·되돌리기·다른 창의 최종 문서) 그 자리의 다음을 여기서
  //  찾는다(settlePos 의 previous — 문서의 순서에는 이미 그 자리가 없을 수 있다, Codex 설계 3차). 시퀀스가 바뀔 때만 비운다.
  const previousOrder = useRef<readonly string[] | undefined>(undefined);
  const run = useRef({
    playing: false,
    rate: 1,
    owner: "raf" as "raf" | "video",
    token: 0, // 소스를 갈거나 다시 탐색할 때마다 오른다 — 늦게 온 영상 이벤트를 버리는 기준
    arrived: -1, // 영상이 목표 위치까지 온 token. token 과 같아야 영상이 시계를 맡는다
    loaded: false, // 지금 소스의 메타데이터를 받았다(그 전에는 탐색하지 않는다 — loadedmetadata 가 최신 목표로 보낸다)
    shown: "", // 지금 올려 둔 소스의 열쇠(클립 열쇠 + 주소). 빈 문자열 = 영상 없음
    head: 0, // 지금 올려 둔 클립의 유효 시작(초) — 그 영상의 시각은 컷 안 시각보다 이만큼 앞서 있다(sync 가 맞춘다)
    speed: 1, // 지금 올려 둔 클립의 속도 배율 — head 와 같이 sync 가 맞춘다
    failed: new Set<string>(), // 재생하지 못한 클립 열쇠
    armed: false, // 구간 반복 — 마지막으로 위치를 옮긴 뒤 구간 끝(아웃) 앞에 있었다. 아웃 뒤에서 시작했으면 꺼진 채다
    // 반복의 '빈 바퀴' 판정(되돌아갈 때 — loopBack) — 이 둘뿐이다. 일어난 일마다 깃발을 켜고 끄지 않는다: 바퀴의 범위를
    //  바꾸는 길과 시간을 흘리는 길을 전부 열거해야 해서 빠진 길이 거듭 나왔다(Codex 재검토).
    //  · lap — 지금 도는 바퀴를 열 때의 범위(from~to)와, 온전한 바퀴인지(whole: 범위의 처음에서 시작했고 도중에 자리를 옮기지
    //    않았다). 판정하는 순간에 그때의 범위와 지금의 범위를 견준다 — 범위가 왜 달라졌는지는 묻지 않는다.
    //  · flowed — 그 바퀴에 흐른 시간(초). 무엇이 그 시간을 흘렸는지로 센다(tick·onEnded) — 0 이면 틀 것이 없던 바퀴다.
    lap: { from: 0, to: 0, whole: false },
    flowed: 0,
    frame: 0,
    last: 0,
  });

  const published = useRef<EditView>(STOPPED);
  const scoped = useRef(scope);
  const placed = useRef(layout); // 마지막으로 위치를 맞춘 배치 — 시퀀스가 바뀔 때 '떠나는 쪽'의 끝을 여기서 찾는다
  const ephemeralRef = useRef(ephemeral);
  ephemeralRef.current = ephemeral;
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

    // 올려 둘 소스의 열쇠(클립 열쇠 + 주소) — 재생할 수 있는 영상일 때만. 아니면 빈 문자열(영상 없음).
    const shownOf = (clip: SlotClip | null, source: EditSource | null) => {
      const key = clip ? clipKey(clip) : "";
      return clip && source?.state === "ok" && source.type === "video" && source.url && !state.failed.has(key)
        ? `${key}\n${source.url}` : "";
    };
    // 그 컷의 [from, to](타임라인 시각)에서 rAF 시계가 흘린 시간 — 그 구간을 보이는 것이 바뀌는 경계로 쪼개, 틀 영상이 보이지
    //  않는 조각(빈 자리·그림·못 트는 클립)의 길이만 더한다. 틀 영상이 보이는 조각에서 rAF 로 버틴 시간은 흐른 것이 아니다
    //  (그 영상이 도착하기 전이거나, 실제 끝 뒤라 곧 넘길 자리다). 조각은 그 컷의 클립 수만큼뿐이다.
    const idleFlow = (slot: CutSlot, from: number, to: number) => {
      let sum = 0;
      for (const part of visibleSegments(live.current.doc, slot)) {
        const length = Math.min(to, slot.start + part.to) - Math.max(from, slot.start + part.from);
        if (length > 0 && !shownOf(part.clip, part.clip && live.current.sourceOf(part.clip))) sum += length;
      }
      return sum;
    };

    // 영상 시각 ↔ 컷 안 시각(앞 자르기, Jay 2026-10-14) — 올려 둔 클립은 원본의 head 초에서 시작한다. 영상의 시각을 읽고 쓰는 것과
    //  '실제 끝'은 이 셋으로만 한다. head·speed 는 **지금 영상 요소에 올려 둔 클립**의 것이다(state.head·state.speed): 위치가 방금
    //  다른 클립으로 넘어갔어도, sync 가 소스를 갈기 전까지 영상 요소에는 앞 클립이 올라가 있다(tick·stop 이 그 값으로 읽는다).
    const shownClip = () => ({ head: state.head, speed: state.speed });
    const clipTime = (video: EditVideo) => localAt(shownClip(), video.currentTime);
    const send = (video: EditVideo, local: number) => {
      video.currentTime = mediaAt(shownClip(), local);
    };
    const endOf = (video: EditVideo | null | undefined) => localAt(shownClip(), videoEnd(video));

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

    // 영상을 보낼 자리 — 컷 안 시각 그대로, 다만 실제 끝 뒤로는 보낼 수 없다(브라우저가 끝으로 자른다). 자르지 않은 시각과
    //  견주면 영영 '어긋남'이라 seeked 마다 같은 자리로 다시 보내고, 도착하지 못해 재생이 그 자리에 선다(2026-10-11 R21).
    const aim = () => Math.min(pos.current!.local, endOf(videoRef.current));

    // 영상이 보낼 자리에 와 있지 않다 — 허용 오차 밖이거나, 영상은 실제 끝에 서 있는데 자리는 그 앞이다. 뒤의 것은 허용 오차
    //  안이어도 '도착'이 아니다: 끝에 선 영상은 그대로 틀 수 없어 넘기게 되고(over), 그러면 틀 수 있는 마지막 조각을 건너뛴다 —
    //  그 조각뿐인 구간 반복은 '빈 바퀴'로 멈췄다(Codex 재검토). 그 자리로 되감으면 틀 수 있다.
    const astray = (video: EditVideo, target: number) => {
      const end = endOf(video);
      return Math.abs(clipTime(video) - target) > SEEK_SLOP || (target < end && clipTime(video) >= end);
    };

    // 이 클립은 여기까지다 — 그 클립의 끝으로 보내 다음(아래 클립·다음 컷)으로 넘어가게 한다. 남은 길은 rAF 시계가 잇는다.
    const passClip = () => {
      const { slot, clip } = visible();
      if (!slot || !clip) return;
      pos.current = { cut: slot.path, local: clip.len };
      state.owner = "raf";
      state.last = performance.now();
    };

    // 이 영상으로는 더 갈 수 없다 — 재생헤드가 실제 끝 뒤거나(적어 둔 길이보다 짧은 영상), 영상이 그 끝에 서 있다.
    //  · 재생헤드 쪽: 영상이 끝 바로 앞(허용 오차 안)에 있으면 '도착'이지만, 그 영상에 시계를 맡기면 재생헤드가 영상의 시각으로
    //    되돌아간다(Codex 코드 리뷰).
    //  · 영상 쪽: 끝에 선 영상에 play() 를 걸면 브라우저가 처음부터 다시 튼다. 자리가 끝 앞이면 먼저 되감으므로(astray), 끝에 선
    //    채 여기까지 오는 것은 탐색이 끝난 뒤에도 끝인 때뿐이다(탐색 중에 목표가 끝 바로 앞으로 바뀜 · 되감아도 못 벗어남).
    const over = (video: EditVideo) => Math.max(pos.current!.local, clipTime(video)) >= endOf(video);

    const startVideo = () => {
      const video = videoRef.current;
      // 끝난 영상에 play() 를 걸면 브라우저가 처음부터 다시 튼다 — 걸지 않고, 재생 중에 먼저 끝난 것(ended)과 같게 넘긴다.
      if (video && over(video)) return passClip();
      const token = state.token;
      video?.play().catch((error: unknown) => {
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
    const sync = (moved: boolean) => {
      const video = videoRef.current;
      const { clip, source } = visible();
      const shown = shownOf(clip, source);
      const playable = !!shown;
      // 올려 둘 클립의 시작점 — 소스를 갈거나(바로 아래의 swap 은 onMeta 를 그 자리에서 부른다) 탐색하기 **전에** 맞춘다.
      //  같은 소스인데 시작점만 바뀌었으면(길이 조절 창에서 앞 손잡이를 옮김) 위치를 옮긴 것과 같게 다룬다: 영상이 새 자리에
      //  닿기 전에는 시계를 넘기지 않는다 — 그냥 두면 도는 영상의 시각이 그대로 컷 안 시각으로 읽혀 재생헤드가 그 차이만큼 튄다.
      //  속도만 바뀌어도(속도 막대) 같다 — 영상의 시각을 컷 안 시각으로 바꾸는 식이 바뀌었다.
      const head = playable ? clip!.head : 0;
      const speed = playable ? clipSpeed(clip!) : 1;
      const jump = moved || (shown === state.shown && (head !== state.head || speed !== state.speed));
      state.head = head;
      state.speed = speed;
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
        if (playable && video.swap?.(source!.url!)) {
          // 미리 받아 둔 영상을 앞으로 내놓았다 — 다시 받지 않는다. 미리 굴리던 것이면 돌고 있다: 영상에 시계를 맡길 때가
          //  아니면(멈춤·역방향) 세운다 — 정지를 눌렀는데 넘어온 영상이 계속 돌았다(Codex 코드 리뷰). 메타데이터를 이미
          //  받았으면 그 이벤트는 지나갔으므로 여기서 잇고, 아직이면 진짜 loadedmetadata 가 온다.
          if (owner === "raf") video.pause();
          if ((video.readyState ?? 0) >= 1) onMeta();
        } else {
          if (playable) video.src = source!.url!;
          else video.removeAttribute("src");
          video.load(); // loadedmetadata → 목표 위치로 탐색 → seeked → (재생 중이면) play
        }
      } else if (video && playable) {
        const local = aim();
        const off = astray(video, local);
        if (jump) {
          // 위치를 옮겼다 — 최신 목표에 닿기 전에는 영상에 시계를 넘기지 않는다. 진행 중이던 옛 탐색의 도착은 믿지 않고,
          // 그것이 끝나면 seeked 처리부가 최신 목표로 다시 보낸 뒤에 도착을 선언한다.
          state.token++;
          if (state.loaded && !video.seeking) {
            if (off) send(video, local);
            else state.arrived = state.token;
          }
        } else if (owner === "raf" && state.arrived === state.token && !video.seeking && off) {
          send(video, local); // 정지·역방향 — 영상을 위치에 맞춘다
        }
        // 돌고 있는 영상이어도, 재생헤드가 그 실제 끝 뒤로 갔으면 시계를 맡기지 않는다(startVideo 가 넘긴다).
        if (owner === "video" && state.arrived === state.token && (video.paused || over(video))) startVideo();
        if (owner === "raf" && !video.paused) video.pause();
      }
      // 바닥(1)은 배속에만 건다 — 곱한 값에 걸면 25% 속도가 사라진다(Codex 설계 검토). 셔틀 8배 × 400% 는 크롬 한도를 넘어 16 에서 멈춘다.
      if (video && playable) video.playbackRate = playRate(Math.max(1, Math.abs(state.rate)) * speed);
      prepare();
      publish();
    };

    // 지금 보이는 것이 끝난 뒤 보일 자리(at)와 거기까지 남은 길이(left, 타임라인 초) — tick 이 넘기는 순서 그대로다: 구간의
    //  끝(경계와 같은 자리 포함)·반복하는 전체 끝이면 구간 처음으로 되돌아가고, 아니면 같은 컷의 아래 클립이나 다음 컷.
    const upcoming = (): { at: EditPos; left: number } | null => {
      const at = pos.current;
      const slot = slotOf(at?.cut);
      if (!at || !slot) return null;
      const { layout, doc, loop } = live.current;
      const end = visibleClip(doc, slot, at.local)?.len ?? slot.len;
      const next = layout.cuts[layout.cuts.indexOf(slot) + 1];
      const range = rangeNow();
      const here = slot.start + at.local;
      const edge = slot.start + end;
      const turn = range && state.armed && range.to <= edge ? range.to : end >= slot.len && !next && (loop || range) ? edge : null;
      const to = turn !== null ? posAt(layout, range?.from ?? 0)
        : end < slot.len ? { cut: slot.path, local: end } : next ? { cut: next.path, local: 0 } : null;
      return to && { at: to, left: (turn ?? edge) - here };
    };
    // 다음에 보일 영상을 미리 받아 그 자리에 세워 둔다 — 정방향 재생 중에만(멈춘 채 훑을 때마다 받으면 요청이 두 배가 된다).
    //  다음이 영상이 아니거나 지금 것과 같으면(한 클립 안의 구간 반복) 비운다. 프레임마다 불려도 같은 것이면 요소는 그대로다.
    //  넘어가기 직전(ROLL_LEAD)에는 그것을 미리 굴린다 — 멈추거나 자리를 옮겨 그 순간에서 멀어지면 세워 제자리로 돌린다.
    const prepare = () => {
      const video = videoRef.current;
      if (!video?.prepare) return;
      if (!state.playing || state.rate < 0) return video.roll?.(false); // 받아 둔 것은 그대로 둔다
      const next = upcoming();
      const slot = slotOf(next?.at.cut);
      const clip = slot && next ? visibleClip(live.current.doc, slot, next.at.local) : null;
      const source = clip ? live.current.sourceOf(clip) : null;
      const shown = shownOf(clip, source);
      const url = shown && shown !== state.shown ? source!.url : null;
      // 세워 둘 자리·굴릴 배속도 **그 다음 클립의** 시작점·속도로 센다(지금 올린 클립의 것이 아니다)
      const at = next?.at.local ?? 0;
      video.prepare(url, url ? mediaAt(clip!, at) : at, url ? playRate(Math.max(1, Math.abs(state.rate)) * clipSpeed(clip!)) : 1);
      video.roll?.(!!url && next!.left / state.rate <= ROLL_LEAD);
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
        if (slot) pos.current = { cut: slot.path, local: Math.min(Math.max(0, clipTime(video)), slot.len) };
      }
      sync(!adopt);
      // 멈춘 자리를 그린다 — 영상의 시각을 위치로 받으면 마지막 tick 이 그린 자리와 다르다(그 사이 편집점을 넘었으면 보이는
      //  클립도 바뀐다). 안 그리면 재생헤드·시각이 한 박자 낡은 채 선다(Codex 코드 리뷰).
      live.current.paint(now());
    };

    // 지금 지킬 구간 — 구간 반복(range).
    const rangeNow = () => live.current.range;
    // 구간 반복(마크 인/아웃) — 구간(range)이 있으면 아웃을 넘는 순간 인으로 돌아간다. '넘는 순간'을 tick 앞뒤 시각의
    //  비교로만 보면 영상의 ended 가 위치를 먼저 아웃으로 옮긴 때를 놓친다 → 아웃 앞에 있었는지를 적어 둔다(armed).
    //  아웃 뒤에서 시작했거나 아웃 뒤로 훑었으면 꺼진 채라 끝까지 간 뒤(전체 끝) 구간 처음으로 들어온다(Codex 설계 검토).
    const arm = () => {
      const range = rangeNow();
      state.armed = !!range && now() < range.to;
    };
    // 지금 되풀이하는 범위 — 구간 반복이면 그 구간, 아니면 전체.
    const span = () => rangeNow() ?? { from: 0, to: live.current.layout.total };
    // 바퀴를 연다(재생을 누름 · 되돌아감) — 그때의 범위와, 그 처음(또는 그 앞)에서 시작하는지를 적는다. 중간에서 시작한 바퀴는
    //  온전한 바퀴가 아니다: 지나가지 않은 앞부분에 틀 것이 있는지 모른다.
    const openLap = () => {
      const { from, to } = span();
      state.lap = { from, to, whole: now() <= from + LAP_SLOP };
      state.flowed = 0;
    };
    // 반복 — 구간 처음(구간이 없으면 맨 처음)으로 돌아가 이어 튼다. 위치를 옮긴 것과 같게 다룬다: 영상이 그 자리에 닿을 때까지
    //  시간이 선다(같은 영상으로 되돌아오는 한 클립짜리도 같은 길 — 끝난 영상의 옛 시각을 시계로 읽지 않는다).
    //  빈 바퀴는 돌지 않는다 — 방금 돈 바퀴가 온전한데(처음에서 시작해 자리를 옮기지 않았고, 열 때의 범위가 지금도 그대로다)
    //  흐른 시간이 없으면, 틀 것이 하나도 없는 바퀴다(적어 둔 길이보다 짧은 영상을 넘기기만 했다 — 컷이 몇이든): 멈춘다.
    //  그냥 두면 프레임마다 넘기고 돌아오기만 되풀이해 '재생 중'인 채 화면의 시간이 선다. 온전하지 않은 바퀴는 판정하지 않고
    //  한 바퀴 더 돈다. 멈추는 자리는 돌아간 자리(바퀴의 처음 — 구간 반복이면 인)다: 넘긴 클립의 끝에 서면 재생헤드가 구간 밖에
    //  남는다.
    const loopBack = () => {
      const { from, to } = span();
      const { lap } = state;
      const empty = lap.whole && lap.from === from && lap.to === to && state.flowed === 0;
      const back = (pos.current = posAt(live.current.layout, from));
      if (empty) return stop(false);
      openLap();
      arm(); // 아웃 뒤에서 시작해 전체 끝을 돌아 들어온 때 — 다음 tick 전에 영상이 끝나도 구간을 지키게(Codex 코드 리뷰)
      sync(true);
      // 돌아간 자리의 영상을 곧바로 넘겨 이미 바퀴의 끝을 지났다 — 방금 연 바퀴가 흐른 시간 없이 끝난 것이다(같은 판정).
      //  넘긴 자리를 그리지 않고 여기서 멈춘다.
      if (now() >= to) {
        pos.current = back;
        return stop(false);
      }
      live.current.paint(now());
      state.frame = requestAnimationFrame(tick);
    };

    // passes = 이 프레임에 이미 클립을 넘긴 횟수(아래의 '한 번 더 본다'로 다시 불릴 때마다 하나씩 는다).
    const tick = (stamp: number, passes = 0) => {
      if (!state.playing || !pos.current) return;
      const { cuts } = live.current.layout;
      let slot = slotOf(pos.current.cut);
      if (!slot) return stop();
      let local = pos.current.local;
      const range = state.rate > 0 ? rangeNow() : null;
      if (!range) state.armed = false;
      else if (slot.start + local < range.to) state.armed = true;
      if (state.owner === "video") {
        // 영상이 시계 — 아직 목표 위치에 못 왔거나 버퍼링 중이면 시간도 선다.
        const video = videoRef.current;
        if (video && state.arrived === state.token) local = Math.max(0, clipTime(video));
      } else {
        local += (Math.max(0, stamp - state.last) / 1000) * state.rate;
      }
      // 이 걸음에 흐른 시간을 바퀴에 더한다(빈 바퀴 판정) — 걸음이 **지난 구간**에서, 무엇이 그 시간을 흘렸는지로 센다.
      //  · 구간의 끝은 바퀴의 끝에서 자른다: 넘긴 자리가 아웃 뒤일 수 있다 — 거기서 흐른 시간을 세면 구간 안에 틀 것이 없는데도
      //    계속 돈다(Codex 재리뷰). 아웃을 넘었는지는 아래의 되돌아가기 판정과 같은 식(타임라인 시각 = slot.start + local)으로
      //    본다 — 컷 안 시각으로 빼면 끝자리 오차만큼 아웃 뒤가 샌다.
      //  · 영상이 시계면 영상의 시각이 간 만큼이다(도착 전·받는 중이면 0). rAF 시계면 그 구간 가운데 틀 영상이 보이지 않는
      //    조각만이다(idleFlow) — 걸음이 크면 그 안에서 보이는 것이 바뀐다: 출발 자리만 보면 뒤에 나타난 그림을 놓친다.
      //  · 컷의 끝을 넘은 몫: rAF 는 조각이 그 컷 안에만 있어 저절로 빠진다. 영상의 시각이 끝을 조금 넘어 읽힌 몫은 남지만,
      //    영상이 시계였다면 그 걸음은 컷 안에서 출발했다 — 판정(0 인가)은 달라지지 않는다.
      if (state.rate > 0) {
        const from = slot.start + pos.current.local;
        const to = Math.min(slot.start + local, span().to);
        state.flowed += state.owner === "video" ? Math.max(0, to - from) : idleFlow(slot, from, to);
      }
      state.last = stamp;
      if (state.rate > 0 && local >= slot.len) {
        const next = cuts[cuts.indexOf(slot) + 1];
        if (!next && (live.current.loop || range)) return loopBack();
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
      if (range && state.armed && slot.start + local >= range.to) return loopBack();
      const at = (pos.current = { cut: slot.path, local });
      sync(false);
      // 이 프레임의 sync 가 그 클립을 넘겼다(passClip — 영상이 실제 끝에 닿은 것을 ended 보다 이 프레임이 먼저 봤다 · 드러난 영상이
      //  그 시각보다 짧다). 넘긴 자리를 그리지 않고 같은 프레임에 한 번 더 본다(지난 시간 0): 그 자리가 구간의 아웃·반복하는 끝을
      //  지났으면 곧바로 되돌아간다. 그리고 나서 다음 프레임에 되돌아가면, 재생헤드가 한 프레임 동안 구간 밖(그 클립의 끝)을
      //  가리키고 판의 영상이 가려졌다(2026-10-11 격리 실측). 넘길 때마다 위치가 앞으로만 가므로 끝이 있고, 한 프레임에 넘기는
      //  수에도 상한을 둔다(PASS_MAX) — 방금 넘긴 것까지 세어 상한에 닿았으면 넘긴 자리를 그리고 다음 프레임이 잇는다.
      if (pos.current !== at && passes + 1 < PASS_MAX) return tick(stamp, passes + 1);
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
      openLap();
      state.last = performance.now();
      arm();
      sync(true);
      state.frame = requestAnimationFrame(tick);
    };

    const seek = (time: number) => {
      wanted.current = null;
      pos.current = posAt(live.current.layout, time);
      state.lap.whole = false; // 자리를 옮겼다 — 이 바퀴는 처음부터 끝까지 지나간 바퀴가 아니다(빈 바퀴로 판정하지 않는다)
      arm();
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
      // 이미 도착한 소스의 메타데이터는 또 온 것이다(미리 받아 둔 요소를 앞으로 내놓은 직후) — 시계로 도는 영상을 되감지 않는다.
      if (!state.shown || !pos.current || !video || state.arrived === state.token) return;
      state.loaded = true;
      const target = aim(); // 받는 동안 위치가 또 바뀌었을 수 있다 — 항상 최신 목표로
      // 새로 받은 요소는 0 에 서 있다. 미리 그 자리에 세워 둔 요소는 다시 보내지 않는다 — 아직 가는 중이면(seeking) 시각은 이미
      //  목표를 가리키므로 도착은 seeked 가 알린다(Codex 설계 검토). 미리 굴려 둔 요소는 이미 돌고 있다 — 목표를 조금 지나
      //  있어도 되감지 않고 그대로 시계를 맡긴다(되감으면 그만큼 선다).
      const ahead = clipTime(video) - target;
      if (!video.paused && ahead >= 0 && ahead <= ROLL_SLOP * Math.abs(state.rate)) arrive();
      else if (astray(video, target)) send(video, target);
      else if (!video.seeking) arrive();
    };
    const onSeeked = () => {
      const video = videoRef.current;
      if (!state.shown || !pos.current || !video) return;
      // 탐색하는 동안 목표가 또 바뀌었으면(끌어서 훑기) 한 번 더 간다. 영상이 시계로 돌고 있을 때는 건드리지 않는다.
      //  여기서는 허용 오차만 본다(astray 의 '끝에 섰는데 자리는 그 앞'은 보지 않는다) — 탐색이 끝난 뒤에도 끝이면 다시 보내도
      //  같을 수 있고, seeked 마다 다시 보내면 끝이 없다. 그때는 도착으로 치고 over 가 넘긴다.
      const clock = state.owner === "video" && state.arrived === state.token;
      const target = aim();
      if (!clock && Math.abs(clipTime(video) - target) > SEEK_SLOP) send(video, target);
      else arrive();
    };
    const onEnded = () => {
      // 적어 둔 길이보다 영상이 먼저 끝났다 — 그 클립의 끝으로 보내 다음으로 넘어가게 한다. 마지막 프레임(tick) 뒤로 영상이 간
      //  만큼도 바퀴에 더한다: 한 프레임보다 짧게 돌고 끝나면 tick 은 그 걸음을 한 번도 못 본다. 시계로 돌던 영상이 끝났다는 것은
      //  끝까지 돌았다는 것이다 — 그 값이 0 으로 읽혀도 0 으로 치지는 않는다(끝에 선 영상은 애초에 시계가 되지 못한다 — over).
      //  바퀴의 끝(아웃) 뒤에서 돌다 끝난 것은 더하지 않는다 — tick 의 셈과 같은 자름이다(이 바퀴의 시간이 아니다).
      const video = videoRef.current;
      if (state.owner !== "video" || state.arrived !== state.token || !video || !pos.current) return;
      if (now() < span().to) state.flowed += Math.max(Number.EPSILON, clipTime(video) - pos.current.local);
      passClip();
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
      rememberPos(scoped.current, pos.current, placed.current, ephemeralRef.current);
      scoped.current = scope;
      pos.current = null;
      previousOrder.current = undefined;
      wanted.current = lastPos.get(scope) ?? null;
      run.current.failed.clear();
    }
    const back = wanted.current;
    if (back && layout.cuts.some((slot) => slot.path === back.cut)) {
      pos.current = back;
      wanted.current = null;
    }
    const settled = settlePos(layout, pos.current, order, doc.cutOrder, previousOrder.current);
    pos.current = settled.pos;
    placed.current = layout;
    if (order) previousOrder.current = order;
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
      rememberPos(scoped.current, pos.current, live.current.layout, ephemeralRef.current);
      state.playing = false;
      state.token++;
      state.shown = "";
      cancelAnimationFrame(state.frame);
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
        video.prepare?.(null, 0); // 미리 받던 것도 내려놓는다
      }
    };
  }, [stop, videoRef]);

  // 재생 중(정방향)에 배속을 바꾸면 바로 따른다 — 걸려 있던 구간 반복은 그대로 이어진다. 배속이 바뀔 때만 돈다
  //  (L 로 올려 둔 속도를 다른 렌더가 되돌리지 않는다).
  useEffect(() => {
    const state = run.current;
    if (!state.playing || state.rate < 0 || state.rate === speed) return;
    state.rate = speed;
    sync(false);
  }, [speed, sync]);

  return {
    view,
    now,
    seek,
    seekPos: useCallback((next: EditPos) => seek(timeOf(live.current.layout, next)), [seek]),
    stop: useCallback(() => stop(), [stop]),
    toggle: useCallback(() => (run.current.playing ? stop() : play(live.current.speed)), [play, stop]),
    // L / J — 같은 방향으로 다시 누르면 지금의 2배(최대 8배), 방향을 바꾸거나 멈춘 상태면 L 은 고른 배속·J 는 1배.
    shuttle: useCallback((dir: 1 | -1) => {
      const { playing, rate } = run.current;
      play(playing && Math.sign(rate) === dir ? dir * Math.min(8, Math.abs(rate) * 2) : dir > 0 ? live.current.speed : dir);
    }, [play]),
    stepFrames: useCallback((frames: number) => {
      stop();
      seek(now() + frames / EDIT_FPS);
    }, [now, seek, stop]),
    stepEdit: useCallback((dir: 1 | -1) => {
      seek(stepPoint(editPoints(live.current.layout), now(), dir));
    }, [now, seek]),
    // 구간 반복 재생을 켠다 — 구간을 먼저 엔진에 넣고(다음 렌더가 같은 값을 다시 넣는다) 그 처음으로 가서 정방향(고른 배속)으로 튼다.
    //  상태가 반영되기를 기다렸다 틀면 그 사이(첫 tick 전)에 영상이 끝난 때를 놓치고, 역재생 중이면 역방향이 이어진다(Codex 설계 검토).
    playRange: useCallback((next: { from: number; to: number }) => {
      live.current = { ...live.current, range: next };
      seek(next.from);
      play(live.current.speed);
    }, [play, seek]),
  };
}
