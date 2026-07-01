// 히스토리 패널 우측의 '간략 트리' — 이 카드가 속한 연결된 가계(원본→파생)를 작게 한눈에.
// viewBox SVG 라 영역에 맞춰 자동 축소된다. 클릭=크게 보기 · 미들클릭=정보. 편집은 '구성에서 보기'(보드)에서.
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { HISTORY_MINI_LAYOUT, buildHistoryLayout } from "../lib/historyGraphLayout";
import { thumbOf } from "../lib/media";
import type { HistoryGraph, InfoTarget, PreviewTarget } from "../types";

// SVG 좌표(유저 단위) — preserveAspectRatio 로 실제 픽셀은 컨테이너에 맞춰 스케일.
const { nodeW: NW, nodeH: NH } = HISTORY_MINI_LAYOUT;

export function HistoryMiniTree({
  focusId,
  version,
  graph: graphProp,
  onPreview,
  onInfo,
}: {
  focusId: string;
  version?: number; // 값이 바뀌면 트리 refetch(연결/해제 반영)
  graph?: HistoryGraph | null; // 외부(패널)에서 이미 받은 그래프 — 있으면 재fetch 안 함
  onPreview: (t: PreviewTarget) => void;
  onInfo: (t: InfoTarget) => void;
}) {
  const [fetched, setFetched] = useState<HistoryGraph | null>(null);
  const [err, setErr] = useState(false);
  const graph = graphProp !== undefined ? graphProp : fetched;

  useEffect(() => {
    if (graphProp !== undefined) return; // 외부에서 그래프를 주면 직접 받지 않는다
    let alive = true;
    setErr(false);
    api
      .historyTree(focusId)
      .then((g) => alive && setFetched(g))
      .catch(() => alive && setErr(true));
    return () => {
      alive = false;
    };
  }, [focusId, version, graphProp]);

  // 깊이(최장경로) 기준 열 배치 + 부모 무게중심 정렬(보드 트리와 동일 알고리즘).
  const layout = useMemo(() => buildHistoryLayout(graph, HISTORY_MINI_LAYOUT), [graph]);

  return (
    <div className="lin-tree">
      <div className="lin-tree-head">
        이 카드의 트리
        {graph && <span className="lin-row-n">{graph.nodes.length}</span>}
      </div>
      {err ? (
        <div className="lin-tree-empty">트리를 불러오지 못했습니다.</div>
      ) : !graph ? (
        <div className="lin-tree-empty">불러오는 중…</div>
      ) : !layout || graph.nodes.length < 2 ? (
        <div className="lin-tree-empty">
          연결된 트리가 없습니다.
          <br />
          형제를 ‘연결’하거나 재생성·가져오기를 하면 여기 트리가 생깁니다.
        </div>
      ) : (
        <svg
          className="lin-tree-svg"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          preserveAspectRatio="xMidYMid meet"
        >
          {/* 엣지 — 실선=derived, 점선=reference(@소스) */}
          {layout.edges.map((e, i) => {
            const p = layout.pos[e.parent_gen_id];
            const c = layout.pos[e.child_gen_id];
            if (!p || !c) return null;
            const x1 = p.x + NW;
            const y1 = p.y + NH / 2;
            const x2 = c.x;
            const y2 = c.y + NH / 2;
            const mx = (x1 + x2) / 2;
            return (
              <path
                key={i}
                d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                className={"lin-tedge " + (e.relation === "reference" ? "ref" : "der")}
              />
            );
          })}
          {/* 노드 */}
          {graph.nodes.map((g) => {
            const p = layout.pos[g.id];
            if (!p) return null;
            const thumb = thumbOf(g);
            const a = g.assets[0];
            const cls =
              "lin-tnode" +
              (g.id === graph.focus_id ? " focus" : "") +
              (graph.root_ids.includes(g.id) ? " root" : "") +
              (g.is_final ? " final" : "");
            return (
              <g
                key={g.id}
                className={cls}
                onClick={() =>
                  a &&
                  onPreview({ url: a.file_path, type: a.type, name: g.prompt.slice(0, 50), genId: g.id })
                }
                onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    onInfo({ kind: "generation", gen: g, x: e.clientX, y: e.clientY });
                  }
                }}
              >
                <title>{g.prompt.slice(0, 80) || "(제목 없음)"}</title>
                {thumb ? (
                  <image
                    href={thumb}
                    x={p.x}
                    y={p.y}
                    width={NW}
                    height={NH}
                    preserveAspectRatio="xMidYMid slice"
                  />
                ) : a?.type === "video" && a.file_path ? (
                  // 영상(썸네일 없음): 첫 프레임을 띄워 검은 칸 대신 내용이 보이게
                  <foreignObject x={p.x} y={p.y} width={NW} height={NH}>
                    <video
                      src={a.file_path}
                      muted
                      playsInline
                      preload="metadata"
                      style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                    />
                  </foreignObject>
                ) : (
                  <rect x={p.x} y={p.y} width={NW} height={NH} rx={8} className="lin-tph" />
                )}
                <rect
                  x={p.x}
                  y={p.y}
                  width={NW}
                  height={NH}
                  rx={8}
                  className="lin-tframe"
                  fill="none"
                />
                {g.is_final && (
                  <text x={p.x + NW - 6} y={p.y + 18} className="lin-tstar" textAnchor="end">
                    ★
                  </text>
                )}
                {/* 현재 카드 위치를 명확히 — 라임 글로우 테두리 + '현재' 라벨 */}
                {g.id === graph.focus_id && (
                  <>
                    <rect
                      x={p.x - 3}
                      y={p.y - 3}
                      width={NW + 6}
                      height={NH + 6}
                      rx={11}
                      className="lin-tnow-ring"
                      fill="none"
                    />
                    <rect
                      x={p.x + NW / 2 - 18}
                      y={p.y - 16}
                      width={36}
                      height={15}
                      rx={7}
                      className="lin-tnow-bg"
                    />
                    <text x={p.x + NW / 2} y={p.y - 5} textAnchor="middle" className="lin-tnow">
                      현재
                    </text>
                  </>
                )}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
