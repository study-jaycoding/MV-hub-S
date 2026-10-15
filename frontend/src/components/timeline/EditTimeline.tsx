// 편집 탭 아래쪽 — 눈금자(북마크·마크 인/아웃)·컷 줄·영상 트랙(위가 우선)·소리 줄과 재생헤드.
// 재생헤드는 부모가 ref 로 직접 옮긴다(프레임마다 React 렌더 없음). 클립은 좌우로 못 옮기고(자리는 그 컷이다) 위아래로 끌어
// 트랙만 바꾼다. 컷(폴더)의 순서는 컷 머리 칸을 좌우로 끌어 바꾼다(Jay 2026-10-13).
import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { Generation } from "../../types";
import {
  clipKey,
  cutDropTime,
  grabLabel,
  timecode,
  visibleSegments,
  type EditDoc,
  type EditLayout,
  type EditMarks,
  type MediaState,
  type PlaceState,
  type ShownMarker,
  type SlotClip,
} from "../../lib/editTimeline";
import { useT } from "../../lib/i18n";
import { pressStartedCovered, useDragKeyHold } from "../../lib/keyGate";
import { computeMarquee, marqueeHits, type MarqueeRect } from "../../lib/marquee";
import { thumbOf } from "../../lib/media";
import { useEscapeClose } from "../../lib/useEscapeClose";

export const ZOOM_MIN = 2; // px/초
export const ZOOM_MAX = 400;
const LANE_H = 58;
const DRAG_START = 6;
const RULER_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const EDGE_PX = 48; // 컷을 끄는 중 — 타임라인의 이만큼 안쪽 가장자리에 오면 그쪽으로 저절로 넘긴다
const EDGE_STEP = 14; // 한 프레임에 넘기는 px
const DBLCLICK_MS = 500; // 끈 직후의 더블클릭으로 치는 간격(운영체제 기본 더블클릭 시간쯤)
const FINAL_MARK_MIN = 28; // 최종 ★ 표(19px + 양옆 여백)가 들어가는 클립의 최소 폭(px)
const DV_MARK_MIN = 52; // '다빈치' 표가 들어가는 클립의 최소 폭(px) — 더 좁으면 빨간 테두리만
const NO_PICKS: ReadonlySet<string> = new Set();
const notPlaying = () => false;

export interface ClipLink {
  state: MediaState;
  gen: Generation | null;
}

// 풀의 카드를 끌어 트랙 줄 위에 올렸을 때 그 칸에 적는 글 — 휠 클릭 메뉴의 줄과 같은 판정(placeState)이다. 끄는 유령도 같은 글을 쓴다.
export interface DropHint {
  cut: string;
  track: number;
  state: PlaceState;
}
export function dropLabel(hint: Pick<DropHint, "track" | "state">, t: (text: string) => string): string {
  const { track, state } = hint;
  return state === "empty" ? t("V{track} 에 넣기").replace("{track}", String(track))
    : state === "taken" ? t("V{track} 교체").replace("{track}", String(track))
      : state === "here" ? t("지금 여기") : t("잠김 — 놓을 수 없음");
}

const trackTint = (color: string | undefined) => (color ? ({ "--trk": color } as CSSProperties) : undefined);

