// 편집 탭 — 클립 길이 조절 창(Jay 2026-10-13: 타임라인의 클립을 휠 클릭 → 같은 날 밤 "플로팅창으로 더 제대로 편집할 수 있게").
//  뒤를 자른다 — 줄인 뒤의 구간에는 아래 트랙이 보인다.
//  · **떠 있는 창**이다(lib/useFloatingPanel): 머리를 끌어 옮기고 자리를 기억한다. 밖을 눌러도 닫히지 않는다 — ✕ 나 Esc(초점이 창 안일 때).
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
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { EDIT_FPS } from "../../lib/editTimeline";
import { useT } from "../../lib/i18n";
import { isTypingTarget } from "../../lib/keyGate";
import { markKeyHandled } from "../../lib/keyHandled";
import { makeStore } from "../../lib/storage";
import { clampFloatingPanelPosition, useFloatingPanel } from "../../lib/useFloatingPanel";

const LS = makeStore("ch.editTrim.");
const WIDTH = 560;
const HEIGHT = 500; // 처음 놓을 자리를 잡는 데만 쓴다(그 뒤로는 끌어 둔 자리)

export function EditTrimPop({
  x,
  y,
  openId,
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
  x: number; // 연 자리(휠 클릭·메뉴) — 끌어 둔 자리가 아직 없을 때만 쓴다
  y: number;
  openId: string; // 열 때마다(다른 클립으로 바뀔 때도) 새 값 — 초점을 창으로 데려오고 재생을 멈춘다
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

  // 자리 — 끌어 둔 자리(저장), 없으면 연 자리의 위쪽. 화면 밖으로 나가지 않게 잡는 것은 훅이 한다.
  const { pos, panelRef, onHeadMouseDown } = useFloatingPanel(LS, "pos", "size", true);
  const first = useRef(clampFloatingPanelPosition(
    { x: x - WIDTH / 2, y: y - HEIGHT - 16 },
    { width: WIDTH, height: HEIGHT },
    { width: window.innerWidth, height: window.innerHeight },
  )).current;
  const at = pos ?? first;
  const panel = useRef<HTMLDivElement | null>(null);
  const setPanel = useCallback((node: HTMLDivElement | null) => {
    panel.current = node;
    panelRef(node);
  }, [panelRef]);
  const onHead = (event: ReactMouseEvent) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    onHeadMouseDown(event, first);
  };

  // 큰 화면 — 재생 중이 아니면 그 길이의 마지막 프레임에 선다. 길이·클립이 바뀌면 재생을 멈춘다.
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const last = (frames - 1) / EDIT_FPS;
  useEffect(() => {
    const element = video.current;
    setPlaying(false);
    if (!element) return;
    element.pause();
    const seek = () => {
      element.currentTime = last;
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

  // 열 때(다른 클립으로 바뀔 때도) 초점을 창으로 — 그래야 키가 바로 창의 것이다
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
  }, [openId]);

  // 숫자 칸 — 치는 동안은 칸의 글자, Enter·칸을 떠날 때 적용한다. 못 읽는 값은 버리고 지금 값으로 돌아간다.
  const [draft, setDraft] = useState<{ field: "sec" | "frame"; text: string } | null>(null);
  const commit = () => {
    if (!draft) return;
    const number = Number(draft.text.trim().replace(",", "."));
    setDraft(null);
    if (!draft.text.trim() || !Number.isFinite(number) || number <= 0) return;
    set(draft.field === "sec" ? number * EDIT_FPS : number);
  };
  const seconds = (trimmed ? frames / EDIT_FPS : full).toFixed(2);
  const field = (name: "sec" | "frame", shown: string, label: string) => (
    <input type="text" className="ed-trim-num" inputMode={name === "sec" ? "decimal" : "numeric"} aria-label={label}
      value={draft?.field === name ? draft.text : shown}
      onFocus={(event) => event.target.select()}
      onChange={(event) => setDraft({ field: name, text: event.target.value })}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }} />
  );

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      markKeyHandled(event.nativeEvent); // 뒤 화면의 Esc(선택 해제)가 같은 키를 또 쓰지 않게
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
        {src && <video ref={video} className="ed-trim-view" src={src} muted playsInline preload="auto" />}
        <div className="ed-trim-play">
          {src && <button type="button" className="ed-trim-go" onClick={togglePlay}>{playing ? "■ " + t("멈춤") : "▶ " + t("재생")}</button>}
          <span>
            {trimmed
              ? t("잘라낸 뒤 {cut}초 · 원본 {full}초").replace("{cut}", cut.toFixed(2)).replace("{full}", full.toFixed(2))
              : t("원본 {full}초 그대로").replace("{full}", full.toFixed(2))}
          </span>
        </div>
        <input type="range" className="ed-trim-range" min={1} max={top} step={1} value={frames}
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
