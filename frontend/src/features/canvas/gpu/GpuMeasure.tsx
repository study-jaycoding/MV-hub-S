// GPU 보기 모드의 숨은 측정 칸 — DOM 카드가 없는 동안, 크기가 내용에 맞춰 정해지는 카드(레퍼런스 높이·제목 폭/높이)를 화면 밖에 읽기 형태로
//  붙여 지금 측정(SceneBoard 의 offsetWidth/offsetHeight)과 같은 읽기로 잰다(docs/status/캔버스_GPU판설계_2026-11-11.md 계약 size).
//  한 번에 최대 4장 — 결과를 넘기면 SceneBoard 가 최신 요청(씬·카드·측정 지문)인지 보고 반영한 뒤 다음 묶음을 준다.
//  속은 카드 컴포넌트의 mode:"read" 갈래라 저장 콜백(requestFit 등)이 없다.
import { useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";

export const GPU_MEASURE_BATCH = 4;

export interface GpuMeasureItem {
  id: string;
  /** 측정 지문 — 이 값으로 잰 결과인지 SceneBoard 가 다시 확인한다 */
  sig: string;
  /** .scene-card 뒤 종류 클래스 */
  className: string;
  /** 고정 폭(레퍼런스) — 없으면 내용에 맞춘다(제목) */
  width?: number;
  node: ReactNode;
}

export interface GpuMeasureResult { id: string; sig: string; w: number; h: number }

export function GpuMeasure({ sceneId, items, onMeasured }: { sceneId: string; items: readonly GpuMeasureItem[]; onMeasured: (sceneId: string, results: GpuMeasureResult[]) => void }) {
  const els = useRef(new Map<string, HTMLDivElement>());
  const done = useRef(onMeasured);
  done.current = onMeasured;
  useLayoutEffect(() => {
    if (!items.length) return;
    const results: GpuMeasureResult[] = [];
    for (const it of items.slice(0, GPU_MEASURE_BATCH)) {
      const el = els.current.get(it.id);
      if (el && el.offsetHeight) results.push({ id: it.id, sig: it.sig, w: el.offsetWidth, h: el.offsetHeight });
    }
    if (results.length) done.current(sceneId, results);
  }, [sceneId, items]);
  if (!items.length) return null;
  return (
    <div className="scene-gpu-measure" aria-hidden="true">
      {items.slice(0, GPU_MEASURE_BATCH).map((it) => (
        <div
          key={it.id}
          ref={(el) => {
            if (el) els.current.set(it.id, el);
            else els.current.delete(it.id);
          }}
          className={"scene-card " + it.className}
          style={it.width ? { width: it.width } : undefined}
        >
          {it.node}
        </div>
      ))}
    </div>
  );
}
