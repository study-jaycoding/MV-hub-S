import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { saveJSON } from "../../lib/storage";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import type { AssetNode } from "../../types";
import type { AssetSortDir, AssetSortField, AssetTypeFilter } from "./assetsViewModel";

interface UseAssetSelectionPersistenceArgs {
  activeColors: Set<string>;
  activeTags: Set<string>;
  commentOnly: boolean;
  dir: string;
  files: AssetNode[];
  groupByDate: boolean;
  project: string;
  query: string;
  selected: Set<number>;
  setFocusIdx: Dispatch<SetStateAction<number>>;
  setSelected: Dispatch<SetStateAction<Set<number>>>;
  sortDir: AssetSortDir;
  sortField: AssetSortField;
  sourceOnly: boolean;
  typeFilter: AssetTypeFilter;
}

export function useAssetSelectionPersistence({
  activeColors,
  activeTags,
  commentOnly,
  dir,
  files,
  groupByDate,
  project,
  query,
  selected,
  setFocusIdx,
  setSelected,
  sortDir,
  sortField,
  sourceOnly,
  typeFilter,
}: UseAssetSelectionPersistenceArgs) {
  useEffect(() => {
    // 정렬(sortField/sortDir)이 바뀌면 files 순서가 재배치돼 인덱스 기반 focusIdx 가 엉뚱한 파일을
    // 가리키므로, 날짜구분 토글과 동일하게 선택·포커스를 초기화한다(포커스 stale 방지).
    setSelected(new Set());
    setFocusIdx(-1);
  }, [dir, project, query, activeColors, sourceOnly, commentOnly, activeTags, typeFilter, groupByDate, sortField, sortDir, setFocusIdx, setSelected]);

  const selFilesRef = useRef(files);
  useEffect(() => {
    const prev = selFilesRef.current;
    selFilesRef.current = files;
    if (prev === files) return;
    setSelected((sel) => {
      if (!sel.size) return sel;
      const paths = new Set<string>();
      sel.forEach((index) => {
        const path = prev[index]?.path;
        if (path) paths.add(path);
      });
      const next = new Set<number>();
      files.forEach((file, index) => {
        if (paths.has(file.path)) next.add(index);
      });
      return next;
    });
  }, [files, setSelected]);

  useEffect(() => {
    try {
      const items = [...selected]
        .sort((a, b) => a - b)
        .map((index) => files[index])
        .filter((file) => file && (file.type === "image" || file.type === "video"))
        .map((file) => ({ project, path: file.path, name: file.name, type: file.type }));
      saveJSON(STORAGE_KEYS.assetsSelection, items);
    } catch {
      /* localStorage 불가 시 무시(드래그 페이로드 폴백) */
    }
  }, [selected, files, project]);
}
