// GPU 보기 모드의 숨은 측정 칸 — DOM 카드가 없는 동안, 크기가 내용에 맞춰 정해지는 카드(레퍼런스 높이·제목 폭/높이)를 화면 밖에 읽기 형태로
//  붙여 지금 측정(SceneBoard 의 offsetWidth/offsetHeight)과 같은 읽기로 잰다(docs/status/캔버스_GPU판설계_2026-11-11.md 계약 size).
//  SceneBoard 는 잴 카드 전부를 주고, 여기서 프레임마다 최대 4장씩 붙여 잰다(다음 묶음은 다음 프레임 — 이 칸만 다시 그린다).
//  결과는 모아서(묶음 8개마다·다 재면) 넘긴다 — 묶음마다 넘기면 SceneBoard 전체 다시 그리기·그릴 모델 재계산이 프레임마다 돌았다(11-11 리뷰).
//  SceneBoard 가 최신 요청(씬·카드·측정 지문)인지 보고 반영한다. 속은 카드 컴포넌트의 mode:"read" 갈래라 저장 콜백(requestFit 등)이 없다.
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export const GPU_MEASURE_BATCH = 4;
const FLUSH_BATCHES = 8;

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
  // 어디까지 쟀나 — 받은 목록이 바뀌면(SceneBoard 가 반영 뒤 남은 것만 다시 줌) 처음부터
  const [pos, setPos] = useState({ items, cursor: 0 });
  const cursor = pos.items === items ? pos.cursor : 0;
  const batch = items.slice(cursor, cursor + GPU_MEASURE_BATCH);
  const acc = useRef({ sceneId, results: [] as GpuMeasureResult[] });
  if (acc.current.sceneId !== sceneId) acc.current = { sceneId, results: [] };

  useLayoutEffect(() => {
    if (!batch.length) return;
    for (const it of batch) {
      const el = els.current.get(it.id);
      // 높이 0 도 넘긴다 — 안 넘기면 그 카드가 계속 다시 골라져 뒤 카드를 영영 못 쟀다(SceneBoard 가 0 은 크기로 안 쓴다)
      if (el) acc.current.results.push({ id: it.id, sig: it.sig, w: el.offsetWidth, h: el.offsetHeight });
    }
    const next = cursor + GPU_MEASURE_BATCH;
    const last = next >= items.length;
    // 다음 묶음·넘기기는 다음 프레임에 — layout 단계에서 바로 이어 가면 칠하기 전에 연쇄해 '프레임당 4장'을 못 지키고
    //  수백 장이면 React 최대 갱신 깊이에 닿았다(11-11 리뷰). 씬·목록이 바뀌거나 내려가면 취소.
    const raf = requestAnimationFrame(() => {
      const a = acc.current;
      if ((last || a.results.length >= GPU_MEASURE_BATCH * FLUSH_BATCHES) && a.results.length) {
        const out = a.results;
        a.results = [];
        done.current(sceneId, out);
      }
      if (!last) setPos({ items, cursor: next });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneId, items, cursor]);

  if (!batch.length) return null;
  return (
    <div className="scene-gpu-measure" aria-hidden="true">
      {batch.map((it) => (
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
