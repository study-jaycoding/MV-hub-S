import type { FolderReviewCounts } from "../types";

export interface FolderCountTreeNode {
  name: string;
  path: string;
  /** 이 폴더(하위 포함)에 담긴 카탈로그 생성물 수. 백엔드 트리에서는 디스크 파일 수로 들어온다. */
  count?: number | null;
  /** 디스크에 실제로 있는 파일 수. 생성물 수로 덮어쓰기 전의 원래 값을 보존한 것. */
  fileCount?: number | null;
  newCount?: number | null;
  /** undefined=기존 총계 표시, null=팀 상태 상세 미지원/불일치. */
  reviewCounts?: FolderReviewCounts | null;
  children?: FolderCountTreeNode[];
  virtual?: boolean;
}

// 스크롤 같은 임계값 판정은 전체 트리를 끝까지 세지 않는다.
// 반복문을 사용해 비정상적으로 깊은 폴더에서도 호출 스택을 소모하지 않는다.
export function hasMoreThanFolderNodes(
  nodes: FolderCountTreeNode[],
  limit: number,
): boolean {
  let count = 0;
  const pending = [...nodes];
  while (pending.length) {
    const node = pending.pop()!;
    count += 1;
    if (count > limit) return true;
    if (node.children?.length) pending.push(...node.children);
  }
  return false;
}

// 렌더 루트 상대 경로 정규화 — 백슬래시/중복슬래시/앞뒤슬래시/. .. 제거.
export function normalizeFolderPath(path: string | null | undefined): string {
  return (path || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

function normalizeFolderCounts(counts: Record<string, number>): Record<string, number> {
  // 실제 폴더명이 `constructor`/`__proto__`여도 Object.prototype과 충돌하지 않게 한다.
  const normalized: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [key, value] of Object.entries(counts)) {
    const path = normalizeFolderPath(key);
    if (path) normalized[path] = (normalized[path] || 0) + value;
  }
  return normalized;
}

// 디스크 트리에 없는 folder_path(팀원이 쓴 경로 등)를 부모 체인과 함께 가상 노드로 합성한다.
function mergeVirtualFolders(
  roots: FolderCountTreeNode[],
  counts: Record<string, number>,
): FolderCountTreeNode[] {
  const clone = (nodes: FolderCountTreeNode[]): FolderCountTreeNode[] =>
    nodes.map((node) => ({
      ...node,
      children: node.children ? clone(node.children) : node.children,
    }));
  const out = clone(roots);
  const byPath = new Map<string, FolderCountTreeNode>();
  const index = (nodes: FolderCountTreeNode[]) => {
    for (const node of nodes) {
      byPath.set(node.path, node);
      if (node.children) index(node.children);
    }
  };
  index(out);

  const ensure = (path: string): FolderCountTreeNode => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const segments = path.split("/");
    const node: FolderCountTreeNode = {
      name: segments[segments.length - 1],
      path,
      count: 0,
      children: [],
      virtual: true,
    };
    byPath.set(path, node);
    if (segments.length === 1) {
      out.push(node);
    } else {
      const parent = ensure(segments.slice(0, -1).join("/"));
      parent.children = parent.children || [];
      parent.children.push(node);
    }
    return node;
  };

  for (const path of Object.keys(counts)) ensure(path);
  return out;
}

// 정확 경로별 개수를 한 번만 부모 경로에 누적한다. 이후 각 노드는 자기 경로 O(1) 조회만 한다.
function cumulativeFolderCounts(counts: Record<string, number>): Record<string, number> {
  const cumulative: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [path, count] of Object.entries(counts)) {
    let current = path;
    while (current) {
      cumulative[current] = (cumulative[current] || 0) + count;
      const slash = current.lastIndexOf("/");
      if (slash < 0) break;
      current = current.slice(0, slash);
    }
  }
  return cumulative;
}

