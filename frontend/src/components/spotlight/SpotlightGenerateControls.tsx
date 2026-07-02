import type { Dispatch, ReactNode, SetStateAction } from "react";

interface Props {
  children: ReactNode;
  count: number;
  maxCount: number;
  setCount: Dispatch<SetStateAction<number>>;
  busy: boolean;
  cost: number | null;
  costLoading: boolean;
  onSubmit: () => void;
}

export function SpotlightGenerateControls({
  children,
  count,
  maxCount,
  setCount,
  busy,
  cost,
  costLoading,
  onSubmit,
}: Props) {
  return (
    <div className="sl-controls">
      <div className="sl-left">
        {children}
        <div className="sl-count" title={`한 번에 생성할 장수 (최대 ${maxCount}, 각 장이 별도 카드)`}>
          <button
            className="sl-count-btn"
            onClick={() => setCount((value) => Math.max(1, value - 1))}
            disabled={count <= 1}
          >
            −
          </button>
          <span className="sl-count-val">
            {count}/{maxCount}
          </span>
          <button
            className="sl-count-btn"
            onClick={() => setCount((value) => Math.min(maxCount, value + 1))}
            disabled={count >= maxCount}
          >
            +
          </button>
        </div>
      </div>

      <button className="sl-gen" disabled={busy} onClick={onSubmit}>
        {busy ? "생성 중…" : count > 1 ? `Generate ${count}` : "Generate"}{" "}
        <span className="sl-sparkle">✦</span>
        {costLoading ? (
          <span className="sl-cost loading">…</span>
        ) : (
          cost != null &&
          cost > 0 && (
            <span
              className="sl-cost"
              title={`예상 크레딧 ${cost * count}${count > 1 ? ` (${count}장)` : ""} — 해상도·길이·모드에 따라 변동`}
            >
              {cost * count}
            </span>
          )
        )}
      </button>
    </div>
  );
}
