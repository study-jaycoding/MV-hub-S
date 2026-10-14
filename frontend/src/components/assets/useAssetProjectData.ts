import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../../api";
import { ingestAssetTreeVersions } from "../../lib/assetVersions";
import { reconcileArrayState, reconcileRecordState } from "../../lib/stateReconciliation";
import { makeStore } from "../../lib/storage";
import type { AssetMeta, AssetNode } from "../../types";

const STORE = makeStore("ch.assets.");
const TREE_CACHE_KEY = "treecache";
const META_CACHE_KEY = "metacache";
const CACHE_MAX_BYTES = 3_000_000; // localStorage 안전 상한(대략) — 넘으면 저장 생략(다음 세션은 다시 fetch)
// 비울 때 넣는 고정 빈 값 — 매번 새 {}·[] 를 만들면 아래의 '다시 계산되는 갱신'과 같은 되먹임에 끼어든다(조작 규칙 54).
const EMPTY_TREE: AssetNode[] = [];
const EMPTY_META: Record<string, AssetMeta> = {};

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
  // PM 프로젝트에 연결된(자동 마운트) 이름 — 드롭다운에서 라임색으로 구분 표시.
  const [linkedProjects, setLinkedProjects] = useState<Set<string>>(new Set());
  const [project, setProject] = useState("");
  const [tree, setTree] = useState<AssetNode[]>([]);
  const [meta, setMeta] = useState<Record<string, AssetMeta>>({});
  // 화면의 meta 를 **받아 온** 폴더(캐시든 서버든) — 지금 폴더와 다르면 아직 이 폴더의 메타를 모른다. 빈 메타 {} 와 '아직 못 받음'을 가른다:
  //  못 받은 채로 태그를 고치면 기존 태그를 모르는 목록이 통째로 저장돼 지워진다(조작 규칙 45 — 아래 metaReady).
  const [metaFor, setMetaFor] = useState("");
  // 화면의 tree 를 받아 온 폴더(캐시든 서버든) — 아래 return 에서 '지금 폴더의 것일 때만' 내보내는 가림의 열쇠. ref(treeProjectRef)가 아니라 state 인 까닭:
  //  받아 둔 폴더로 돌아갈 때 setTree 는 같은 내용이면 건너뛰므로(bail-out) ref 만 바뀌면 가린 빈 화면이 그대로 남을 수 있다 — state 는 바뀌면 반드시 다시 그린다.
  const [treeFor, setTreeFor] = useState("");
  const [loading, setLoading] = useState(false);
  // 폴더 목록과 파일 트리의 오류는 따로 — 한 칸을 같이 쓰면 트리가 성공할 때 풀리지 않은 목록 오류까지 지웠다(60회차). 화면에는 남은 것을 보인다.
  const [projectsError, setProjectsError] = useState<string | null>(null);
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
  // 화면의 tree/meta 를 **함수형 갱신(prev => …) 없이** 바꾼다(조작 규칙 54 — 27회차 실측 M02, Assets 창이 React #185 로 깨짐): 같은 값이라
  //  버려진(밀린) 갱신이 큐에 남아 있으면 React 는 뒤의 함수형 갱신을 **렌더마다 그 위에서 다시 계산**한다 — reconcile 은 내용이 다르면 매번
  //  새 객체를 돌려주니 meta 참조가 커밋마다 바뀌고 → files 새 배열 → 선택 정리 레이아웃 효과 → 동기 재렌더 → 반복. 지금 상태(ref)로 한 번만
  //  계산한 고정 객체를 넣는다(다시 계산돼도 같은 객체). 두 폴더 메타가 모두 비어 있을 때만 안 깨진 것이 그 증거(같은 참조라 끊긴다).
  const treeStateRef = useRef(tree);
  treeStateRef.current = tree;
  const metaStateRef = useRef(meta);
  metaStateRef.current = meta;
  // 지금 화면의 tree/meta 가 '어느 프로젝트' 것인지 — 미러 이펙트의 캐시 키. projectRef(=지금 렌더의
  //  프로젝트)로 미러하면, A 를 그리는 중 선택이 B 로 바뀐 렌더에서 이펙트가 돌 때 A 트리가 B 키에 박힌다.
  const treeProjectRef = useRef("");
  const metaProjectRef = useRef("");

  // 목록 조회의 순번 — 팀을 잇달아 바꾸면(B → C) 늦게 온 B 의 목록이 C 의 화면을 덮고, 그 기본 폴더로 선택까지 옮겼다(조작 규칙 40).
  //  가장 나중에 보낸 조회의 응답만 받는다(성공·실패 모두).
  const projectsSeqRef = useRef(0);
  const reloadProjects = useCallback((keepCurrent = false) => {
    const seq = ++projectsSeqRef.current;
    api
      .assetProjects(workspaceId)
      .then((info) => {
        if (seq !== projectsSeqRef.current) return;
        setProjectsError(null);
        setProjects((prev) => reconcileArrayState(prev, info.projects));
        setLinkedProjects(new Set(info.linked || []));
        setProject((current) => {
          // 워크스페이스를 옮기면 이전 팀 폴더는 목록에서 빠진다 — 그때는 저장된 선택도
          // 되살리지 않고 새 목록의 기본값으로 내려간다(남의 팀 폴더에 머무르지 않게).
          if (keepCurrent && current && info.projects.includes(current)) return current;
          const saved = STORE.get("project", "");
          return saved && info.projects.includes(saved) ? saved : info.default;
        });
      })
      .catch((err) => {
        if (seq === projectsSeqRef.current) setProjectsError(String(err));
      });
  }, [workspaceId]);

  // 화면의 tree/meta 가 바뀔 때마다(reload·드롭임포트·메타편집 등 어떤 경로든) 현재 프로젝트 캐시에 미러링
  //  → 직접 setter 로 편집해도 캐시가 어긋나지 않는다(다른 폴더 갔다 와도 최신 반영).
  useEffect(() => {
    if (treeProjectRef.current) treeCacheRef.current[treeProjectRef.current] = tree;
  }, [tree]);
  useEffect(() => {
    if (metaProjectRef.current) metaCacheRef.current[metaProjectRef.current] = meta;
  }, [meta]);

  /** 메타를 서버에서 다시 받는다. 돌려주는 값 = 받았는가 — 저장 실패 뒤 '서버 값으로 되돌렸다'고 알리는 쪽이 정말 되돌렸는지 본다(조작 규칙 41). */
  const reloadMeta = useCallback(async (targetProject = project): Promise<boolean> => {
    if (!targetProject) return false;
    seedProject(targetProject);
    const cached = metaCacheRef.current[targetProject];
    // 캐시 즉시 표시는 '지금 보고 있는' 프로젝트일 때만 — 아니면 미러 이펙트가 현재 프로젝트 캐시를 오염시킨다.
    if (cached && projectRef.current === targetProject) {
      metaProjectRef.current = targetProject; // 화면에 올리는 meta 의 소속을 함께 기록(미러 이펙트 짝)
      setMeta(reconcileRecordState(metaStateRef.current, cached));
      setMetaFor(targetProject);
    } else if (projectRef.current === targetProject && metaProjectRef.current !== targetProject) {
      // 처음 여는 폴더 — 화면에 남은 것은 **앞 폴더의** 메타다. 응답을 기다리는 동안 그대로 두면 앞 폴더의 태그·색이 이 폴더의 것처럼
      //  보이고 고쳐진다(아래 reloadTree 의 같은 자리). 소속 표시를 먼저 비운다 — 빈 값이 미러 이펙트를 타고 앞 폴더의 캐시에 적히지 않게.
      metaProjectRef.current = "";
      if (Object.keys(metaStateRef.current).length) setMeta(EMPTY_META);
    }
    try {
      const fresh = await api.assetMeta(targetProject);
      metaCacheRef.current[targetProject] = fresh; // 어느 프로젝트든 fresh 는 캐시(다음 방문 즉시)
      persistCache(`${META_CACHE_KEY}.${targetProject}`, fresh); // 프로젝트별 키 — 창 닫아도 살아남게
      if (projectRef.current === targetProject) {
        // API가 매번 새 객체를 반환해도 내용이 같으면 526개 파일 화면을 다시 계산·렌더하지 않는다.
        metaProjectRef.current = targetProject;
        setMeta(reconcileRecordState(metaStateRef.current, fresh));
        setMetaFor(targetProject);
      }
      return true;
    } catch {
      if (!cached && projectRef.current === targetProject) {
        metaProjectRef.current = targetProject;
        if (Object.keys(metaStateRef.current).length) setMeta(EMPTY_META);
      }
      return false;
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
        treeProjectRef.current = targetProject; // 화면에 올리는 tree 의 소속을 함께 기록(미러 이펙트 짝)
        setTreeFor(targetProject);
        setTree(reconcileArrayState(treeStateRef.current, cached)); // 캐시 있으면 즉시 표시(로딩 화면 없음)
        onTreeLoaded?.(cached);
        setLoading(false);
      } else {
        // 처음 여는 폴더 — 앞 폴더의 파일을 걷는다(조작 규칙 45). 그대로 두면 응답이 올 때까지(큰 폴더는 몇 초) 앞 폴더의 파일이 이 폴더의
        //  것처럼 남아 눌리고 고쳐진다: 화면의 셀·저장은 이미 이 폴더로 나가므로, 두 폴더에 같은 경로가 있으면 **앞 폴더의 태그에 새 태그를
        //  더한 목록이 이 폴더에 저장돼** 이 폴더의 태그를 덮었다(Codex 코드 리뷰). 소속 표시를 먼저 비운다 — 빈 값이 미러 이펙트를 타고
        //  앞 폴더의 캐시에 적히지 않게(같은 폴더를 받는 중에 다시 불린 것이면 건드리지 않는다).
        if (treeProjectRef.current !== targetProject) {
          treeProjectRef.current = "";
          if (treeStateRef.current.length) setTree(EMPTY_TREE);
        }
        setLoading(true);
      }
    }
    try {
      const nextTree = await api.assetTree(targetProject, fresh);
      ingestAssetTreeVersions(targetProject, nextTree.children); // 전역 버전 표 갱신(캔버스와 공유)
      treeCacheRef.current[targetProject] = nextTree.children; // 어느 프로젝트든 fresh 는 캐시
      persistCache(`${TREE_CACHE_KEY}.${targetProject}`, nextTree.children); // 프로젝트별 키
      if (isCurrent()) {
        // 새 트리 객체라도 파일·버전·계층이 같으면 현재 화면 참조를 유지한다.
        treeProjectRef.current = targetProject;
        setTreeFor(targetProject);
        setTree(reconcileArrayState(treeStateRef.current, nextTree.children));
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

  // 폴더가 바뀌면 **그리기 전에** 화면을 그 폴더의 것으로 맞춘다(useLayoutEffect — 받아 둔 것이 있으면 그것으로, 없으면 비운다). 그린 뒤에
  //  맞추면 새 폴더 이름 아래 앞 폴더의 파일·메타가 한 박자 그려지고, 그때의 조작이 새 폴더로 나간다(조작 규칙 45).
  useLayoutEffect(() => {
    if (!project) {
      // 폴더가 하나도 없는 팀으로 옮겼다 — 앞 팀 폴더의 화면을 비운다. 그냥 돌아가면 앞 폴더의 조회는 '지금 것이 아니어서' 로딩을 끄지 않고,
      //  사이드바의 '로딩…'과 앞 팀의 파일 목록이 그대로 남았다(조작 규칙 40). 화면의 소속 표시(ref)를 먼저 비운다 — 안 그러면 아래의
      //  빈 값이 미러 이펙트를 타고 앞 폴더의 캐시에 적힌다.
      treeProjectRef.current = "";
      metaProjectRef.current = "";
      if (treeStateRef.current.length) setTree(EMPTY_TREE);
      if (Object.keys(metaStateRef.current).length) setMeta(EMPTY_META);
      setError(null);
      setLoading(false);
      return;
    }
    void refreshProjectData(project);
  }, [project, refreshProjectData]);

  return {
    error: projectsError ?? error,
    loading,
    // 화면에 내보내는 tree/meta 는 **지금 폴더의 것일 때만**(규칙 45 의 남은 한 박자 — 27회차 실측): 폴더를 바꾼 첫 렌더는 '새 폴더 이름 + 앞 폴더 목록'
    //  이라 셀이 앞 폴더의 파일 이름으로 새 폴더에 썸네일을 물었다(레이아웃 효과가 캐시를 넣는 것은 그 뒤). 열쇠는 state(treeFor·metaFor) — 받은 뒤 바뀌므로
    //  가린 렌더 다음에 반드시 다시 그린다. 받기 전에 실패한 폴더는 열쇠가 앞 폴더에 남지만 그때 state 는 이미 비워져 있어 보이는 것은 같다(빈 화면).
    //  미러 effect·setTree/setMeta 는 가리지 않은 state 그대로(가린 빈 값이 캐시에 적히면 안 된다).
    //  가리는 동안 **받아 둔 캐시가 있으면 그것을** 내보낸다(없으면 빈 값): 빈 값으로 가리면 받아 둔 폴더로 돌아갈 때 빈 격자가 한 프레임 그려졌다
    //  (28회차 p6 격리 실측 — 가상 목록이 0→6 을 다음 프레임에 다시 잰다). 캐시는 그 폴더의 것이라 앞 폴더 이름이 섞일 길이 없고, 레이아웃 효과가
    //  같은 내용을 state 로 올리면 열쇠가 맞아 그대로 이어진다.
    meta: metaFor === project ? meta : (metaCacheRef.current[project] ?? EMPTY_META),
    /** 이 폴더의 메타(태그·색·소스)를 받았는가 — 받기 전에는 메타를 고치는 조작을 받지 않는다. */
    metaReady: !!project && metaFor === project,
    project,
    projects,
    linkedProjects,
    refreshProjectData,
    reloadMeta,
    reloadProjects,
    reloadTree,
    setMeta,
    setProject,
    setTree,
    tree: treeFor === project ? tree : (treeCacheRef.current[project] ?? EMPTY_TREE),
  };
}
