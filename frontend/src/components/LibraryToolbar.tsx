// 라이브러리 툴바 (힉스필드식): History(미디어 타입 필터) + 필터 토글 +
// 썸네일 크기 조절 슬라이더 + List/Grid 레이아웃 토글.
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import { loadJSON } from "../lib/storage";

type MediaFilter = "all" | "image" | "video" | "audio";

const MEDIA_OPTS: { v: MediaFilter; label: string }[] = [
  { v: "all", label: "전체" },
  { v: "image", label: "이미지" },
  { v: "video", label: "영상" },
  { v: "audio", label: "오디오" },
];

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
  // 그래프 보드(히스토리/구성) 모드 — 의미 없는 컨트롤(필터 사이드바 토글·리스트/그리드 토글)을 숨긴다.
  boardMode?: boolean;
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
}: Props) {
  const t = useT();
  const typeLabel = MEDIA_OPTS.find((o) => o.v === typeFilter)?.label ?? "전체";
  const typeIndex = Math.max(0, MEDIA_OPTS.findIndex((o) => o.v === typeFilter));

  // 태그 패널 — 에셋 파트와 동일: 플로팅(헤더 드래그 이동) + CSS resize + 위치·크기 영속.
  const [tagPos, setTagPos] = useState<{ x: number; y: number } | null>(() =>
    loadJSON("ch.lib.tagPos"),
  );
  const [tagSize, setTagSize] = useState<{ w: number; h: number } | null>(() =>
    loadJSON("ch.lib.tagSize"),
  );
  const tagDragRef = useRef<{ dx: number; dy: number } | null>(null);
  const tagPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (tagPos) localStorage.setItem("ch.lib.tagPos", JSON.stringify(tagPos));
  }, [tagPos]);
  useEffect(() => {
    if (tagSize) localStorage.setItem("ch.lib.tagSize", JSON.stringify(tagSize));
  }, [tagSize]);
  // 크기조절(CSS resize) → offset 측정해 영속.
  useEffect(() => {
    if (!tagPanelOpen) return;
    const el = tagPanelRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTagSize({ w: el.offsetWidth, h: el.offsetHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [tagPanelOpen]);

  const onTagDrag = useCallback((e: MouseEvent) => {
    const d = tagDragRef.current;
    if (!d) return;
    setTagPos({ x: e.clientX - d.dx, y: e.clientY - d.dy });
  }, []);
  const onTagDragUp = useCallback(() => {
    tagDragRef.current = null;
    window.removeEventListener("mousemove", onTagDrag);
    window.removeEventListener("mouseup", onTagDragUp);
  }, [onTagDrag]);
  const onTagHeadDown = (e: React.MouseEvent) => {
    const pos = tagPos || { x: 180, y: 150 };
    tagDragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    window.addEventListener("mousemove", onTagDrag);
    window.addEventListener("mouseup", onTagDragUp);
  };
  return (
    <div className="lib-toolbar">
      {/* 필터 사이드바 토글 — 열림=▢(사각), 닫힘=▷(삼각). 보드 모드(히스토리)에선 사이드바가 없어 숨김. */}
      {!boardMode && (
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
            {MEDIA_OPTS.map((o, i) => (
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
            max={MEDIA_OPTS.length - 1}
            step={1}
            value={typeIndex}
            onChange={(e) => onTypeFilter(MEDIA_OPTS[Number(e.target.value)].v)}
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
          {/* 골드 dot — 레드 앞. 누르면 최종(골드) 지정된 것만 필터. */}
          {onToggleFinal && (
            <button
              className={"af-dot af-dot-gold" + (finalOnly ? " on" : "")}
              title="최종(골드)으로 지정된 것만 보기"
              onClick={onToggleFinal}
            />
          )}
          {colorDots.map(({ k, hex }) => {
            const on = colorFilter.has(hex);
            return (
              <button
                key={k}
                className={"af-dot" + (on ? " on" : "")}
                style={{
                  background: hex,
                  filter: on ? "brightness(1.2) saturate(1.25)" : "brightness(0.45) saturate(0.7)",
                  opacity: on ? 1 : 0.85,
                  borderColor: on ? "#fff" : "rgba(0,0,0,0.4)",
                  boxShadow: on ? `0 0 0 2px ${hex}, 0 0 11px ${hex}` : "none",
                }}
                title={`${k.toUpperCase()} 컬러만 보기`}
                onClick={() => onToggleColor(hex)}
              />
            );
          })}
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
            <div
              className="tag-panel"
              ref={tagPanelRef}
              style={{
                left: (tagPos || { x: 180, y: 150 }).x,
                top: (tagPos || { x: 180, y: 150 }).y,
                width: tagSize?.w,
                height: tagSize?.h,
              }}
            >
              <div className="tag-panel-head" onMouseDown={onTagHeadDown}>
                <span>
                  등록된 태그 <span className="muted">({tags.length})</span>
                </span>
                {tagFilter.size > 0 && (
                  <button
                    className="tag-panel-clear"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={onClearTags}
                  >
                    필터 해제
                  </button>
                )}
              </div>
              <div className="tag-panel-list">
                {tags.length === 0 && (
                  <div className="tag-panel-empty">등록된 태그가 없습니다.</div>
                )}
                {tags.map((t) => (
                  <span key={t} className={"tag-pill" + (tagFilter.has(t) ? " on" : "")}>
                    <button
                      className="tag-pill-name"
                      title="클릭=이 태그만 · Shift/Ctrl+클릭=다중 선택"
                      onClick={(e) => onSelectTag(t, e.shiftKey || e.ctrlKey || e.metaKey)}
                    >
                      #{t}
                    </button>
                    <button
                      className="tag-pill-x"
                      title="이 태그를 모든 생성본에서 삭제"
                      onClick={() => onDeleteTag(t)}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 썸네일 꽉 채움(cover ▣) ↔ 비율 유지(contain ▢) 토글 — 에셋 파트와 동일 */}
        <button
          className={"fit-toggle" + (!fill ? " on" : "")}
          onClick={onToggleFill}
          title={
            fill
              ? "꽉 채우기(크롭) — 클릭 시 전체 보기"
              : "전체 보기(블랙바) — 클릭 시 꽉 채우기"
          }
        >
          {fill ? "▣" : "▢"}
        </button>

        {/* 크기 조절 바 — 구성탭(onZoomValue)이면 보드 줌(0.3~2.5)을 직접 제어(휠 확대/축소와 연동),
            그 외 탭은 카드 크기(scale, 0.7~1.7). */}
        <div className="size-slider" title={onZoomValue ? "화면 확대/축소" : "카드 크기"}>
          <input
            type="range"
            min={onZoomValue ? 0.3 : 0.7}
            max={onZoomValue ? 2.5 : 1.7}
            step={0.05}
            value={onZoomValue ? (zoomValue ?? 1) : scale}
            onChange={(e) =>
              onZoomValue ? onZoomValue(Number(e.target.value)) : onScale(Number(e.target.value))
            }
          />
        </div>

        {/* List / Grid 토글 — 보드 모드(히스토리 그래프)에선 의미 없어 숨김. */}
        {!boardMode && (
        <div className="layout-toggle">
          <button
            className={layout === "list" ? "on" : ""}
            onClick={() => onLayout("list")}
            title={t("리스트")}
          >
            <svg
              viewBox="0 0 24 24"
              width="15"
              height="15"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <line x1="9" y1="4" x2="9" y2="20" />
            </svg>
          </button>
          <button
            className={(layout === "grid" ? "on" : "") + (layout === "grid" && groupByDate ? " grouped" : "")}
            onClick={() => (layout === "grid" ? onToggleGroupByDate() : onLayout("grid"))}
            title={
              layout === "grid"
                ? groupByDate
                  ? t("날짜 구분 끄기 (한 번 더)")
                  : t("힉스필드 날짜별로 구분")
                : t("그리드")
            }
          >
            <svg
              viewBox="0 0 24 24"
              width="15"
              height="15"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" />
              <rect x="14" y="14" width="7" height="7" rx="1.5" />
            </svg>
          </button>
        </div>
        )}
      </div>
    </div>
  );
}
