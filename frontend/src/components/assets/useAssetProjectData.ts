import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { makeStore } from "../../lib/storage";
import type { AssetMeta, AssetNode } from "../../types";

const STORE = makeStore("ch.assets.");

export function useAssetProjectData({
  onTreeLoaded,
}: {
  onTreeLoaded?: (children: AssetNode[]) => void;
}) {
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProject] = useState("");
  const [tree, setTree] = useState<AssetNode[]>([]);
  const [meta, setMeta] = useState<Record<string, AssetMeta>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 프로젝트별 트리·메타 캐시 — 한 번 본 폴더는 다시 열 때 즉시 보여주고(로딩 플래시 제거), 뒤에서 조용히 최신화.
  //  파일 그리드는 tree 에서 파생되므로 트리 캐시 하나로 사이드바+그리드 둘 다 즉시 표시된다.
  const treeCacheRef = useRef<Record<string, AssetNode[]>>({});
  const metaCacheRef = useRef<Record<string, Record<string, AssetMeta>>>({});
  const projectRef = useRef(project); // 최신 선택 프로젝트 — 느린 응답이 돌아와도 딴 프로젝트를 덮지 않게
  projectRef.current = project;

  const reloadProjects = useCallback((keepCurrent = false) => {
    api
      .assetProjects()
      .then((info) => {
        setProjects(info.projects);
        setProject((current) => {
          if (keepCurrent && current && info.projects.includes(current)) return current;
          const saved = STORE.get("project", "");
          return saved && info.projects.includes(saved) ? saved : info.default;
        });
      })
      .catch((err) => setError(String(err)));
  }, []);

  // 화면의 tree/meta 가 바뀔 때마다(reload·드롭임포트·메타편집 등 어떤 경로든) 현재 프로젝트 캐시에 미러링
  //  → 직접 setter 로 편집해도 캐시가 어긋나지 않는다(다른 폴더 갔다 와도 최신 반영).
  useEffect(() => {
    if (projectRef.current) treeCacheRef.current[projectRef.current] = tree;
  }, [tree]);
  useEffect(() => {
    if (projectRef.current) metaCacheRef.current[projectRef.current] = meta;
  }, [meta]);

  const reloadMeta = useCallback(async (targetProject = project) => {
    if (!targetProject) return;
    const cached = metaCacheRef.current[targetProject];
    if (cached) setMeta(cached); // 캐시 즉시 표시
    try {
      const fresh = await api.assetMeta(targetProject);
      metaCacheRef.current[targetProject] = fresh; // 어느 프로젝트든 fresh 는 캐시(다음 방문 즉시)
      if (projectRef.current === targetProject) setMeta(fresh); // 여전히 이 프로젝트를 보고 있을 때만 화면 반영
    } catch {
      if (!cached && projectRef.current === targetProject) setMeta({});
    }
  }, [project]);

  const reloadTree = useCallback(async (targetProject = project) => {
    if (!targetProject) return;
    const isCurrent = () => projectRef.current === targetProject;
    const cached = treeCacheRef.current[targetProject];
    if (cached) {
      setTree(cached); // 캐시 있으면 즉시 표시(로딩 화면 없음)
      onTreeLoaded?.(cached);
      if (isCurrent()) setLoading(false); // 이전 uncached 로딩 잔여가 있으면 끈다
    } else if (isCurrent()) {
      setLoading(true); // 처음 여는 프로젝트만 로딩 표시(tree 는 안 비운다 — 비우면 mirror effect 가 빈 캐시를 남길 수 있음)
    }
    try {
      const nextTree = await api.assetTree(targetProject);
      treeCacheRef.current[targetProject] = nextTree.children; // 어느 프로젝트든 fresh 는 캐시
      if (isCurrent()) {
        setTree(nextTree.children);
        onTreeLoaded?.(nextTree.children);
        setError(null);
        setLoading(false);
      }
    } catch (err) {
      if (isCurrent()) {
        setError(String(err));
        setLoading(false);
      }
    }
  }, [onTreeLoaded, project]);

  const refreshProjectData = useCallback(
    async (targetProject = project) => {
      if (!targetProject) return;
      await Promise.all([reloadTree(targetProject), reloadMeta(targetProject)]);
    },
    [project, reloadMeta, reloadTree],
  );

  useEffect(() => {
    reloadProjects();
  }, [reloadProjects]);

  useEffect(() => {
    if (project) STORE.set("project", project);
  }, [project]);

  useEffect(() => {
    if (!project) return;
    void refreshProjectData(project);
  }, [project, refreshProjectData]);

  return {
    error,
    loading,
    meta,
    project,
    projects,
    refreshProjectData,
    reloadMeta,
    reloadProjects,
    setMeta,
    setProject,
    setTree,
    tree,
  };
}
