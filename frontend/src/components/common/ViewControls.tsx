import { useCallback, useRef, useState, type CSSProperties } from "react";
import { dropFocusAfterPress } from "../../lib/keyGate";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { useOutsideMouseDown } from "../../lib/useOutsideMouseDown";
import { useSceneZoomPct } from "../../lib/sceneZoomStore";
import { FitIcon, GridIcon, ListIcon, StepIcon } from "./ViewIcons";

type LayoutMode = "grid" | "list";

// Masonry 아이콘(폭이 다른 칸) — Square 는 GridIcon, List 는 ListIcon
const MasonryIcon = () => (
  <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="4" width="11" height="7" rx="1.5" /><rect x="15" y="4" width="7" height="7" rx="1.5" /><rect x="2" y="13" width="6" height="7" rx="1.5" /><rect x="10" y="13" width="12" height="7" rx="1.5" />
  </svg>
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
  // 카드 Layout(Square · Masonry) — onSetMasonry 를 주면 단추 넷 대신 **보기 단추 하나**(누르면 보기 창, Jay 2026-10-30). 안 주면 옛 단추 그대로(Assets·보드).
  masonry?: boolean;
  onSetMasonry?: (on: boolean) => void;
  // 씬 캔버스 줌 — 있으면 슬라이더 대신 [맞춤][−][%][+] 클러스터를 그린다.
  zoomControl?: { onFit: () => void; onStep: (dir: 1 | -1) => void };
  t?: (text: string) => string;
}

const SIZE_STEP = 0.05; // 크기 조절 단위 — 눈금도 이 간격(70~170% = 21눈금)

// 보기 창(Jay 2026-10-30 — 힉스필드 Layout 창처럼, A안 · ✓ 없음 · 21눈금 · Fill · 설명 글 없음). 고르면 바로 바뀌고 창은 열린 채 —
//  바깥 누름·Esc 로 닫는다. Split by date = 옛 '리스트/그리드 한 번 더'의 날짜별 구분 · Fill = 옛 꽉 채우기(전체 보기의 반대).
function ViewMenu({ fitContain, onToggleFit, scale, onScale, scaleMin, scaleMax, sizeTitle, layout, groupByDate, onSelectLayout,
  onToggleGroupByDate, masonry = false, onSetMasonry, t = (text) => text }: Props & { onSetMasonry: (on: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideMouseDown(wrapRef, close, open, undefined, true);
  useEscapeClose(close, open, true, true); // Esc 는 창만 닫는다(뒤 카드의 선택은 그대로)
  const current = layout === "list" ? "list" : masonry ? "masonry" : "square";
  const pick = (key: typeof current) => {
    if (key === "list") return onSelectLayout("list");
    onSelectLayout("grid");
    onSetMasonry(key === "masonry");
  };
  const ticks = Math.round((scaleMax - scaleMin) / SIZE_STEP) + 1;
  const base = Math.round((1 - scaleMin) / SIZE_STEP); // 100% 눈금
  const LAYOUTS = [
    { key: "square", label: "Square", icon: <GridIcon /> },
    { key: "masonry", label: "Masonry", icon: <MasonryIcon /> },
    { key: "list", label: "List", icon: <ListIcon /> },
  ] as const;
  const fillOff = current === "masonry"; // Masonry 는 원래 안 잘린다
  return (
    <div className="vp-wrap" ref={wrapRef}>
      {/* S·T·C·필터 단추와 같은 상자 단추(Jay 2026-10-30 "동떨어져 보이고 크기가 다르다") — 연 동안 = 라임 테두리 */}
      <button
        type="button"
        className={"af-btn vp-btn" + (open ? " open" : "")}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${t("보기")} — Layout · Split by date · Fill · Card size`}
        onClick={() => setOpen((v) => !v)}
      >
        {LAYOUTS.find((item) => item.key === current)!.icon}
      </button>
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
    zoomControl,
    t = (text) => text,
  } = props;
  if (onSetMasonry) return <ViewMenu {...props} onSetMasonry={onSetMasonry} />;
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
