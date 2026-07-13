import type { MouseEvent as ReactMouseEvent, Ref } from "react";
import { useT } from "../../lib/i18n";
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
  searchActive,
  sourceOnly,
  activeColors,
  query,
  project,
  breadcrumb,
  onProjectRoot,
  onBreadcrumb,
  typeFilter,
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
  searchActive: boolean;
  sourceOnly: boolean;
  activeColors: Set<string>;
  query: string;
  project: string;
  breadcrumb: string[];
  onProjectRoot: () => void;
  onBreadcrumb: (path: string) => void;
  typeFilter: AssetTypeFilter;
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
          onSelectTag={onSelectTag}
          onDeleteTag={onDeleteTag}
          deleteTitle="이 태그를 모든 파일에서 삭제"
        />
      )}

      {searchActive ? (
        <span className="crumb-search">
          {activeTags.size
            ? [...activeTags].map((tag) => `#${tag}`).join(" ")
            : sourceOnly
              ? "소스"
              : activeColors.size
                ? "컬러"
                : query.trim().startsWith("#")
                  ? "태그"
                  : "이름"}{" "}
          필터{query.trim() && !query.trim().startsWith("#") ? `: ${query.trim()}` : ""}
        </span>
      ) : (
        <>
          <button onClick={onProjectRoot}>{project}</button>
          {breadcrumb.map((segment, index) => (
            <span key={index}>
              <span className="crumb-sep">/</span>
              <button onClick={() => onBreadcrumb(breadcrumb.slice(0, index + 1).join("/"))}>
                {segment}
              </button>
            </span>
          ))}
        </>
      )}
      <span className="crumb-count">
        {typeFilter === "image"
          ? t("이미지")
          : typeFilter === "video"
            ? t("영상")
            : typeFilter === "audio"
              ? t("오디오")
              : t("전체")}{" "}
        · {fileCount}{t("개")}
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
          scaleMin={0.6}
          scaleMax={1.8}
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
