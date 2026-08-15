// 에셋 버전 갱신 공용 실행기 — SceneBoard 와 SpotlightPrompt 에 85줄씩 복붙돼 있던
// "프로젝트별 in-flight 중복 억제 → assetTree 조회 → 버전표 반영 → 해제" 블록의 단일 정의.
// (실제로 한쪽에만 폴백이 붙는 식으로 어긋나기 시작해 통합 — 트리거(초기/포커스/실시간)와
//  프로젝트 수집은 각 컴포넌트의 문맥이 달라 그대로 남긴다.)
import { api } from "../api";
import { ingestAssetTreeVersions } from "./assetVersions";

export interface RefLike {
  file_path?: string | null;
}

// refs 목록에서 asset: 참조가 가리키는 프로젝트 집합을 뽑는다.
// only 가 비어 있지 않으면 그 목록에 든 프로젝트만(실시간 신호의 '변경된 것만' 필터).
export function assetProjectsFromRefs(
  refs: Iterable<RefLike>,
  only?: string[],
): Set<string> {
  const limit = only && only.length ? new Set(only) : null;
  const projs = new Set<string>();
  for (const r of refs) {
    if (!r.file_path?.startsWith("asset:")) continue;
    const proj = r.file_path.slice(6).split("|")[0];
    if (proj && (!limit || limit.has(proj))) projs.add(proj);
  }
  return projs;
}

interface RefreshDeps {
  fetchTree: (project: string, fresh: boolean) => Promise<{ children?: unknown[] }>;
  ingest: (project: string, children: unknown[]) => void;
}

const defaultDeps: RefreshDeps = {
  fetchTree: (project, fresh) => api.assetTree(project, fresh),
  ingest: (project, children) =>
    ingestAssetTreeVersions(project, children as Parameters<typeof ingestAssetTreeVersions>[1]),
};

// 프로젝트별 1-in-flight 로 assetTree 를 읽어 전역 버전표를 갱신한다.
// fresh=true 는 서버 캐시를 건너뛰는 강제 재탐색(초기/포커스 안전망), false 는
// 실시간 신호용(무효화된 캐시 재사용). 조회 실패는 무시 — 다음 신호/포커스에서 재시도.
export function runAssetVersionRefresh(
  projects: Iterable<string>,
  inFlight: Set<string>,
  fresh: boolean,
  deps: RefreshDeps = defaultDeps,
): void {
  for (const proj of projects) {
    if (inFlight.has(proj)) continue;
    inFlight.add(proj);
    deps
      .fetchTree(proj, fresh)
      .then((tree) => deps.ingest(proj, tree.children || []))
      .catch(() => {
        /* 조회 실패는 무시(다음 신호/포커스에서 재시도) */
      })
      .finally(() => inFlight.delete(proj));
  }
}

// 창 복귀(포커스/가시성) 안전망 리스너 — 30초 스로틀. effect 에서 호출하고 반환값을
// cleanup 으로 쓴다. (SceneBoard·SpotlightPrompt 가 같은 리스너를 각자 구현하던 것.)
export function addFocusRefreshListener(refresh: () => void, throttleMs = 30_000): () => void {
  let lastAt = 0;
  const onFocus = () => {
    if (document.hidden) return;
    const now = Date.now();
    if (now - lastAt < throttleMs) return;
    lastAt = now;
    refresh();
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onFocus);
  return () => {
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onFocus);
  };
}
