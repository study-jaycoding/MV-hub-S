import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { api } from "../../api";
import { flashMsg } from "../../lib/flash";
import type { AssetMeta, AssetNode } from "../../types";
import { EMPTY_ASSET_META, assetFileBaseName } from "./assetsViewModel";

interface Params {
  project: string;
  filesRef: MutableRefObject<AssetNode[]>;
  metaRef: MutableRefObject<Record<string, AssetMeta>>;
  selected: Set<number>;
  activeTags: Set<string>;
  setMeta: Dispatch<SetStateAction<Record<string, AssetMeta>>>;
  setActiveTags: Dispatch<SetStateAction<Set<string>>>;
}

export function useAssetMetaActions({
  project,
  filesRef,
  metaRef,
  selected,
  activeTags,
  setMeta,
  setActiveTags,
}: Params) {
  const selPaths = () =>
    [...selected].map((index) => filesRef.current[index]?.path).filter(Boolean) as string[];

  const patchMeta = (paths: string[], partial: Partial<AssetMeta>) =>
    setMeta((prev) => {
      const next = { ...prev };
      for (const path of paths) next[path] = { ...(next[path] || EMPTY_ASSET_META), ...partial };
      return next;
    });

  const reconcile = () =>
    api.assetMeta(project).then(setMeta).catch(() => {});

  const metaFail = () => {
    reconcile();
    flashMsg("변경 적용 실패 — 서버 상태로 되돌렸습니다");
  };

  const colorAssets = (paths: string[], color: string) => {
    const allSame = paths.every((path) => metaRef.current[path]?.color === color);
    const next = allSame ? null : color;
    patchMeta(paths, { color: next });
    Promise.all(paths.map((path) => api.setAssetColor(project, path, next))).catch(metaFail);
  };

  const sourceAssets = (paths: string[]) => {
    const named = paths.map((path) => ({ path, name: assetFileBaseName(path, filesRef.current) }));
    setMeta((prev) => {
      const next = { ...prev };
      for (const { path, name } of named)
        next[path] = { ...(next[path] || EMPTY_ASSET_META), is_source: true, source_name: name };
      return next;
    });
    Promise.all(named.map(({ path, name }) => api.setAssetSource(project, path, name, true))).catch(metaFail);
  };

  const toggleSource = (path: string) => {
    if (metaRef.current[path]?.is_source) {
      patchMeta([path], { is_source: false, source_name: null });
      api.setAssetSource(project, path, null, false).catch(metaFail);
    } else {
      sourceAssets([path]);
    }
  };

  const removeAssetTag = (path: string, tag: string) => {
    setMeta((prev) => {
      const next = { ...prev };
      const cur = next[path] || EMPTY_ASSET_META;
      next[path] = { ...cur, tags: cur.tags.filter((item) => item !== tag) };
      return next;
    });
    const nextTags = (metaRef.current[path]?.tags || []).filter((item) => item !== tag);
    api.setAssetTags(project, path, nextTags).catch(metaFail);
  };

  const setAssetTagsReplace = (path: string, nextTags: string[]) => {
    setMeta((prev) => ({ ...prev, [path]: { ...(prev[path] || EMPTY_ASSET_META), tags: nextTags } }));
    api.setAssetTags(project, path, nextTags).catch(metaFail);
  };

  const bulkTagAdd = (path: string, names: string[]) => {
    const targets = Array.from(new Set([...selPaths(), path]));
    if (!targets.length) return;
    const next = { ...metaRef.current };
    for (const target of targets) {
      const cur = next[target] || EMPTY_ASSET_META;
      next[target] = { ...cur, tags: Array.from(new Set([...cur.tags, ...names])) };
    }
    metaRef.current = next;
    setMeta(next);
    Promise.allSettled(targets.map((target) => api.setAssetTags(project, target, next[target].tags))).catch(metaFail);
  };

  const bulkTagRemove = (path: string, names: string[]) => {
    const targets = Array.from(new Set([...selPaths(), path]));
    if (!targets.length) return;
    const drop = new Set(names);
    const next = { ...metaRef.current };
    for (const target of targets) {
      const cur = next[target] || EMPTY_ASSET_META;
      next[target] = { ...cur, tags: cur.tags.filter((tag) => !drop.has(tag)) };
    }
    metaRef.current = next;
    setMeta(next);
    Promise.allSettled(targets.map((target) => api.setAssetTags(project, target, next[target].tags))).catch(metaFail);
  };

  const deleteTag = (tag: string) => {
    const affected = Object.entries(metaRef.current)
      .filter(([, meta]) => meta.tags.includes(tag))
      .map(([path]) => path);
    if (!affected.length) return;
    const next = { ...metaRef.current };
    for (const path of affected) next[path] = { ...next[path], tags: next[path].tags.filter((item) => item !== tag) };
    metaRef.current = next;
    setMeta(next);
    Promise.all(affected.map((path) => api.setAssetTags(project, path, next[path].tags))).catch(metaFail);
    if (activeTags.has(tag))
      setActiveTags((prev) => {
        const out = new Set(prev);
        out.delete(tag);
        return out;
      });
  };

  return {
    selPaths,
    reconcile,
    colorAssets,
    sourceAssets,
    toggleSource,
    removeAssetTag,
    setAssetTagsReplace,
    bulkTagAdd,
    bulkTagRemove,
    deleteTag,
  };
}
