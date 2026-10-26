// 편집 탭 — 속도 막대(Jay 2026-10-23 Ctrl+R, 다빈치 리타임 컨트롤 · 모의 그림 ③ 그대로). 계약은 docs/EDIT_TAB.md.
//  고른 영상 클립 위에 겹쳐 그린다. 오른쪽 끝 **위쪽(파랑) 끌기 = 속도**(쓰는 원본 구간 그대로, 길이 = 원본 ÷ 속도) · **아래쪽(라임) 끌기 =
//  끝**(속도 그대로, 쓰는 원본 구간을 바꾼다 — 길이 조절 창의 '끝'과 같은 값 trim) · 가운데 아래 'p% ▾' = 속도 메뉴.
//  · 끄는 동안은 화면만 바뀌고 **놓을 때 한 번** 저장한다(되돌리기 한 단계). Esc·포인터를 놓친 것은 취소다.
//  · 막대 자체는 누름을 받지 않는다(CSS pointer-events) — 아래 클립의 고르기·끌기·우클릭은 그대로다. 잡는 곳·단추만 받는다.
//  · 속도는 정수 % 로 맞춘다(끌기·메뉴) — 화면 글자와 Resolve 의 Percentage 가 같게. 직접 입력만 소수 둘째 자리까지.
//  · 잡는 곳 둘은 키보드로도 쓴다(Codex 독립 리뷰 P3 — 슬라이더라면 값·키가 있어야 한다): Tab 으로 가서 ←/→(↑/↓) = 속도 1% · 끝 한 프레임,
//    Shift = 10. 누를 때마다 저장한다(한 번이 되돌리기 한 단계). 화살표는 뒤의 편집 키(재생헤드 옮기기)로 보내지 않는다.
import {
  useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent,
} from "react";
import { clipFrames, clipLen, clipSource, clipSpeed, EDIT_FPS, SPEED_MAX, SPEED_MIN, type SlotClip } from "../../lib/editTimeline";
import { fillKeys, hintOf, useEditShortcutsVersion } from "../../lib/editShortcuts";
import { useT } from "../../lib/i18n";
import { EditMenu } from "./EditTrackMenu";

const PRESETS = [0.25, 0.5, 0.75, 1, 1.5, 2];
const MENU_W = 170;

export type RetimeChange = { speed: number } | { range: { head: number; trim: number | null } };
type Preview = { kind: "speed" | "trim"; speed: number; trim: number | null; len: number };

// 이 클립이 가질 수 있는 가장 빠른 속도 — 타임라인 길이가 한 프레임은 되어야 한다(floor(원본 × 24 ÷ 속도) ≥ 1). 100% 로 되돌리기는 이 상한과
//  무관하게 늘 된다(메뉴·직접 입력 — setClipSpeed 가 1 은 막지 않는다).
export function speedCap(clip: SlotClip): number {
  return Math.min(SPEED_MAX, Math.floor(clipSource(clip, clip.full) * EDIT_FPS * 100 + 1e-6) / 100);
}

// 끌어서 정한 타임라인 프레임 수 → 속도(정수 %, SPEED_MIN~speedCap).
export function speedForFrames(clip: SlotClip, frames: number): number {
  const raw = Math.round((clipSource(clip, clip.full) * EDIT_FPS) / Math.max(1, frames) * 100) / 100;
  return Math.min(speedCap(clip), Math.max(SPEED_MIN, raw));
}

// 끌어서 정한 타임라인 프레임 수 → 쓰는 원본 길이(초, null = 원본 끝까지). 속도 그대로 — 원본 프레임으로 맞추고, 한 프레임은 남긴다.
export function trimForFrames(clip: SlotClip, frames: number): number | null {
  const speed = clipSpeed(clip);
  const top = clipFrames(clip.full) - Math.round(clip.head * EDIT_FPS); // 시작점 뒤로 남은 원본 프레임
  const used = Math.min(top, Math.max(Math.ceil(speed - 1e-9), Math.round(frames * speed)));
  return used >= top ? null : used / EDIT_FPS;
}

export const speedText = (speed: number) => `${+(speed * 100).toFixed(2)}%`;

// trim 을 바꾼 클립(그 길이를 셀 때 — trim = null 이면 원본 끝까지)
function withTrim(clip: SlotClip, trim: number | null): SlotClip {
  const shaped: SlotClip = { ...clip };
  if (trim === null) delete shaped.trim;
  else shaped.trim = trim;
  return shaped;
}

// 원본 끝까지 늘렸을 때의 타임라인 길이(프레임) — 그 속도로
export function mostFrames(clip: SlotClip, speed = clipSpeed(clip)): number {
  return Math.round(clipLen(withTrim({ ...clip, speed }, null), clip.full) * EDIT_FPS);
}

