// 가상 스크롤용 "행 모델" — 생성물 배열을 (날짜 헤더 행 + 카드 행)의 순서열로 변환한다.
// virtua Virtualizer 가 이 rows 를 행 단위로 가상화하고, ThumbnailGrid 는 행을 렌더한다.
// 키보드 네비(방향키)는 DOM 기하 대신 여기 navGrid(카드 행렬)로 계산한다.
import { dayInfoFromUtcString, type DayInfo } from "./dateGroups";
import type { Generation } from "../types";

export type VirtualRow =
  | { type: "header"; key: string; dayKey: string; label: string }
  // height·widths = Masonry 줄만(그 줄의 썸네일 높이와 카드마다의 폭, px)
  | { type: "cards"; key: string; items: Generation[]; height?: number; widths?: number[] };

export interface GridRowModel {
  rows: VirtualRow[]; // 렌더 순서열(헤더 + 카드 행)
  navGrid: number[][]; // 카드 행만: navGrid[navRow] = [generations 인덱스, ...] (열 순서)
  posByGen: { navRow: number; col: number }[]; // generations[i] → 카드 격자 위치
  rowIndexOfNavRow: number[]; // navRow → rows[] 인덱스(virtua scrollToIndex 용)
  // 날짜별 그룹(헤더 체크박스 '그 날짜 전체 선택'용). groupByDate 아니면 null. 예전엔 별도 O(n)
  // 스캔(buildGenerationDateGroups)이었으나 이 빌드 루프에 합쳐 페이지 추가마다 재스캔을 줄였다.
  dateGroups: Map<string, { label: string; ids: string[] }> | null;
  // Masonry 만: navCenters[navRow][col] = 그 카드 가운데의 가로 자리(px). 줄마다 칸이 달라 위·아래는 열 번호가 아니라 가장 가까운 카드로 간다.
  navCenters?: number[][];
}

// Masonry(그림 비율 줄, Jay 2026-10-30) — 카드 폭 = 줄 높이 × 그림 비율. 목표 높이로 쌓다가 폭을 넘기는 순간 그 줄을 끊고,
//  줄 폭이 꽉 차게 높이를 줄인다(목표 이하). 날짜가 바뀌거나 목록이 끝나 꽉 차지 않은 줄은 목표 높이 그대로다(늘리지 않는다).
export interface JustifyOptions {
  width: number; // 줄 폭(컨테이너 안쪽)
  targetHeight: number;
  gap: number;
  ratioOf: (generation: Generation) => number; // 가로 ÷ 세로
}

