// 캔버스 우측 상단 네비게이터(미니맵) — 카드가 화면 밖으로 벗어나면 표시.
//  · 노드 배치(레퍼런스=파랑/생성=회색/선택=라임)와 현재 보는 영역(뷰포트 박스)을 축소해서 보여준다.
//  · 클릭/드래그로 그 위치로 화면 이동.
// 성능: 팬/줌은 부모가 리렌더 없이 처리하므로, 뷰포트 박스·표시여부는 update() 로 DOM 을 직접 갱신하고
//       부모의 applyTransform 이 매 팬/줌마다 이 update() 를 호출한다(updateRef 로 연결).
import { useEffect, useLayoutEffect, useRef } from "react";
import type { MutableRefObject, RefObject } from "react";

export interface MinimapBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: string;
}
export interface MinimapBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const MM_MAX_W = 180; // 미니맵 최대 폭(px)
const MM_MAX_H = 130; // 미니맵 최대 높이(px)
const MM_PAD = 60; // 콘텐츠 주변 여백(캔버스 좌표)

interface Props {
  boxes: MinimapBox[];
  bounds: MinimapBounds;
  selected: Set<string>;
  scrollRef: RefObject<HTMLDivElement>;
  panRef: MutableRefObject<{ x: number; y: number }>;
  zoomRef: MutableRefObject<number>;
  // 부모의 applyTransform 이 매 팬/줌마다 여기 담긴 update() 를 호출 → 뷰포트 박스 즉시 갱신.
  updateRef: MutableRefObject<(() => void) | null>;
  // 미니맵의 한 지점(캔버스 좌표)을 화면 중앙으로. commit=드래그 종료 시 카메라 저장.
  onNavigate: (worldX: number, worldY: number, commit: boolean) => void;
}

export function SceneMinimap({
  boxes,
  bounds,
  selected,
  scrollRef,
  panRef,
  zoomRef,
  updateRef,
  onNavigate,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  // 드래그 중 언마운트(씬 전환·카드 삭제로 미니맵 사라짐)돼도 window 리스너가 남지 않게 정리.
  useEffect(() => () => dragCleanupRef.current?.(), []);

  // 여백 포함 월드 → 미니맵 스케일. 콘텐츠가 미니맵 박스 안에 다 들어가도록 축소만.
  const wMinX = bounds.minX - MM_PAD;
  const wMinY = bounds.minY - MM_PAD;
  const worldW = bounds.maxX - bounds.minX + MM_PAD * 2;
  const worldH = bounds.maxY - bounds.minY + MM_PAD * 2;
  const scale = Math.min(MM_MAX_W / worldW, MM_MAX_H / worldH);
  const mmW = Math.max(40, worldW * scale);
  const mmH = Math.max(30, worldH * scale);

  // 표시여부(화면 밖 카드 존재)와 뷰포트 박스를 DOM 에 직접 반영 — 리렌더 없이 팬/줌에 반응.
  const update = () => {
    const wrap = wrapRef.current;
    const view = viewRef.current;
    const sc = scrollRef.current;
    if (!wrap || !view || !sc) return;
    const vp = sc.getBoundingClientRect();
    const z = zoomRef.current;
    const pan = panRef.current;
    // 월드 콘텐츠의 화면상 사각형 — 한 변이라도 뷰포트를 벗어나면 '화면 밖 카드 있음'.
    const sx0 = pan.x + bounds.minX * z;
    const sy0 = pan.y + bounds.minY * z;
    const sx1 = pan.x + bounds.maxX * z;
    const sy1 = pan.y + bounds.maxY * z;
    const eps = 2;
    const offscreen =
      sx0 < -eps || sy0 < -eps || sx1 > vp.width + eps || sy1 > vp.height + eps;
    wrap.style.display = offscreen ? "block" : "none";
    // 현재 보는 영역(뷰포트)을 월드로 환산 → 미니맵 좌표. 미니맵 박스 안으로 클램프.
    const vwl = -pan.x / z;
    const vwt = -pan.y / z;
    const left = (vwl - wMinX) * scale;
    const top = (vwt - wMinY) * scale;
    const right = left + (vp.width / z) * scale;
    const bottom = top + (vp.height / z) * scale;
    const cl = Math.max(0, Math.min(left, mmW));
    const ct = Math.max(0, Math.min(top, mmH));
    const cr = Math.max(0, Math.min(right, mmW));
    const cb = Math.max(0, Math.min(bottom, mmH));
    view.style.left = cl + "px";
    view.style.top = ct + "px";
    view.style.width = Math.max(0, cr - cl) + "px";
    view.style.height = Math.max(0, cb - ct) + "px";
  };

  // 매 렌더마다 최신 geometry 를 담은 update() 를 부모 ref 에 연결(+ 즉시 1회 반영).
  useLayoutEffect(() => {
    updateRef.current = update;
    update();
    return () => {
      if (updateRef.current === update) updateRef.current = null;
    };
  });

  const onDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    e.stopPropagation(); // 보드의 마퀴/팬 시작 방지
    e.preventDefault();
    // ★rect 를 드래그 시작 시점에 캐시 — 클릭으로 미니맵이 숨겨져도(getBoundingClientRect=0)
    //   좌표가 튀지 않게. 미니맵은 고정 위치라 드래그 내내 이 rect 로 변환해도 정확하다.
    const rect = wrap.getBoundingClientRect();
    const at = (clientX: number, clientY: number) => ({
      wx: wMinX + (clientX - rect.left) / scale,
      wy: wMinY + (clientY - rect.top) / scale,
    });
    const start = at(e.clientX, e.clientY);
    onNavigate(start.wx, start.wy, false);
    const move = (ev: MouseEvent) => {
      const p = at(ev.clientX, ev.clientY);
      onNavigate(p.wx, p.wy, false);
    };
    const teardown = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      dragCleanupRef.current = null;
    };
    const up = (ev: MouseEvent) => {
      const p = at(ev.clientX, ev.clientY);
      teardown();
      onNavigate(p.wx, p.wy, true);
    };
    dragCleanupRef.current = teardown;
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div
      className="scene-minimap"
      ref={wrapRef}
      style={{ width: mmW, height: mmH, display: "none" }}
      onMouseDown={onDown}
      title="네비게이터 — 클릭·드래그로 이동"
    >
      {boxes.map((b) => (
        <div
          key={b.id}
          className={
            "scene-minimap-card" +
            (b.kind === "reference" ? " ref" : " gen") +
            (selected.has(b.id) ? " sel" : "")
          }
          style={{
            left: (b.x - wMinX) * scale,
            top: (b.y - wMinY) * scale,
            width: Math.max(2, b.w * scale),
            height: Math.max(2, b.h * scale),
          }}
        />
      ))}
      <div className="scene-minimap-view" ref={viewRef} />
    </div>
  );
}