// 끝 손잡이의 키 한 번(delta = 타임라인 프레임, 음수 = 줄이기) — 원본 프레임을 하나씩 따라가며 **그 방향으로 delta 만큼 바뀐 가장 가까운 길이**의 trim.
//  속도 때문에 원본 한 프레임이 타임라인 여러 프레임(느린 속도)이거나 그 반대(빠른 속도)라, 타임라인 프레임으로 셈하면 가장 가까운 길이를 건너뛴다
//  (Codex 독립 리뷰 6차: 91% · 131 에서 ← 가 130 이 아니라 129 로 갔다). 범위(한 프레임 ~ 원본 끝)를 넘는 걸음은 그 끝까지.
//  null = 원본 끝까지(trim 을 지움) · undefined = 더 갈 데가 없다.
//  지금 쓰는 원본(used)은 반올림하지 않는다 — 원본 끝이 프레임 사이면(120.4프레임) 그 바로 안의 온전한 프레임(120)도 후보다(Codex 독립 리뷰 7차: 25% ·
//  481 에서 ← 가 480 을 건너뛰고 476 으로 갔다). 원본 끝이 프레임에 맞으면 그 자리는 '원본 끝까지'(null)로 둔다.
export function trimStep(clip: SlotClip, delta: number): number | null | undefined {
  const top = clipFrames(clip.full) - Math.round(clip.head * EDIT_FPS); // 원본 끝 안의 마지막 온전한 프레임까지(시작점 뒤)
  const end = (clip.full - clip.head) * EDIT_FPS; // 원본 끝(프레임 — 프레임 사이일 수 있다)
  const least = Math.ceil(clipSpeed(clip) - 1e-9); // 타임라인 한 프레임이 되는 가장 짧은 원본
  const lenOf = (trim: number | null) => Math.round(clipLen(withTrim(clip, trim), clip.full) * EDIT_FPS);
  const now = Math.round(clip.len * EDIT_FPS);
  const used = clipSource(clip, clip.full) * EDIT_FPS; // 지금 쓰는 원본(프레임 — 소수일 수 있다)
  if (delta < 0) {
    for (let next = Math.min(top, Math.ceil(used - 1e-6) - 1); next >= least; next--) {
      if (lenOf(next / EDIT_FPS) <= now + delta) return next / EDIT_FPS;
    }
    return least <= top && least < used - 1e-6 && lenOf(least / EDIT_FPS) < now ? least / EDIT_FPS : undefined;
  }
  for (let next = Math.floor(used + 1e-6) + 1; next <= top; next++) {
    if (next === top && top >= end - 1e-6) break; // 원본 끝이 프레임에 맞다 — 그 자리는 아래의 '원본 끝까지'
    if (lenOf(next / EDIT_FPS) >= now + delta) return next / EDIT_FPS;
  }
  return lenOf(null) > now ? null : undefined;
}

