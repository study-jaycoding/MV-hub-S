import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { ingestAssetTreeVersions } from "../../lib/assetVersions";
import { makeStore } from "../../lib/storage";
import type { AssetMeta, AssetNode } from "../../types";

const STORE = makeStore("ch.assets.");
const TREE_CACHE_KEY = "treecache";
const META_CACHE_KEY = "metacache";
const CACHE_MAX_BYTES = 3_000_000; // localStorage 안전 상한(대략) — 넘으면 저장 생략(다음 세션은 다시 fetch)

// 캐시 맵을 localStorage 에 저장(용량 초과·직렬화 실패는 조용히 무시).
function persistCache(key: string, obj: unknown) {
  try {
    const s = JSON.stringify(obj);
    // 상한 초과면 저장을 건너뛰되, 예전에 저장된 작은(=낡은) 캐시가 다음 세션에 되살아나지 않게 비운다.
    STORE.set(key, s.length <= CACHE_MAX_BYTES ? s : "");
  } catch {
    /* ignore */
  }
}

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
  //  ★localStorage 에 저장 — 에셋 창을 껐다 켜도(컴포넌트 언마운트) 캐시가 살아남아 즉시 표시된다.
  const treeCacheRef = useRef<Record<string, AssetNode[]>>({});
  const metaCacheRef = useRef<Record<string, Record<string, AssetMeta>>>({});
  const cacheSeededRef = useRef(false);
  if (!cacheSeededRef.current) {
    cacheSeededRef.current = true; // 최초 렌더 1회만 localStorage 에서 시드
    treeCacheRef.current = STORE.loadJSON<Record<string, AssetNode[]>>(TREE_CACHE_KEY) || {};
    metaCacheRef.current = STORE.loadJSON<Record<string, Record<string, AssetMeta>>>(META_CACHE_KEY) || {};
  }
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
    // 캐시 즉시 표시는 '지금 보고 있는' 프로젝트일 때만 — 아니면 미러 이펙트가 현재 프로젝트 캐시를 오염시킨다.
    if (cached && projectRef.current === targetProject) setMeta(cached);
    try {
      const fresh = await api.assetMeta(targetProject);
      metaCacheRef.current[targetProject] = fresh; // 어느 프로젝트든 fresh 는 캐시(다음 방문 즉시)
      persistCache(META_CACHE_KEY, metaCacheRef.current); // 창 닫아도 살아남게 localStorage 저장
      if (projectRef.current === targetProject) setMeta(fresh); // 여전히 이 프로젝트를 보고 있을 때만 화면 반영
    } catch {
      if (!cached && projectRef.current === targetProject) setMeta({});
    }
  }, [project]);

  const reloadTree = useCallback(async (targetProject = project, fresh = false) => {
    if (!targetProject) return;
    const isCurrent = () => projectRef.current === targetProject;
    const cached = treeCacheRef.current[targetProject];
    // 화면(setTree/로딩)은 '지금 보고 있는' 프로젝트일 때만 건드린다 — 아니면 미러 이펙트가 현재 프로젝트
    //  캐시를 다른 프로젝트 트리로 오염시킨다. (백그라운드 fetch 로 캐시 갱신은 아래에서 계속 수행)
    if (isCurrent()) {
      if (cached) {
        setTree(cached); // 캐시 있으면 즉시 표시(로딩 화면 없음)
        onTreeLoaded?.(cached);
        setLoading(false);
      } else {
        setLoading(true); // 처음 여는 프로젝트만 로딩 표시(tree 는 안 비운다 — 비우면 mirror effect 가 빈 캐시를 남길 수 있음)
      }
    }
    try {
      const nextTree = await api.assetTree(targetProject, fresh);
      ingestAssetTreeVersions(targetProject, nextTree.children); // 전역 버전 표 갱신(캔버스와 공유)
      treeCacheRef.current[targetProject] = nextTree.children; // 어느 프로젝트든 fresh 는 캐시
      persistCache(TREE_CACHE_KEY, treeCacheRef.current); // 창 닫아도 살아남게 localStorage 저장
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
    async (targetProject = project, fresh = false) => {
      if (!targetProject) return;
      // fresh=true 면 트리를 캐시 우회로 다시 읽는다(실시간 변경 수신 시 — 백엔드 캐시 경합으로 옛 버전이
      // 남는 경우까지 방어).
      await Promise.all([reloadTree(targetProject, fresh), reloadMeta(targetProject)]);
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

  // 창을 다시 볼 때(포커스/탭 전환) 현재 프로젝트를 fresh 로 다시 읽어 최신 파일 버전을 반영한다
  // → 외부에서 원본을 같은 이름으로 덮어쓰고 어셋 창으로 돌아오면 썸네일이 자동으로 최신화된다.
  // 캔버스와 같은 동작(포커스 재조회) — 디바운스로 focus/visibilitychange 중복 호출을 한 번으로 묶는다.
  useEffect(() => {
    let lastAt = 0;
    const refresh = () => {
      if (document.hidden || !projectRef.current) return;
      const now = Date.now();
      if (now - lastAt < 500) return;
      lastAt = now;
      void reloadTree(projectRef.current, true);
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [reloadTree]);

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
