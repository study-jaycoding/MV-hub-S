import type { CSSProperties, KeyboardEvent } from "react";
import { SpotlightOptionIcon } from "./SpotlightOptionIcon";

// 길이 칩 — 칩에는 "4s" 만, 누르면 바로 위에 "Total duration" 창이 뜬다(Jay 2026-10-28, 힉스필드 길이 창 모양).
// 생성창·수정 창 공용. 여닫기는 부르는 쪽이 쥔다(생성창 open 이름·수정 창 menu) — 바깥 누름은 .sl-chip-wrap 밖이면 닫힌다.
// 눈금은 고른 간격: stops 가 있으면 그 길이들만(눈금 = 그 값들), 없으면 눈금 = 처음·10·15·20·끝이고 눈금 사이를 1초 단위로 고르게 나눈다
// (짧은 길이 쪽이 막대의 넓은 자리를 차지해 고르기 쉽다 — 힉스필드와 같다). 화살표 키는 1초(또는 한 눈금)씩.
const SEG = 100; // 눈금 한 칸을 나누는 막대 단위 수(1초보다 촘촘해야 끌기가 매끄럽다)

export function SpotlightDurationChip({
  value,
  min,
  max,
  stops,
  open,
  onToggle,
  onChange,
  disabled = false,
  ignored = false,
  label = "길이",
  title,
}: {
  value: number;
  min: number;
  max: number;
  stops?: number[];
  open: boolean;
  onToggle: () => void;
  onChange: (value: number) => void;
  disabled?: boolean;
  /** CLI 가 이 모드에서 버리는 값 — 흐리게 + 못 누름(2026-09-15 Jay 규칙), 값은 보존 */
  ignored?: boolean;
  label?: string;
  title?: string;
}) {
  const locked = disabled || ignored;
  const marks = stops ?? [...new Set([min, ...[10, 15, 20].filter((v) => v > min && v < max), max])];
  const last = Math.max(1, marks.length - 1);
  // 값 → 막대 자리(눈금 i 에서 i+1 사이를 고르게), 막대 자리 → 값
  const toPos = (v: number) => {
    if (stops) return Math.max(0, stops.indexOf(v));
    const i = Math.max(0, marks.findIndex((_m, k) => k === marks.length - 1 || v < marks[k + 1]));
    const a = marks[Math.min(i, marks.length - 1)], b = marks[Math.min(i + 1, marks.length - 1)];
    return Math.round((i + (b > a ? (v - a) / (b - a) : 0)) * SEG);
  };
  const fromPos = (p: number) => {
    if (stops) return stops[p];
    const i = Math.min(Math.floor(p / SEG), marks.length - 2);
    if (i < 0) return marks[0];
    return Math.round(marks[i] + (p / SEG - i) * (marks[i + 1] - marks[i]));
  };
  const step = (e: KeyboardEvent<HTMLInputElement>) => {
    const dir = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const next = stops ? stops[Math.min(stops.length - 1, Math.max(0, stops.indexOf(value) + dir))] : Math.min(max, Math.max(min, value + dir));
    if (next !== value) onChange(next);
  };
  const at = (i: number) => ({ "--at": (i / last).toFixed(4) }) as CSSProperties;
  const top = stops ? Math.max(1, stops.length - 1) : last * SEG;
  const filled = { "--pos": (Math.min(top, Math.max(0, toPos(value))) / top).toFixed(4) } as CSSProperties; // 손잡이까지 라임 채움
  return (
    <div className="sl-chip-wrap">
      <button
        type="button"
        className={"sl-chip sl-opt-chip sl-opt-dur" + (ignored ? " sl-opt-ignored" : "") + (open && !locked ? " active" : "")}
        title={title ?? label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open && !locked}
        disabled={locked}
        onClick={onToggle}
      >
        <span className="sl-opt-ic"><SpotlightOptionIcon name="duration" /></span>
        <span className="sl-opt-val">{value}s</span>
      </button>
      {open && !locked && (
        <div className="sl-dropdown sl-dur-pop" role="dialog" aria-label={label}>
          <div className="sl-dur-title">Total duration</div>
          <div className="sl-dur-head">{value}s</div>
          <div className="sl-dur-track" style={filled}>
            <span className="sl-dur-fill" aria-hidden="true" />
            {marks.map((v, i) => <span key={v} className="sl-dur-dot" style={at(i)} aria-hidden="true" />)}
            <input
              type="range"
              aria-label={label}
              aria-valuetext={`${value}s`}
              min={0}
              max={stops ? stops.length - 1 : last * SEG}
              step={1}
              value={toPos(value)}
              onKeyDown={step}
              onChange={(e) => {
                const next = fromPos(Number(e.target.value));
                if (next !== value) onChange(next);
              }}
            />
          </div>
          <div className="sl-dur-marks" aria-hidden="true">
            {marks.map((v, i) => <span key={v} style={at(i)}>{v}</span>)}
          </div>
        </div>
      )}
    </div>
  );
}
