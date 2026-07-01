import { edgeKey, type HistoryGraphLayout, type HistoryHighlight, type XY } from "../../lib/historyGraphLayout";

interface Props {
  layout: HistoryGraphLayout;
  width: number;
  height: number;
  nodeW: number;
  nodeH: number;
  posOf: (id: string) => XY;
  hasCenter: boolean;
  highlight: HistoryHighlight;
  whiteEdges: Set<string>;
  disabled: Set<string>;
}

function edgePath(parent: XY, child: XY, nodeW: number, nodeH: number) {
  const x1 = parent.x + nodeW;
  const y1 = parent.y + nodeH / 2;
  const x2 = child.x;
  const y2 = child.y + nodeH / 2;
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}

export function HistoryBoardEdges({
  layout,
  width,
  height,
  nodeW,
  nodeH,
  posOf,
  hasCenter,
  highlight,
  whiteEdges,
  disabled,
}: Props) {
  return (
    <svg className="linb-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {layout.edges.map((edge, index) => {
        const parent = posOf(edge.parent_gen_id);
        const child = posOf(edge.child_gen_id);
        if (!parent || !child) return null;
        const key = edgeKey(edge.parent_gen_id, edge.child_gen_id);
        const dim = hasCenter && !highlight.edges.has(key);
        const edgeOff = disabled.has(edge.parent_gen_id) || disabled.has(edge.child_gen_id);
        return (
          <path
            key={index}
            d={edgePath(parent, child, nodeW, nodeH)}
            className={
              "linb-edge " +
              (edge.relation === "reference" ? "ref" : "der") +
              (dim ? " dim" : "") +
              (edgeOff ? " disabled" : "")
            }
          />
        );
      })}
      {layout.edges
        .filter((edge) => highlight.edges.has(edgeKey(edge.parent_gen_id, edge.child_gen_id)))
        .map((edge, index) => {
          const parent = posOf(edge.parent_gen_id);
          const child = posOf(edge.child_gen_id);
          if (!parent || !child) return null;
          const edgeOff = disabled.has(edge.parent_gen_id) || disabled.has(edge.child_gen_id);
          return (
            <path
              key={"main" + index}
              d={edgePath(parent, child, nodeW, nodeH)}
              className={"linb-edge main" + (edgeOff ? " disabled" : "")}
            />
          );
        })}
      {layout.edges
        .filter((edge) => whiteEdges.has(edgeKey(edge.parent_gen_id, edge.child_gen_id)))
        .map((edge, index) => {
          const parent = posOf(edge.parent_gen_id);
          const child = posOf(edge.child_gen_id);
          if (!parent || !child) return null;
          const edgeOff = disabled.has(edge.parent_gen_id) || disabled.has(edge.child_gen_id);
          return (
            <path
              key={"hl" + index}
              d={edgePath(parent, child, nodeW, nodeH)}
              className={"linb-edge hl" + (edgeOff ? " disabled" : "")}
            />
          );
        })}
    </svg>
  );
}
