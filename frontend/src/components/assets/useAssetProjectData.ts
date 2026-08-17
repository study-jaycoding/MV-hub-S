import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { ingestAssetTreeVersions } from "../../lib/assetVersions";
import { reconcileArrayState, reconcileRecordState } from "../../lib/stateReconciliation";
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
  workspaceId,
}: {
  onTreeLoaded?: (children: AssetNode[]) => void;
  /** 선택 팀 워크스페이스 — 바뀌면 프로젝트 유래 폴더 목록을 그 팀으로 다시 좁힌다. */
  workspaceId?: string;
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
    cacheSeededRef.current = true; // 최초 렌더 1회만 — 구버전 '합본 한 키' 캐시를 프로젝트별 키로 이관
    // (합본 키는 큰 폴더 하나가 3MB 상한을 넘기면 '모든' 프로젝트 캐시가 같이 비워지는 문제가 있었다.)
    // ★검증 후 삭제: localStorage quota 초과는 조용히 삼켜지므로, 프로젝트별 키가 실제로 저장됐는지
    //  읽어서 대조한 뒤에만 합본 키를 비운다 — 실패하면 합본 키를 남겨 다음 세션 캐시를 잃지 않는다(코덱스 P2).
    const migrate = (legacyKey: string, into: Record<string, unknown>) => {
      const old = STORE.loadJSON<Record<string, unknown>>(legacyKey);
      if (!old) return;
      Object.assign(into, old);
      let allOk = true;
      for (const [p, v] of Object.entries(old)) {
        try {
          const s = JSON.stringify(v);
          if (s.length > CACHE_MAX_BYTES) continue; // 그 프로젝트만 저장 생략 — 이관 실패로 안 친다
          const k = `${legacyKey}.${p}`;
          STORE.set(k, s);
          if (STORE.get(k, "") !== s) allOk = false; // quota 초과 등 무음 실패 감지
        } catch {
          allOk = false;
        }
      }
      if (allOk) STORE.set(legacyKey, "");
    };
    migrate(TREE_CACHE_KEY, treeCacheRef.current);
    migrate(META_CACHE_KEY, metaCacheRef.current);
  }
  // 프로젝트별 키에서 필요할 때 시드(첫 접근 1회) — 창을 껐다 켜도 그 폴더 화면이 즉시 뜬다.
  const seededProjectsRef = useRef<Set<string>>(new Set());
  const seedProject = (p: string) => {
    if (seededProjectsRef.current.has(p)) return;
    seededProjectsRef.current.add(p);
    if (!(p in treeCacheRef.current)) {
      const t = STORE.loadJSON<AssetNode[]>(`${TREE_CACHE_KEY}.${p}`);
      if (t) treeCacheRef.current[p] = t;
    }
    if (!(p in metaCacheRef.current)) {
      const m = STORE.loadJSON<Record<string, AssetMeta>>(`${META_CACHE_KEY}.${p}`);
      if (m) metaCacheRef.current[p] = m;
    }
  };
  const projectRef = useRef(project); // 최신 선택 프로젝트 — 느린 응답이 돌아와도 딴 프로젝트를 덮지 않게
  projectRef.current = project;

  const reloadProjects = useCallback((keepCurrent = false) => {
    api
      .assetProjects(workspaceId)
      .then((info) => {
        setProjects((prev) => reconcileArrayState(prev, info.projects));
        setProject((current) => {
          // 워크스페이스를 옮기면 이전 팀 폴더는 목록에서 빠진다 — 그때는 저장된 선택도
          // 되살리지 않고 새 목록의 기본값으로 내려간다(남의 팀 폴더에 머무르지 않게).
          if (keepCurrent && current && info.projects.includes(current)) return current;
          const saved = STORE.get("project", "");
          return saved && info.projects.includes(saved) ? saved : info.default;
        });
      })
      .catch((err) => setError(String(err)));
  }, [workspaceId]);

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
    seedProject(targetProject);
    const cached = metaCacheRef.current[targetProject];
    // 캐시 즉시 표시는 '지금 보고 있는' 프로젝트일 때만 — 아니면 미러 이펙트가 현재 프로젝트 캐시를 오염시킨다.
    if (cached && projectRef.current === targetProject) {
      setMeta((prev) => reconcileRecordState(prev, cached));
    }
    try {
      const fresh = await api.assetMeta(targetProject);
      metaCacheRef.current[targetProject] = fresh; // 어느 프로젝트든 fresh 는 캐시(다음 방문 즉시)
      persistCache(`${META_CACHE_KEY}.${targetProject}`, fresh); // 프로젝트별 키 — 창 닫아도 살아남게
      if (projectRef.current === targetProject) {
        // API가 매번 새 객체를 반환해도 내용이 같으면 526개 파일 화면을 다시 계산·렌더하지 않는다.
        setMeta((prev) => reconcileRecordState(prev, fresh));
      }
    } catch {
      if (!cached && projectRef.current === targetProject) {
        setMeta((prev) => reconcileRecordState(prev, {}));
      }
    }
  }, [project]);

  const reloadTree = useCallback(async (targetProject = project, fresh = false) => {
    if (!targetProject) return;
    seedProject(targetProject);
    const isCurrent = () => projectRef.current === targetProject;
    const cached = treeCacheRef.current[targetProject];
    // 화면(setTree/로딩)은 '지금 보고 있는' 프로젝트일 때만 건드린다 — 아니면 미러 이펙트가 현재 프로젝트
    //  캐시를 다른 프로젝트 트리로 오염시킨다. (백그라운드 fetch 로 캐시 갱신은 아래에서 계속 수행)
    if (isCurrent()) {
      if (cached) {
        setTree((prev) => reconcileArrayState(prev, cached)); // 캐시 있으면 즉시 표시(로딩 화면 없음)
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
      persistCache(`${TREE_CACHE_KEY}.${targetProject}`, nextTree.children); // 프로젝트별 키
      if (isCurrent()) {
        // 새 트리 객체라도 파일·버전·계층이 같으면 현재 화면 참조를 유지한다.
        setTree((prev) => reconcileArrayState(prev, nextTree.children));
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

  return {
    error,
    loading,
    meta,
    project,
    projects,
    refreshProjectData,
    reloadMeta,
    reloadProjects,
    reloadTree,
    setMeta,
    setProject,
    setTree,
    tree,
  };
}
