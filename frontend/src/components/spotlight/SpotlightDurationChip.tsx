import { SpotlightOptionIcon } from "./SpotlightOptionIcon";

// 길이 칩 — 칩에는 "4s" 만, 누르면 바로 위에 큰 값과 눈금 슬라이더 창이 뜬다(Jay 2026-10-28, 힉스필드 길이 창 모양).
// 생성창·수정 창 공용. 여닫기는 부르는 쪽이 쥔다(생성창 open 이름·수정 창 menu) — 바깥 누름은 .sl-chip-wrap 밖이면 닫힌다.
// stops 가 있으면 모델이 정해 둔 그 길이들만 고른다(눈금 = 그 값들), 없으면 min~max 1초 단위(눈금 = 처음·10·15·20·끝).
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
  const at = (v: number) => (stops
    ? (stops.length > 1 ? stops.indexOf(v) / (stops.length - 1) : 0)
    : (max > min ? (v - min) / (max - min) : 0));
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
          <div className="sl-dd-title">Duration</div>
          <div className="sl-dur-head">{value}s</div>
          <input
            type="range"
            aria-label={label}
            min={stops ? 0 : min}
            max={stops ? stops.length - 1 : max}
            step={1}
            value={stops ? Math.max(0, stops.indexOf(value)) : value}
            onChange={(e) => onChange(stops ? stops[Number(e.target.value)] : Number(e.target.value))}
          />
          <div className="sl-dur-marks" aria-hidden="true">
            {marks.map((v) => <span key={v} style={{ left: `${(at(v) * 100).toFixed(2)}%` }}>{v}</span>)}
          </div>
        </div>
      )}
    </div>
  );
}
