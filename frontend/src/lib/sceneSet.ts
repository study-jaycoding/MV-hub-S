import type { SceneSetFolder } from "./scenes";

const MAX_SET_TAGS = 32;
const MAX_TAG_LENGTH = 64;

// Set 노드 태그 입력은 쉼표/줄바꿈으로 구분한다. 사용자가 익숙하게 #을 붙여도
// 생성물의 일반 등록 태그에는 이름만 전달하고, 같은 태그는 한 번만 보낸다.
export function parseSceneSetTags(raw: string | undefined): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const part of (raw || "").split(/[,\n\r]+/)) {
    const tag = part.trim().replace(/^#+/, "").trim().slice(0, MAX_TAG_LENGTH);
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    found.push(tag);
    if (found.length >= MAX_SET_TAGS) break;
  }
  return found;
}

function normalizeFolder(value: unknown): SceneSetFolder | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<SceneSetFolder>;
  const projectId = typeof source.projectId === "string" ? source.projectId.trim() : "";
  const projectName = typeof source.projectName === "string" ? source.projectName.trim() : "";
  const path = typeof source.path === "string"
    ? source.path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
    : "";
  const segments = path.split("/").filter(Boolean);
  if (!projectId || !segments.length || segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  return { projectId, ...(projectName ? { projectName } : {}), path: segments.join("/") };
}

export function encodeSceneFolderDrag(folder: SceneSetFolder): string {
  const normalized = normalizeFolder(folder);
  return normalized ? JSON.stringify(normalized) : "";
}

export function parseSceneFolderDrag(raw: string): SceneSetFolder | null {
  if (!raw) return null;
  try {
    return normalizeFolder(JSON.parse(raw));
  } catch {
    return null;
  }
}