export function EditRetime({
  clip,
  start,
  zoom,
  name,
  onChange,
  onClose,
}: {
  clip: SlotClip;
  start: number; // 그 컷의 시작(초) — 클립이 놓인 자리
  zoom: number; // px/초
  name: string; // 머리 줄의 이름
  onChange: (change: RetimeChange) => void; // 놓을 때 한 번(바뀐 것이 있을 때만)
  onClose: () => void;
}) {
  const t = useT();
  const speed = clipSpeed(clip);
  // 끄는 중의 미리보기 — kind 와 그 결과(속도 또는 trim)·그때의 타임라인 길이(초)
  const [drag, setDragState] = useState<Preview | null>(null);
  const latest = useRef<Preview | null>(null); // 놓는 순간의 값 — 마지막 움직임이 아직 그려지기 전에 놓아도 그 값으로 적는다
  const setDrag = (next: Preview | null) => {
    latest.current = next;
    setDragState(next);
  };
  const press = useRef<{ kind: "speed" | "trim"; x: number; frames: number; id: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; typing: boolean } | null>(null);
  const footRef = useRef<HTMLButtonElement>(null);

  // 끄는 중의 Esc = 취소(뒤 화면의 Esc 로 가지 않게 먼저 받는다)
  useEffect(() => {
    if (!drag) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      press.current = null;
      setDrag(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [drag]);

  const down = (kind: "speed" | "trim") => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation(); // 줄의 끌어 고르기·클립 끌기로 가지 않게
    if (kind === "speed" && speedCap(clip) < SPEED_MIN) return; // 고를 수 있는 속도가 없다(아래 speedable)
    event.currentTarget.setPointerCapture?.(event.pointerId);
    press.current = { kind, x: event.clientX, frames: Math.round(clip.len * EDIT_FPS), id: event.pointerId };
    setDrag({ kind, speed, trim: clip.trim ?? null, len: clip.len });
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const held = press.current;
    if (!held || held.id !== event.pointerId) return;
    const frames = Math.max(1, Math.round(held.frames + ((event.clientX - held.x) / zoom) * EDIT_FPS));
    if (held.kind === "speed") {
      const next = speedForFrames(clip, frames);
      setDrag({ kind: "speed", speed: next, trim: clip.trim ?? null, len: clipLen({ ...clip, speed: next }, clip.full) });
    } else {
      const trim = trimForFrames(clip, frames);
      setDrag({ kind: "trim", speed, trim, len: clipLen(withTrim(clip, trim), clip.full) });
    }
  };
  const up = (cancel: boolean) => (event: ReactPointerEvent<HTMLElement>) => {
    const held = press.current;
    if (!held || held.id !== event.pointerId) return;
    press.current = null;
    const result = latest.current;
    setDrag(null);
    if (cancel || !result) return;
    if (held.kind === "speed" && result.speed !== speed) onChange({ speed: result.speed });
    if (held.kind === "trim" && result.trim !== (clip.trim ?? null) && result.len !== clip.len) {
      onChange({ range: { head: clip.head, trim: result.trim } });
    }
  };
  const cap = speedCap(clip);
  const speedable = cap >= SPEED_MIN; // 원본이 25% 의 한 프레임도 못 채우면 속도를 고를 수 없다(끌기·키 — 100% 복귀는 메뉴)
  // 키보드 — ←/↓ 는 줄이고 →/↑ 는 늘린다(속도 % · 끝의 타임라인 프레임). 끄는 중에는 막기만 한다.
  const keys = (kind: "speed" | "trim") => (event: ReactKeyboardEvent<HTMLElement>) => {
    const dir = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 0;
    if (!dir || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault(); // 편집 키(재생헤드 옮기기)가 같은 화살표를 쓰지 않게 — 편집 키는 막힌 키를 건너뛴다
    event.stopPropagation();
    if (drag) return;
    const step = dir * (event.shiftKey ? 10 : 1);
    if (kind === "speed") {
      if (!speedable) return; // 고를 수 있는 속도가 없다(원본이 아주 짧다) — 100% 복귀는 메뉴로
      // 범위(25% ~ 상한) 안으로 — 늘리는 키가 줄이거나(상한 밖의 지금 값) 줄이는 키가 늘리지 않게 그 방향으로 바뀔 때만
      //  소수 둘째 자리 %(직접 입력)는 그대로 두고 1·10%p 를 더한다(100.50% → 101.50% — 정수로 반올림하면 102%)
      const next = Math.max(SPEED_MIN, Math.min(cap, Math.round(speed * 10000 + step * 100) / 10000));
      if (dir > 0 ? next > speed : next < speed) onChange({ speed: next });
      return;
    }
    const trim = trimStep(clip, step);
    if (trim !== undefined) onChange({ range: { head: clip.head, trim } });
  };
  // 슬라이더의 값과 범위 — 끄는 중이면 미리보기 값이고, 범위는 언제나 그 값을 담는다(상한 밖의 지금 속도 · 미리보기 속도에서의 끝 범위)
  const nowSpeed = drag?.speed ?? speed;
  const nowFrames = Math.round((drag?.len ?? clip.len) * EDIT_FPS);
  const range = (kind: "speed" | "trim") => (kind === "speed"
    ? { min: +(Math.min(SPEED_MIN, nowSpeed) * 100).toFixed(2), max: +(Math.max(cap, nowSpeed) * 100).toFixed(2), now: +(nowSpeed * 100).toFixed(2) }
    : { min: Math.min(1, nowFrames), max: Math.max(mostFrames(clip, nowSpeed), nowFrames), now: nowFrames });
  const grip = (kind: "speed" | "trim", label: string) => (
    <span className={`ed-rt-grip ed-rt-${kind}`} role="slider" tabIndex={0} aria-label={label} title={label}
      aria-orientation="horizontal"
      aria-valuemin={range(kind).min} aria-valuemax={range(kind).max} aria-valuenow={range(kind).now}
      aria-disabled={kind === "speed" && !speedable ? true : undefined}
      aria-valuetext={kind === "speed" ? speedText(nowSpeed) : `${(drag?.len ?? clip.len).toFixed(2)}${t("초")}`}
      onKeyDown={keys(kind)}
      onPointerDown={down(kind)} onPointerMove={move} onPointerUp={up(false)} onPointerCancel={up(true)} onLostPointerCapture={up(true)} />
  );

  const len = drag?.len ?? clip.len;
  const shownSpeed = drag?.speed ?? speed;
  useEditShortcutsVersion(); // 닫기 단추의 키 글자 = 지금 지정된 속도 막대 키
  const pick = (next: number) => {
    setMenu(null);
    if (next !== speed) onChange({ speed: next });
  };
  return (
    <>
      {drag && drag.len !== clip.len && (
        // 끄기 전의 자리 — 점선(줄어든 만큼·늘어날 자리를 같이 본다)
        <div className="ed-rt-ghost" style={{ left: start * zoom, width: clip.len * zoom }} aria-hidden="true" />
      )}
      <div className={"ed-rt" + (drag ? ` ed-rt-drag-${drag.kind}` : "")} style={{ left: start * zoom + 1, width: Math.max(28, len * zoom - 2) }}>
        <div className="ed-rt-in">
          <div className="ed-rt-head">
            <button type="button" className="ed-rt-x" aria-label={t("속도 조절 닫기")} title={fillKeys(t("속도 조절 닫기 ({key})"), { key: hintOf("retime") })}
              onPointerDown={(event) => event.stopPropagation()} onClick={onClose}>✕</button>
            <b>{t("속도 조절")}</b>
            <span>{name}</span>
          </div>
          <div className="ed-rt-strip" aria-hidden="true" />
        </div>
        <button type="button" ref={footRef} className="ed-rt-foot" aria-haspopup="menu" aria-expanded={!!menu}
          title={t("속도 고르기")}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            if (menu) return setMenu(null);
            const box = footRef.current?.getBoundingClientRect();
            setMenu({ x: (box?.left ?? 0) + (box?.width ?? 0) / 2 - MENU_W / 2, y: (box?.bottom ?? 0) + 4, typing: false });
          }}>
          {speedText(shownSpeed)} <i>▾</i>
          {drag && <small>{len.toFixed(2)}s</small>}
        </button>
        {grip("speed", t("속도 — 끌거나 ←/→ 로 바꾸기(원본 구간 그대로 · Shift 10%)"))}
        {grip("trim", t("끝 — 끌거나 ←/→ 로 자르기·늘리기(속도 그대로 · Shift 10프레임)"))}
      </div>
      {menu && (
        <EditMenu x={menu.x} y={menu.y} width={MENU_W} height={menu.typing ? 90 : 290} label={t("속도")} trigger={footRef}
          className="ed-rt-menu" role={menu.typing ? "dialog" : "menu"} onClose={() => setMenu(null)}>
          {menu.typing ? <SpeedInput speed={speed} cap={cap} onPick={pick} /> : <>
            {PRESETS.map((value, index) => (
              <button key={value} type="button" role="menuitemradio" aria-checked={value === speed} autoFocus={index === 0}
                className={"ed-tmenu-item" + (value === speed ? " ed-here" : "")} disabled={value > cap && value !== 1} onClick={() => pick(value)}>
                {speedText(value)}
                <i>{value === 1 ? t("원래 속도") : value === speed ? t("지금") : ""}</i>
              </button>
            ))}
            {!PRESETS.includes(speed) && (
              <button type="button" role="menuitemradio" aria-checked className="ed-tmenu-item ed-here" onClick={() => setMenu(null)}>
                {speedText(speed)}<i>{t("지금")}</i>
              </button>
            )}
            <div className="ed-tmenu-sep" />
            <button type="button" role="menuitem" className="ed-tmenu-item" onClick={() => setMenu({ ...menu, typing: true })}>
              {t("속도 직접 입력…")}
            </button>
          </>}
        </EditMenu>
      )}
    </>
  );
}

