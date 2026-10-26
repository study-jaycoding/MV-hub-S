// 라이브러리 툴바 (힉스필드식): History(미디어 타입 필터) + 필터 토글 +
// 썸네일 크기 조절 슬라이더 + List/Grid 레이아웃 토글.
import { dropFocusAfterPress } from "../lib/keyGate";
import { useEscapeClose } from "../lib/useEscapeClose";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../lib/i18n";
import type { ReviewFilter } from "../lib/generationReview";
import type { MediaFilter } from "../lib/mediaTypes";
import { MEDIA_FILTER_OPTIONS } from "../lib/mediaTypes";
import { makeStore } from "../lib/storage";
import { useFloatingPanel } from "../lib/useFloatingPanel";
import { ColorFilterDots } from "./common/ColorFilterDots";
import { LibraryWorkspaceFilter, type WorkspaceFilterProps } from "./common/LibraryWorkspaceFilter";
import { SidebarEdgeToggle } from "./common/SidebarEdgeToggle";
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
  // 폴더 묶음 보기(공유 & 리뷰 탭에서 폴더를 골랐고, 묶어 보일 수 있는 조회일 때만 준다) — [컷별 | 전체] 전환.
  //  summary 는 지금 묶어 보이는 중일 때만: 건수 자리가 '컷 N · M건' 으로 바뀐다(M = 고른 폴더 아래 전부).
  folderCards?: {
    on: boolean;
    onChange: (on: boolean) => void;
    // top = 프로젝트 맨 위(에피소드 단계) → '에피소드 N · M건'. note = 덧붙일 말(걸러 보는 중의 '거르는 중…'·'최근 N건 기준' — 이미 번역된 글)
    summary?: { folders: number; items: number; top?: boolean; note?: string };
    pending?: { top: boolean }; // 묶음 답을 기다리는 중 — 낱장 숫자 대신 '컷 · 불러오는 중…'
  };
  loading: boolean;
  failedCount: number; // 실패 항목 수(>0 이면 '실패 정리' 노출)
  onClearFailed: () => void;
  // 워크스페이스로 걸러 보기 — 회색 dot 왼쪽에 [칩][버튼]. **주지 않으면 안 그린다**:
  //  구성 보드 툴바는 워크스페이스 조건이 배선돼 있지 않아(App.tsx 의 보드 배선) 눌러도 무동작이다.
  workspaceFilter?: WorkspaceFilterProps;
  // 에셋 파트와 동일한 인스턴트 필터(컬러 dot · S · T)
  colorDots: { k: string; hex: string }[];
  colorFilter: Set<string>;
  onToggleColor: (hex: string) => void;
  sharedOnly: boolean;
  onToggleShared: () => void;
  reviewFilter?: ReviewFilter;
  onReviewFilter?: (filter: ReviewFilter) => void;
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
  // 씬 캔버스 전용: 슬라이더 대신 [맞춤][−][%][+] 클러스터(씬 카메라에 직접 배선).
  sceneZoom?: { onFit: () => void; onStep: (dir: 1 | -1) => void };
  // 그래프 보드(히스토리/구성) 모드 — 의미 없는 컨트롤(리스트/그리드 토글 등)을 숨긴다.
  boardMode?: boolean;
  // 보드 모드라도 필터 사이드바 손잡이를 보인다 — 캔버스는 폴더 사이드바가 있어 열고닫아야 함.
  // 미지정이면 !boardMode(라이브러리만 표시)를 따른다. 사이드바 옆이 아닌 떠 있는 창의 도구 줄은 false.
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
  folderCards,
  loading,
  failedCount,
  onClearFailed,
  workspaceFilter,
  colorDots,
  colorFilter,
  onToggleColor,
  sharedOnly,
  onToggleShared,
  reviewFilter = "shared",
  onReviewFilter,
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
  sceneZoom,
  boardMode = false,
  showFilterToggle,
}: Props) {
  const t = useT();
  const [reviewMenuOpen, setReviewMenuOpen] = useState(false);
  const reviewMenuRef = useRef<HTMLDivElement>(null);
  useEscapeClose(() => setReviewMenuOpen(false), reviewMenuOpen, true, true); // 메뉴만 닫는다 — 뒤의 선택·폴더 창은 그대로
  useEffect(() => {
    if (!reviewMenuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!reviewMenuRef.current?.contains(event.target as Node)) setReviewMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [reviewMenuOpen]);
  const reviewLabel = reviewFilter === "held" ? t("보류만 보기") : t("공유만 보기");
  const oppositeFilter = reviewFilter === "held" ? "shared" : "held";
  const oppositeLabel = oppositeFilter === "held" ? t("보류만 보기") : t("공유만 보기");
  const typeLabel = MEDIA_FILTER_OPTIONS.find((o) => o.v === typeFilter)?.label ?? "전체";
  const typeIndex = Math.max(0, MEDIA_FILTER_OPTIONS.findIndex((o) => o.v === typeFilter));

  // 태그 패널 — 에셋 파트와 동일: 플로팅(헤더 드래그 이동) + CSS resize + 위치·크기 영속.
  const {
    pos: tagPos,
    size: tagSize,
    panelRef: tagPanelRef,
    onHeadMouseDown: onTagHeadDown,
  } = useFloatingPanel(LIB_LS, "tagPos", "tagSize", tagPanelOpen);
  // 태그 패널은 body 에 그린다(아래 createPortal) — 폴더 창(.folder-peek, z 151)·'생성 결과' 창 안에 두면 그 창의 쌓임 맥락에 갇혀,
  //  창 밖에 뜨는 코멘트 패널 앞으로 올릴 수 없다(조작 점검 7회 R14). 좌표·크기·앞세우기는 그대로다(position: fixed — 어디에 그리든 같다).
  //  밖으로 나간 패널이 **어느 툴바의 것인가**는 data-float-of ↔ data-float-owner 로 적는다 — '어디 안에 있나'를 DOM 포함으로 묻는
  //  판정(초점 잃은 키·폴더 창의 색 단축키)이 패널의 단추를 이 툴바(와 이 툴바를 품은 창) 안의 것으로 본다(lib/keyGate floatHost).
  const floatId = useId();
  const barRef = useRef<HTMLDivElement>(null);
  const floatRef = useRef<HTMLDivElement>(null);
  // 툴바를 감싼 잠금(<main inert> — 폴더 창을 닫은 직후 낡은 목록을 보이는 동안)은 body 로 나간 패널에 닿지 않는다 — 그릴 때마다 따라 건다.
  useLayoutEffect(() => {
    floatRef.current?.toggleAttribute("inert", !!barRef.current?.closest("[inert]"));
  });
  // 이 툴바를 품은 창(폴더 창·'생성 결과' 창)의 카드를 끄는 동안 패널은 놓기를 가리지 않는다. body 로 나온 패널은 창 밖의 놓을 자리
  //  (사이드바 폴더·하단 프롬프트)보다 앞에 뜨는데, '생성 결과' 창이 끄는 동안 제 막에 거는 클릭통과(.drag-through)를 더는 물려받지
  //  못한다 — 패널이 덮은 자리에 놓은 카드가 폴더에 담기지 않았다(Codex 코드 리뷰). 폴더 창에서는 패널이 프롬프트(152) 위로 올라와
  //  같은 일이 생긴다. 그 창과 같은 박자로 한다(components/scene/SceneVariantPopup): dragstart 가 끝난 **한 박자 뒤**에 걸고(그 안에서
  //  히트 판정을 바꾸면 브라우저가 끌기를 버린다), 막힌 끌기(preventDefault — dragend 가 오지 않는다)에는 걸지 않고, dragend·drop·
  //  (dragend 없이 끝난 끌기 뒤의) mouseup 에 푼다. 잡는 단계로 듣는다 — 카드의 그립은 dragstart 전파를 멈춘다.
  //  패널 안에서 시작한 끌기(태그 순서 바꾸기)는 창 밖이라 걸리지 않는다. 창 밖 툴바의 패널(보통 탭)은 전과 같다.
  useEffect(() => {
    if (!tagPanelOpen) return;
    let timer: number | null = null;
    const pass = (on: boolean) => {
      if (floatRef.current) floatRef.current.style.pointerEvents = on ? "none" : "";
    };
    const onStart = (e: DragEvent) => {
      const win = barRef.current?.closest(".folder-peek, .scene-varwin");
      if (!win || !win.contains(e.target as Node)) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        if (!e.defaultPrevented) pass(true);
      }, 0);
    };
    const onEnd = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      pass(false);
    };
    document.addEventListener("dragstart", onStart, true);
    window.addEventListener("dragend", onEnd, true);
    window.addEventListener("drop", onEnd, true);
    window.addEventListener("mouseup", onEnd, true);
    return () => {
      document.removeEventListener("dragstart", onStart, true);
      window.removeEventListener("dragend", onEnd, true);
      window.removeEventListener("drop", onEnd, true);
      window.removeEventListener("mouseup", onEnd, true);
      onEnd();
    };
  }, [tagPanelOpen]);
  return (
    <div className="lib-toolbar" ref={barRef} data-float-owner={floatId}>
      {/* 필터 사이드바 여닫기 — 줄 흐름 밖, 사이드바 끝선 위의 손잡이(시안 C). 캔버스는 폴더 사이드바가 있어 표시. */}
      {(showFilterToggle ?? !boardMode) && (
        <SidebarEdgeToggle open={filtersOpen} onToggle={onToggleFilters}
          title={filtersOpen ? t("필터 사이드바 닫기") : t("필터 사이드바 열기")} />
      )}
      {/* 미디어 타입 — 4개 점 슬라이더(전체·이미지·영상·오디오). 슬라이드/점클릭 모두 전환.
          data-type 으로 선택 타입별 색(전체=라임·이미지=파랑·영상=보라·오디오=주황)을 CSS 가 입힌다. */}
      <div className="lib-hist-slider" data-type={typeFilter} title="미디어 타입 — 슬라이드로 전환">
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
            onPointerDown={(e) => dropFocusAfterPress(e.currentTarget)} // 마우스 조작이 끝나면 초점을 내려놓는다(lib/keyGate)
          />
        </div>
      </div>

      <span className="lib-count">
        {folderCards?.summary
          ? `${t(folderCards.summary.top ? "에피소드" : "컷")} ${folderCards.summary.folders} · ${folderCards.summary.items}${t("건")}`
            + (folderCards.summary.note ? ` · ${folderCards.summary.note}` : "")
          : folderCards?.pending
          ? `${t(folderCards.pending.top ? "에피소드" : "컷")} · ${t("불러오는 중…")}`
          : <>{t(typeLabel)} · {count}{countMore ? "+" : ""}{t("건")}{loading && ` · ${t("로딩…")}`}</>}
      </span>
      {folderCards && (
        <span className="lib-cut-seg" role="group" aria-label={t("폴더 묶음 보기")}>
          <button
            type="button"
            className={folderCards.on ? "on" : ""}
            aria-pressed={folderCards.on}
            title={t("바로 아래 폴더(컷)마다 카드 한 장으로 묶어 보기")}
            onClick={() => folderCards.onChange(true)}
          >
            {t("컷별")}
          </button>
          <button
            type="button"
            className={folderCards.on ? "" : "on"}
            aria-pressed={!folderCards.on}
            title={t("이 폴더 아래의 생성물을 한 장씩 모두 보기")}
            onClick={() => folderCards.onChange(false)}
          >
            {t("전체")}
          </button>
        </span>
      )}
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
          {workspaceFilter && <LibraryWorkspaceFilter {...workspaceFilter} />}
          <ColorFilterDots
            colorDots={colorDots}
            activeColors={colorFilter}
            onToggleColor={onToggleColor}
            grayOn={grayOn}
            onToggleGray={onToggleGray}
            finalOnly={finalOnly}
            onToggleFinal={onToggleFinal}
          />
          <div className="lib-review-filter" ref={reviewMenuRef}>
            <button
              className={"af-btn" + (sharedOnly ? " on" : "") + (reviewFilter === "held" ? " held" : "")}
              title={reviewLabel}
              aria-label={reviewLabel}
              aria-pressed={sharedOnly}
              aria-expanded={reviewMenuOpen}
              onClick={() => { setReviewMenuOpen(false); onToggleShared(); }}
              onContextMenu={(event) => {
                if (!onReviewFilter) return;
                event.preventDefault();
                setReviewMenuOpen((open) => !open);
              }}
            >S</button>
            {reviewMenuOpen && onReviewFilter && (
              <button
                className={"af-btn on lib-review-alternative" + (oppositeFilter === "held" ? " held" : "")}
                title={oppositeLabel}
                aria-label={oppositeLabel}
                onClick={() => { onReviewFilter(oppositeFilter); setReviewMenuOpen(false); }}
              >S</button>
            )}
          </div>
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
          {tagPanelOpen && createPortal(
            <div ref={floatRef} data-float-of={floatId}>
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
            </div>,
            document.body,
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
          zoomControl={sceneZoom}
          t={t}
        />
      </div>
    </div>
  );
}
