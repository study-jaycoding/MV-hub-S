// 캔버스 우측 상단 네비게이터(미니맵) — 카드가 화면 밖으로 벗어나면 표시.
//  · 노드 배치(레퍼런스=파랑/생성=회색/선택=라임)와 현재 보는 영역(뷰포트 박스)을 축소해서 보여준다.
//  · 클릭/드래그로 그 위치로 화면 이동.
// 성능: 팬/줌은 부모가 리렌더 없이 처리하므로, 뷰포트 박스·표시여부는 update() 로 DOM 을 직접 갱신하고
//       부모의 applyTransform 이 매 팬/줌마다 이 update() 를 호출한다(updateRef 로 연결).
import { useEffect, useLayoutEffect, useRef } from "react";
import type { MutableRefObject, RefObject } from "react";
import { minimapViewBox } from "../../lib/sceneViewport";
import { addWindowMouseDrag, dragLost, removeWindowMouseDrag } from "../../lib/windowDrag";

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

  // 보드(뷰포트) 크기 — 크기 감시가 알려 준 값을 기억한다. update() 에서 clientWidth 를 읽으면 렌더마다(아래 layout effect) 막 붙은
  //  카드 전부의 배치를 그 자리에서 강제로 계산했다(70회차 격리 실측: 세션 첫 씬 열기 긴 작업 108ms 중 이 함수 자기 시간 65ms).
  //  감시의 알림은 배치가 끝난 뒤(그리기 전)에 와서 그때 읽는 값은 이미 계산돼 있다. 모르는 동안(첫 알림 전)은 갱신하지 않는다.
  const vpRef = useRef<{ width: number; height: number } | null>(null);
  //  보드는 이 미니맵의 조상이라 처음 붙을 때는 자식(이 컴포넌트)의 effect 가 보드 ref 가 붙기 전에 돈다 — 그때 한 번만 보고 말면
  //  감시가 영영 안 걸려 미니맵이 계속 숨었다(Codex 70회차 리뷰 P2). 커밋마다 지금 보드가 감시 중인 것과 같은지 보고, 다르면 다시 건다.
  const watchRef = useRef<{ el: HTMLElement; ro: ResizeObserver } | null>(null);
  useEffect(() => {
    const sc = scrollRef.current;
    if (watchRef.current?.el === sc || typeof ResizeObserver === "undefined") return;
    watchRef.current?.ro.disconnect();
    watchRef.current = null;
    if (!sc) return;
    const ro = new ResizeObserver(() => {
      vpRef.current = { width: sc.clientWidth, height: sc.clientHeight };
      updateRef.current?.();
    });
    ro.observe(sc);
    watchRef.current = { el: sc, ro };
  });
  useEffect(() => () => watchRef.current?.ro.disconnect(), []);

  // 표시여부(화면 밖 카드 존재)와 뷰포트 박스를 DOM 에 직접 반영 — 리렌더 없이 팬/줌에 반응.
  //  팬은 매 프레임 불리므로 바뀐 값만 쓰고, 박스 이동은 transform 으로 한다(위치·크기를 매번 쓰면 보드를 다시 칠했다).
  const update = () => {
    const wrap = wrapRef.current;
    const view = viewRef.current;
    const vp = vpRef.current;
    if (!wrap || !view || !vp) return;
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
    const display = offscreen ? "block" : "none";
    if (wrap.style.display !== display) wrap.style.display = display;
    // 현재 보는 영역(뷰포트)을 월드로 환산 → 미니맵 좌표. 미니맵 박스 안으로 자르고 정수 px 로(minimapViewBox) —
    //  바뀐 값만 쓴다. 소수 px 로 걸음마다 쓰면 25% 이하에서 미니맵을 매번 다시 칠했다.
    const vwl = -pan.x / z;
    const vwt = -pan.y / z;
    const left = (vwl - wMinX) * scale;
    const top = (vwt - wMinY) * scale;
    const box = minimapViewBox(left, top, left + (vp.width / z) * scale, top + (vp.height / z) * scale, mmW, mmH);
    const transform = `translate(${box.x}px, ${box.y}px)`;
    if (view.style.transform !== transform) view.style.transform = transform;
    const width = box.w + "px";
    const height = box.h + "px";
    if (view.style.width !== width) view.style.width = width;
    if (view.style.height !== height) view.style.height = height;
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
    // rAF 코얼레싱 — mousemove 를 프레임당 1회로 합쳐 onNavigate 폭주 방지.
    let raf = 0;
    let last: { x: number; y: number } | null = null;
    const move = (ev: MouseEvent) => {
      last = { x: ev.clientX, y: ev.clientY };
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!last) return;
        const p = at(last.x, last.y);
        onNavigate(p.wx, p.wy, false);
      });
    };
    const teardown = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      removeWindowMouseDrag(move, up);
      dragCleanupRef.current = null;
    };
    // mouseup 을 놓친 끌기(창 blur·단추를 뗀 채 온 움직임 — lib/windowDrag)는 정리만 한다 — 뗀 자리를 모른다. 리스너가 남지 않게.
    const up = (ev: Event) => {
      teardown();
      if (dragLost(ev)) return;
      const p = at((ev as MouseEvent).clientX, (ev as MouseEvent).clientY);
      onNavigate(p.wx, p.wy, true);
    };
    dragCleanupRef.current = teardown;
    addWindowMouseDrag(move, up);
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
            "scene-minimap-card k-" + b.kind + (selected.has(b.id) ? " sel" : "")
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