/** 생성 설정의 비율("16:9" · "9x16")을 가로 ÷ 세로로 — auto·없음·깨진 값은 null. */
export function paramAspectRatio(params: Record<string, unknown> | null | undefined): number | null {
  const match = typeof params?.aspect_ratio === "string" ? /^\s*(\d+(?:\.\d+)?)\s*[:x×/]\s*(\d+(?:\.\d+)?)\s*$/.exec(params.aspect_ratio) : null;
  const ratio = match ? Number(match[1]) / Number(match[2]) : NaN;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

/** 스크롤 컨테이너의 안쪽 폭(좌우 padding 을 뺀 것). */
export function gridContentWidth(el: HTMLElement): number {
  const style = getComputedStyle(el);
  return el.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
}

// 컬럼 수 = 반응형 그리드가 실제로 만들 열 개수. CSS repeat(auto-fill, minmax(minCellPx,1fr)) 와
// 같은 공식으로 계산해 시각 밀도를 일치시킨다. 좌우 padding 은 컨테이너에서 실측하고, gap 은 카드 행
// (.gen-vrow-grid)의 값이라 컨테이너(block)에선 못 읽으므로 인자로 받는다.
export function computeGridColumns(el: HTMLElement, minCellPx: number, gapPx: number): number {
  const content = gridContentWidth(el);
  if (content <= 0 || minCellPx <= 0) return 1;
  return Math.max(1, Math.floor((content + gapPx) / (minCellPx + gapPx)));
}

export function buildGridRows(
  generations: Generation[],
  columns: number,
  groupByDate: boolean,
  dayInfoOf: (iso: string) => DayInfo = dayInfoFromUtcString,
  justify?: JustifyOptions, // 주면 Masonry 줄(columns 는 안 쓴다)
): GridRowModel {
  const cols = Math.max(1, columns);
  const rows: VirtualRow[] = [];
  const navGrid: number[][] = [];
  const posByGen: { navRow: number; col: number }[] = new Array(generations.length);
  const rowIndexOfNavRow: number[] = [];
  const navCenters: number[][] | undefined = justify ? [] : undefined;

  const dateGroups: Map<string, { label: string; ids: string[] }> | null = groupByDate
    ? new Map()
    : null;
  let cur: number[] = []; // 현재 카드 행에 쌓이는 generations 인덱스
  let ratios: number[] = []; // Masonry — cur 의 그림 비율
  let ratioSum = 0;
  let lastDay: string | null = null;

  const flush = (full = false) => {
    if (!cur.length) return;
    const navRow = navGrid.length;
    rowIndexOfNavRow.push(rows.length);
    const items = cur.map((i) => generations[i]);
    if (justify) {
      const height = full ? Math.max(1, (justify.width - justify.gap * (cur.length - 1)) / ratioSum) : justify.targetHeight;
      const widths = ratios.map((ratio) => ratio * height);
      let x = 0;
      navCenters!.push(widths.map((width) => { const center = x + width / 2; x += width + justify.gap; return center; }));
      rows.push({ type: "cards", key: `c${navRow}`, items, height, widths });
    } else rows.push({ type: "cards", key: `c${navRow}`, items });
    navGrid.push(cur);
    cur = [];
    ratios = [];
    ratioSum = 0;
  };

  for (let i = 0; i < generations.length; i++) {
    if (groupByDate) {
      const { key, label } = dayInfoOf(generations[i].created_at);
      // 날짜 그룹 누적(생성순 그대로) — 예전 buildGenerationDateGroups 별도 스캔을 이 루프로 합침.
      let ent = dateGroups!.get(key);
      if (!ent) {
        ent = { label, ids: [] };
        dateGroups!.set(key, ent);
      }
      ent.ids.push(generations[i].id);
      if (key !== lastDay) {
        flush(); // 날짜 바뀌면 현재 카드 행 마감(헤더는 전폭이라 별도 행)
        lastDay = key;
        rows.push({ type: "header", key: `h${key}`, dayKey: key, label });
      }
    }
    if (!justify && cur.length >= cols) flush();
    posByGen[i] = { navRow: navGrid.length, col: cur.length };
    cur.push(i);
    if (justify) {
      const ratio = justify.ratioOf(generations[i]);
      ratios.push(ratio);
      ratioSum += ratio;
      if (ratioSum * justify.targetHeight + justify.gap * (cur.length - 1) >= justify.width) flush(true);
    }
  }
  flush();
  return { rows, navGrid, posByGen, rowIndexOfNavRow, dateGroups, ...(navCenters ? { navCenters } : {}) };
}

// 방향키 → 이동할 인덱스. 없으면 null(경계). 아래/위는 같은 열(초과 시 그 행 마지막 열로 클램프).
// 생성 그리드(GridRowModel)와 에셋 그리드(AssetGridRowModel) 둘 다 쓰도록 필요한 필드만 받는다.
export function navigateGrid(
  model: { navGrid: number[][]; posByGen: { navRow: number; col: number }[]; navCenters?: number[][] },
  fromGenIndex: number,
  key: string,
): number | null {
  const pos = model.posByGen[fromGenIndex];
  if (!pos) return null;
  const { navGrid, navCenters } = model;
  const { navRow, col } = pos;
  if (key === "ArrowRight") return navGrid[navRow]?.[col + 1] ?? null;
  if (key === "ArrowLeft") return navGrid[navRow]?.[col - 1] ?? null;
  const toRow = key === "ArrowDown" ? navRow + 1 : key === "ArrowUp" ? navRow - 1 : -1;
  const target = navGrid[toRow];
  if (!target) return null;
  if (!navCenters) return target[Math.min(col, target.length - 1)];
  // Masonry — 지금 카드 가운데와 가로로 가장 가까운 카드
  const from = navCenters[navRow][col];
  let best = 0;
  navCenters[toRow].forEach((center, index) => {
    if (Math.abs(center - from) < Math.abs(navCenters[toRow][best] - from)) best = index;
  });
  return target[best];
}
