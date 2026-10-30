import { useCallback, useRef, useState, type CSSProperties } from "react";
import { dropFocusAfterPress } from "../../lib/keyGate";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { useOutsideMouseDown } from "../../lib/useOutsideMouseDown";
import { CLEAR_FAILED_ICON, HIDE_FAILED_ICON, type FilterActivity } from "./LibraryWorkspaceFilter";
import { FitIcon, GridIcon, ListIcon } from "./ViewIcons";

type LayoutMode = "grid" | "list";

// Masonry 아이콘(폭이 다른 칸) — Square 는 GridIcon, List 는 ListIcon
const MasonryIcon = () => (
  <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="4" width="11" height="7" rx="1.5" /><rect x="15" y="4" width="7" height="7" rx="1.5" /><rect x="2" y="13" width="6" height="7" rx="1.5" /><rect x="10" y="13" width="12" height="7" rx="1.5" />
  </svg>
);

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
  // 카드 Layout(Square · Masonry) — onSetMasonry 를 주면 단추 넷 대신 **보기 단추 하나**(누르면 보기 창, Jay 2026-10-30). 안 주면 옛 단추 그대로(Resolve·보드).
  masonry?: boolean;
  onSetMasonry?: (on: boolean) => void;
  // Masonry 없이 보기 창만(어셋 탭 — 어셋 격자에는 Masonry 계산이 없다, Jay 2026-10-30)
  viewMenu?: boolean;
  // 씬 캔버스 단추 창 — Fill · Hide failed · Activity(실패·차단 정리), Jay 2026-10-30. 주면 □ 대신 이 단추 하나
  canvas?: FilterActivity;
  // 씬 캔버스 — 크기 슬라이더 자리를 비운다(캔버스 줌 [− 비율 +] 은 캔버스의 네비게이터 위 막대, Jay 2026-10-30 — 전엔 여기 [맞춤][−][%][+]).
  hideSize?: boolean;
  t?: (text: string) => string;
}

const SIZE_STEP = 0.05; // 크기 조절 단위 — 눈금도 이 간격(70~170% = 21눈금)

// 단추 창의 열고 닫기 — 바깥 누름·Esc 로 닫는다(Esc 는 창만 — 뒤 카드의 선택은 그대로)
function usePop() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideMouseDown(wrapRef, close, open, undefined, true);
  useEscapeClose(close, open, true, true);
  return { open, setOpen, close, wrapRef };
}

// 단추 — S·T·C 와 같은 크기, 상자 없는 아이콘(앞의 세로선은 CSS — .assets-filters > .vp-wrap) · 연 동안 = 옅은 라임
function PopButton({ open, onClick, title, children }: { open: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button type="button" className={"af-btn vp-btn" + (open ? " open" : "")} aria-haspopup="menu" aria-expanded={open} title={title} onClick={onClick}>
      {children}
    </button>
  );
}

// 보기 창(Jay 2026-10-30 — 힉스필드 Layout 창처럼, A안 · ✓ 없음 · 21눈금 · Fill · 설명 글 없음). 고르면 바로 바뀌고 창은 열린 채 —
//  바깥 누름·Esc 로 닫는다. Split by date = 옛 '리스트/그리드 한 번 더'의 날짜별 구분 · Fill = 옛 꽉 채우기(전체 보기의 반대).
//  onSetMasonry 가 없으면(어셋) Layout 은 Square · List 만.
function ViewMenu({ fitContain, onToggleFit, scale, onScale, scaleMin, scaleMax, sizeTitle, layout, groupByDate, onSelectLayout,
  onToggleGroupByDate, masonry = false, onSetMasonry, t = (text) => text }: Props) {
  const { open, setOpen, wrapRef } = usePop();
  const current = layout === "list" ? "list" : masonry && onSetMasonry ? "masonry" : "square";
  const pick = (key: typeof current) => {
    if (key === "list") return onSelectLayout("list");
    onSelectLayout("grid");
    onSetMasonry?.(key === "masonry");
  };
  const ticks = Math.round((scaleMax - scaleMin) / SIZE_STEP) + 1;
  const base = Math.round((1 - scaleMin) / SIZE_STEP); // 100% 눈금
  const LAYOUTS = ([
    { key: "square", label: "Square", icon: <GridIcon /> },
    { key: "masonry", label: "Masonry", icon: <MasonryIcon /> },
    { key: "list", label: "List", icon: <ListIcon /> },
  ] as const).filter((item) => item.key !== "masonry" || onSetMasonry);
  const fillOff = current === "masonry"; // Masonry 는 원래 안 잘린다
  return (
    <div className="vp-wrap" ref={wrapRef}>
      <PopButton open={open} onClick={() => setOpen((v) => !v)} title={`${t("보기")} — Layout · Split by date · Fill · Card size`}>
        {LAYOUTS.find((item) => item.key === current)!.icon}
      </PopButton>
      {open && (
        <div className="vp-pop" role="menu" aria-label={t("보기")}>
          <div className="vp-head">Layout</div>
          {LAYOUTS.map((item) => (
            <button type="button" key={item.key} role="menuitemradio" aria-checked={current === item.key}
              className={"vp-item" + (current === item.key ? " sel" : "")} onClick={() => pick(item.key)}>
              <span className="vp-ic">{item.icon}</span>
              {item.label}
            </button>
          ))}
          <div className="vp-sep" />
          <button type="button" role="menuitemcheckbox" aria-checked={groupByDate} className="vp-item" onClick={onToggleGroupByDate}>
            Split by date
            <span className={"vp-sw" + (groupByDate ? " on" : "")} aria-hidden="true" />
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked={!fitContain} className="vp-item" disabled={fillOff} onClick={onToggleFit}>
            Fill
            <span className={"vp-sw" + (fitContain ? "" : " on")} aria-hidden="true" />
          </button>
          <div className="vp-sep" />
          <div className="vp-head">Card size<span className="vp-val">{Math.round(scale * 100)}%</span></div>
          {/* 크기 조절바(Jay 2026-10-30 A안 — 힉스필드처럼 상자 자체가 조절바). 손잡이 = 실제 슬라이더 손잡이(흰 세로 막대), 왼쪽부터 값까지 옅은 채움,
              눈금 = 조절 단위마다 하나(100% 만 길게). 채움·눈금은 손잡이 가운데가 가는 길(.vp-size CSS 의 안쪽 11.5px)에 맞춘다 */}
          <div className="vp-size" title={sizeTitle} style={{ "--pct": (scale - scaleMin) / (scaleMax - scaleMin) } as CSSProperties}>
            <div className="vp-fill" aria-hidden="true" />
            <div className="vp-ticks" aria-hidden="true">
              {Array.from({ length: ticks }, (_, index) => <i key={index} className={index === base ? "major" : undefined} />)}
            </div>
            <input
              type="range"
              min={scaleMin}
              max={scaleMax}
              step={SIZE_STEP}
              value={scale}
              aria-label="Card size"
              onChange={(e) => onScale(Number(e.target.value))}
              onPointerDown={(e) => dropFocusAfterPress(e.currentTarget)} // 마우스 조작이 끝나면 초점을 내려놓는다(lib/keyGate)
            />
          </div>
        </div>
      )}
    </div>
  );
}