export const EditTimeline = memo(function EditTimeline({
  layout,
  doc,
  links,
  zoom,
  rev,
  selected,
  currentCut,
  offCuts,
  marks,
  markers,
  scrollRef,
  headRef,
  getNow,
  onSeek,
  onZoom,
  onSelect,
  onClearSelection,
  onPickMany,
  onMoveClip,
  onPickCut,
  onOpenCut,
  onToggleTrack,
  onToggleMute,
  onTrackMenu,
  onMarkerMenu,
  onClipMenu,
  onClipTrim,
  dropHint,
  onMoveCut,
  resolvePicked = NO_PICKS,
  resolveScroll = 0,
  isPlaying = notPlaying,
}: {
  layout: EditLayout;
  doc: EditDoc;
  links: ReadonlyMap<string, ClipLink>;
  zoom: number;
  rev: number; // 끌기를 시작한 뒤 문서가 갈렸으면 그 끌기는 버린다
  selected: ReadonlySet<string>;
  currentCut: string | null;
  offCuts: ReadonlySet<string>; // 비활성 컷(폴더) — 흐리게 그린다. 숨기기를 켜면 배치(layout)에 아예 없다
  marks: EditMarks;
  markers: readonly ShownMarker[]; // 북마크(보이는 것만, 시간순)
  scrollRef: RefObject<HTMLDivElement>;
  headRef: RefObject<HTMLDivElement>;
  getNow: () => number;
  onSeek: (time: number) => void;
  onZoom: (zoom: number) => void;
  onSelect: (key: string, additive: boolean) => void;
  onClearSelection: () => void;
  onPickMany: (keys: string[]) => void; // 끌어서 고르기의 결과 — 이 클립들을 고른다(더하기면 앞선 것도 들어 있다)
  onMoveClip: (key: string, track: number, rev: number) => void;
  onPickCut: (cut: string) => void; // 클립(그림)을 눌렀다 — 재생헤드가 다른 컷에 있으면 그 컷으로 옮긴다
  onOpenCut: (cut: string) => void; // 컷 자리(클립·빈 자리·컷 이름)를 더블클릭 — 그 컷의 생성물 창
  onToggleTrack: (list: "tracksOff" | "tracksLocked", track: number) => void;
  onToggleMute: () => void;
  onTrackMenu: (track: number, x: number, y: number) => void; // 트랙 머리를 우클릭 — 트랙 추가·삭제·옮기기·색
  onMarkerMenu: (key: string, x: number, y: number) => void; // 북마크를 더블클릭·우클릭 — 이름·색·지우기
  onClipMenu: (key: string, x: number, y: number) => void; // 클립을 우클릭 — Resolve 보내기
  onClipTrim: (key: string, x: number, y: number) => void; // 클립을 휠 클릭 — 길이 조절 창
  dropHint: DropHint | null; // 풀의 카드를 끌어 이 줄 위에 올렸다 — 그 카드의 컷 칸을 강조한다(끌기는 EditTab 이 쥔다)
  // 컷 머리 칸을 끌어 놓았다 — path 를 before 앞으로(before = 놓은 자리의 바로 뒤에 보이는 컷, null = 맨 뒤). rev = 끌기 시작 때의 것
  onMoveCut: (path: string, before: string | null, rev: number) => void;
  // 다빈치(미디어 풀)에서 고른 생성물(Jay 2026-10-14) — 그 클립에 빨간 테두리와 '다빈치' 표. 새로 고르면 화면 밖일 때만 거기까지 넘긴다
  resolvePicked?: ReadonlySet<string>;
  resolveScroll?: number; // 올라가면 그 클립까지 넘긴다(앱이 '따라가는 탭'에서만 올린다)
  isPlaying?: () => boolean; // 타임라인이 도는 중인가 — 그동안은 다빈치 선택으로 넘기지 않는다(재생헤드 따라가기가 앞선다)
}) {
  const t = useT();
  const lanesRef = useRef<HTMLDivElement>(null);
  const live = useRef({ zoom, onZoom, getNow });
  live.current = { zoom, onZoom, getNow };
  // 확대/축소 뒤에도 기준(커서 아래 시각, 없으면 재생헤드)이 화면의 같은 자리에 오게 한다.
  const anchor = useRef<{ time: number; offset: number } | null>(null);
  const zoomed = useRef(zoom);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || zoomed.current === zoom) return;
    const time = anchor.current?.time ?? getNow();
    const offset = anchor.current?.offset ?? time * zoomed.current - scroll.scrollLeft;
    scroll.scrollLeft = Math.max(0, time * zoom - offset);
    zoomed.current = zoom;
    anchor.current = null;
  });

  // 휠은 타임라인 안에서만 가로챈다 — Alt = 확대(커서 기준), Ctrl·Shift = 좌우. (React 의 onWheel 은 취소가 안 된다.)
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const onWheel = (event: WheelEvent) => {
      const delta = event.deltaY || event.deltaX;
      if (!delta) return;
      if (event.altKey) {
        event.preventDefault();
        const { zoom: current, onZoom: setZoom } = live.current;
        const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, current * (delta < 0 ? 1.15 : 1 / 1.15)));
        if (next === current) return;
        const offset = event.clientX - scroll.getBoundingClientRect().left;
        anchor.current = { time: (scroll.scrollLeft + offset) / current, offset };
        setZoom(next);
      } else if (event.ctrlKey || event.shiftKey) {
        event.preventDefault();
        scroll.scrollLeft += delta;
      }
    };
    scroll.addEventListener("wheel", onWheel, { passive: false });
    return () => scroll.removeEventListener("wheel", onWheel);
  }, [scrollRef]);

  // 다빈치에서 새로 고른 것이 화면 밖이면 그 클립까지 가로로 넘긴다(Jay 2026-10-14 ⓐ — 재생헤드·풀은 그대로). 고른 것이 바뀔 때만 —
  //  처음 그릴 때(편집 탭을 열 때)와 배치·확대가 바뀔 때는 넘기지 않는다(보던 자리를 끌어가지 않게). 재생 중에도 넘기지 않는다 —
  //  재생헤드 따라가기(EditTab.paint)가 다음 프레임에 되돌린다(Codex 리뷰). 보이는지는 컷이 아니라 그 클립으로 잰다(같은 컷의 긴 다른
  //  트랙 때문에 이미 보이는 클립을 두고 넘겼다 — Codex 리뷰). 신호(resolveScroll)는 표시(resolvePicked)와 따로다 — 표시는 모든 브라우저
  //  탭이 받지만 넘기기는 앱이 '따라가는 탭'에서만 올린다(다른 탭의 타임라인까지 움직였다 — Codex 리뷰). 클립·컷·상자를 누르거나 끄는
  //  중에도 넘기지 않는다(버린다) — 컷 끌기는 놓는 순간의 스크롤로 끼울 자리를 다시 재서, 끄는 사이 온 신호가 넘기면 겨냥한 자리가 아닌
  //  넘어간 화면의 컷 앞에 놓였다(Codex 39회차). 눈금자를 누른 채 훑는 중도 같다 — 다음 움직임의 시각이 넘어간 자리로 뛰었다(Codex 39회차 리뷰).
  const seenScroll = useRef(resolveScroll);
  useEffect(() => {
    if (seenScroll.current === resolveScroll) return;
    seenScroll.current = resolveScroll;
    const scroll = scrollRef.current;
    if (!scroll || !resolvePicked.size || isPlaying() || drag.current || cutPress.current || boxPress.current || scrubbing.current) return;
    for (const slot of layout.cuts) {
      const clip = slot.clips.find((item) => resolvePicked.has(links.get(clipKey(item))?.gen?.id ?? ""));
      if (!clip) continue;
      const left = slot.start * zoom;
      if (left < scroll.scrollLeft || (slot.start + Math.min(clip.len, slot.len)) * zoom > scroll.scrollLeft + scroll.clientWidth) {
        scroll.scrollLeft = Math.max(0, left - scroll.clientWidth / 3);
      }
      return;
    }
  }, [resolveScroll, resolvePicked, layout, links, zoom, scrollRef, isPlaying]);

  const timeAt = (clientX: number) => {
    const rect = lanesRef.current?.getBoundingClientRect();
    return rect ? (clientX - rect.left) / zoom : 0;
  };
  // 더블클릭한 자리의 컷 — 클립·빈 자리·컷 이름·소리 줄 어디든 그 세로 칸의 컷이다. 눈금자는 재생헤드 몫이라 뺀다.
  const openCutAt = (event: ReactMouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest(".ed-ruler")) return;
    // 끌어서 고른 직후의 더블클릭(끌기 + 한 번 누르기를 두 번 누름으로 센 것)도 — 줄 어디서든(Codex 설계 검토)
    if (performance.now() - marqueeEnded.current < DBLCLICK_MS) return;
    // 컷 머리를 끈 직후의 더블클릭(끌기 + 한 번 누르기를 브라우저가 두 번 누름으로 센 것)은 폴더 창을 열지 않는다
    if ((event.target as HTMLElement).closest(".ed-cutcell") && performance.now() - cutDragEnded.current < DBLCLICK_MS) return;
    const time = timeAt(event.clientX);
    const slot = layout.cuts.find((item) => time >= item.start && time < item.start + item.len);
    if (slot) onOpenCut(slot.path);
  };
  const scrubbing = useRef(false); // 눈금자를 누른 채 훑는 중 — 다빈치 넘김을 쉰다(위)
  const endScrub = () => {
    scrubbing.current = false;
  };
  const scrub = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.type === "pointerdown") {
      if (event.button !== 0) return;
      event.stopPropagation(); // 눈금자를 눌러도 고른 클립은 그대로다
      scrubbing.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    } else if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    else if (!(event.buttons & 1)) {
      // 왼쪽 단추가 떼어진 채 온 움직임 — 놓기를 놓쳤다(조작 규칙 21: 휠 단추를 같이 누른 채 왼쪽만 떼면 pointerup 이 안 와서 훑기와
      //  넘김 쉬기가 남았다 — Codex 39회차 재검토). 클립·컷 끌기와 같이 거기서 끝낸다.
      endScrub();
      event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    onSeek(timeAt(event.clientX));
  };

  // 끌어서 고르기(Jay 2026-10-14) — 영상 트랙 줄·A1 줄의 빈 곳에서 6px 넘게 끌면 상자다. 상자에 걸친 클립을 고른다(잠긴 트랙은
  //  뺀다 — 눌러서도 못 고른다). Ctrl·Shift 를 누른 채 시작하면 지금 고른 것에 더한다. 그 밑(누르기)은 지금처럼 고른 것을 푼다.
  //  풀의 끌어서 고르기와 같은 약속이다(조작 규칙 21): 놓친 끝·Esc·창이 초점을 잃음은 상자만 걷고 그때까지의 선택은 남긴다.
  //  재생헤드는 움직이지 않는다. 시작점은 줄 기준으로 적는다(줄은 스크롤과 함께 움직인다) — 끄는 사이 휠로 넘기거나 배율·배치가
  //  바뀌어도 그 자리로 다시 재고, 놓는 순간에도 한 번 더 잰다(Codex 설계 검토).
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
  const boxPress = useRef<{
    x: number; y: number; at: [number, number]; base: string[]; id: number; moved: boolean; rev: number; off: () => void;
  } | null>(null);
  const marqueeEnded = useRef(-Infinity);
  const measureMarquee = () => {
    const state = boxPress.current;
    const lanes = lanesRef.current;
    if (!state?.moved || !lanes) return;
    // 끄는 사이 문서가 갈렸다(다른 창의 변경·되돌리기) — 다른 끌기처럼 상자를 걷는다. 안 걷으면 더하기의 바탕(base)에 남은, 이제는 없는
    //  클립이 다시 고른 것에 들어간다(Codex 코드 리뷰). 고른 것은 그대로 둔다(부모가 없는 것을 이미 뺐다).
    if (state.rev !== rev) return endMarquee();
    const box = lanes.getBoundingClientRect();
    const { rect, b } = computeMarquee(lanes, { x: box.left + state.x, y: box.top + state.y }, { clientX: state.at[0], clientY: state.at[1] });
    setMarquee(rect);
    // 바탕도 지금 줄에 있는 클립만 — 배치만 바뀌어(숨김 컷 등) 사라진 클립이 되살아나지 않게
    const shown = new Set([...lanes.querySelectorAll<HTMLElement>(".ed-clip[data-clip]")].map((el) => el.dataset.clip));
    onPickMany([...marqueeHits<string>(lanes, ".ed-clip[data-clip]:not(.ed-locked)", b, state.base.filter((key) => shown.has(key)),
      (el) => el.dataset.clip)]);
  };
  const endMarquee = () => {
    const state = boxPress.current;
    boxPress.current = null;
    setMarquee(null);
    if (!state) return;
    state.off();
    const lanes = lanesRef.current;
    if (lanes?.hasPointerCapture(state.id)) lanes.releasePointerCapture(state.id);
    if (state.moved) marqueeEnded.current = performance.now();
  };
  const marqueeLive = useRef({ measure: measureMarquee, end: endMarquee });
  marqueeLive.current = { measure: measureMarquee, end: endMarquee };
  const lanesDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pressStartedCovered()) return; // 떠 있던 창·메뉴를 닫는 누름은 뒤 화면의 누름이 아니다(조작 규칙 4)
    const adding = event.ctrlKey || event.metaKey || event.shiftKey;
    if (!adding) onClearSelection(); // 빈 곳을 누르면 푼다(지금까지와 같다)
    if (event.button !== 0 || !(event.target as HTMLElement).closest(".ed-l-v, .ed-l-a")) return;
    endMarquee();
    const box = event.currentTarget.getBoundingClientRect();
    // 창이 초점을 잃으면 걷는다 — **누르는 순간부터**(6px 문턱 전에 잃고 돌아와 움직이면 상자가 시작됐다 — Codex 코드 리뷰)
    const blur = () => marqueeLive.current.end();
    window.addEventListener("blur", blur);
    boxPress.current = {
      x: event.clientX - box.left, y: event.clientY - box.top, at: [event.clientX, event.clientY],
      base: adding ? [...selected] : [], id: event.pointerId, moved: false, rev, off: () => window.removeEventListener("blur", blur),
    };
  };
  const lanesMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = boxPress.current;
    if (!state || event.pointerId !== state.id) return;
    if (!(event.buttons & 1)) return endMarquee(); // 왼쪽 단추가 떼어진 채 온 움직임 — 놓기를 놓쳤다(조작 규칙 21)
    state.at = [event.clientX, event.clientY];
    if (!state.moved) {
      const box = event.currentTarget.getBoundingClientRect();
      if (Math.hypot(event.clientX - box.left - state.x, event.clientY - box.top - state.y) < DRAG_START) return;
      state.moved = true;
      event.currentTarget.setPointerCapture(state.id);
    }
    measureMarquee();
  };
  const lanesUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = boxPress.current;
    if (!state || event.pointerId !== state.id) return;
    if (event.button === 0) {
      state.at = [event.clientX, event.clientY];
      measureMarquee(); // 놓는 순간의 자리·배치로 마지막으로 잰다
    }
    endMarquee(); // pointerup = 마지막 단추가 떼어졌다 — 끝이다
  };
  const marqueeOn = !!marquee;
  useEscapeClose(() => endMarquee(), marqueeOn, true, true);
  useDragKeyHold(marqueeOn);
  useEffect(() => {
    if (!marqueeOn) return;
    const scroll = scrollRef.current;
    const remeasure = () => marqueeLive.current.measure(); // 끄는 사이 휠로 넘김 — 상자와 고른 것을 그 자리로
    scroll?.addEventListener("scroll", remeasure);
    return () => scroll?.removeEventListener("scroll", remeasure);
  }, [marqueeOn, scrollRef]);
  useEffect(() => marqueeLive.current.measure(), [layout, zoom, rev]); // 끄는 사이 배율·배치(실측 길이)가 바뀜 · 문서가 갈리면 걷는다
  useEffect(() => () => marqueeLive.current.end(), []);

  // 끄는 동안 포인터 옆의 잡은 것 이름표(Jay 2026-10-15 11A ⓐ) — 클립 끌기·컷 순서 끌기. 많이 줄여 그 컷의 이름이 칸에 다 안 보일
  //  때만(컷 칸은 넘친 글자를 자른다) — 끌기를 시작할 때 한 번 잰다. 자리는 ref 로 옮긴다(움직일 때마다 다시 그리지 않는다).
  const [grab, setGrab] = useState<{ cut: string; key?: string } | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const tipAt = useRef<[number, number]>([0, 0]);
  const moveTip = (event?: { clientX: number; clientY: number }) => {
    if (event) tipAt.current = [event.clientX, event.clientY];
    const [x, y] = tipAt.current;
    const tip = tipRef.current;
    if (!tip) return;
    // 오른쪽에 자리가 없으면 포인터 왼쪽에 — 창 끝에서 이름표가 화면 밖으로 나갔다(Codex 11A 리뷰)
    const left = x + 12 + tip.offsetWidth > window.innerWidth ? x - 12 - tip.offsetWidth : x + 12;
    tip.style.transform = `translate(${left}px, ${y - 40}px)`;
  };
  const grabStart = (cut: string, key?: string) => {
    const cell = [...(lanesRef.current?.querySelectorAll<HTMLElement>(".ed-cutcell") ?? [])].find((el) => el.dataset.cut === cut);
    if (cell && cell.scrollWidth > cell.clientWidth) setGrab({ cut, key });
  };
  const grabText = grab && grabLabel(layout, grab.cut, grab.key);

  // 클립 끌기 — 6px 넘게 움직이면 끌기로 보고, 놓은 자리의 트랙으로 옮긴다(찬 자리면 맞바꿈).
  //  끄는 중(6px 를 넘긴 뒤)이라는 것은 상태로도 든다(clipDragging) — Esc 겹과 키 막기를 켜는 데 쓴다. 전에는 ref 뿐이라 Esc 가 고른 것만
  //  풀고 놓으면 그대로 옮겨졌고, 끄는 동안 Space·Delete 가 뒤에서 먹었다(Codex 코드 리뷰 3회째 — 카드·컷 끌기와 같은 규칙으로 맞춘다).
  const drag = useRef<{ key: string; cut: string; track: number; y: number; rev: number; moved: boolean; el: HTMLElement; id: number } | null>(null);
  const [clipDragging, setClipDragging] = useState(false);
  // 클립 끌기를 걷는다 — 누르기만 한 것(문턱 전)도. ref·요소의 스타일·포인터 쥐기·상태를 한 곳에서 정리한다(놓기·Esc·창이 초점을
  //  잃음·문서가 갈림·그 클립이 사라짐·다른 단추로 창을 엶 — Codex 코드 리뷰 4회째: 끌던 요소가 사라지면 놓는 이벤트가 오지 않아 끄는 중
  //  상태(키·메뉴 막기)가 남았고, 문턱 전에 휠 클릭으로 창을 열면 뒤에서 끌기가 살아났다).
  const cancelClipDrag = () => {
    const current = drag.current;
    drag.current = null;
    setClipDragging(false);
    if (!current) return;
    setGrab(null);
    current.el.style.transform = "";
    current.el.style.zIndex = "";
    if (current.el.hasPointerCapture(current.id)) current.el.releasePointerCapture(current.id);
  };
  const clipLive = useRef(cancelClipDrag);
  clipLive.current = cancelClipDrag;
  const clipDown = (event: ReactPointerEvent<HTMLElement>, key: string, from: number, locked: boolean, cut: string) => {
    event.stopPropagation(); // 오른쪽 단추도 — 우클릭(메뉴)이 고른 것을 풀지 않게(빈 자리를 누른 것이 아니다)
    if (event.button !== 0) return;
    onPickCut(cut); // 그림을 누르면 그 컷으로 간다(보는 것은 편집이 아니라 잠긴 트랙도 된다)
    if (locked) return; // 잠긴 트랙의 클립은 고르지도 못한다
    onSelect(key, event.ctrlKey || event.metaKey || event.shiftKey);
    drag.current = { key, cut, track: from, y: event.clientY, rev, moved: false, el: event.currentTarget, id: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const clipMove = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    // 왼쪽 단추가 떼어진 채 온 움직임 — 그 놓기는 오지 않았다. 다른 단추(휠)를 같이 누른 채 왼쪽만 떼면 pointerup 은 마지막 단추가
    //  떼일 때에야 온다: 그때까지 끌기가 이어지고, 나중에 휠을 떼는 것이 놓기가 됐다(같은 종류 — 컷 순서 끌기·카드 끌기, Codex 코드 리뷰 2회째).
    if (!(event.buttons & 1)) return clipUp(event, true);
    const dy = event.clientY - current.y;
    if (!current.moved && Math.abs(dy) < DRAG_START) return;
    if (!current.moved) {
      setClipDragging(true);
      grabStart(current.cut, current.key);
    }
    current.moved = true;
    moveTip(event);
    event.currentTarget.style.transform = `translateY(${dy}px)`;
    event.currentTarget.style.zIndex = "4";
  };
  const clipUp = (event: ReactPointerEvent<HTMLElement>, cancel = false) => {
    const current = drag.current;
    cancelClipDrag();
    if (!current?.moved || cancel) return;
    const lane = document.elementsFromPoint(event.clientX, event.clientY)
      .find((element) => element instanceof HTMLElement && element.dataset.track);
    const track = Number((lane as HTMLElement | undefined)?.dataset.track);
    if (track > 0 && track !== current.track) onMoveClip(current.key, track, current.rev);
  };

  // 컷(폴더) 순서 끌기(Jay 2026-10-13) — 컷 머리 칸을 좌우로 6px 넘게 끌면 순서 끌기다(그 밑은 누르기 = 그 컷으로 이동).
  //  끼울 자리 = 포인터가 가운데를 넘지 않은 첫 컷의 앞(없으면 맨 뒤). 제자리(자기 앞·바로 다음 컷의 앞)면 표시하지 않고, 놓아도
  //  아무 일도 없다. 옮기는 길은 놓기뿐이다 — Esc · 창이 초점을 잃음 · 단추가 떼어진 채 온 움직임 · 쥐기를 잃음 · 그사이 문서가
  //  갈림(rev) · 끌던 컷이 사라짐은 전부 버린다. 끄는 동안 재생·편집 키는 쉰다(Esc 겹이 켜져 있다 — lib/useEscapeClose).
  // 그리기용 — 놓을 자리의 원본은 cutPress. side = 끼울 자리가 화면 밖이면 그쪽(Jay 2026-10-15 11A ⓑ — 가장자리에 '끼울 자리 ▶')
  const [cutDrag, setCutDrag] = useState<{ path: string; before: string | null; side: "left" | "right" | null } | null>(null);
  const cutPress = useRef<{
    path: string; x: number; at: number; rev: number; moved: boolean; el: HTMLElement; id: number; before: string | null;
  } | null>(null);
  const cutSwallow = useRef(false); // 끈 뒤에 따라오는 click 한 번은 누르기가 아니다(조작 규칙 36)
  const cutDragEnded = useRef(-Infinity);
  const edgeFrame = useRef(0);
  const cutStays = (path: string, before: string | null) => {
    const index = layout.cuts.findIndex((slot) => slot.path === path);
    return before === path || before === (layout.cuts[index + 1]?.path ?? null);
  };
  // 포인터 밑의 끼울 자리 — **지금의** 스크롤·배율·배치로 잰다
  const cutBefore = (clientX: number) => {
    const time = timeAt(clientX);
    return layout.cuts.find((slot) => time < slot.start + slot.len / 2)?.path ?? null;
  };
  const placeCutDrag = (clientX: number) => {
    const press = cutPress.current;
    if (!press) return;
    const before = cutBefore(clientX);
    press.before = before;
    // 끼울 자리가 보이는 칸 밖인가 — 위에서 줄의 자리를 잰 뒤라 스크롤 값을 읽어도 배치를 다시 계산하지 않는다
    const view = scrollRef.current;
    const x = cutDropTime(layout, before) * zoom;
    const side = !view || cutStays(press.path, before) ? null
      : x < view.scrollLeft ? "left" : x > view.scrollLeft + view.clientWidth ? "right" : null;
    setCutDrag((old) => (old && old.before === before && old.side === side ? old : { path: press.path, before, side }));
  };
  const endCutDrag = (drop: boolean) => {
    const press = cutPress.current;
    cutPress.current = null;
    cancelAnimationFrame(edgeFrame.current);
    if (!press?.moved) return;
    cutSwallow.current = true;
    cutDragEnded.current = performance.now();
    setCutDrag(null);
    setGrab(null);
    if (press.el.hasPointerCapture(press.id)) press.el.releasePointerCapture(press.id);
    if (!drop) return;
    // 놓는 순간에 다시 잰다 — 적어 둔 자리(press.before)는 마지막으로 움직였을 때의 것이라, 포인터를 멈춘 채 휠로 넘겼거나 그사이
    //  길이가 고쳐 적혀 배치가 밀렸으면 포인터 밑의 컷이 아니다(Codex 코드 리뷰 2회째)
    const before = cutBefore(press.at);
    if (!cutStays(press.path, before)) onMoveCut(press.path, before, press.rev);
  };
  const cutLive = useRef({ place: placeCutDrag, end: endCutDrag });
  cutLive.current = { place: placeCutDrag, end: endCutDrag };
  // 끄는 동안 프레임마다 끼울 자리를 다시 잡는다 — 포인터가 멈춰 있어도 밑의 컷은 바뀐다(가장자리에서 저절로 넘기기 · 휠로 넘기기·
  //  확대 · 실측 길이가 와서 배치가 밀림). 자리가 같으면 다시 그리지 않는다(placeCutDrag)
  const edgeScroll: () => void = useRef(() => {
    const press = cutPress.current;
    const scroll = scrollRef.current;
    if (!press?.moved || !scroll) return;
    const rect = scroll.getBoundingClientRect();
    const step = press.at < rect.left + EDGE_PX ? -EDGE_STEP : press.at > rect.right - EDGE_PX ? EDGE_STEP : 0;
    if (step) scroll.scrollLeft += step;
    cutLive.current.place(press.at);
    edgeFrame.current = requestAnimationFrame(edgeScroll);
  }).current;
  const cutDown = (event: ReactPointerEvent<HTMLElement>, path: string) => {
    event.stopPropagation();
    cutSwallow.current = false; // 새 누름이다 — 앞 끌기에 딸린 click 은 이미 지나갔다
    if (event.button !== 0) return;
    cutPress.current = {
      path, x: event.clientX, at: event.clientX, rev, moved: false, el: event.currentTarget, id: event.pointerId, before: path,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const cutMove = (event: ReactPointerEvent<HTMLElement>) => {
    const press = cutPress.current;
    if (!press || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    // 왼쪽 단추가 떼어진 채 온 움직임 — 놓는 이벤트를 놓쳤다(조작 규칙 21). 다른 단추(휠)가 아직 눌려 있어도 같다: 그때는
    //  pointerup 없이 움직임만 온다 — 뒤에 그 단추를 떼는 것이 놓기가 되지 않게 여기서 버린다
    if (!(event.buttons & 1)) return endCutDrag(false);
    press.at = event.clientX;
    if (!press.moved) {
      if (Math.abs(event.clientX - press.x) < DRAG_START) return;
      press.moved = true;
      grabStart(press.path);
      edgeFrame.current = requestAnimationFrame(edgeScroll);
    }
    moveTip(event);
    placeCutDrag(event.clientX);
  };
  // 클립 끌기 — Esc 는 끌기를 버린다(제자리로). 그 뒤의 놓기는 아무것도 옮기지 않는다(drag 가 비어 있다).
  useEscapeClose(() => cancelClipDrag(), clipDragging, true, true);
  useDragKeyHold(clipDragging);
  useEffect(() => {
    if (!clipDragging) return;
    const cancel = () => clipLive.current();
    window.addEventListener("blur", cancel);
    return () => window.removeEventListener("blur", cancel);
  }, [clipDragging]);
  // 누르거나 끄는 사이 문서가 갈렸거나(rev) 그 클립이 화면에서 사라졌으면(다른 창이 지움·그 컷 폴더가 없어짐) 걷는다 — 쥐고 있던
  //  요소가 없어지면 놓는 이벤트를 받을 곳이 없다
  useEffect(() => {
    const current = drag.current;
    if (current && (current.rev !== rev || !current.el.isConnected)) clipLive.current();
  }, [rev, layout]);
  const cutDragging = !!cutDrag;
  useEscapeClose(() => endCutDrag(false), cutDragging, true, true);
  useDragKeyHold(cutDragging); // 초점이 남은 뒤의 단추(누른 컷 칸 포함)를 Space·Enter 가 누르지 않게
  useEffect(() => {
    if (!cutDragging) return;
    const cancel = () => cutLive.current.end(false);
    window.addEventListener("blur", cancel);
    return () => window.removeEventListener("blur", cancel);
  }, [cutDragging]);
  useEffect(() => {
    const press = cutPress.current;
    if (press && (press.rev !== rev || !layout.cuts.some((slot) => slot.path === press.path))) cutLive.current.end(false);
  }, [rev, layout]);
  useEffect(() => () => cancelAnimationFrame(edgeFrame.current), []);

  const width = Math.max(layout.total * zoom + 120, 0);
  const step = RULER_STEPS.find((seconds) => seconds * zoom >= 90) ?? RULER_STEPS[RULER_STEPS.length - 1];
  const ticks: number[] = [];
  for (let time = 0; time <= layout.total + step; time += step) ticks.push(time);
  const tracks = Array.from({ length: layout.tracks }, (_, i) => layout.tracks - i); // 위에서부터
  const keepFocus = (event: ReactMouseEvent) => event.preventDefault();
  const hintSlot = dropHint ? layout.cuts.find((slot) => slot.path === dropHint.cut) : undefined;

  // span = 그 컷의 길이. 꺼진 클립은 컷보다 길 수 있어(컷 길이는 켜진 클립만 센다) 컷의 끝에서 잘라 그린다 — 다음 컷을 덮지 않게.
  const renderClip = (clip: SlotClip, start: number, span: number) => {
    const key = clipKey(clip);
    const link = links.get(key);
    const state = link?.state ?? "unknown";
    const locked = doc.tracksLocked.includes(clip.track);
    const off = !!clip.off || doc.tracksOff.includes(clip.track) || offCuts.has(clip.cut);
    // 잡기 쉬운 최소 폭(6px)보다 컷의 경계가 먼저다 — 한 프레임짜리 컷에서 6px 로 늘리면 다음 컷 자리를 덮고 거기서 눌린다
    //  (Codex 코드 리뷰 2026-10-13). 아주 좁은 컷에서는 옆 여백(1px)도, 폭의 하한도 없다(1px 로 올려도 컷이 0.8px 이면 넘친다).
    //  테두리가 폭보다 넓어지는 좁은 클립은 테두리 없이 그린다(.ed-thin — 테두리 2px·고른 것 4px 는 폭을 줄여도 남는다).
    const room = span * zoom;
    const pad = room > 4 ? 1 : 0;
    const clipWidth = Math.max(0, Math.min(Math.max(6, clip.len * zoom - 2), room - pad * 2));
    const thin = clipWidth < 6;
    const thumb = link?.gen ? thumbOf(link.gen, 256) : null;
    const frames = Math.min(16, Math.max(1, Math.round(clipWidth / ((LANE_H - 6) * (16 / 9)))));
    // 줄인 클립의 '원본의 나머지'(뒤) — 그 컷 안에 남는 만큼만 빗금으로 보인다(아래 트랙이 드러나는 구간이다). 누를 수 없다.
    //  앞을 자른 만큼(clip.head)은 나머지가 아니다 — 원본에서 시작점 뒤로 남은 길이(full − head)로 센다.
    const rest = (Math.min(clip.full - clip.head, span) - clip.len) * zoom;
    const resolved = !!link?.gen && resolvePicked.has(link.gen.id); // 다빈치에서 고른 것
    return (
      <Fragment key={key}>
      {rest > 4 && <div className="ed-clip-rest" style={{ left: (start + clip.len) * zoom, width: rest - 1 }} />}
      <div
        className={"ed-clip" + (selected.has(key) ? " ed-sel" : "") + (off ? " ed-off" : "") +
          (state !== "ok" ? ` ed-${state}` : "") + (locked ? " ed-locked" : "") + (thin ? " ed-thin" : "") + (resolved ? " ed-dv" : "")}
        style={{ left: start * zoom + pad, width: clipWidth }}
        data-clip={key} // 길이 조절 창이 이 클립의 화면 자리를 잰다(EditTab.openTrim)
        title={link?.gen?.prompt?.slice(0, 80) || undefined}
        // 휠 클릭(가운데 단추) = 길이 조절 창(Jay 2026-10-13). 누름의 자동 스크롤은 줄 뿌리의 keepFocus 가 이미 막는다.
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          if (drag.current?.moved) return; // 끄는 중의 휠 클릭은 창을 열지 않는다(끌기는 이어진다)
          cancelClipDrag(); // 누르기만 한(문턱 전) 끌기는 걷는다 — 창이 뜬 뒤 왼쪽을 누른 채 움직이면 뒤에서 끌기가 살아났다
          onClipTrim(key, event.clientX, event.clientY);
        }}
        onPointerDown={(event) => clipDown(event, key, clip.track, locked, clip.cut)}
        onPointerMove={clipMove}
        onPointerUp={(event) => clipUp(event, event.button !== 0)} // 끌기를 시작한 왼쪽 단추의 놓기만 확정이다
        onPointerCancel={(event) => clipUp(event, true)}
        // 놓는 이벤트를 놓쳤다(창 밖에서 뗌 등) — 브라우저가 쥐기를 거두며 이것만 보낸다. 안 들으면 클립이 끌던 만큼 어긋난 채 남았다
        //  (2026-10-12 격리 실측 3/3 — 그 클립을 다시 눌러야 풀렸다). 끝점이 없으니 옮기지 않는다. 보통의 놓기 뒤에도 오지만 그때는 할 일이 없다.
        onLostPointerCapture={(event) => clipUp(event, true)}
        onContextMenu={(event) => {
          event.preventDefault();
          if (drag.current?.moved) return; // 끄는 중의 우클릭은 메뉴를 열지 않는다
          cancelClipDrag();
          onClipMenu(key, event.clientX, event.clientY);
        }}
      >
        {state === "ok" && thumb
          ? Array.from({ length: frames }, (_, i) => <i key={i} style={{ backgroundImage: `url("${thumb}")` }} />)
          : <span className="ed-clip-msg">{state === "missing" ? t("미디어 없음") : state === "unknown" ? t("확인 못 함") : ""}</span>}
        {/* 최종 ★ 표(오른쪽 위)와 겹치지 않을 폭이어야 한다(Codex 리뷰) — 모자라면 빨간 테두리만 */}
        {resolved && clipWidth >= DV_MARK_MIN + (link?.gen?.is_final ? FINAL_MARK_MIN : 0) && <span className="ed-clip-dv">{t("다빈치")}</span>}
        {/* 앞을 자른 클립(Jay 2026-10-14) — 왼쪽 가장자리의 빗금: 원본의 처음에서 시작하지 않는다. 표시만 한다 */}
        {clip.head > 0 && <span className="ed-clip-head" aria-hidden="true" />}
        {/* 길이를 줄였으면(휠 클릭) 쓰는 길이 / 원본 길이 */}
        <b>{clip.len.toFixed(1)}s{clip.len < clip.full ? ` / ${clip.full.toFixed(1)}s` : ""}</b>
        {/* 최종(★) — 풀의 카드와 같은 금색 표(Jay 2026-10-14). 표시만 한다(누름은 클립이 받는다). 표보다 좁은 클립에는 그리지 않는다 */}
        {link?.gen?.is_final && clipWidth >= FINAL_MARK_MIN && (
          <span className="ed-clip-final" role="img" aria-label={t("최종")}>
            <svg className="card-final-star" viewBox="2 0 96 91" aria-hidden="true" focusable="false">
              <polygon points="50,0 61,35 98,35 68,57 79,91 50,70 21,91 32,57 2,35 39,35" />
            </svg>
          </span>
        )}
      </div>
      </Fragment>
    );
  };

  return (
    <div className="ed-tl">
      <div className="ed-heads" onMouseDown={keepFocus}>
        <div className="ed-head ed-h-ruler" />
        <div className="ed-head ed-h-cut"><b>{t("컷")}</b>{t("폴더")}</div>
        {tracks.map((track) => {
          const locked = doc.tracksLocked.includes(track);
          const off = doc.tracksOff.includes(track);
          return (
            <div className="ed-head ed-h-v" key={track} style={trackTint(doc.trackColors?.[track])}
              title={t("우클릭 — 트랙 추가·삭제·옮기기·색")}
              onContextMenu={(event) => {
                event.preventDefault();
                onTrackMenu(track, event.clientX, event.clientY);
              }}>
              <b>V{track}</b>
              <button type="button" className={"ed-hbtn" + (locked ? " ed-on" : "")} aria-pressed={locked}
                title={locked ? t("잠금 풀기") : t("트랙 잠그기")} aria-label={locked ? t("잠금 풀기") : t("트랙 잠그기")}
                onClick={() => onToggleTrack("tracksLocked", track)}>
                <svg width="11" height="12" viewBox="0 0 11 12" aria-hidden="true">
                  <rect x="1.5" y="5" width="8" height="6" rx="1.2" />
                  <path d={locked ? "M3.2 5V3.6a2.3 2.3 0 0 1 4.6 0V5" : "M3.2 5V3.6a2.3 2.3 0 0 1 4.4-.9"} fill="none" strokeWidth="1.3" />
                </svg>
              </button>
              <button type="button" className={"ed-hbtn" + (off ? " ed-dim" : "")} aria-pressed={!off}
                title={off ? t("트랙 켜기") : t("트랙 끄기")} aria-label={off ? t("트랙 켜기") : t("트랙 끄기")}
                onClick={() => onToggleTrack("tracksOff", track)}>
                <svg width="14" height="11" viewBox="0 0 14 11" aria-hidden="true">
                  <rect x="1" y="1" width="12" height="9" rx="1.6" fill="none" strokeWidth="1.3" />
                  {!off && <rect x="3.4" y="3.3" width="7.2" height="4.4" rx="0.6" />}
                </svg>
              </button>
            </div>
          );
        })}
        <div className="ed-head ed-h-a">
          <b>A1</b>
          <button type="button" className={"ed-hbtn ed-mute" + (doc.muted ? " ed-on" : "")} aria-pressed={!!doc.muted}
            title={t("소리 끄기")} aria-label={t("소리 끄기")} onClick={onToggleMute}>M</button>
        </div>
      </div>
      <div className="ed-scroll" ref={scrollRef}>
        <div className="ed-lanes" ref={lanesRef} style={{ width }} onPointerDown={lanesDown} onPointerMove={lanesMove}
          onPointerUp={lanesUp} onPointerCancel={endMarquee} onLostPointerCapture={() => boxPress.current?.moved && endMarquee()}
          onMouseDown={keepFocus} onDoubleClick={openCutAt}>
          {marquee && <div className="assets-marquee" style={{ left: marquee.l, top: marquee.t, width: marquee.w, height: marquee.h }} />}
          <div className="ed-ruler" onPointerDown={scrub} onPointerMove={scrub}
            onPointerUp={endScrub} onPointerCancel={endScrub} onLostPointerCapture={endScrub}>
            {ticks.map((time) => (
              <div className="ed-tick" key={time} style={{ left: time * zoom }}><span>{timecode(time)}</span></div>
            ))}
            {/* 마크 인/아웃 — 막대는 구간, 양 끝의 둥근 점은 인·아웃 자리(다빈치). 표시만 한다(누르면 눈금자가 받는다). */}
            {marks.band && <div className="ed-inout" style={{ left: marks.band.from * zoom, width: (marks.band.to - marks.band.from) * zoom }} />}
            {marks.in !== null && <div className="ed-mark ed-mark-in" style={{ left: marks.in * zoom }} />}
            {marks.out !== null && <div className="ed-mark ed-mark-out" style={{ left: marks.out * zoom }} />}
            {/* 북마크 — 누르면 그 자리로, 더블클릭·우클릭하면 편집 창 */}
            {markers.map((item) => (
              <button type="button" key={item.key} className="ed-mk"
                style={{ left: item.time * zoom, ...(item.marker.color ? { "--mk": item.marker.color } : {}) } as CSSProperties}
                title={`${t("북마크")} ${timecode(item.time)}${item.marker.name ? ` — ${item.marker.name}` : ""}`}
                aria-label={`${t("북마크")} ${timecode(item.time)}${item.marker.name ? ` — ${item.marker.name}` : ""}`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onSeek(item.time)}
                onDoubleClick={(event) => onMarkerMenu(item.key, event.clientX, event.clientY)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onMarkerMenu(item.key, event.clientX, event.clientY);
                }} />
            ))}
          </div>
          <div className="ed-lane ed-l-cut">
            {layout.cuts.map((slot) => (
              // 컷 이름 = 폴더. 누르면 그 컷 처음으로 가고 클립 고르기를 푼다 — 이어서 누르는 D 가 이 폴더에 걸린다.
              //  좌우로 끌면 폴더의 순서를 바꾼다(위의 컷 순서 끌기).
              <button type="button" key={slot.path} style={{ left: slot.start * zoom, width: slot.len * zoom }} data-cut={slot.path}
                className={"ed-cutcell" + (slot.path === currentCut ? " ed-cur" : "") + (slot.clips.length ? "" : " ed-nopick") +
                  (offCuts.has(slot.path) ? " ed-cutoff" : "") + (cutDrag?.path === slot.path ? " ed-cutdrag" : "")}
                title={`${offCuts.has(slot.path) ? `${slot.path} — ${t("비활성 폴더")}` : slot.path} · ${t("끌어서 순서 바꾸기")}`}
                onPointerDown={(event) => cutDown(event, slot.path)}
                onPointerMove={cutMove}
                onPointerUp={(event) => endCutDrag(event.button === 0)}
                onPointerCancel={() => endCutDrag(false)}
                onLostPointerCapture={() => endCutDrag(false)}
                onClick={() => {
                  if (cutSwallow.current) {
                    cutSwallow.current = false; // 건너뛰는 것은 그 끌기에 딸린 한 번뿐이다
                    return;
                  }
                  onClearSelection();
                  onSeek(slot.start);
                }}>
                {slot.name}
              </button>
            ))}
          </div>
          {tracks.map((track) => (
            <div className={"ed-lane ed-l-v" + (doc.tracksOff.includes(track) ? " ed-lane-off" : "")} key={track} data-track={track}
              style={trackTint(doc.trackColors?.[track])}>
              {layout.cuts.map((slot) => {
                const clip = slot.clips.find((item) => item.track === track);
                if (clip) return renderClip(clip, slot.start, slot.len);
                // 고르지 않은 컷은 V1 에 빈 자리로만 보인다.
                return track === 1 && !slot.clips.length ? (
                  <div className={"ed-slot" + (offCuts.has(slot.path) ? " ed-slot-off" : "")} key={slot.path}
                    title={t("더블클릭하면 이 컷의 생성물 창이 열립니다 — 카드를 휠 클릭해 넣을 트랙을 고릅니다.")}
                    style={{ left: slot.start * zoom + 1, width: Math.max(6, slot.len * zoom - 2) }}>
                    {slot.len * zoom > 60 ? (offCuts.has(slot.path) ? t("비활성") : t("비어 있음")) : ""}
                  </div>
                ) : null;
              })}
              {/* 풀의 카드를 끌어 이 줄 위에 올렸다 — 들어갈 칸(그 카드의 컷)과 무슨 일이 생기는지. 가로 위치는 보지 않는다 */}
              {dropHint?.track === track && hintSlot && (
                <div className={`ed-drop ed-drop-${dropHint.state}`}
                  style={{ left: hintSlot.start * zoom + 1, width: Math.max(6, hintSlot.len * zoom - 2) }}>
                  {dropLabel(dropHint, t)}
                </div>
              )}
              {/* 컷을 끄는 중 끼울 자리가 화면 밖 — 그쪽 가장자리에(V1 줄 안에서 sticky 로 보이는 칸의 끝에 붙는다 — 프레임마다 옮기지 않는다) */}
              {track === 1 && cutDrag?.side && (
                <div className={`ed-edgemark ed-edgemark-${cutDrag.side}`} aria-hidden="true">
                  {cutDrag.side === "left" ? `◀ ${t("끼울 자리")}` : `${t("끼울 자리")} ▶`}
                </div>
              )}
            </div>
          ))}
          <div className={"ed-lane ed-l-a" + (doc.muted ? " ed-lane-off" : "")}>
            {layout.cuts.flatMap((slot) =>
              visibleSegments(doc, slot)
                .filter((segment) => segment.clip && links.get(clipKey(segment.clip))?.gen?.assets[0]?.type === "video")
                .map((segment) => (
                  <div className="ed-aud" key={`${slot.path}:${segment.from}`}
                    style={{ left: (slot.start + segment.from) * zoom + 1, width: Math.max(4, (segment.to - segment.from) * zoom - 2) }} />
                )))}
          </div>
          {layout.cuts.map((slot) => <div className="ed-cutline" key={slot.path} style={{ left: slot.start * zoom }} />)}
          <div className="ed-cutline" style={{ left: layout.total * zoom }} />
          {/* 컷을 끄는 중 — 놓으면 끼워질 자리 */}
          {cutDrag && !cutStays(cutDrag.path, cutDrag.before) && (
            <div className="ed-cutdrop" style={{ left: cutDropTime(layout, cutDrag.before) * zoom }} />
          )}
          {marks.band && <div className="ed-inout-shade" style={{ left: marks.band.from * zoom, width: (marks.band.to - marks.band.from) * zoom }} />}
          <div className="ed-phead" ref={headRef} />
        </div>
      </div>
      {grabText && (
        <div className="ed-grabtip" aria-hidden="true" ref={(el) => {
          tipRef.current = el;
          moveTip();
        }}>{grabText}</div>
      )}
    </div>
  );
});
