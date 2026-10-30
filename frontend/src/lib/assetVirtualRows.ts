// 에셋 그리드용 "행 모델" — 생성 그리드(gridVirtualRows)의 인덱스판. AssetsView 가 virtua 로
// 화면에 보이는 셀만 마운트하도록, 파일 배열을 (날짜 헤더 행 + 카드 행)의 순서열로 변환한다.
// 선택이 인덱스 기반(Set<number>)이라 navGrid 도 파일 인덱스 행렬로 둔다.
import { dayInfoFromEpochSeconds } from "./dateGroups";
import type { AssetNode } from "../types";

export type AssetVirtualRow =
  | { type: "header"; key: string; dayKey: string; label: string }
  // height·widths = Masonry 줄만(그 줄의 칸 높이와 칸마다의 폭, px)
  | { type: "cards"; key: string; idxs: number[]; height?: number; widths?: number[] };

export interface AssetGridRowModel {
  rows: AssetVirtualRow[]; // 렌더 순서열(헤더 + 카드 행)
  navGrid: number[][]; // 카드 행만: navGrid[navRow] = [files 인덱스, ...] (열 순서)
  posByIdx: { navRow: number; col: number }[]; // files[i] → 카드 격자 위치
  rowIndexOfNavRow: number[]; // navRow → rows[] 인덱스(virtua scrollToIndex 용)
  dateGroups: Map<string, { label: string; idxs: number[] }>; // 날짜별 그룹(헤더 체크박스용)
  navCenters?: number[][]; // Masonry 만 — 칸 가운데의 가로 자리(위·아래 키 = 가장 가까운 칸, lib/gridVirtualRows navigateGrid)
}

// Masonry(Jay 2026-10-30) — 생성 그리드(lib/gridVirtualRows JustifyOptions)와 같은 줄 맞춤: 목표 높이로 쌓다가 폭을 넘기면 끊고
//  줄 폭이 꽉 차게 높이를 줄인다(목표 이하). 날짜가 바뀌거나 끝나 꽉 차지 않은 줄은 목표 높이 그대로.
export interface AssetJustifyOptions {
  width: number;
  targetHeight: number;
  gap: number;
  ratioOf: (file: AssetNode) => number; // 가로 ÷ 세로
}

export function buildAssetRows(
  files: AssetNode[],
  columns: number,
  groupByDate: boolean,
  justify?: AssetJustifyOptions, // 주면 Masonry 줄(columns 는 안 쓴다)
): AssetGridRowModel {
  const cols = Math.max(1, columns);
  const rows: AssetVirtualRow[] = [];
  const navGrid: number[][] = [];
  const posByIdx: { navRow: number; col: number }[] = new Array(files.length);
  const rowIndexOfNavRow: number[] = [];
  const dateGroups = new Map<string, { label: string; idxs: number[] }>();
  const navCenters: number[][] | undefined = justify ? [] : undefined;

  let cur: number[] = []; // 현재 카드 행에 쌓이는 files 인덱스
  let ratios: number[] = []; // Masonry — cur 의 그림 비율
  let ratioSum = 0;
  let lastDay: string | null = null;

  const flush = (full = false) => {
    if (!cur.length) return;
    const navRow = navGrid.length;
    rowIndexOfNavRow.push(rows.length);
    if (justify) {
      const height = full ? Math.max(1, (justify.width - justify.gap * (cur.length - 1)) / ratioSum) : justify.targetHeight;
      const widths = ratios.map((ratio) => ratio * height);
      let x = 0;
      navCenters!.push(widths.map((width) => { const center = x + width / 2; x += width + justify.gap; return center; }));
      rows.push({ type: "cards", key: `c${navRow}`, idxs: cur, height, widths });
    } else rows.push({ type: "cards", key: `c${navRow}`, idxs: cur });
    navGrid.push(cur);
    cur = [];
    ratios = [];
    ratioSum = 0;
  };

  for (let i = 0; i < files.length; i++) {
    if (groupByDate) {
      const { key, label } = dayInfoFromEpochSeconds(files[i].mtime);
      let ent = dateGroups.get(key); // 날짜 그룹 누적(생성순 그대로) — 헤더 '그 날짜 전체 선택'용
      if (!ent) {
        ent = { label, idxs: [] };
        dateGroups.set(key, ent);
      }
      ent.idxs.push(i);
      if (key !== lastDay) {
        flush(); // 날짜 바뀌면 현재 카드 행 마감(헤더는 전폭이라 별도 행)
        lastDay = key;
        rows.push({ type: "header", key: `h${key}`, dayKey: key, label });
      }
    }
    if (!justify && cur.length >= cols) flush();
    posByIdx[i] = { navRow: navGrid.length, col: cur.length };
    cur.push(i);
    if (justify) {
      const ratio = justify.ratioOf(files[i]);
      ratios.push(ratio);
      ratioSum += ratio;
      if (ratioSum * justify.targetHeight + justify.gap * (cur.length - 1) >= justify.width) flush(true);
    }
  }
  flush();
  return { rows, navGrid, posByIdx, rowIndexOfNavRow, dateGroups, ...(navCenters ? { navCenters } : {}) };
}
