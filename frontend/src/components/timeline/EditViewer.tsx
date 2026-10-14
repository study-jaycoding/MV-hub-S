// 편집 탭의 뷰어 한 판(Jay 2026-10-08, 다빈치의 뷰어) — 위 줄(지금 시각 · 무엇을 볼지 · 전체 길이 · 싱글/듀얼), 무대,
//  아래 줄(타임바 · 처음·역재생·정지·재생·끝·반복 · 오른쪽에 소리 크기). 타임라인·소스·한 트랙만 보기가 같은 판을 쓴다.
//  구간 반복·마크 인·마크 아웃은 위 막대의 다이나믹 트림 단추 왼쪽으로 옮겼다(Jay 2026-10-14).
//  판은 '무엇을 그릴지'(shown)와 조작 함수만 받는다 — 시계는 편집 탭이 가진 엔진(타임라인·소스)의 것이다.
//  `<video>` 는 판마다 하나고 떼지 않는다(떼면 재생 훅이 걸어 둔 이벤트와 주소가 사라진다) — 안 보이는 판은 hidden 으로 둔다.
//  지금 시각과 타임바 머리는 React 를 거치지 않고, 등록해 둔 그리기 함수가 프레임마다 고친다.
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { timecode, type EditMarks } from "../../lib/editTimeline";
import { isSourceView, type ViewMode } from "../../lib/editTimelineStore";
import { useT } from "../../lib/i18n";
import type { EditShown } from "../../lib/useEditFollow";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { useOutsideMouseDown } from "../../lib/useOutsideMouseDown";

// 프레임마다 고치는 글자(타임코드) — **있는 글자 노드의 값만** 바꾼다. `textContent` 로 쓰면 글자 노드를 갈아 끼우는 일(자식 목록
//  변경)이라 브라우저가 문서 전체의 스타일을 다시 계산한다: 재생 중 프레임마다 약 7ms 씩(클립 300·DOM 5,727, 2026-10-13 격리 실측 —
//  같은 글자를 nodeValue 로 쓰면 0ms). 글자가 그대로면 쓰지 않는다(타임코드는 초당 24번만 바뀐다).
export function writeText(el: Element | null, text: string): void {
  if (!el) return;
  const node = el.firstChild;
  if (node && node.nodeType === Node.TEXT_NODE && !node.nextSibling) {
    if (node.nodeValue !== text) node.nodeValue = text;
  } else el.textContent = text;
}

export interface ViewOption {
  value: ViewMode;
  label: string;
  hint?: string;
}
export interface ViewerControls {
  toggle: () => void;
  stop: () => void;
  shuttle: (dir: 1 | -1) => void;
  seek: (time: number) => void; // 재생바 누르기·끌기 — 이 판만(다이나믹 재생 모드에서도)
  edge: (end: boolean) => void; // 처음으로·끝으로 단추 — 다이나믹 재생 모드면 두 판 같이(2026-10-14)
}
export interface ViewerProps {
  order: number; // 보이는 자리(0 = 왼쪽). -1 = 안 보인다(요소는 남는다)
  place?: 0 | 1; // 판 자리(왼쪽 0 · 오른쪽 1 — 싱글이면 1). 카드를 놓은 판을 찾는다(data-place)
  mode: ViewMode;
  options: ViewOption[];
  onMode: (next: ViewMode) => void;
  shown: EditShown;
  videoRef: RefObject<HTMLVideoElement>;
  spareRef?: RefObject<HTMLVideoElement>; // 다음 영상을 미리 받아 둘 두 번째 요소(editVideoPair) — 자기 시계로 이어 트는 판만
  muted: boolean;
  playing: boolean;
  rate: number; // 음수 = 역방향
  total: number; // 전체 길이(초)
  marks: readonly number[]; // 타임바의 얇은 줄(소스 테이프의 클립 경계, 초)
  io?: EditMarks | null; // 마크 인/아웃 — 타임바 위의 구간 선과 아래의 회색 꼬리표
  flags?: readonly { time: number; color?: string }[]; // 북마크 — 타임바 위의 색 꼬리표
  over?: ReactNode; // 무대를 덮는 것 — 밑의 영상 요소는 그대로 둔다
  registerPaint: (paint: (time: number) => void) => () => void; // 이 판의 시각·타임바를 그릴 함수를 시계에 건다
  controls: ViewerControls;
  loop: boolean;
  onLoop: () => void;
  speed: number; // 재생 배속 — 누르면 다음 값으로(onSpeed)
  onSpeed: () => void;
  volume: number; // 소리 크기 0~1 — 판의 영상 요소에 그대로 건다(끄고 켜기는 muted 가 따로 한다)
  onVolume: (volume: number) => void;
  label: string; // 'e070 / c0050 · V3'
  detail: string; // '만든 사람 · 모델 · 5.0s'
  empty: string | null; // 그릴 것이 없을 때의 안내(있으면 화면 가운데에 그것만)
  active: boolean; // 재생 키(Space·J·K·L…)가 이 판의 시계로 간다 — 판이 둘일 때만 표시한다
  onActivate: () => void;
  dualButton: { dual: boolean; onToggle: () => void } | null; // 싱글/듀얼 단추 — 맨 오른쪽 판에만
}

