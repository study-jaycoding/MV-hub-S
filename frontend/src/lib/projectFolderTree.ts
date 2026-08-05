import { loadJSON, saveJSON } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";
import { normalizeFolderPath } from "./folderTreeModel";
import type { ProjectFolderLink, ProjectFolderNode, ProjectFolderState } from "../types";

export type ProjectFolderEntry = ProjectFolderLink & Partial<ProjectFolderState>;

const FOLDER_EXPANSION_STORAGE_VERSION = 2;
export const PROJECT_FOLDER_INITIAL_VISIBLE_LIMIT = 250;

interface StoredProjectFolderExpansion {
  version: number;
  projects: Record<string, string[]>;
}

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
    const stored = loadJSON<StoredProjectFolderExpansion>(STORAGE_KEYS.projectFolderExpanded);
    // v1은 모든 폴더를 자동 확장해 저장했다. 큰 트리 지연을 되살리지 않도록 한 번 폐기하고 v2로 시드한다.
    if (
      !stored ||
      stored.version !== FOLDER_EXPANSION_STORAGE_VERSION ||
      !stored.projects ||
      typeof stored.projects !== "object"
    ) {
      return {};
    }
    const out: Record<string, Set<string>> = Object.create(null) as Record<string, Set<string>>;
    for (const [projectId, paths] of Object.entries(stored.projects)) {
      out[projectId] = new Set(Array.isArray(paths) ? paths.map(String) : []);
    }
    return out;
  } catch {
    return {};
  }
}

export function saveProjectFolderExpansion(value: Record<string, Set<string>>) {
  try {
    const projects: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
    for (const [projectId, paths] of Object.entries(value)) projects[projectId] = [...paths];
    saveJSON(STORAGE_KEYS.projectFolderExpanded, {
      version: FOLDER_EXPANSION_STORAGE_VERSION,
      projects,
    });
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
  const pending = [...nodes];
  while (pending.length) {
    const node = pending.pop()!;
    const children = node.children || [];
    if (children.length > 0) out.add(node.path);
    pending.push(...children);
  }
  return out;
}

function countProjectFolderNodes(nodes: ProjectFolderNode[]): number {
  let count = 0;
  const pending = [...nodes];
  while (pending.length) {
    const node = pending.pop()!;
    count += 1;
    pending.push(...(node.children || []));
  }
  return count;
}

/**
 * Choose the first expansion state without rendering an entire large tree at once.
 * Small trees keep the old all-open behavior. Large trees open one level only when that still
 * fits the visible-row budget, plus the ancestor chain required to reveal the last selection.
 */
export function initialProjectFolderExpansion(
  nodes: ProjectFolderNode[],
  selectedPath = "",
  visibleLimit = PROJECT_FOLDER_INITIAL_VISIBLE_LIMIT,
): Set<string> {
  const expandable = collectExpandableProjectFolders(nodes);
  if (countProjectFolderNodes(nodes) <= visibleLimit) return expandable;

  const expanded = new Set<string>();
  const firstLevelRows =
    nodes.length + nodes.reduce((count, node) => count + (node.children?.length || 0), 0);
  if (firstLevelRows <= visibleLimit) {
    for (const node of nodes) {
      if (node.children?.length) expanded.add(node.path);
    }
  }

  const segments = normalizeFolderPath(selectedPath).split("/").filter(Boolean);
  for (let depth = 1; depth < segments.length; depth += 1) {
    const ancestor = segments.slice(0, depth).join("/");
    if (expandable.has(ancestor)) expanded.add(ancestor);
  }
  return expanded;
}
