import type { Generation, HistoryEdge, HistoryGraph } from "../types";

export type XY = { x: number; y: number };
export type HistoryView = { z: number; x: number; y: number };

export interface HistoryNodePos extends XY {
  col: number;
  row: number;
}

export interface HistoryLayoutSizing {
  nodeW: number;
  nodeH: number;
  gapX: number;
  gapY: number;
  pad: number;
}

export interface HistoryGraphLayout {
  byId: Record<string, Generation>;
  pos: Record<string, HistoryNodePos>;
  width: number;
  height: number;
  edges: HistoryEdge[];
}

export interface HistoryHighlight {
  edges: Set<string>;
  nodes: Set<string>;
}

export const HISTORY_BOARD_LAYOUT: HistoryLayoutSizing = {
  nodeW: 124,
  nodeH: 124,
  gapX: 78,
  gapY: 26,
  pad: 28,
};

export const HISTORY_MINI_LAYOUT: HistoryLayoutSizing = {
  nodeW: 84,
  nodeH: 84,
  gapX: 46,
  gapY: 22,
  pad: 20,
};

export const edgeKey = (parent: string, child: string) => parent + ">" + child;

export function getHistoryCenter(
  graph: HistoryGraph | null,
  selected: Set<string>,
  focusId: string | null,
): string[] {
  if (selected.size) return [...selected];
  if (graph && focusId && graph.nodes.some((n) => n.id === focusId)) return [focusId];
  return [];
}

export function traceConnectedHistoryLine(
  graph: HistoryGraph | null,
  center: string[],
): HistoryHighlight {
  const edges = new Set<string>();
  const nodes = new Set<string>();
  if (!graph || !center.length) return { edges, nodes };

  const inEdges: Record<string, { p: string; c: string }[]> = {};
  const outEdges: Record<string, { p: string; c: string }[]> = {};
  for (const e of graph.edges) {
    (inEdges[e.child_gen_id] ||= []).push({ p: e.parent_gen_id, c: e.child_gen_id });
    (outEdges[e.parent_gen_id] ||= []).push({ p: e.parent_gen_id, c: e.child_gen_id });
  }

  center.forEach((id) => nodes.add(id));
  let stack = [...center];
  const seenUp = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seenUp.has(id)) continue;
    seenUp.add(id);
    for (const e of inEdges[id] || []) {
      edges.add(edgeKey(e.p, e.c));
      nodes.add(e.p);
      stack.push(e.p);
    }
  }

  stack = [...center];
  const seenDown = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seenDown.has(id)) continue;
    seenDown.add(id);
    for (const e of outEdges[id] || []) {
      edges.add(edgeKey(e.p, e.c));
      nodes.add(e.c);
      stack.push(e.c);
    }
  }

  return { edges, nodes };
}

export function traceAncestorHistoryEdges(
  graph: HistoryGraph | null,
  selected: Set<string>,
): Set<string> {
  const edges = new Set<string>();
  if (!graph || !selected.size) return edges;

  const inEdges: Record<string, { p: string; c: string }[]> = {};
  for (const e of graph.edges) {
    (inEdges[e.child_gen_id] ||= []).push({ p: e.parent_gen_id, c: e.child_gen_id });
  }

  const stack = [...selected];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of inEdges[id] || []) {
      edges.add(edgeKey(e.p, e.c));
      stack.push(e.p);
    }
  }

  return edges;
}

export function buildHistoryLayout(
  graph: HistoryGraph | null,
  sizing: HistoryLayoutSizing,
): HistoryGraphLayout | null {
  if (!graph || !graph.nodes.length) return null;

  const byId: Record<string, Generation> = {};
  graph.nodes.forEach((n) => (byId[n.id] = n));

  const parentsOf: Record<string, string[]> = {};
  for (const e of graph.edges) {
    if (!byId[e.parent_gen_id] || !byId[e.child_gen_id]) continue;
    (parentsOf[e.child_gen_id] ||= []).push(e.parent_gen_id);
  }

  const depthMemo: Record<string, number> = {};
  const depthOf = (id: string, guard: Set<string> = new Set()): number => {
    if (id in depthMemo) return depthMemo[id];
    const ps = parentsOf[id] || [];
    if (!ps.length || guard.has(id)) return (depthMemo[id] = 0);
    guard.add(id);
    const d = 1 + Math.max(...ps.map((p) => depthOf(p, guard)));
    guard.delete(id);
    return (depthMemo[id] = d);
  };

  const sortTs = (id: string) => byId[id]?.sort_ts || 0;
  const maxCol = Math.max(0, ...graph.nodes.map((n) => depthOf(n.id)));
  const columns: string[][] = Array.from({ length: maxCol + 1 }, () => []);
  graph.nodes.forEach((n) => columns[depthOf(n.id)].push(n.id));

  const pos: Record<string, HistoryNodePos> = {};
  columns.forEach((colIds, c) => {
    const bary = (id: string) => {
      const prs = (parentsOf[id] || [])
        .map((p) => pos[p]?.row)
        .filter((r): r is number => r != null);
      return prs.length ? prs.reduce((s, r) => s + r, 0) / prs.length : sortTs(id) / 1e9;
    };
    if (c === 0) colIds.sort((a, b) => sortTs(a) - sortTs(b));
    else colIds.sort((a, b) => bary(a) - bary(b) || sortTs(a) - sortTs(b));
    colIds.forEach((id, row) => {
      pos[id] = {
        col: c,
        row,
        x: sizing.pad + c * (sizing.nodeW + sizing.gapX),
        y: sizing.pad + row * (sizing.nodeH + sizing.gapY),
      };
    });
  });

  const maxRows = Math.max(1, ...columns.map((c) => c.length));
  const width = sizing.pad * 2 + (maxCol + 1) * sizing.nodeW + maxCol * sizing.gapX;
  const height = sizing.pad * 2 + maxRows * sizing.nodeH + (maxRows - 1) * sizing.gapY;
  return { byId, pos, width, height, edges: graph.edges };
}

export function expandHistoryDims(
  layout: HistoryGraphLayout | null,
  manualPos: Record<string, XY>,
  sizing: HistoryLayoutSizing,
): { w: number; h: number } {
  if (!layout) return { w: 0, h: 0 };
  let w = layout.width;
  let h = layout.height;
  for (const id in manualPos) {
    const p = manualPos[id];
    w = Math.max(w, p.x + sizing.nodeW + sizing.pad);
    h = Math.max(h, p.y + sizing.nodeH + sizing.pad);
  }
  return { w, h };
}