const NO_FLAGS: readonly { time: number; color?: string }[] = [];

export function EditViewer({
  order, place, mode, options, onMode, shown, videoRef, spareRef, muted, playing, rate, total, marks, io = null, flags = NO_FLAGS,
  over = null, registerPaint, controls,
  loop, onLoop, speed, onSpeed, volume, onVolume, label, detail, empty, active, onActivate, dualButton,
}: ViewerProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const pickRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  // 초점이 밖에 생겨도 닫는다 — 마우스로 열면 단추가 초점을 받지 않아(keepFocus) 아래 onBlur 만으로는 Tab 에 안 닫혔다(풀의 메뉴와 같다)
  useOutsideMouseDown(pickRef, () => setOpen(false), open, undefined, true);
  // 판이 숨겨지면(order < 0) 메뉴도 닫는다 — 판은 숨겨도 마운트돼 있어, 열림이 남으면 보이지 않는 겹이 뒤 화면의 키를 전부 막는다
  //  (lib/keyGate: 켜진 Esc 겹 = 키의 주인).
  useEffect(() => {
    if (order < 0) setOpen(false);
  }, [order]);
  useEscapeClose(() => setOpen(false), open && order >= 0, true, true);
  // 메뉴는 화면 아래까지만 — 트랙이 많으면(20개 = 23항목) 낮은 창(900×600)에서 아래 7항목이 화면 밖이었고 안쪽 스크롤도 없었다. 페이지가
  //  늘어나 스크롤되면 상태 알약이 마지막 항목을 덮는다(24회차 격리 실측). 뜬 자리에서 남은 높이로 상한을 잰다(조작 규칙 50 — 고정값 아님).
  useLayoutEffect(() => {
    if (!open) return;
    const fit = () => {
      const pop = popRef.current;
      if (pop) pop.style.maxHeight = `${Math.max(0, Math.floor(window.innerHeight - pop.getBoundingClientRect().top - 8))}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [open]);
  useEffect(() => registerPaint((time) => {
    writeText(timeRef.current, timecode(time));
    const at = `${total > 0 ? Math.min(100, Math.max(0, (time / total) * 100)) : 0}%`;
    if (headRef.current) headRef.current.style.left = at;
    if (fillRef.current) fillRef.current.style.width = at;
  }), [registerPaint, total]);

  const { clip, source, failed } = shown;
  const isVideo = !!clip && source?.state === "ok" && source.type === "video" && !failed;
  const still = clip && source?.state === "ok" && !isVideo ? (source.type === "image" ? source.url : source.thumb) : null;
  const notice = empty
    ?? (!clip ? null
      : source?.state === "missing" ? t("미디어 없음 — 공유 목록에 없는 생성물입니다.")
        : source?.state === "unknown" ? t("확인 못 함 — 공유 목록을 아직 받지 못했습니다.")
          : failed ? t("이 영상을 재생하지 못했습니다.") : null);
  const keepFocus = (event: ReactMouseEvent) => event.preventDefault(); // 단추가 초점을 가져가면 재생 키가 그 단추로 간다
  // 위 줄의 배속 글자는 '지금 실제로 도는 속도'다 — 엔진은 멈춘 뒤에도 마지막 속도(rate)를 쥐고 있어서, 도는 동안에만 낸다
  //  (안 그러면 멈춘 화면에 2x·◀ 1x 가 남는다). 고른 배속은 아래 줄의 배속 단추가 보인다.
  const fast = playing && (Math.abs(rate) > 1 || rate < 0) ? `${rate < 0 ? "◀ " : ""}${Math.abs(rate)}x` : "";
  const speedTitle = t("재생 배속 — 누를 때마다 1x · 1.5x · 2x · 4x");
  const current = options.find((option) => option.value === mode);
  const scrub = (event: ReactPointerEvent) => {
    const box = trackRef.current?.getBoundingClientRect();
    if (box) controls.seek(total * Math.min(1, Math.max(0, (event.clientX - box.left) / Math.max(1, box.width))));
  };
  // 소리 크기 — 영상 요소 둘(앞·뒤로 바꿔 트는 짝) 모두에 건다. 짝이 바뀌어도 요소는 그대로라 값이 남는다.
  useEffect(() => {
    for (const el of [videoRef.current, spareRef?.current]) if (el) el.volume = volume;
  }, [volume, videoRef, spareRef]);
  // 끈 막대 — 타임바처럼 누르거나 끌어서 정한다(입력칸이 아니라 초점을 가져가지 않는다 — 재생 키가 막대로 가지 않게).
  //  스피커를 누르면 0 ↔ 끄기 전의 크기(없으면 1).
  const volRef = useRef<HTMLDivElement>(null);
  const volBack = useRef(volume > 0 ? volume : 1);
  if (volume > 0) volBack.current = volume;
  const setVolumeAt = (event: ReactPointerEvent) => {
    const box = volRef.current?.getBoundingClientRect();
    if (box) onVolume(Math.round(Math.min(1, Math.max(0, (event.clientX - box.left) / Math.max(1, box.width))) * 100) / 100);
  };
  const volTitle = `${t("소리 크기")} ${Math.round(volume * 100)}%`;
  const button = (name: string, title: string, run: () => void, icon: JSX.Element, on = false) => (
    <button type="button" className={`ed-tbtn ed-t-${name}` + (on ? " ed-on" : "")} title={title} aria-label={title}
      aria-pressed={name === "loop" ? on : undefined} onClick={run}>{icon}</button>
  );

  return (
    <section className={"ed-view" + (isSourceView(mode) ? " ed-src" : "") + (active ? " ed-view-on" : "")}
      hidden={order < 0} style={{ order: order + 1 }} data-view={String(mode)} data-place={place}
      // 누르면(마우스), 또는 이 판의 단추를 키보드로 실행하면(click) 이 판이 재생 키를 받는다. 초점이 들어온 것만으로는
      //  바꾸지 않는다 — 우클릭 메뉴가 닫히며 초점을 돌려줄 때 재생 대상이 엉뚱하게 바뀐다(Codex 코드 리뷰).
      onMouseDownCapture={onActivate} onClickCapture={onActivate}>
      <div className="ed-vtop" onMouseDown={keepFocus}>
        <span className="ed-vtc" ref={timeRef}>00:00:00:00</span>
        <div className="ed-vpick" ref={pickRef} onBlur={(event) => {
          // Tab 으로 메뉴 밖으로 나가면 닫는다 — 열린 채 남으면 뒤 화면의 재생 키를 계속 막는다(Esc 겹 = 키의 주인). 마우스는 바깥 누름이
          //  닫고(useOutsideMouseDown), 창 밖으로 초점이 나간 것(relatedTarget 없음)은 닫지 않는다(조작 규칙 51).
          const to = event.relatedTarget as Node | null;
          if (to && !event.currentTarget.contains(to)) setOpen(false);
        }}>
          <button type="button" className={"ed-vpick-btn" + (open ? " ed-on" : "")} aria-haspopup="menu" aria-expanded={open}
            title={t("이 뷰어에서 무엇을 볼지 고릅니다")} onClick={() => setOpen(!open)}>
            {current?.label ?? (typeof mode === "number" ? `V${mode}` : mode)}
            <svg className="ed-caret" viewBox="0 0 8 5" aria-hidden="true"><path d="M0 0h8L4 5z" /></svg>
          </button>
          {open && (
            <div className="ed-pop ed-vpop" role="menu" ref={popRef} aria-label={t("이 뷰어에서 무엇을 볼지 고릅니다")}>
              {options.map((option) => (
                <button key={String(option.value)} type="button" role="menuitemradio" aria-checked={option.value === mode}
                  className={"ed-pop-item" + (option.value === mode ? " ed-on" : "")}
                  onClick={() => {
                    setOpen(false);
                    if (option.value !== mode) onMode(option.value);
                  }}>
                  <b>{option.value === mode ? "✓" : ""}</b>{option.label}{option.hint && <i>{option.hint}</i>}
                </button>
              ))}
            </div>
          )}
        </div>
        {fast && <b className="ed-vspeed">{fast}</b>}
        <span className="ed-vtc ed-vtotal">{timecode(total)}</span>
        {dualButton && (
          <button type="button" className={"ed-tbtn ed-dual" + (dualButton.dual ? " ed-on" : "")} aria-pressed={dualButton.dual}
            onClick={dualButton.onToggle}
            title={dualButton.dual ? t("싱글 뷰어로 — 뷰어 하나만 봅니다") : t("듀얼 뷰어로 — 뷰어 두 개를 나란히 봅니다")}
            aria-label={dualButton.dual ? t("싱글 뷰어로 — 뷰어 하나만 봅니다") : t("듀얼 뷰어로 — 뷰어 두 개를 나란히 봅니다")}>
            <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden="true">
              {dualButton.dual ? <><rect x="0.5" y="0.5" width="7.5" height="11" /><rect x="10" y="0.5" width="7.5" height="11" /></>
                : <rect x="0.5" y="0.5" width="17" height="11" />}
            </svg>
          </button>
        )}
      </div>
      <div className="ed-stage">
        {/* 영상 요소는 떼지 않는다 — 떼면 재생 훅이 걸어 둔 이벤트와 주소가 함께 사라진다. */}
        <video ref={videoRef} className="ed-media" muted={muted} playsInline preload="auto" hidden={!isVideo}
          poster={isVideo && source?.thumb ? source.thumb : undefined} />
        {/* 두 번째 요소 — 다음 영상을 미리 받아 둔다. 어느 쪽이 앞인지는 재생이 정한다(data-spare — 가려진 쪽) */}
        {spareRef && (
          <video ref={spareRef} className="ed-media" muted={muted} playsInline preload="auto" hidden={!isVideo}
            poster={isVideo && source?.thumb ? source.thumb : undefined} />
        )}
        {still && <img className="ed-media" src={still} alt="" draggable={false} />}
        {notice && <div className="ed-notice" role="status">{notice}</div>}
        {!empty && label && <span className="ed-chip ed-chip-l">{label}</span>}
        {!empty && detail && <span className="ed-chip ed-chip-r">{detail}</span>}
        {!empty && over}
      </div>
      <div className="ed-vbot" onMouseDown={keepFocus}>
        {/* 타임바 — 누르거나 끌어서 훑는다(다빈치의 재생바). 빨강 = 지금 자리, 위의 색 꼬리표 = 북마크, 밝은 선과 아래의 회색
            꼬리표 = 마크 인/아웃. 얇은 줄은 소스 테이프의 클립 경계. */}
        <div className="ed-scrub" role="slider" aria-label={t("타임바")} aria-valuemin={0} aria-valuemax={Math.round(total)} aria-valuenow={0}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            scrub(event);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) scrub(event);
          }}>
          <div className="ed-scrub-track" ref={trackRef}>
            <div className="ed-scrub-fill" ref={fillRef} />
            {total > 0 && io?.band && (
              <div className="ed-scrub-range"
                style={{ left: `${(io.band.from / total) * 100}%`, width: `${((io.band.to - io.band.from) / total) * 100}%` }} />
            )}
            {total > 0 && marks.map((mark) => <i key={mark} style={{ left: `${(mark / total) * 100}%` }} />)}
            {total > 0 && flags.map((flag) => (
              <span className="ed-scrub-mk" key={flag.time} style={{ left: `${(flag.time / total) * 100}%`, background: flag.color }} />
            ))}
            {total > 0 && io && [io.in, io.out].map((time, side) => time !== null && (
              <span className={"ed-scrub-io" + (side ? " ed-scrub-out" : "")} key={side} style={{ left: `${(time / total) * 100}%` }} />
            ))}
            <div className="ed-scrub-head" ref={headRef} />
          </div>
        </div>
        <div className="ed-trans">
          {button("first", t("처음으로 (Home)"), () => controls.edge(false),
            <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true"><rect x="1" y="1" width="2" height="12" /><path d="M15 1v12L5 7z" /></svg>)}
          {button("rev", t("역재생 (J)"), () => controls.shuttle(-1),
            <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true"><path d="M11 1v12L1 7z" /></svg>)}
          {button("stop", t("정지 (K)"), controls.stop,
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1" y="1" width="10" height="10" rx="1" /></svg>)}
          <button type="button" className="ed-tbtn ed-play" title={t("재생/정지 (Space)")} aria-label={t("재생/정지 (Space)")} onClick={controls.toggle}>
            {playing ? (
              <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true"><rect x="1.5" y="1" width="3.2" height="12" /><rect x="7.3" y="1" width="3.2" height="12" /></svg>
            ) : (
              <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true"><path d="M2 1v12l9-6z" /></svg>
            )}
          </button>
          {button("last", t("끝으로 (End)"), () => controls.edge(true),
            <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true"><rect x="13" y="1" width="2" height="12" /><path d="M1 1v12l10-6z" /></svg>)}
          {button("loop", t("반복 재생"), onLoop,
            <svg className="ed-line" width="18" height="14" viewBox="0 0 18 14" aria-hidden="true"><path d="M5 3h8a4 4 0 0 1 0 8H5a4 4 0 0 1 0-8" /><path d="M8 .6 5 3l3 2.4" /></svg>, loop)}
          <button type="button" className={"ed-tbtn ed-t-speed" + (speed !== 1 ? " ed-on" : "")} title={speedTitle} aria-label={speedTitle}
            onClick={onSpeed}>{speed}x</button>
          <span className="ed-tside ed-vol">
            <button type="button" className={"ed-tbtn ed-t-vol" + (volume === 0 ? " ed-on" : "")} aria-pressed={volume === 0}
              title={volume === 0 ? t("소리 켜기") : t("소리 끄기")} aria-label={volume === 0 ? t("소리 켜기") : t("소리 끄기")}
              onClick={() => onVolume(volume > 0 ? 0 : volBack.current)}>
              <svg className="ed-line" width="18" height="14" viewBox="0 0 18 14" aria-hidden="true">
                <path d="M1.5 5h2.8L8 2v10L4.3 9H1.5z" />
                {volume === 0 ? <path d="M11.5 4.5l5 5M16.5 4.5l-5 5" />
                  : <><path d="M11 4.6a3.4 3.4 0 0 1 0 4.8" />{volume > 0.5 && <path d="M13.3 2.6a6.2 6.2 0 0 1 0 8.8" />}</>}
              </svg>
            </button>
            <div className="ed-vol-bar" role="slider" aria-label={t("소리 크기")} title={volTitle}
              aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(volume * 100)}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                setVolumeAt(event);
              }}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) setVolumeAt(event);
              }}>
              <div className="ed-vol-track" ref={volRef}>
                <div className="ed-vol-fill" style={{ width: `${volume * 100}%` }} />
                <div className="ed-vol-knob" style={{ left: `${volume * 100}%` }} />
              </div>
            </div>
          </span>
        </div>
      </div>
    </section>
  );
}
