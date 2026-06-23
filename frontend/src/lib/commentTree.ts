// 코멘트 스레드 트리 계산(부모→답글)의 공용 순수 유틸.
// 에셋 코멘트와 생성본 코멘트는 의도적으로 분리된 별개 시스템이지만, "트리를 어떻게 구성하느냐"라는
// 계산만큼은 완전히 동일했다(복붙). UI·동작·api 는 각자 두고 이 계산만 공유한다 — 분리 원칙 유지.
// id·parent_id·created_at 만 있으면 어떤 코멘트 타입이든 받는다(제네릭).

export interface CommentNode {
  id: string;
  parent_id?: string | null;
  created_at: string;
}

export interface CommentTree<T> {
  byParent: Record<string, T[]>; // parent_id("" = 루트) → 자식들
  byId: Record<string, T>;
  roots: T[]; // 최상위(부모 없음/부모 유실), 최신이 위로
  descendantsOf: (rootId: string) => T[]; // 한 루트의 모든 후손을 시간순 평탄화(들여쓰기 1단계용)
}

export function buildCommentTree<T extends CommentNode>(comments: T[]): CommentTree<T> {
  const byParent: Record<string, T[]> = {};
  const byId: Record<string, T> = {};
  for (const c of comments) {
    (byParent[c.parent_id || ""] ||= []).push(c);
    byId[c.id] = c;
  }
  const ids = new Set(comments.map((c) => c.id));
  // 최상위 코멘트는 최신이 위로(답글은 한 단계로 평탄화해 시간순)
  const roots = comments
    .filter((c) => !c.parent_id || !ids.has(c.parent_id))
    .slice()
    .reverse();
  const descendantsOf = (rootId: string): T[] => {
    const out: T[] = [];
    const collect = (pid: string) => {
      for (const k of byParent[pid] || []) {
        out.push(k);
        collect(k.id);
      }
    };
    collect(rootId);
    return out.sort((a, b) =>
      a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1,
    );
  };
  return { byParent, byId, roots, descendantsOf };
}
