import { loadJSON, saveJSON } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";
import type { ProjectFolderLink, ProjectFolderNode, ProjectFolderState } from "../types";

export type ProjectFolderEntry = ProjectFolderLink & Partial<ProjectFolderState>;

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
