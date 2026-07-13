import { GridIcon, ListIcon } from "./ViewIcons";

type LayoutMode = "grid" | "list";

interface Props {
  fitContain: boolean;
  onToggleFit: () => void;
  scale: number;
  onScale: (value: number) => void;
  scaleMin: number;
  scaleMax: number;
  sizeTitle: string;
  layout: LayoutMode;
  groupByDate: boolean;
  onSelectLayout: (layout: LayoutMode) => void;
  onToggleGroupByDate: () => void;
  showLayout?: boolean;
  t?: (text: string) => string;
}

export function ViewControls({
  fitContain,
  onToggleFit,
  scale,
  onScale,
  scaleMin,
  scaleMax,
  sizeTitle,
  layout,
  groupByDate,
  onSelectLayout,
  onToggleGroupByDate,
  showLayout = true,
  t = (text) => text,
}: Props) {
  // 툴팁은 항상 뷰 이름(그리드/리스트)만 — 날짜 구분 상태와 무관(라이브러리·에셋 공통).
  const layoutTitle = (mode: LayoutMode) => t(mode === "list" ? "리스트" : "그리드");

  return (
    <>
      <button
        className={"fit-toggle" + (fitContain ? " on" : "")}
        onClick={onToggleFit}
        title={
          fitContain
            ? "전체 보기(블랙바) — 클릭 시 꽉 채우기"
            : "꽉 채우기(크롭) — 클릭 시 전체 보기"
        }
      >
        {fitContain ? "▢" : "▣"}
      </button>
      <div className="size-slider" title={sizeTitle}>
        <input
          type="range"
          min={scaleMin}
          max={scaleMax}
          step={0.05}
          value={scale}
          onChange={(e) => onScale(Number(e.target.value))}
        />
      </div>
      {showLayout && (
        <div className="layout-toggle">
          <button
            className={(layout === "list" ? "on" : "") + (layout === "list" && groupByDate ? " grouped" : "")}
            onClick={() => (layout === "list" ? onToggleGroupByDate() : onSelectLayout("list"))}
            title={layoutTitle("list")}
          >
            <ListIcon />
          </button>
          <button
            className={(layout === "grid" ? "on" : "") + (layout === "grid" && groupByDate ? " grouped" : "")}
            onClick={() => (layout === "grid" ? onToggleGroupByDate() : onSelectLayout("grid"))}
            title={layoutTitle("grid")}
          >
            <GridIcon />
          </button>
        </div>
      )}
    </>
  );
}
