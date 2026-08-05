import { loadJSON, saveJSON } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";
import type { ProjectFolderLink, ProjectFolderNode, ProjectFolderState } from "../types";

export type ProjectFolderEntry = ProjectFolderLink & Partial<ProjectFolderState>;

// 같은 페이지에서 작업 공간↔캔버스를 오갈 때 ProjectSection 이 서로 다른 사이드바로 재마운트된다.
// 이미 읽은 UNC 폴더 트리를 모듈 세션 캐시에 남겨, 매 전환마다 "폴더 로딩..."부터 다시 시작하지 않게 한다.
// 영구 저장은 하지 않는다. 새로고침하면 실제 디스크를 다시 읽어 오래된 폴더 구조가 고착되지 않는다.
const projectFolderSessionCache = new Map<string, ProjectFolderEntry>();

export function cachedProjectFolderEntries(projectIds: Iterable<string>): Record<string, ProjectFolderEntry> {
  const out: Record<string, ProjectFolderEntry> = {};
  for (const projectId of projectIds) {
    const entry = projectFolderSessionCache.get(projectId);
    if (entry) out[projectId] = entry;
  }
  return out;
}

export function rememberProjectFolderEntry(entry: ProjectFolderEntry): ProjectFolderEntry {
  projectFolderSessionCache.set(entry.project_id, entry);
  return entry;
}

export function rememberProjectFolderLink(link: ProjectFolderLink): ProjectFolderEntry {
  const cached = projectFolderSessionCache.get(link.project_id);
  // 같은 루트면 기존 tree 를 유지한 채 링크 메타만 최신화한다. 루트가 바뀌었으면 옛 트리를 즉시 폐기한다.
  const next = cached?.root_path === link.root_path ? { ...cached, ...link } : { ...link };
  return rememberProjectFolderEntry(next);
}

export function loadProjectFolderExpansion(): Record<string, Set<string>> {
  try {
    const obj = loadJSON<Record<string, unknown>>(STORAGE_KEYS.projectFolderExpanded) || {};
    const out: Record<string, Set<string>> = {};
    for (const [projectId, paths] of Object.entries(obj || {})) {
      out[projectId] = new Set(Array.isArray(paths) ? paths.map(String) : []);
    }
    return out;
  } catch {
    return {};
  }
}

export function saveProjectFolderExpansion(value: Record<string, Set<string>>) {
  try {
    const plain: Record<string, string[]> = {};
    for (const [projectId, paths] of Object.entries(value)) plain[projectId] = [...paths];
    saveJSON(STORAGE_KEYS.projectFolderExpanded, plain);
  } catch {
    /* ignore */
  }
}

export function visibleProjectFolderRoots(tree: ProjectFolderNode): ProjectFolderNode[] {
  if (tree.path === "" && tree.name.toLowerCase() === "render") return tree.children || [];
  return [tree];
}

export function collectExpandableProjectFolders(
  nodes: ProjectFolderNode[],
  out = new Set<string>(),
): Set<string> {
  for (const node of nodes) {
    const children = node.children || [];
    if (children.length > 0) out.add(node.path);
    collectExpandableProjectFolders(children, out);
  }
  return out;
}