// 속도 직접 입력 — % 로 친다(25 ~ 400). Enter = 적용 · 못 읽는 값·범위 밖은 적용하지 않고 까닭을 적는다.
function SpeedInput({ speed, cap, onPick }: { speed: number; cap: number; onPick: (speed: number) => void }) {
  const t = useT();
  const [text, setText] = useState(String(+(speed * 100).toFixed(2)));
  const value = Number(text.trim().replace(",", ".").replace(/%$/, ""));
  const next = Math.round(value * 100) / 10000;
  // 100%(원래 속도)로 되돌리기는 늘 된다 — 원본이 짧게 다시 재어져 상한이 100% 밑이어도(setClipSpeed 와 같다)
  const ok = Number.isFinite(value) && next >= SPEED_MIN && (next <= cap || next === 1);
  return (
    <div className="ed-rt-input">
      <label>
        <input type="text" inputMode="decimal" autoFocus value={text} aria-label={t("속도(%)")}
          onFocus={(event) => event.target.select()}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && ok) onPick(next);
          }} />
        <span>%</span>
        <button type="button" className="ed-tmenu-item" disabled={!ok} onClick={() => onPick(next)}>{t("적용")}</button>
      </label>
      <small>{t("{min}~{max}% 사이").replace("{min}", String(SPEED_MIN * 100)).replace("{max}", String(+(cap * 100).toFixed(2)))}</small>
    </div>
  );
}