function overlayFolderCounts(
  nodes: FolderCountTreeNode[],
  counts: Record<string, number>,
  newCounts?: Record<string, number>,
  reviewCounts?: Record<string, FolderReviewCounts> | null,
): FolderCountTreeNode[] {
  return nodes.map((node) => ({
    ...node,
    count: counts[node.path] || 0,
    // 들어온 count 는 디스크 파일 수다(백엔드 폴더 스캔). 생성물 수로 덮기 전에 보존해,
    // '폴더엔 파일이 있는데 카탈로그엔 없다'를 화면에서 구분할 수 있게 한다.
    // 가상 폴더(디스크에 없는 folder_path)는 파일이 없으므로 0.
    fileCount: node.virtual ? 0 : node.count ?? 0,
    newCount: newCounts?.[node.path] || 0,
    reviewCounts: reviewCounts === null ? null : reviewCounts
      ? reviewCounts[node.path] ?? { final: 0, held: 0, shared: 0 } : undefined,
    children: node.children
      ? overlayFolderCounts(node.children, counts, newCounts, reviewCounts)
      : node.children,
  }));
}

// 같은 응답의 총계와 상세가 맞는 경우에만 상태를 표시한다. 누락을 일반 공유/0으로 추정하지 않는다.
function cumulativeReviewCounts(
  counts: Record<string, number>,
  reviewCounts: Record<string, FolderReviewCounts>,
): Record<string, FolderReviewCounts> | null {
  const fields = ["final", "held", "shared"] as const;
  for (const [path, total] of Object.entries(counts)) {
    const parts = Object.prototype.hasOwnProperty.call(reviewCounts, path) ? reviewCounts[path] : undefined;
    if (!parts || !fields.every((field) => Number.isSafeInteger(parts[field]) && parts[field] >= 0)
      || parts.final + parts.held + parts.shared !== total) return null;
  }
  const out: Record<string, FolderReviewCounts> = Object.create(null);
  for (const field of fields) {
    // 총계에 없는 추가 상세 키는 가상 폴더나 상태 수를 만들지 않는다.
    const values = Object.fromEntries(Object.keys(counts).map((path) => [path, reviewCounts[path][field]]));
    const totals = cumulativeFolderCounts(normalizeFolderCounts(values));
    for (const [path, count] of Object.entries(totals)) {
      (out[path] ??= { final: 0, held: 0, shared: 0 })[field] = count;
    }
  }
  return out;
}

/**
 * Add logical folders and generation badges to a disk folder tree.
 *
 * The previous component implementation scanned every count key for every node
 * (O(nodes × paths)).  This builds parent totals once, then performs O(1) lookups per node.
 */
function diskOnly(nodes: FolderCountTreeNode[]): FolderCountTreeNode[] {
  // 생성물 수를 아직 모르는 상태(조회 전). 디스크 파일 수만 알려주고 생성물 수는 비워 둔다 —
  // 여기서 파일 수를 생성물 수인 척 보여주면, 데이터가 도착하는 순간 숫자가 뒤집혀 보인다.
  return nodes.map((node) => ({
    ...node,
    count: null,
    fileCount: node.count ?? 0,
    children: node.children ? diskOnly(node.children) : node.children,
  }));
}

export function buildFolderCountTree(
  roots: FolderCountTreeNode[],
  counts?: Record<string, number>,
  newCounts?: Record<string, number>,
  reviewCounts?: Record<string, FolderReviewCounts> | null,
): FolderCountTreeNode[] {
  if (!counts) return diskOnly(roots);
  // counts 가 비어 있어도(이 워크스페이스에 생성물 0건) 덮어쓴다 — 예전에는 디스크 파일 수를
  // 그대로 뒀는데, 그러면 같은 자리 숫자가 '생성물 수'와 '파일 수' 사이를 오갔다.
  const normalizedCounts = normalizeFolderCounts(counts);
  const normalizedNewCounts = newCounts ? normalizeFolderCounts(newCounts) : undefined;
  const withVirtualFolders = mergeVirtualFolders(roots, normalizedCounts);
  return overlayFolderCounts(
    withVirtualFolders,
    cumulativeFolderCounts(normalizedCounts),
    normalizedNewCounts ? cumulativeFolderCounts(normalizedNewCounts) : undefined,
    reviewCounts == null ? reviewCounts : cumulativeReviewCounts(counts, reviewCounts),
  );
}
