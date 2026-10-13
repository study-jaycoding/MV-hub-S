// 편집 탭 — 클립 길이 조절 창(Jay 2026-10-13: 타임라인의 클립을 휠 클릭 → 같은 날 밤 "플로팅창으로 더 제대로 편집할 수 있게").
//  뒤를 자른다 — 줄인 뒤의 구간에는 아래 트랙이 보인다.
//  · **떠 있는 창**이다(lib/useFloatingPanel): 머리를 끌어 옮기고, 끌어 옮긴 자리를 기억한다. 옮긴 적이 없으면 **누른 클립의 바로 위**에
//    뜬다(Jay 2026-10-14 — 그 전날은 화면 오른쪽 위였다). 뷰어의 아래쪽과 타임라인의 윗줄을 덮지만 누른 클립은 덮지 않는다(trimPopPlace).
//    밖을 눌러도 닫히지 않는다 — ✕ 나 Esc(초점이 창 안일 때).
//    창이 떠 있어도 타임라인은 그대로 쓴다: Esc 겹·키 주인으로 올리지 않는다(lib/keyGate 의 '올리지 않는 것' — 코멘트 패널과 같다).
//  · **키는 초점을 따른다.** 창은 body 에 그린다(createPortal) — 편집 키(EditTab.onKey)는 편집 화면 밖에서 난 키를 듣지 않으므로
//    초점이 창 안이면 ←/→·Space·Delete 가 뒤의 재생헤드·클립에 먹지 않고, 초점이 타임라인이면 키는 타임라인의 것이다.
//  · 끝까지 줄여도 단추를 disabled 로 끄지 않는다(aria-disabled) — 끄면 초점이 body 로 떨어져 키가 창을 떠난다(2026-10-13 격리 실측:
//    그때 ←/→ 가 죽었다).
//  · 값은 프레임(24fps) 단위다. 조절할 때마다 바로 문서에 적는다(부르는 쪽이 이어진 걸음들을 되돌리기 한 단계로 묶는다).
//  · 큰 화면은 그 길이에서 **마지막으로 보이는 프레임**을 보여 주고, ▶ 는 줄인 길이만큼 창 안에서 재생한다 — 타임라인의 재생헤드는
//    건드리지 않는다(그 클립이 위 트랙에 가려져 있거나 꺼져 있어도 볼 수 있다).
//  · ←/→ = 1프레임, Shift+←/→ = 10프레임, Space = 재생·멈춤, Ctrl+Z = 되돌리기. 숫자 칸(초·프레임)에 직접 친다(Enter·칸을 떠날 때 적용).
//    끝까지 늘리면 '원본 길이로'와 같다(줄임을 지운다).
import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { EDIT_FPS } from "../../lib/editTimeline";
import { useT } from "../../lib/i18n";
import { isTypingTarget } from "../../lib/keyGate";
import { markKeyHandled } from "../../lib/keyHandled";
import { makeStore } from "../../lib/storage";
import { clampFloatingPanelPosition, useFloatingPanel } from "../../lib/useFloatingPanel";

const LS = makeStore("ch.editTrim.");
const WIDTH = 560;
const HEIGHT = 520; // 처음 놓을 자리를 잡는 데만 쓴다(그려진 뒤에는 실제 크기로 다시 잡는다)
const GAP = 10; // 누른 클립과 창 사이
const EDGE = 8; // 화면 가장자리에 남기는 여백(clampFloatingPanelPosition 의 기본과 같다)

export interface TrimAnchor { x: number; y: number; width: number; height: number }

// 창을 놓을 자리(Jay 2026-10-14: 누른 클립 근처) — 그 클립의 **바로 위**, 가로는 클립의 보이는 부분 가운데.
//  클립은 덮지 않는다: 덮으면 방금 누른 클립과 옆 클립을 다시 누를 수 없다(2026-10-13 격리 실측 — 그때는 누른 자리 위에 띄웠다).
//  위에 자리가 없으면(낮은 창) 클립의 옆(오른쪽, 안 되면 왼쪽)에 아래 끝을 맞춰 놓고, 그것도 안 되면 화면 오른쪽 위다.
//  anchor 가 없으면(그 클립이 화면에 안 보인다) 화면 오른쪽 위.
export function trimPopPlace(
  anchor: TrimAnchor | null,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const fit = (x: number, y: number) => clampFloatingPanelPosition({ x: Math.round(x), y: Math.round(y) }, panel, viewport);
  const corner = fit(viewport.width - panel.width - 16, 64);
  if (!anchor || anchor.width <= 0) return corner;
  const right = anchor.x + anchor.width;
  const above = anchor.y - GAP - panel.height;
  if (above >= EDGE) return fit(anchor.x + anchor.width / 2 - panel.width / 2, above);
  const y = anchor.y + anchor.height - panel.height;
  if (right + GAP + panel.width <= viewport.width - EDGE) return fit(right + GAP, y);
  if (anchor.x - GAP - panel.width >= EDGE) return fit(anchor.x - GAP - panel.width, y);
  return corner;
}

