import type { MouseEvent as ReactMouseEvent, Ref } from "react";
import { useT } from "../../lib/i18n";
import { MEDIA_FILTER_OPTIONS } from "../../lib/mediaTypes";
import { ASSET_COLOR_DOTS, ColorFilterDots } from "../common/ColorFilterDots";
import { TagFilterPanel } from "../common/TagFilterPanel";
import { ViewControls } from "../common/ViewControls";
import { AssetSortMenu } from "./AssetSortMenu";
import type { AssetSortDir, AssetSortField, AssetTypeFilter } from "./assetsViewModel";

type LayoutMode = "grid" | "list";

export function AssetsCrumbBar({
  tagPanelOpen,
  allTags,
  activeTags,
  tagPanelRef,
  tagPanelPos,
  tagPanelSize,
  onTagHeadMouseDown,
  onClearTags,
  onSelectTag,
  onDeleteTag,
  sourceOnly,
  activeColors,
  typeFilter,
  onTypeFilterChange,
  fileCount,
  onToggleColor,
  grayOn,
  onToggleGray,
  onToggleSourceOnly,
  tagFilterActive,
  onToggleTagPanel,
  commentOnly,
  hasAnyUnread,
  onToggleCommentOnly,
  fit,
  onToggleFit,
  scale,
  onScale,
  layout,
  groupByDate,
  onSelectLayout,
  onToggleGroupByDate,
  sortField,
  sortDir,
  onSortField,
  onSortDir,
}: {
  tagPanelOpen: boolean;
  allTags: string[];
  activeTags: Set<string>;
  tagPanelRef: Ref<HTMLDivElement>;
  tagPanelPos: { x: number; y: number } | null;
  tagPanelSize?: { w: number; h: number } | null;
  onTagHeadMouseDown: (e: ReactMouseEvent, fallback?: { x: number; y: number }) => void;
  onClearTags: () => void;
  onSelectTag: (tag: string, additive: boolean) => void;
  onDeleteTag: (tag: string) => void;
  sourceOnly: boolean;
  activeColors: Set<string>;
  typeFilter: AssetTypeFilter;
  onTypeFilterChange: (value: AssetTypeFilter) => void;
  fileCount: number;
  onToggleColor: (hex: string) => void;
  grayOn: boolean;
  onToggleGray: () => void;
  onToggleSourceOnly: () => void;
  tagFilterActive: boolean;
  onToggleTagPanel: () => void;
  commentOnly: boolean;
  hasAnyUnread: boolean;
  onToggleCommentOnly: () => void;
  fit: "cover" | "contain";
  onToggleFit: () => void;
  scale: number;
  onScale: (value: number) => void;
  layout: LayoutMode;
  groupByDate: boolean;
  onSelectLayout: (layout: LayoutMode) => void;
  onToggleGroupByDate: () => void;
  sortField: AssetSortField;
  sortDir: AssetSortDir;
  onSortField: (field: AssetSortField) => void;
  onSortDir: (dir: AssetSortDir) => void;
}) {
  const t = useT();
  // 미디어 타입 4점 슬라이더 — 메인 라이브러리 툴바(생성탭)와 동일 UI·동일 위치(좌측).
  // 사이드바 타입 필터와 한 상태(typeFilter)를 조작하므로 어느 쪽으로 바꿔도 함께 움직인다.
  const typeIndex = Math.max(
    0,
    MEDIA_FILTER_OPTIONS.findIndex((o) => o.v === (typeFilter ?? "all")),
  );
  return (
    <div className="assets-crumb">
      {tagPanelOpen && (
        <TagFilterPanel
          tags={allTags}
          activeTags={activeTags}
          panelRef={tagPanelRef}
          pos={tagPanelPos}
          size={tagPanelSize}
          onHeadMouseDown={onTagHeadMouseDown}
          onClear={onClearTags}
          onClose={onToggleTagPanel}
          onSelectTag={onSelectTag}
          onDeleteTag={onDeleteTag}
          deleteTitle="이 태그를 모든 파일에서 삭제"
          orderKey="ch.assets.tagOrder"
        />
      )}

      <div
        className="lib-hist-slider"
        data-type={typeFilter ?? "all"}
        title="미디어 타입 — 슬라이드로 전환"
      >
        <span className="lib-hist-label">
          {t(MEDIA_FILTER_OPTIONS[typeIndex].label)}
        </span>
        <div className="lib-hist-range">
          <div className="lib-hist-ticks">
            {MEDIA_FILTER_OPTIONS.map((o, i) => (
              <button
                key={o.v}
                type="button"
                className={"lib-hist-tick" + (i === typeIndex ? " on" : "")}
                title={t(o.label)}
                onClick={() => onTypeFilterChange(o.v === "all" ? null : o.v)}
              />
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={MEDIA_FILTER_OPTIONS.length - 1}
            step={1}
            value={typeIndex}
            onChange={(e) => {
              const next = MEDIA_FILTER_OPTIONS[Number(e.target.value)].v;
              onTypeFilterChange(next === "all" ? null : next);
            }}
          />
        </div>
      </div>
      {/* 생성탭 툴바와 동일 — 슬라이더 옆에 '타입 · 건수' 표시 */}
      <span className="lib-count">
        {t(MEDIA_FILTER_OPTIONS[typeIndex].label)} · {fileCount}
        {t("개")}
      </span>

      <div className="assets-tools">
        <div className="assets-filters">
          <ColorFilterDots
            colorDots={ASSET_COLOR_DOTS}
            activeColors={activeColors}
            onToggleColor={onToggleColor}
            grayOn={grayOn}
            onToggleGray={onToggleGray}
          />
          <button
            className={"af-btn" + (sourceOnly ? " on" : "")}
            title="소스로 등록된 것만 보기"
            onClick={onToggleSourceOnly}
          >
            S
          </button>
          <button
            className={"af-btn" + (tagFilterActive ? " on" : "")}
            title="등록된 태그 보기/선택/삭제 (T 다시 누르면 닫힘+필터 해제)"
            onClick={onToggleTagPanel}
          >
            T
          </button>
          <button
            className={
              "af-btn af-c" +
              (commentOnly ? " on" : "") +
              (hasAnyUnread && !commentOnly ? " alert" : "")
            }
            title={
              hasAnyUnread
                ? "새 코멘트가 있는 파일만 보기 (미확인 코멘트 있음)"
                : "새 코멘트가 있는 파일만 보기"
            }
            onClick={onToggleCommentOnly}
          >
            C
          </button>
        </div>

        <ViewControls
          fitContain={fit === "contain"}
          onToggleFit={onToggleFit}
          scale={scale}
          onScale={onScale}
          scaleMin={0.7}
          scaleMax={1.7}
          sizeTitle="크기"
          layout={layout}
          groupByDate={groupByDate}
          onSelectLayout={onSelectLayout}
          onToggleGroupByDate={onToggleGroupByDate}
          t={t}
        />

        <AssetSortMenu
          field={sortField}
          dir={sortDir}
          onField={onSortField}
          onDir={onSortDir}
        />
      </div>
    </div>
  );
}
