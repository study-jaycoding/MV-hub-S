import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { saveJSON } from "../../lib/storage";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import type { AssetNode } from "../../types";
import type { AssetTypeFilter } from "./assetsViewModel";

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
  sourceOnly,
  typeFilter,
}: UseAssetSelectionPersistenceArgs) {
  useEffect(() => {
    setSelected(new Set());
    setFocusIdx(-1);
  }, [dir, project, query, activeColors, sourceOnly, commentOnly, activeTags, typeFilter, groupByDate, setFocusIdx, setSelected]);

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
