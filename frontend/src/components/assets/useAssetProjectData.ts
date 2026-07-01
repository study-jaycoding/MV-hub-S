import { useCallback, useEffect, useState } from "react";
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

  const reloadMeta = useCallback(async (targetProject = project) => {
    if (!targetProject) return;
    try {
      setMeta(await api.assetMeta(targetProject));
    } catch {
      setMeta({});
    }
  }, [project]);

  const reloadTree = useCallback(async (targetProject = project) => {
    if (!targetProject) return;
    setLoading(true);
    try {
      const nextTree = await api.assetTree(targetProject);
      setTree(nextTree.children);
      onTreeLoaded?.(nextTree.children);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
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
    reloadProjects,
    setMeta,
    setProject,
    setTree,
    tree,
  };
}
