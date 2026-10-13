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
import { useDragKeyHold } from "../../lib/keyGate";
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

  const timeAt = (clientX: number) => {
    const rect = lanesRef.current?.getBoundingClientRect();
    return rect ? (clientX - rect.left) / zoom : 0;
  };
  // 더블클릭한 자리의 컷 — 클립·빈 자리·컷 이름·소리 줄 어디든 그 세로 칸의 컷이다. 눈금자는 재생헤드 몫이라 뺀다.
  const openCutAt = (event: ReactMouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest(".ed-ruler")) return;
    // 컷 머리를 끈 직후의 더블클릭(끌기 + 한 번 누르기를 브라우저가 두 번 누름으로 센 것)은 폴더 창을 열지 않는다
    if ((event.target as HTMLElement).closest(".ed-cutcell") && performance.now() - cutDragEnded.current < DBLCLICK_MS) return;
    const time = timeAt(event.clientX);
    const slot = layout.cuts.find((item) => time >= item.start && time < item.start + item.len);
    if (slot) onOpenCut(slot.path);
  };
  const scrub = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.type === "pointerdown") {
      if (event.button !== 0) return;
      event.stopPropagation(); // 눈금자를 눌러도 고른 클립은 그대로다
      event.currentTarget.setPointerCapture(event.pointerId);
    } else if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    onSeek(timeAt(event.clientX));
  };

  // 클립 끌기 — 6px 넘게 움직이면 끌기로 보고, 놓은 자리의 트랙으로 옮긴다(찬 자리면 맞바꿈).
  const drag = useRef<{ key: string; track: number; y: number; rev: number; moved: boolean } | null>(null);
  const clipDown = (event: ReactPointerEvent<HTMLElement>, key: string, from: number, locked: boolean, cut: string) => {
    event.stopPropagation(); // 오른쪽 단추도 — 우클릭(메뉴)이 고른 것을 풀지 않게(빈 자리를 누른 것이 아니다)
    if (event.button !== 0) return;
    onPickCut(cut); // 그림을 누르면 그 컷으로 간다(보는 것은 편집이 아니라 잠긴 트랙도 된다)
    if (locked) return; // 잠긴 트랙의 클립은 고르지도 못한다
    onSelect(key, event.ctrlKey || event.metaKey || event.shiftKey);
    drag.current = { key, track: from, y: event.clientY, rev, moved: false };
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
    current.moved = true;
    event.currentTarget.style.transform = `translateY(${dy}px)`;
    event.currentTarget.style.zIndex = "4";
  };
  const clipUp = (event: ReactPointerEvent<HTMLElement>, cancel = false) => {
    const current = drag.current;
    drag.current = null;
    event.currentTarget.style.transform = "";
    event.currentTarget.style.zIndex = "";
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
  const [cutDrag, setCutDrag] = useState<{ path: string; before: string | null } | null>(null); // 그리기용 — 놓을 자리의 원본은 cutPress
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
    press.before = cutBefore(clientX);
    setCutDrag((old) => (old && old.before === press.before ? old : { path: press.path, before: press.before }));
  };
  const endCutDrag = (drop: boolean) => {
    const press = cutPress.current;
    cutPress.current = null;
    cancelAnimationFrame(edgeFrame.current);
    if (!press?.moved) return;
    cutSwallow.current = true;
    cutDragEnded.current = performance.now();
    setCutDrag(null);
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
      edgeFrame.current = requestAnimationFrame(edgeScroll);
    }
    placeCutDrag(event.clientX);
  };
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
    // 줄인 클립의 '원본의 나머지' — 그 컷 안에 남는 만큼만 빗금으로 보인다(아래 트랙이 드러나는 구간이다). 누를 수 없다.
    const rest = (Math.min(clip.full, span) - clip.len) * zoom;
    return (
      <Fragment key={key}>
      {rest > 4 && <div className="ed-clip-rest" style={{ left: (start + clip.len) * zoom, width: rest - 1 }} />}
      <div
        className={"ed-clip" + (selected.has(key) ? " ed-sel" : "") + (off ? " ed-off" : "") +
          (state !== "ok" ? ` ed-${state}` : "") + (locked ? " ed-locked" : "") + (thin ? " ed-thin" : "")}
        style={{ left: start * zoom + pad, width: clipWidth }}
        title={link?.gen?.prompt?.slice(0, 80) || undefined}
        // 휠 클릭(가운데 단추) = 길이 조절 창(Jay 2026-10-13). 누름의 자동 스크롤은 줄 뿌리의 keepFocus 가 이미 막는다.
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          if (drag.current?.moved) return; // 끄는 중의 휠 클릭은 창을 열지 않는다(끌기는 이어진다)
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
          onClipMenu(key, event.clientX, event.clientY);
        }}
      >
        {state === "ok" && thumb
          ? Array.from({ length: frames }, (_, i) => <i key={i} style={{ backgroundImage: `url("${thumb}")` }} />)
          : <span className="ed-clip-msg">{state === "missing" ? t("미디어 없음") : state === "unknown" ? t("확인 못 함") : ""}</span>}
        {/* 길이를 줄였으면(휠 클릭) 쓰는 길이 / 원본 길이 */}
        <b>{clip.len.toFixed(1)}s{clip.len < clip.full ? ` / ${clip.full.toFixed(1)}s` : ""}</b>
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
        <div className="ed-lanes" ref={lanesRef} style={{ width }} onPointerDown={onClearSelection} onMouseDown={keepFocus}
          onDoubleClick={openCutAt}>
          <div className="ed-ruler" onPointerDown={scrub} onPointerMove={scrub}>
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
              <button type="button" key={slot.path} style={{ left: slot.start * zoom, width: slot.len * zoom }}
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
            <div className="ed-cutdrop"
              style={{ left: (layout.cuts.find((slot) => slot.path === cutDrag.before)?.start ?? layout.total) * zoom }} />
          )}
          {marks.band && <div className="ed-inout-shade" style={{ left: marks.band.from * zoom, width: (marks.band.to - marks.band.from) * zoom }} />}
          <div className="ed-phead" ref={headRef} />
        </div>
      </div>
    </div>
  );
});
