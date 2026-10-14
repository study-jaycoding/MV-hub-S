import { useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
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
  /** 이 폴더의 메타를 받았는가(useAssetProjectData.metaReady). 안 주면 받은 것으로 본다. */
  ready?: boolean;
}

/** 메타를 받기 전에 고치려 할 때의 안내 — 태그 편집을 여는 자리(AssetsView)도 같은 글을 쓴다. */
export const ASSET_META_NOT_READY = "이 폴더의 태그·색을 아직 받지 못했습니다 — 받은 뒤에 고칠 수 있습니다.";

export function useAssetMetaActions({
  project,
  filesRef,
  metaRef,
  selected,
  activeTags,
  setMeta,
  setActiveTags,
  reloadMeta,
  ready = true,
}: Params) {
  const currentProjectRef = useRef(project);
  currentProjectRef.current = project;
  // 저장 실패 뒤 메타를 서버 값으로 되돌릴 때마다 오른다 — 열려 있는 태그 편집기는 칩을 사본으로 들고 있어, 이것을 보고 다시 맞춘다
  //  (안 맞추면 "되돌렸습니다" 뒤에도 실패한 태그의 칩이 남고 다음 Enter 가 그것까지 저장한다 — 조작 규칙 43).
  const [restoreEpoch, setRestoreEpoch] = useState(0);
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
        if (restored) setRestoreEpoch((epoch) => epoch + 1);
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
    commitMeta((current) => {
      const next = { ...current };
      const cur = next[path] || EMPTY_ASSET_META;
      next[path] = { ...cur, tags: cur.tags.filter((item) => item !== tag) };
      return next;
    });
    enqueueSave(() => api.applyAssetTagOps(project, [{ path, remove: [tag] }]));
  };

  // previous = 그 조작 **직전** 편집기의 칩 목록. 열 때의 목록이나 최신 부모 메타와 견주면 안 된다 — 연 뒤 넣었다 뺀 태그가
  //  연산에서 빠지거나, 다른 창이 넣어 아직 편집기에 안 보이는 태그까지 빼게 된다(서버셋 설계 ③, Codex).
  const setAssetTagsReplace = (path: string, nextTags: string[], previous: string[] = metaRef.current[path]?.tags ?? []) => {
    const tags = [...nextTags];
    const add = tags.filter((tag) => !previous.includes(tag));
    const remove = previous.filter((tag) => !tags.includes(tag));
    commitMeta((current) => ({
      ...current,
      [path]: { ...(current[path] || EMPTY_ASSET_META), tags },
    }));
    if (add.length || remove.length) enqueueSave(() => api.applyAssetTagOps(project, [{ path, add, remove }]));
  };

  const bulkTagAdd = (path: string, names: string[]) => {
    const targets = Array.from(new Set([...selPaths(), path]));
    if (!targets.length) return;
    commitMeta((current) => {
      const out = { ...current };
      for (const target of targets) {
        const cur = out[target] || EMPTY_ASSET_META;
        out[target] = { ...cur, tags: Array.from(new Set([...cur.tags, ...names])) };
      }
      return out;
    });
    enqueueSave(() => api.applyAssetTagOps(project, targets.map((target) => ({ path: target, add: names }))));
  };

  const bulkTagRemove = (path: string, names: string[]) => {
    const targets = Array.from(new Set([...selPaths(), path]));
    if (!targets.length) return;
    const drop = new Set(names);
    commitMeta((current) => {
      const out = { ...current };
      for (const target of targets) {
        const cur = out[target] || EMPTY_ASSET_META;
        out[target] = { ...cur, tags: cur.tags.filter((tag) => !drop.has(tag)) };
      }
      return out;
    });
    enqueueSave(() => api.applyAssetTagOps(project, targets.map((target) => ({ path: target, remove: names }))));
  };

  const deleteTag = (tag: string) => {
    const affected = Object.entries(metaRef.current)
      .filter(([, meta]) => meta.tags.includes(tag))
      .map(([path]) => path);
    if (!affected.length) return;
    commitMeta((current) => {
      const out = { ...current };
      for (const path of affected)
        out[path] = { ...out[path], tags: out[path].tags.filter((item) => item !== tag) };
      return out;
    });
    enqueueSave(() => api.applyAssetTagOps(project, affected.map((path) => ({ path, remove: [tag] }))));
    if (activeTags.has(tag))
      setActiveTags((prev) => {
        const out = new Set(prev);
        out.delete(tag);
        return out;
      });
  };

  // 이 폴더의 메타를 받기 전에는 고치지 않는다(조작 규칙 45). 아래 조작은 모두 **지금 화면의 메타**에서 다음 값을 만든다 — 메타가 아직
  //  비어 있을 때(폴더를 처음 열어 파일 목록만 먼저 온 사이) 고치면 화면이 기존 태그·색이 없는 값으로 바뀐다. 태그 저장은 더하기·빼기라
  //  서버의 기존 태그는 지우지 않지만(서버셋 설계 ③), 색 토글·편집기 기준은 여전히 화면 값을 본다.
  const whenReady = <Args extends unknown[]>(run: (...args: Args) => void) => (...args: Args) => {
    if (ready) run(...args);
    else flashMsg(ASSET_META_NOT_READY);
  };

  return {
    selPaths,
    reconcile,
    colorAssets: whenReady(colorAssets),
    sourceAssets: whenReady(sourceAssets),
    toggleSource: whenReady(toggleSource),
    removeAssetTag: whenReady(removeAssetTag),
    setAssetTagsReplace: whenReady(setAssetTagsReplace),
    bulkTagAdd: whenReady(bulkTagAdd),
    bulkTagRemove: whenReady(bulkTagRemove),
    deleteTag: whenReady(deleteTag),
    restoreEpoch,
  };
}