export function EditTrimPop({
  openId,
  anchor,
  title,
  full,
  value,
  trimmed,
  src,
  onChange,
  onUndo,
  onRedo,
  onClose,
}: {
  openId: string; // 열 때마다(다른 클립으로 바뀔 때도) 새 값 — 초점을 창으로 데려오고 재생을 멈춘다
  anchor: TrimAnchor | null; // 연 순간의 누른 클립의 화면 자리 — 창이 새로 뜰 때만 본다(떠 있는 채 다른 클립으로 바뀌어도 창은 그 자리다)
  title: string; // 'C0110 · V2'
  full: number; // 원본 길이(초)
  value: number; // 지금 쓰는 길이(초)
  trimmed: boolean; // 줄여 둔 클립인가 — '원본 길이로'가 켜진다
  src: string | null; // 그 영상(큰 화면) — 없으면 화면 없이 숫자만
  onChange: (seconds: number | null) => void; // null = 원본 길이로
  onUndo: () => void;
  onRedo: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const top = Math.max(1, Math.floor(full * EDIT_FPS + 1e-6)); // 원본을 넘지 않는 가장 긴 프레임 수(snapTrim 과 같은 내림)
  const frames = Math.min(top, Math.max(1, Math.round(value * EDIT_FPS)));
  const set = (next: number) => {
    const to = Math.min(top, Math.max(1, Math.round(next)));
    if (to >= top) {
      if (trimmed) onChange(null);
    } else if (to !== frames || !trimmed) onChange(to / EDIT_FPS);
  };

  // 자리 — 끌어 옮긴 적이 있으면 그 자리(저장), 없으면 **열 때마다** 누른 클립의 바로 위(trimPopPlace). 화면 밖으로 나가지 않게 잡는
  //  것은 훅이 한다. 훅은 열기만 해도 자리를 적어 둔다(화면 밖 보정용) — 그래서 '끌어 옮겼다'는 표(moved)를 따로 둔다: 표가 없으면
  //  적힌 자리를 쓰지 않는다(전날 판이 적어 둔 오른쪽 위 자리도 그렇게 지나간다).
  const { pos, setPos, panelRef, onHeadMouseDown } = useFloatingPanel(LS, "pos", "size", true);
  const [moved, setMoved] = useState(() => LS.get("moved", "") === "1");
  const opened = useRef({ anchor, moved }).current; // 창이 뜬 순간의 것
  const first = useRef(trimPopPlace(anchor, { width: WIDTH, height: HEIGHT }, { width: window.innerWidth, height: window.innerHeight })).current;
  const [placed, setPlaced] = useState(false); // 이 열림의 자리를 훅에 알렸다 — 그 뒤로는 훅의 자리(pos)가 화면의 자리다
  const at = (moved || placed) && pos ? pos : first;
  const panel = useRef<HTMLDivElement | null>(null);
  const setPanel = useCallback((node: HTMLDivElement | null) => {
    panel.current = node;
    panelRef(node);
  }, [panelRef]);
  // 그려진 크기로 한 번 더 잡는다 — 낮은 창에서는 큰 화면이 줄어 창이 520px 보다 낮다(그때 '위에 자리가 없다'고 잘못 보지 않게).
  //  열 때 한 번이다: 떠 있는 동안 다른 클립으로 바뀌어도 옮기지 않는다.
  useLayoutEffect(() => {
    if (opened.moved) return;
    const box = panel.current?.getBoundingClientRect();
    const size = box && box.height > 0 ? { width: box.width, height: box.height } : { width: WIDTH, height: HEIGHT };
    setPos(trimPopPlace(opened.anchor, size, { width: window.innerWidth, height: window.innerHeight }));
    setPlaced(true);
  }, [opened, setPos]);
  // 머리를 실제로 끌었을 때만 '옮겼다'로 적는다(누르기만 한 것은 아니다)
  const dragWatch = useRef<(() => void) | null>(null);
  useEffect(() => () => dragWatch.current?.(), []);
  const onHead = (event: ReactMouseEvent) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    onHeadMouseDown(event, at);
    if (moved) return;
    const from = { x: event.clientX, y: event.clientY };
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("blur", stop);
      dragWatch.current = null;
    };
    const move = (next: MouseEvent) => {
      if (next.buttons === 0) return stop(); // 놓는 이벤트를 놓쳤다 — 그 끌기는 이미 끝났다(lib/windowDrag 와 같은 판정)
      if (Math.abs(next.clientX - from.x) + Math.abs(next.clientY - from.y) < 3) return;
      setMoved(true);
      LS.set("moved", "1");
      stop();
    };
    dragWatch.current?.();
    dragWatch.current = stop;
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
    window.addEventListener("blur", stop);
  };

  // 큰 화면 — 재생 중이 아니면 그 길이의 마지막 프레임에 선다. 길이·클립이 바뀌면 재생을 멈춘다.
  const video = useRef<HTMLVideoElement>(null);
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null); // 못 받은 영상의 주소 — 그 주소일 때만 '못 받음'이다
  const broken = !!src && brokenSrc === src;
  const [playing, setPlayingState] = useState(false);
  // 재생 중인가를 ref 로도 든다 — 영상 정보(loadedmetadata)가 오기 전에 ▶ 를 누르면, 열 때 걸어 둔 '마지막 프레임으로'가 뒤늦게
  //  돌아 재생 자리를 끝으로 옮겼다(Codex 코드 리뷰 6회째). 그 콜백이 도는 순간의 뜻을 본다.
  const playRef = useRef(false);
  const setPlaying = (on: boolean) => {
    playRef.current = on;
    setPlayingState(on);
  };
  const last = (frames - 1) / EDIT_FPS;
  useEffect(() => {
    const element = video.current;
    setPlaying(false);
    if (!element) return;
    element.pause();
    const seek = () => {
      if (!playRef.current) element.currentTime = last;
    };
    if (element.readyState >= 1) seek();
    else element.addEventListener("loadedmetadata", seek, { once: true });
    return () => element.removeEventListener("loadedmetadata", seek);
  }, [last, src, openId]);
  const stopPlay = () => {
    const element = video.current;
    setPlaying(false);
    if (!element) return;
    element.pause();
    element.currentTime = last;
  };
  const togglePlay = () => {
    const element = video.current;
    if (!element) return;
    if (playing) return stopPlay();
    element.currentTime = 0;
    setPlaying(true);
    void Promise.resolve(element.play()).catch(() => setPlaying(false)); // 못 틀면(받는 중·막힘) 멈춘 채로 둔다
  };
  // 줄인 길이의 끝에서 멈춘다 — timeupdate 는 1초에 네 번쯤이라 프레임마다 본다
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const element = video.current;
      if (!element || element.ended || element.currentTime >= frames / EDIT_FPS) {
        if (element) {
          element.pause();
          element.currentTime = last;
        }
        setPlaying(false);
      } else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, frames, last]);

  // 숫자 칸 — 치는 동안은 칸의 글자, Enter·칸을 떠날 때 적용한다. 못 읽는 값은 버리고 지금 값으로 돌아간다.
  //  치던 글자는 그 클립의 것이다(of) — 창이 다른 클립으로 바뀌면 버린다: 초점을 창으로 옮기는 순간 칸이 blur 되며 적용이 불리는데,
  //  그때의 onChange 는 이미 새 클립의 것이다.
  const [draftOf, setDraft] = useState<{ field: "sec" | "frame"; text: string; of: string } | null>(null);
  const draft = draftOf?.of === openId ? draftOf : null;
  // 열 때(다른 클립으로 바뀔 때도) 초점을 창으로 — 그래야 키가 바로 창의 것이다
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
  }, [openId]);
  // Esc 는 취소다 — 치던 값을 버리고 닫는다. 닫히며 초점이 편집 화면으로 옮겨질 때 칸이 blur 되는데, 그 blur 가 적용을 부르지
  //  않게 한다(2026-10-13 격리 실측: 12f 에서 77 을 치고 Esc → 77f 가 적용된 채 닫혔다). ✕ 는 칸을 떠나는 누름이라 적용된다.
  const cancelled = useRef(false);
  const commit = () => {
    setDraft(null);
    if (!draft || cancelled.current) return;
    const number = Number(draft.text.trim().replace(",", "."));
    if (!draft.text.trim() || !Number.isFinite(number) || number <= 0) return;
    set(draft.field === "sec" ? number * EDIT_FPS : number);
  };
  const seconds = (trimmed ? frames / EDIT_FPS : full).toFixed(2);
  const field = (name: "sec" | "frame", shown: string, label: string) => (
    <input type="text" className="ed-trim-num" inputMode={name === "sec" ? "decimal" : "numeric"} aria-label={label}
      value={draft?.field === name ? draft.text : shown}
      onFocus={(event) => event.target.select()}
      onChange={(event) => setDraft({ field: name, text: event.target.value, of: openId })}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }} />
  );

  // 창 안에서 난 키는 창 밖으로 내보내지 않는다 — 편집 키는 편집 화면 밖의 키를 안 듣지만, 편집 탭이 연 폴더 창이 떠 있으면 라이브러리
  //  단축키(lib/useGenerationKeyboardActions — window 의 버블 단계)가 살아 있고 그쪽은 키가 어디서 났는지 보지 않는다: 창 안에서 R·D 를
  //  누르면 뒤 폴더 창의 고른 카드에 색·비활성이 걸렸다(Codex 코드 리뷰 6회째). 전파만 막는다 — 글자 치기·Tab 같은 기본 동작은 그대로다.
  const onKeyDown = (event: ReactKeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      markKeyHandled(event.nativeEvent); // 뒤 화면의 Esc(선택 해제)가 같은 키를 또 쓰지 않게
      cancelled.current = true;
      onClose();
      return;
    }
    if (isTypingTarget(event.target)) return; // 숫자 칸 — 글자·화살표·Space 는 칸의 것이다
    const mod = (event.ctrlKey || event.metaKey) && !event.altKey;
    if (mod && event.code === "KeyZ") {
      event.preventDefault();
      (event.shiftKey ? onRedo : onUndo)();
    } else if (mod || event.altKey) return;
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault(); // 슬라이더가 스스로 한 칸 더 움직이지 않게
      set(frames + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 10 : 1));
    } else if (event.code === "Space") {
      event.preventDefault(); // 초점이 남은 단추를 누르는 키가 아니다 — 창에서는 재생·멈춤
      togglePlay();
    }
  };

  // 끝에 닿은 단추도 초점은 받는다(위 주석) — 눌러도 아무 일이 없을 뿐이다
  const step = (delta: number, label: string) => {
    const off = delta < 0 ? frames <= 1 : frames >= top;
    return (
      <button type="button" aria-disabled={off} onClick={() => {
        if (!off) set(frames + delta);
      }}>{label}</button>
    );
  };
  const cut = Math.max(0, full - frames / EDIT_FPS);
  return createPortal(
    <div ref={setPanel} className="ed-trim" role="dialog" aria-label={t("길이 조절")} tabIndex={-1}
      style={{ left: at.x, top: at.y }} onKeyDown={onKeyDown}>
      <div className="ed-trim-head" onMouseDown={onHead}>
        <b>{t("길이 조절")}</b>
        <span>{title}</span>
        <button type="button" aria-label={t("닫기")} title={t("닫기")} onClick={onClose}>✕</button>
      </div>
      <div className="ed-trim-body">
        {src && <video ref={video} className="ed-trim-view" src={src} muted playsInline preload="auto" onError={() => setBrokenSrc(src)} />}
        <div className="ed-trim-play">
          {src && (
            <button type="button" className="ed-trim-go" aria-disabled={broken} onClick={() => {
              if (!broken) togglePlay();
            }}>{playing ? "■ " + t("멈춤") : "▶ " + t("재생")}</button>
          )}
          {broken && <em>{t("영상을 불러오지 못했습니다 — 길이는 조절할 수 있습니다")}</em>}
          <span>
            {trimmed
              ? t("잘라낸 뒤 {cut}초 · 원본 {full}초").replace("{cut}", cut.toFixed(2)).replace("{full}", full.toFixed(2))
              : t("원본 {full}초 그대로").replace("{full}", full.toFixed(2))}
          </span>
        </div>
        <input type="range" className="ed-trim-range" min={1} max={top} step={1} value={frames}
          style={{ "--fill": `${top > 1 ? ((frames - 1) / (top - 1)) * 100 : 100}%` } as CSSProperties}
          aria-label={t("클립 길이(프레임)")} aria-valuetext={`${(frames / EDIT_FPS).toFixed(2)}${t("초")}`}
          onChange={(event) => set(Number(event.target.value))} />
        <div className="ed-trim-scale"><span>0</span><span>{(full / 2).toFixed(1)}</span><span>{full.toFixed(2)}{t("초")}</span></div>
        <div className="ed-trim-row">
          {step(-10, "−10f")}
          {step(-1, "−1f")}
          <i />
          {field("sec", seconds, t("길이(초)"))}
          <span>{t("초")}</span>
          <span className="ed-trim-eq">=</span>
          {field("frame", String(frames), t("클립 길이(프레임)"))}
          <span>{t("프레임")}</span>
          <i />
          {step(1, "+1f")}
          {step(10, "+10f")}
        </div>
        <div className="ed-trim-foot">
          <button type="button" aria-disabled={!trimmed} onClick={() => {
            if (trimmed) onChange(null);
          }}>{t("원본 길이로")}</button>
          <small>{t("←/→ 1프레임 · Shift 10프레임 · Space 재생 · Esc 닫기")}</small>
        </div>
      </div>
    </div>,
    document.body,
  );
}
