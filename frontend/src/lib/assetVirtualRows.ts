// 에셋 그리드용 "행 모델" — 생성 그리드(gridVirtualRows)의 인덱스판. AssetsView 가 virtua 로
// 화면에 보이는 셀만 마운트하도록, 파일 배열을 (날짜 헤더 행 + 카드 행)의 순서열로 변환한다.
// 선택이 인덱스 기반(Set<number>)이라 navGrid 도 파일 인덱스 행렬로 둔다.
import { dayInfoFromEpochSeconds } from "./dateGroups";
import type { AssetNode } from "../types";

export type AssetVirtualRow =
  | { type: "header"; key: string; dayKey: string; label: string }
  | { type: "cards"; key: string; idxs: number[] };

export interface AssetGridRowModel {
  rows: AssetVirtualRow[]; // 렌더 순서열(헤더 + 카드 행)
  navGrid: number[][]; // 카드 행만: navGrid[navRow] = [files 인덱스, ...] (열 순서)
  posByIdx: { navRow: number; col: number }[]; // files[i] → 카드 격자 위치
  rowIndexOfNavRow: number[]; // navRow → rows[] 인덱스(virtua scrollToIndex 용)
  dateGroups: Map<string, { label: string; idxs: number[] }>; // 날짜별 그룹(헤더 체크박스용)
}

export function buildAssetRows(
  files: AssetNode[],
  columns: number,
  groupByDate: boolean,
): AssetGridRowModel {
  const cols = Math.max(1, columns);
  const rows: AssetVirtualRow[] = [];
  const navGrid: number[][] = [];
  const posByIdx: { navRow: number; col: number }[] = new Array(files.length);
  const rowIndexOfNavRow: number[] = [];
  const dateGroups = new Map<string, { label: string; idxs: number[] }>();

  let cur: number[] = []; // 현재 카드 행에 쌓이는 files 인덱스
  let lastDay: string | null = null;

  const flush = () => {
    if (!cur.length) return;
    const navRow = navGrid.length;
    rowIndexOfNavRow.push(rows.length);
    rows.push({ type: "cards", key: `c${navRow}`, idxs: cur });
    navGrid.push(cur);
    cur = [];
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
    if (cur.length >= cols) flush();
    posByIdx[i] = { navRow: navGrid.length, col: cur.length };
    cur.push(i);
  }
  flush();
  return { rows, navGrid, posByIdx, rowIndexOfNavRow, dateGroups };
}
