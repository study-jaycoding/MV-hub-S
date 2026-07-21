// 라이브러리 툴바 (힉스필드식): History(미디어 타입 필터) + 필터 토글 +
// 썸네일 크기 조절 슬라이더 + List/Grid 레이아웃 토글.
import { useT } from "../lib/i18n";
import type { MediaFilter } from "../lib/mediaTypes";
import { MEDIA_FILTER_OPTIONS } from "../lib/mediaTypes";
import { makeStore } from "../lib/storage";
import { useFloatingPanel } from "../lib/useFloatingPanel";
import { ColorFilterDots } from "./common/ColorFilterDots";
import { TagFilterPanel } from "./common/TagFilterPanel";
import { ViewControls } from "./common/ViewControls";

const LIB_LS = makeStore("ch.lib.");

interface Props {
  typeFilter: MediaFilter;
  onTypeFilter: (t: MediaFilter) => void;
  scale: number;
  onScale: (v: number) => void;
  fill: boolean;
  onToggleFill: () => void;
  layout: "grid" | "list";
  onLayout: (l: "grid" | "list") => void;
  groupByDate: boolean; // 그리드 날짜별 구분 모드
  onToggleGroupByDate: () => void;
  filtersOpen: boolean;
  onToggleFilters: () => void;
  count: number;
  countMore?: boolean; // 로드된 수 뒤에 '+'(다음 페이지 더 있음)
  loading: boolean;
  failedCount: number; // 실패 항목 수(>0 이면 '실패 정리' 노출)
  onClearFailed: () => void;
  // 에셋 파트와 동일한 인스턴트 필터(컬러 dot · S · T)
  colorDots: { k: string; hex: string }[];
  colorFilter: Set<string>;
  onToggleColor: (hex: string) => void;
  sharedOnly: boolean;
  onToggleShared: () => void;
  commentOnly: boolean; // C 필터: 미확인 코멘트만 보기
  onToggleComment: () => void;
  finalOnly?: boolean; // 골드 필터: 최종(골드)만 보기
  onToggleFinal?: () => void;
  grayOn?: boolean; // 회색 필터: 비활성(회색) 카드 숨기기(다른 dot 과 반대 — 그 카드들만 제외)
  onToggleGray?: () => void;
  hasUnread: boolean; // 미확인 코멘트 존재 → C 자동 알림(호박색)
  tags: string[];
  tagFilter: Set<string>;
  onSelectTag: (t: string, additive: boolean) => void; // 클릭=단일, Shift/Ctrl=다중(에셋과 동일)
  onDeleteTag: (t: string) => void; // ✕ 전역 삭제
  onClearTags: () => void; // 필터 해제
  tagPanelOpen: boolean;
  onToggleTagPanel: () => void;
  // 구성탭(보드) 전용: 크기 슬라이더가 보드 줌을 직접 제어(주면 슬라이더는 scale 대신 이 값을 씀).
  // 휠로 확대/축소하면 zoomValue 가 갱신돼 슬라이더가 따라 움직인다. 별도 숫자 표시는 없음.
  zoomValue?: number; // 현재 보드 줌(0.3~2.5)
  onZoomValue?: (v: number) => void; // 슬라이더 드래그 → 보드 줌 설정
  // 그래프 보드(히스토리/구성) 모드 — 의미 없는 컨트롤(리스트/그리드 토글 등)을 숨긴다.
  boardMode?: boolean;
  // 보드 모드라도 필터 사이드바 토글(▢/▷)을 보인다 — 캔버스는 폴더 사이드바가 있어 열고닫아야 함.
  // 미지정이면 !boardMode(라이브러리만 표시)를 따른다.
  showFilterToggle?: boolean;
}

