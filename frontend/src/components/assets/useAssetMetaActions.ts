import { useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { api } from "../../api";
import { flashMsg } from "../../lib/flash";
import { createMutationQueue } from "../../lib/mutationQueue";
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
  reloadMeta: (targetProject?: string) => Promise<boolean>; // 서버 상태 재조회(가드·캐시 있는 경로) — 돌려주는 값 = 받았는가
}

export function useAssetMetaActions({
  project,
  filesRef,
  metaRef,
  selected,
  activeTags,
  setMeta,
  setActiveTags,
  reloadMeta,
}: Params) {
  const currentProjectRef = useRef(project);
  currentProjectRef.current = project;
  const mutationRevisionRef = useRef(new Map<string, number>());
  const optimisticMetaRef = useRef(new Map<string, Record<string, AssetMeta>>());
  const selPaths = () =>
    [...selected].map((index) => filesRef.current[index]?.path).filter(Boolean) as string[];

  // React 가 다시 렌더되기 전의 연속 클릭도 최신 값을 읽게 ref와 state를 같은 순간에 갱신한다.
  const commitMeta = (
    update: (current: Record<string, AssetMeta>) => Record<string, AssetMeta>,
  ) => {
    const next = update(metaRef.current);
    metaRef.current = next;
    optimisticMetaRef.current.set(project, next);
    mutationRevisionRef.current.set(project, (mutationRevisionRef.current.get(project) || 0) + 1);
    setMeta(next);
    return next;
  };

  const patchMeta = (paths: string[], partial: Partial<AssetMeta>) =>
    commitMeta((current) => {
      const next = { ...current };
      for (const path of paths) next[path] = { ...(next[path] || EMPTY_ASSET_META), ...partial };
      return next;
    });

  // 서버 상태로 되돌림 — 가드된 reloadMeta 로 위임(전환 중이면 딴 프로젝트 화면/캐시를 안 덮는다).
  const reconcile = (): Promise<void> => reloadMeta(project).then(() => undefined);
  const mutationQueuesRef = useRef(new Map<string, ReturnType<typeof createMutationQueue>>());
  const enqueueSave = (operation: () => Promise<unknown>) => {
    let queue = mutationQueuesRef.current.get(project);
    if (!queue) {
      const targetProject = project;
      // 실패한 저장이 있으면 화면을 서버 값으로 되돌려야 한다 — 그 빚(owed). 저장 묶음이 끝날 때마다(성공·실패 모두) 갚을 것이 있나 본다.
      let owed = false;
      const settle = async (failed: boolean) => {
        if (failed) owed = true;
        if (!owed) return;
        const revisionBeforeReload = mutationRevisionRef.current.get(targetProject) || 0;
        const restored = await reloadMeta(targetProject);
        if ((mutationRevisionRef.current.get(targetProject) || 0) !== revisionBeforeReload) {
          // 다시 읽는 사이에 새 편집이 들어왔다 — 그 낙관적 화면을 지킨다(그 저장은 같은 큐에서 이 뒤에 나간다). 다만 그 사본에는
          //  **실패한 값도 들어 있어** 아직 되돌린 것이 아니다: 빚을 남겨 두고, 그 저장이 끝난 뒤(여기가 다시 불린다) 다시 읽어 갚는다.
          //  전엔 여기서 "서버 상태로 되돌렸습니다"라고 했고, 뒤의 저장이 성공하면 다시 읽지 않아 실패한 값이 화면에 남았다
          //  (조작 규칙 41 — Codex 코드 리뷰).
          const optimistic = optimisticMetaRef.current.get(targetProject);
          if (optimistic && currentProjectRef.current === targetProject) {
            metaRef.current = optimistic;
            setMeta(optimistic);
          }
          return;
        }
        owed = false;
        // 되돌리려던 조회까지 실패했으면(서버에 닿지 않는다) '되돌렸다'고 하지 않는다 — 화면에는 저장 안 된 값이 남아 있다.
        flashMsg(restored
          ? "변경 적용 실패 — 서버 상태로 되돌렸습니다"
          : "변경 적용 실패 — 서버에 닿지 않아 되돌리지도 못했습니다. 화면의 값은 저장되지 않았습니다(다시 열면 서버 값이 보입니다).");
      };
      queue = createMutationQueue(() => settle(true), () => settle(false));
      mutationQueuesRef.current.set(targetProject, queue);
    }
    void queue.enqueue(operation);
  };

  const colorAssets = (paths: string[], color: string) => {
    const allSame = paths.every((path) => metaRef.current[path]?.color === color);
    const next = allSame ? null : color;
    patchMeta(paths, { color: next });
    enqueueSave(() => api.setAssetColorsBatch(project, paths, next));
  };

  const sourceAssets = (paths: string[]) => {
    const named = paths.map((path) => ({ path, name: assetFileBaseName(path, filesRef.current) }));
    commitMeta((current) => {
      const next = { ...current };
      for (const { path, name } of named)
        next[path] = { ...(next[path] || EMPTY_ASSET_META), is_source: true, source_name: name };
      return next;
    });
    enqueueSave(() => api.setAssetSourcesBatch(project, named));
  };

  const toggleSource = (path: string) => {
    if (metaRef.current[path]?.is_source) {
      patchMeta([path], { is_source: false, source_name: null });
      enqueueSave(() => api.setAssetSource(project, path, null, false));
    } else {
      sourceAssets([path]);
    }
  };

  const removeAssetTag = (path: string, tag: string) => {
    const next = commitMeta((current) => {
      const next = { ...current };
      const cur = next[path] || EMPTY_ASSET_META;
      next[path] = { ...cur, tags: cur.tags.filter((item) => item !== tag) };
      return next;
    });
    enqueueSave(() => api.setAssetTags(project, path, next[path].tags));
  };

  const setAssetTagsReplace = (path: string, nextTags: string[]) => {
    const tags = [...nextTags];
    commitMeta((current) => ({
      ...current,
      [path]: { ...(current[path] || EMPTY_ASSET_META), tags },
    }));
    enqueueSave(() => api.setAssetTags(project, path, tags));
  };

  const bulkTagAdd = (path: string, names: string[]) => {
    const targets = Array.from(new Set([...selPaths(), path]));
    if (!targets.length) return;
    const next = commitMeta((current) => {
      const out = { ...current };
      for (const target of targets) {
        const cur = out[target] || EMPTY_ASSET_META;
        out[target] = { ...cur, tags: Array.from(new Set([...cur.tags, ...names])) };
      }
      return out;
    });
    enqueueSave(() =>
      api.setAssetTagsBatch(
        project,
        targets.map((target) => ({ path: target, tags: next[target].tags })),
      ),
    );
  };

  const bulkTagRemove = (path: string, names: string[]) => {
    const targets = Array.from(new Set([...selPaths(), path]));
    if (!targets.length) return;
    const drop = new Set(names);
    const next = commitMeta((current) => {
      const out = { ...current };
      for (const target of targets) {
        const cur = out[target] || EMPTY_ASSET_META;
        out[target] = { ...cur, tags: cur.tags.filter((tag) => !drop.has(tag)) };
      }
      return out;
    });
    enqueueSave(() =>
      api.setAssetTagsBatch(
        project,
        targets.map((target) => ({ path: target, tags: next[target].tags })),
      ),
    );
  };

  const deleteTag = (tag: string) => {
    const affected = Object.entries(metaRef.current)
      .filter(([, meta]) => meta.tags.includes(tag))
      .map(([path]) => path);
    if (!affected.length) return;
    const next = commitMeta((current) => {
      const out = { ...current };
      for (const path of affected)
        out[path] = { ...out[path], tags: out[path].tags.filter((item) => item !== tag) };
      return out;
    });
    enqueueSave(() =>
      api.setAssetTagsBatch(
        project,
        affected.map((path) => ({ path, tags: next[path].tags })),
      ),
    );
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
