export interface FolderCountTreeNode {
  name: string;
  path: string;
  count?: number | null;
  newCount?: number | null;
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
): FolderCountTreeNode[] {
  return nodes.map((node) => ({
    ...node,
    count: counts[node.path] || 0,
    newCount: newCounts?.[node.path] || 0,
    children: node.children
      ? overlayFolderCounts(node.children, counts, newCounts)
      : node.children,
  }));
}

/**
 * Add logical folders and generation badges to a disk folder tree.
 *
 * The previous component implementation scanned every count key for every node
 * (O(nodes × paths)).  This builds parent totals once, then performs O(1) lookups per node.
 */
export function buildFolderCountTree(
  roots: FolderCountTreeNode[],
  counts?: Record<string, number>,
  newCounts?: Record<string, number>,
): FolderCountTreeNode[] {
  if (!counts) return roots;
  const normalizedCounts = normalizeFolderCounts(counts);
  if (!Object.keys(normalizedCounts).length) return roots;
  const normalizedNewCounts = newCounts ? normalizeFolderCounts(newCounts) : undefined;
  const withVirtualFolders = mergeVirtualFolders(roots, normalizedCounts);
  return overlayFolderCounts(
    withVirtualFolders,
    cumulativeFolderCounts(normalizedCounts),
    normalizedNewCounts ? cumulativeFolderCounts(normalizedNewCounts) : undefined,
  );
}