// 씬 캔버스 단추 창(Jay 2026-10-30) — Fill · Hide failed · Activity(실패·차단 정리 → 툴바의 앱 확인 창). 워크스페이스와 같은 자리·모양이라
//  툴바의 S·T·C 가 탭을 옮겨도 그 자리에 있다(전엔 □ 가 묶음 밖에 따로 있어 5px 어긋났다).
function CanvasMenu({ fitContain, onToggleFit, canvas, t = (text) => text }: Props & { canvas: FilterActivity }) {
  const { open, setOpen, close, wrapRef } = usePop();
  return (
    <div className="vp-wrap" ref={wrapRef}>
      <PopButton open={open} onClick={() => setOpen((v) => !v)} title={`${t("보기")} — Fill · Hide failed · ${t("실패·차단 정리")}`}>
        <GridIcon />
      </PopButton>
      {open && (
        <div className="vp-pop" role="menu" aria-label={t("보기")}>
          <button type="button" role="menuitemcheckbox" aria-checked={!fitContain} className="vp-item" onClick={onToggleFit}>
            Fill
            <span className={"vp-sw" + (fitContain ? "" : " on")} aria-hidden="true" />
          </button>
          <div className="vp-sep" />
          <button type="button" role="menuitemcheckbox" aria-checked={canvas.hideFailed} className="vp-item" onClick={canvas.onToggleHideFailed}>
            <span className="vp-ic">{HIDE_FAILED_ICON}</span>
            Hide failed
            <span className={"vp-sw" + (canvas.hideFailed ? " on" : "")} aria-hidden="true" />
          </button>
          <div className="vp-sep" />
          <div className="vp-head">Activity</div>
          <button type="button" className="vp-item warn" disabled={canvas.failedCount <= 0} onClick={() => { close(); canvas.onClearFailed(); }}>
            <span className="vp-ic">{CLEAR_FAILED_ICON}</span>
            {t("실패·차단 정리")}
            <span className="vp-end"><span className="vp-cnt">{canvas.failedCount}</span></span>
          </button>
        </div>
      )}
    </div>
  );
}

export function ViewControls(props: Props) {
  const {
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
    onSetMasonry,
    viewMenu = false,
    canvas,
    hideSize = false,
    t = (text) => text,
  } = props;
  if (canvas) return <CanvasMenu {...props} canvas={canvas} />;
  if (onSetMasonry || viewMenu) return <ViewMenu {...props} />;
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
        <FitIcon filled={!fitContain} />
      </button>
      {!hideSize && (
        <div className="size-slider" title={sizeTitle}>
          <input
            type="range"
            min={scaleMin}
            max={scaleMax}
            step={0.05}
            value={scale}
            onChange={(e) => onScale(Number(e.target.value))}
            onPointerDown={(e) => dropFocusAfterPress(e.currentTarget)} // 마우스 조작이 끝나면 초점을 내려놓는다(lib/keyGate)
          />
        </div>
      )}
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
