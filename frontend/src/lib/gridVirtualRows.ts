// 가상 스크롤용 "행 모델" — 생성물 배열을 (날짜 헤더 행 + 카드 행)의 순서열로 변환한다.
// virtua Virtualizer 가 이 rows 를 행 단위로 가상화하고, ThumbnailGrid 는 행을 렌더한다.
// 키보드 네비(방향키)는 DOM 기하 대신 여기 navGrid(카드 행렬)로 계산한다.
import { dayInfoFromUtcString, type DayInfo } from "./dateGroups";
import type { Generation } from "../types";

export type VirtualRow =
  | { type: "header"; key: string; dayKey: string; label: string }
  | { type: "cards"; key: string; items: Generation[] };

export interface GridRowModel {
  rows: VirtualRow[]; // 렌더 순서열(헤더 + 카드 행)
  navGrid: number[][]; // 카드 행만: navGrid[navRow] = [generations 인덱스, ...] (열 순서)
  posByGen: { navRow: number; col: number }[]; // generations[i] → 카드 격자 위치
  rowIndexOfNavRow: number[]; // navRow → rows[] 인덱스(virtua scrollToIndex 용)
}

// 컬럼 수 = 반응형 그리드가 실제로 만들 열 개수. CSS repeat(auto-fill, minmax(minCellPx,1fr)) 와
// 같은 공식으로 계산해 시각 밀도를 일치시킨다. gap·좌우 padding 을 실측한다.
export function computeGridColumns(el: HTMLElement, minCellPx: number): number {
  const style = getComputedStyle(el);
  const padL = parseFloat(style.paddingLeft) || 0;
  const padR = parseFloat(style.paddingRight) || 0;
  const gap = parseFloat(style.columnGap || style.gap || "0") || 0;
  const content = el.clientWidth - padL - padR;
  if (content <= 0 || minCellPx <= 0) return 1;
  return Math.max(1, Math.floor((content + gap) / (minCellPx + gap)));
}

export function buildGridRows(
  generations: Generation[],
  columns: number,
  groupByDate: boolean,
  dayInfoOf: (iso: string) => DayInfo = dayInfoFromUtcString,
): GridRowModel {
  const cols = Math.max(1, columns);
  const rows: VirtualRow[] = [];
  const navGrid: number[][] = [];
  const posByGen: { navRow: number; col: number }[] = new Array(generations.length);
  const rowIndexOfNavRow: number[] = [];

  let cur: number[] = []; // 현재 카드 행에 쌓이는 generations 인덱스
  let lastDay: string | null = null;

  const flush = () => {
    if (!cur.length) return;
    const navRow = navGrid.length;
    rowIndexOfNavRow.push(rows.length);
    rows.push({ type: "cards", key: `c${navRow}`, items: cur.map((i) => generations[i]) });
    navGrid.push(cur);
    cur = [];
  };

  for (let i = 0; i < generations.length; i++) {
    if (groupByDate) {
      const { key, label } = dayInfoOf(generations[i].created_at);
      if (key !== lastDay) {
        flush(); // 날짜 바뀌면 현재 카드 행 마감(헤더는 전폭이라 별도 행)
        lastDay = key;
        rows.push({ type: "header", key: `h${key}`, dayKey: key, label });
      }
    }
    if (cur.length >= cols) flush();
    posByGen[i] = { navRow: navGrid.length, col: cur.length };
    cur.push(i);
  }
  flush();
  return { rows, navGrid, posByGen, rowIndexOfNavRow };
}

// 방향키 → 이동할 generations 인덱스. 없으면 null(경계). 아래/위는 같은 열(초과 시 그 행 마지막 열로 클램프).
export function navigateGrid(
  model: GridRowModel,
  fromGenIndex: number,
  key: string,
): number | null {
  const pos = model.posByGen[fromGenIndex];
  if (!pos) return null;
  const { navGrid } = model;
  const { navRow, col } = pos;
  if (key === "ArrowRight") return navGrid[navRow]?.[col + 1] ?? null;
  if (key === "ArrowLeft") return navGrid[navRow]?.[col - 1] ?? null;
  if (key === "ArrowDown") {
    const next = navGrid[navRow + 1];
    if (!next) return null;
    return next[Math.min(col, next.length - 1)];
  }
  if (key === "ArrowUp") {
    const prev = navGrid[navRow - 1];
    if (!prev) return null;
    return prev[Math.min(col, prev.length - 1)];
  }
  return null;
}