export function LibraryToolbar({
  typeFilter,
  onTypeFilter,
  scale,
  onScale,
  fill,
  onToggleFill,
  layout,
  onLayout,
  groupByDate,
  onToggleGroupByDate,
  filtersOpen,
  onToggleFilters,
  count,
  countMore,
  loading,
  failedCount,
  onClearFailed,
  colorDots,
  colorFilter,
  onToggleColor,
  sharedOnly,
  onToggleShared,
  commentOnly,
  onToggleComment,
  finalOnly = false,
  onToggleFinal,
  grayOn = false,
  onToggleGray,
  hasUnread,
  tags,
  tagFilter,
  onSelectTag,
  onDeleteTag,
  onClearTags,
  tagPanelOpen,
  onToggleTagPanel,
  zoomValue,
  onZoomValue,
  boardMode = false,
  showFilterToggle,
}: Props) {
  const t = useT();
  const typeLabel = MEDIA_FILTER_OPTIONS.find((o) => o.v === typeFilter)?.label ?? "전체";
  const typeIndex = Math.max(0, MEDIA_FILTER_OPTIONS.findIndex((o) => o.v === typeFilter));

  // 태그 패널 — 에셋 파트와 동일: 플로팅(헤더 드래그 이동) + CSS resize + 위치·크기 영속.
  const {
    pos: tagPos,
    size: tagSize,
    panelRef: tagPanelRef,
    onHeadMouseDown: onTagHeadDown,
  } = useFloatingPanel(LIB_LS, "tagPos", "tagSize", tagPanelOpen);
  return (
    <div className="lib-toolbar">
      {/* 필터 사이드바 토글 — 열림=▢(사각), 닫힘=▷(삼각). 캔버스는 폴더 사이드바가 있어 표시. */}
      {(showFilterToggle ?? !boardMode) && (
        <button
          className={"lib-filter lib-filter-ic" + (filtersOpen ? " on" : "")}
          onClick={onToggleFilters}
          title={filtersOpen ? t("필터 사이드바 닫기") : t("필터 사이드바 열기")}
        >
          {filtersOpen ? "▢" : "▷"}
        </button>
      )}
      {/* 미디어 타입 — 4개 점 슬라이더(전체·이미지·영상·오디오). 슬라이드/점클릭 모두 전환 */}
      <div className="lib-hist-slider" title="미디어 타입 — 슬라이드로 전환">
        <span className="lib-hist-label">{t(typeLabel)}</span>
        <div className="lib-hist-range">
          <div className="lib-hist-ticks">
            {MEDIA_FILTER_OPTIONS.map((o, i) => (
              <button
                key={o.v}
                type="button"
                className={"lib-hist-tick" + (i === typeIndex ? " on" : "")}
                title={t(o.label)}
                onClick={() => onTypeFilter(o.v)}
              />
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={MEDIA_FILTER_OPTIONS.length - 1}
            step={1}
            value={typeIndex}
            onChange={(e) => onTypeFilter(MEDIA_FILTER_OPTIONS[Number(e.target.value)].v)}
          />
        </div>
      </div>

      <span className="lib-count">
        {t(typeLabel)} · {count}{countMore ? "+" : ""}{t("건")}{loading && ` · ${t("로딩…")}`}
      </span>
      {failedCount > 0 && (
        <button
          className="lib-clear-failed"
          title="실패·NSFW 차단 등 비정상 생성물을 휴지통으로 (복구 가능 · 힉스필드 원본엔 영향 없음)"
          onClick={onClearFailed}
        >
          실패·차단 정리 ({failedCount})
        </button>
      )}

      <div className="lib-tools">
        {/* 인스턴트 필터: 골드(최종만) · 컬러 dot · S(팀 공유만) · T(태그) · C(코멘트) */}
        <div className="assets-filters">
          <ColorFilterDots
            colorDots={colorDots}
            activeColors={colorFilter}
            onToggleColor={onToggleColor}
            grayOn={grayOn}
            onToggleGray={onToggleGray}
            finalOnly={finalOnly}
            onToggleFinal={onToggleFinal}
          />
          <button
            className={"af-btn" + (sharedOnly ? " on" : "")}
            title="팀에 공유된 것만 보기"
            onClick={onToggleShared}
          >
            S
          </button>
          <button
            className={"af-btn" + (tagPanelOpen || tagFilter.size ? " on" : "")}
            title="태그로 필터 (다시 누르면 닫힘 + 해제)"
            onClick={onToggleTagPanel}
          >
            T
          </button>
          <button
            className={
              "af-btn af-c" +
              (commentOnly ? " on" : "") +
              (hasUnread && !commentOnly ? " alert" : "")
            }
            title={
              hasUnread
                ? "코멘트가 있는 생성본만 보기 (미확인 코멘트 있음)"
                : "코멘트가 있는 생성본만 보기"
            }
            onClick={onToggleComment}
          >
            C
          </button>
          {tagPanelOpen && (
            <TagFilterPanel
              tags={tags}
              activeTags={tagFilter}
              panelRef={tagPanelRef}
              pos={tagPos}
              size={tagSize}
              onHeadMouseDown={onTagHeadDown}
              onClear={onClearTags}
              onClose={onToggleTagPanel}
              onSelectTag={onSelectTag}
              onDeleteTag={onDeleteTag}
              orderKey="ch.lib.tagOrder"
            />
          )}
        </div>

        <ViewControls
          fitContain={!fill}
          onToggleFit={onToggleFill}
          scale={onZoomValue ? (zoomValue ?? 1) : scale}
          onScale={(v) => (onZoomValue ? onZoomValue(v) : onScale(v))}
          scaleMin={onZoomValue ? 0.3 : 0.7}
          scaleMax={onZoomValue ? 2.5 : 1.7}
          sizeTitle={onZoomValue ? "화면 확대/축소" : "카드 크기"}
          layout={layout}
          groupByDate={groupByDate}
          onSelectLayout={onLayout}
          onToggleGroupByDate={onToggleGroupByDate}
          showLayout={!boardMode}
          t={t}
        />
      </div>
    </div>
  );
}
