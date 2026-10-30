import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { dropFocusAfterPress } from "../../lib/keyGate";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { useOutsideMouseDown } from "../../lib/useOutsideMouseDown";
import { useSceneZoomPct } from "../../lib/sceneZoomStore";
import { FitIcon, GridIcon, ListIcon, StepIcon } from "./ViewIcons";

type LayoutMode = "grid" | "list";

// Layout 메뉴 아이콘 — Square(같은 칸 넷) · Masonry(폭이 다른 칸)
const LAYOUT_ICON = { viewBox: "0 0 24 24", width: 16, height: 16, fill: "none", stroke: "currentColor", strokeWidth: 2, "aria-hidden": true } as const;
const SquareLayoutIcon = () => (
  <svg {...LAYOUT_ICON}><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /></svg>
);
const MasonryLayoutIcon = () => (
  <svg {...LAYOUT_ICON}><rect x="2" y="4" width="11" height="7" rx="1.5" /><rect x="15" y="4" width="7" height="7" rx="1.5" /><rect x="2" y="13" width="6" height="7" rx="1.5" /><rect x="10" y="13" width="12" height="7" rx="1.5" /></svg>
);

// 씬 확대 % — 휠 확대 때 이 글자만 다시 그린다(App·툴바는 그대로).
function SceneZoomPct() {
  return <span className="zc-pct">{useSceneZoomPct()}%</span>;
}

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
  // 카드 Layout(Square · Masonry) — onSetMasonry 를 주면 전체 보기 단추 우클릭에 메뉴가 뜬다(Jay 2026-10-30). 안 주면 우클릭은 그대로.
  masonry?: boolean;
  onSetMasonry?: (on: boolean) => void;
  // 씬 캔버스 줌 — 있으면 슬라이더 대신 [맞춤][−][%][+] 클러스터를 그린다.
  zoomControl?: { onFit: () => void; onStep: (dir: 1 | -1) => void };
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
  masonry = false,
  onSetMasonry,
  zoomControl,
  t = (text) => text,
}: Props) {
  // 툴팁은 항상 뷰 이름(그리드/리스트)만 — 날짜 구분 상태와 무관(라이브러리·에셋 공통).
  const layoutTitle = (mode: LayoutMode) => t(mode === "list" ? "리스트" : "그리드");
  const [layoutMenu, setLayoutMenu] = useState(false);
  const fitWrapRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setLayoutMenu(false), []);
  useOutsideMouseDown(fitWrapRef, closeMenu, layoutMenu, undefined, true);
  useEscapeClose(closeMenu, layoutMenu, true, true); // Esc 는 메뉴만 닫는다(뒤 카드의 선택은 그대로)
  // 단추는 툴바 오른쪽 끝 가까이 있다 — 메뉴가 창 오른쪽 밖으로 나가지 않게 왼쪽으로 당긴다
  useLayoutEffect(() => {
    const wrap = fitWrapRef.current, menu = menuRef.current;
    if (!layoutMenu || !wrap || !menu) return;
    const left = wrap.getBoundingClientRect().left;
    menu.style.left = `${Math.max(8, Math.min(left - 8, document.documentElement.clientWidth - menu.offsetWidth - 8)) - left}px`;
  }, [layoutMenu]);
  const pickLayout = (on: boolean) => {
    onSetMasonry?.(on);
    setLayoutMenu(false);
  };

  const fitButton = (
    <button
      className={"fit-toggle" + (fitContain ? " on" : "")}
      onClick={onToggleFit}
      onContextMenu={onSetMasonry ? (e) => { e.preventDefault(); setLayoutMenu((open) => !open); } : undefined}
      title={
        (fitContain
          ? "전체 보기(블랙바) — 클릭 시 꽉 채우기"
          : "꽉 채우기(크롭) — 클릭 시 전체 보기") + (onSetMasonry ? ` · ${t("우클릭 = Layout(Square · Masonry)")}` : "")
      }
    >
      <FitIcon filled={!fitContain} />
    </button>
  );

  return (
    <>
      {onSetMasonry ? (
        <span className="fit-wrap" ref={fitWrapRef}>
          {fitButton}
          {layoutMenu && (
            <div className="asort-menu layout-menu" role="menu" ref={menuRef}>
              <div className="layout-menu-head">Layout</div>
              {[false, true].map((on) => (
                <button
                  type="button"
                  key={on ? "masonry" : "square"}
                  role="menuitemradio"
                  aria-checked={masonry === on}
                  className={"asort-item" + (masonry === on ? " sel" : "")}
                  onClick={() => pickLayout(on)}
                >
                  <span className="asort-bullet">{masonry === on ? "●" : ""}</span>
                  <span className="layout-menu-ic">{on ? <MasonryLayoutIcon /> : <SquareLayoutIcon />}</span>
                  <span className="layout-menu-tx">
                    {on ? "Masonry" : "Square"}
                    <small>{t(on ? "그림 비율 그대로 · 줄마다 꽉 채움" : "정사각 카드")}</small>
                  </span>
                </button>
              ))}
              <div className="asort-sep" />
              <div className="layout-menu-hint">{t("왼쪽 클릭 = 전체 보기 ↔ 꽉 채우기(Square 일 때)")}</div>
            </div>
          )}
        </span>
      ) : fitButton}
      {zoomControl ? (
        <div className="zoom-cluster">
          <button
            className="zc-fit"
            onClick={zoomControl.onFit}
            title={t("전체가 보이게 맞춤 — 선택이 있으면 선택 중심 (단축키 f)")}
          >
            Fit
          </button>
          <div className="zc-group">
            <button onClick={() => zoomControl.onStep(-1)} title={t("축소")}>
              <StepIcon size={8} stroke={2} />
            </button>
            <SceneZoomPct />
            <button onClick={() => zoomControl.onStep(1)} title={t("확대")}>
              <StepIcon plus size={8} stroke={2} />
            </button>
          </div>
        </div>
      ) : (
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
