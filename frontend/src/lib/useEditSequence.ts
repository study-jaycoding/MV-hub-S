// 편집 탭의 조회 — 프로젝트·폴더 트리와, 한 시퀀스 폴더에 공유된 생성물 전부.
// 모집단 = '공유 & 리뷰' 탭이 자동 범위(지금 워크스페이스)에서 필터 없이 그 폴더에 보여 주는 것(일반 공유·보류·최종).
// 그 탭의 '전체 보기'처럼 allWorkspaces 를 켜면 워크스페이스 조건 없이 묻는다(워크스페이스를 못 정한 계정의 출구).
// 계약은 docs/EDIT_TAB.md.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { api, GEN_PAGE, type GenCursor } from "../api";
import type { FolderReviewCounts, Generation, GenQuery, Project, WorkspaceContext } from "../types";
import { isUsableGen } from "./editTimeline";
import { freshItemsInScope } from "./folderContextMenu";
import { buildFolderCountTree, type FolderCountTreeNode } from "./folderTreeModel";
import { t } from "./i18n";
import { matchesWorkspaceFilter, sharedWorkspaceFilter, workspaceViewKey } from "./libraryWorkspaceScope";
import type { TeamFreshItem } from "./projectApi";
import { visibleProjectFolderRoots } from "./projectFolderTree";
import { getTeamBase, getTeamSeenVersion, isAckedFor, subscribeTeamSeen } from "./teamSeen";

export const EDIT_LIST_CAP = 2000; // ponytail: 시퀀스 하나에 이보다 많으면 '최대 2,000건 표시' — 넘는 팀이 생기면 컷 단위 조회로

// 워크스페이스가 확인돼야 공유 목록을 묻는다(공유 & 리뷰 탭과 같은 조건).
export function editWorkspaceReady(workspace: WorkspaceContext): boolean {
  return workspace.scope === "personal" || (workspace.scope === "team" && !!workspace.id);
}

const errorText = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^Error:\s*/, "");

// ── 공유 생성물 ─────────────────────────────────────────────────────────────────────────────────

export type EditListState = "idle" | "loading" | "ok" | "error" | "capped";
export interface EditList {
  state: EditListState;
  gens: Generation[]; // 쓸 수 있는 것만(완료 + 영상/이미지)
  error: string | null;
  complete: boolean; // 끝까지 받았다 — 여기 없는 클립은 '없음'으로 판정해도 된다
  // 지금 든 gens 가 이 문맥을 끝까지 받은 결과다 — gens 로 '빈 폴더'를 가려도 된다. 다시 받는 동안·실패한 뒤에도 남는다
  // (그동안 gens 는 마지막으로 끝까지 받은 것 그대로다. complete 와 달리 내려가지 않아, 빈 폴더 숨기기가 새로 고칠 때마다
  //  출렁이지 않는다). 잘린 결과(capped)로 바뀌면 거짓이다.
  known: boolean;
}

const EMPTY_LIST: EditList = { state: "idle", gens: [], error: null, complete: false, known: false };

export function useEditGenerations({
  authKey,
  workspace,
  projectId,
  seq,
  allWorkspaces = false,
}: {
  authKey: string; // 계정·서버 — 바뀌면 받던 응답을 버린다
  workspace: WorkspaceContext;
  projectId: string | null;
  seq: string | null;
  allWorkspaces?: boolean;
}): EditList & { reload: () => void } {
  const ready = !!projectId && !!seq && (allWorkspaces || editWorkspaceReady(workspace));
  const ctx = JSON.stringify([authKey, workspaceViewKey(workspace), allWorkspaces, projectId, seq]);
  const [held, setHeld] = useState<{ ctx: string } & EditList>({ ctx: "", ...EMPTY_LIST });
  const [nonce, reload] = useReducer((n: number) => n + 1, 0);
  const runRef = useRef(0);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  useEffect(() => {
    const run = ++runRef.current;
    if (!ready) return;
    const alive = () => run === runRef.current;
    // 같은 문맥의 마지막 성공 결과는 다시 받는 동안에도, 실패해도 그대로 둔다.
    // 다만 다시 받는 동안은 '끝까지 받음'이 아니다 — 그 사이 여기 없는 클립을 '없음'으로 판정하지 않는다.
    setHeld((prev) => (prev.ctx === ctx ? { ...prev, state: "loading", complete: false } : { ctx, ...EMPTY_LIST, state: "loading" }));
    void (async () => {
      const query: GenQuery = {
        tab: "team", ...(allWorkspaces ? {} : sharedWorkspaceFilter(workspaceRef.current)),
        project_id: projectId!, folder_path: seq!,
      };
      const gens: Generation[] = [];
      let cursor: GenCursor | null = null;
      let rows = 0;
      let capped = false;
      for (;;) {
        const page = await api.listGenerations(query, cursor);
        if (!alive()) return; // 문맥이 바뀌었다 — 다음 쪽을 묻지 않는다
        rows += page.length;
        gens.push(...page.filter((gen) => isUsableGen(gen) && matchesWorkspaceFilter(gen, query)));
        // 커서와 끝 판정은 거르기 전 원본 쪽으로 — 쓸 수 있는 것이 0개인 쪽에서 멈추면 뒤가 통째로 빠진다.
        const last = page[page.length - 1];
        if (!last || page.length < GEN_PAGE) break;
        if (rows >= EDIT_LIST_CAP) {
          capped = true;
          break;
        }
        cursor = { ts: last.sort_ts ?? 0, id: last.id };
      }
      // known 은 **지금 든 gens** 가 온전한가다 — 잘린 결과로 바꿔 넣었으면 전에 끝까지 받았더라도 거짓이다
      //  (뒤로 밀려 빠진 카드만 있는 폴더를 '빈 폴더'로 숨기게 된다 — Codex 코드 리뷰).
      setHeld({ ctx, state: capped ? "capped" : "ok", gens, error: null, complete: !capped, known: !capped });
    })().catch((error) => {
      if (!alive()) return;
      setHeld((prev) => ({
        ctx, state: "error", error: errorText(error),
        gens: prev.ctx === ctx ? prev.gens : [], complete: false, known: prev.ctx === ctx && prev.known,
      }));
    });
    return () => {
      runRef.current++;
    };
  }, [ctx, ready, projectId, seq, allWorkspaces, nonce]);

  const list = !ready ? EMPTY_LIST : held.ctx === ctx ? held : { ...EMPTY_LIST, state: "loading" as const };
  return { state: list.state, gens: list.gens, error: list.error, complete: list.complete, known: list.known, reload };
}

// ── 프로젝트·폴더 트리 ──────────────────────────────────────────────────────────────────────────

export interface EditTree {
  state: "idle" | "loading" | "ready" | "error";
  roots: FolderCountTreeNode[];
  // 디스크 트리와 팀 개수를 둘 다 온전히 받았다 — false 면 '하위 폴더 없음'을 믿지 않는다.
  complete: boolean;
  note: string | null; // 화면에 그대로 알릴 문구(실패·잘림)
}

const EMPTY_TREE: EditTree = { state: "idle", roots: [], complete: false, note: null };

// 받은 그대로 든다 — 폴더 옆 표시(새 항목 +N)가 바뀔 때 트리를 다시 받지 않고 다시 엮기만 한다.
//  counts = null 이면 개수 조회에 실패했다(디스크 폴더만 보인다). review = null 이면 서버가 상태별 개수를 주지 않는다.
interface TreeData {
  state: EditTree["state"];
  disk: FolderCountTreeNode[];
  counts: Record<string, number> | null;
  review: Record<string, FolderReviewCounts> | null;
  complete: boolean;
  note: string | null;
}
const EMPTY_DATA: TreeData = { state: "idle", disk: [], counts: null, review: null, complete: false, note: null };

// 공유 & 리뷰 사이드바와 같은 조회 — 폴더별 개수와 상태별(최종·보류) 개수가 한 응답에 온다.
const fetchFolderCounts = (projectId: string) =>
  api.projectFolderCountsBatch([projectId], "team").then(
    (r) => ({ counts: r.counts?.[projectId] ?? {}, review: r.review_counts?.[projectId] ?? null }),
    () => null,
  );

export function useEditProjects({
  authKey,
  workspace,
  projectId,
}: {
  authKey: string;
  workspace: WorkspaceContext;
  projectId: string | null;
}): {
  projects: Project[];
  projectsState: "loading" | "ok" | "error";
  tree: EditTree;
  reload: () => void;
  // 폴더 옆 숫자(개수·최종·보류·새 항목)만 다시 받는다 — 디스크 폴더는 다시 읽지 않고, 받는 동안 트리를 치우지도 않는다.
  reloadCounts: () => void;
  freshByProject: Record<string, number>; // 프로젝트 행의 +N(마지막 확인 이후 새로 공유된 것)
} {
  const [nonce, reload] = useReducer((n: number) => n + 1, 0);
  const workspaceId = workspace.scope === "team" ? workspace.id || undefined : undefined;
  const listCtx = JSON.stringify([authKey, workspaceId ?? null]);
  // linked = 폴더가 연결된 프로젝트. null = 연결 조회에 실패해 모른다(연결 없음으로 치지 않는다).
  const [listed, setListed] = useState<{ ctx: string; state: "loading" | "ok" | "error"; projects: Project[]; linked: Set<string> | null }>(
    { ctx: "", state: "loading", projects: [], linked: null },
  );

  // 프로젝트 목록이 성공한 뒤에 폴더 연결을 읽는다 — 로컬 허브는 목록 조회 때 서버의 프로젝트 정의를 받아 둔다.
  useEffect(() => {
    let alive = true;
    setListed((prev) => (prev.ctx === listCtx ? prev : { ctx: listCtx, state: "loading", projects: [], linked: null }));
    void (async () => {
      const { projects } = await api.projects("team", false, workspaceId);
      const links = await api.projectFolderLinks().then((r) => r.links, () => null);
      if (alive) setListed({ ctx: listCtx, state: "ok", projects, linked: links ? new Set(Object.keys(links)) : null });
    })().catch(() => {
      if (alive) setListed((prev) => ({ ...prev, ctx: listCtx, state: "error" }));
    });
    return () => {
      alive = false;
    };
  }, [listCtx, workspaceId, nonce]);

  const listOk = listed.ctx === listCtx && listed.state === "ok";
  const linksKnown = listed.linked !== null;
  const isLinked = !!projectId && !!listed.linked?.has(projectId);
  const treeCtx = JSON.stringify([listCtx, projectId, isLinked, linksKnown]);
  const [tree, setTree] = useState<{ ctx: string } & TreeData>({ ctx: "", ...EMPTY_DATA });
  const countRun = useRef(0); // 개수 조회의 순번 — 늦게 온 옛 응답이 새 숫자를 덮지 않게

  useEffect(() => {
    if (!projectId || !listOk) return;
    let alive = true;
    countRun.current++; // 먼저 떠난 '숫자만 다시 받기'의 응답은 버린다 — 이 조회가 더 새 숫자를 가져온다
    setTree((prev) => (prev.ctx === treeCtx ? { ...prev, state: "loading" } : { ctx: treeCtx, ...EMPTY_DATA, state: "loading" }));
    void (async () => {
      const [folder, counted] = await Promise.all([
        isLinked ? api.projectFolder(projectId).catch(() => null) : Promise.resolve(undefined),
        fetchFolderCounts(projectId),
      ]);
      if (!alive) return;
      const disk = folder?.tree && !folder.error ? visibleProjectFolderRoots(folder.tree) : [];
      const diskOk = linksKnown && (folder === undefined || (!!folder && !folder.error && !folder.truncated));
      const note =
        !linksKnown || folder === null || folder?.error ? t("폴더 정보를 불러오지 못했습니다 — 공유 기록에 있는 폴더만 보입니다.")
          : folder?.truncated ? t("폴더가 많아 일부만 읽었습니다.")
            : counted === null ? t("공유 기록의 폴더를 확인하지 못했습니다 — 이 PC 에서 보이는 폴더만 보입니다.") : null;
      if (!disk.length && counted === null) {
        setTree({ ctx: treeCtx, ...EMPTY_DATA, state: "error", note: t("폴더 정보를 불러오지 못했습니다.") });
        return;
      }
      setTree({
        ctx: treeCtx, state: "ready", note, complete: diskOk && counted !== null, disk,
        counts: counted?.counts ?? null, review: counted?.review ?? null,
      });
    })();
    return () => {
      alive = false;
    };
  }, [treeCtx, projectId, isLinked, linksKnown, listOk, nonce]);

  // 새 항목(+N) — 공유 & 리뷰 사이드바와 같은 원천(기준선 이후 공유된 목록)에서 확인(클릭)한 것을 뺀다. 기준선은 공유 &
  //  리뷰에 처음 들어갈 때 생긴다 — 없으면 묻지 않는다. 구버전 서버(라우트 없음)·실패는 배지만 숨긴다.
  const [fresh, setFresh] = useState<{ ctx: string; items: TeamFreshItem[] }>({ ctx: "", items: [] });
  const live = useRef({ listCtx, treeCtx, projectId, loadFresh: () => {} });
  const loadFresh = useCallback(() => {
    const since = getTeamBase();
    if (!since) return;
    const put = (items: TeamFreshItem[]) => {
      if (live.current.listCtx === listCtx) setFresh({ ctx: listCtx, items }); // 계정·공간이 바뀐 뒤에 온 응답은 버린다
    };
    api.teamFreshAll(since, listCtx).then(put, () => put([]));
  }, [listCtx]);
  useEffect(loadFresh, [loadFresh, nonce]);
  live.current = { listCtx, treeCtx, projectId, loadFresh };
  const reloadCounts = useCallback(() => {
    const { treeCtx: ctx, projectId: pid } = live.current;
    live.current.loadFresh();
    if (!pid) return;
    const run = ++countRun.current;
    void fetchFolderCounts(pid).then((counted) => {
      // 실패하면 마지막으로 받은 숫자를 그대로 둔다. 문맥이 바뀌었거나 더 새 조회가 떠났으면 버린다.
      if (!counted || run !== countRun.current) return;
      setTree((prev) => (prev.ctx === ctx && prev.state === "ready" ? { ...prev, ...counted } : prev));
    });
  }, []);

  // 확인(카드 클릭)할 때마다 스토어가 바뀐다 — 그 자리에서 +N 이 줄어든다.
  const seenVersion = useSyncExternalStore(subscribeTeamSeen, getTeamSeenVersion);
  const unseen = useMemo(() => {
    void seenVersion;
    const byProject: Record<string, number> = {};
    const folders: Record<string, number> = {};
    if (fresh.ctx !== listCtx) return { byProject, folders };
    for (const item of fresh.items) {
      if (!item.project_id || isAckedFor(item.ack_key || item.id, item.shared_at)) continue;
      byProject[item.project_id] = (byProject[item.project_id] || 0) + 1;
    }
    for (const item of projectId ? freshItemsInScope(fresh.items, projectId, "", isAckedFor) : []) {
      if (item.folder_path) folders[item.folder_path] = (folders[item.folder_path] || 0) + 1;
    }
    return { byProject, folders };
  }, [fresh, listCtx, projectId, seenVersion]);

  const projects = listed.ctx === listCtx ? listed.projects : [];
  const shownTree = useMemo<EditTree>(() => {
    if (!projectId) return EMPTY_TREE;
    if (tree.ctx !== treeCtx) return { ...EMPTY_TREE, state: "loading" };
    return {
      state: tree.state, complete: tree.complete, note: tree.note,
      // 개수를 못 받았으면 디스크 폴더만(상태별 개수도 붙이지 않는다). review 가 null 이면 '전체 N'으로 보인다(구버전 서버).
      roots: tree.counts ? buildFolderCountTree(tree.disk, tree.counts, unseen.folders, tree.review) : buildFolderCountTree(tree.disk),
    };
  }, [projectId, tree, treeCtx, unseen.folders]);
  return {
    projects,
    projectsState: listed.ctx === listCtx ? listed.state : "loading",
    tree: shownTree,
    reload,
    reloadCounts,
    freshByProject: unseen.byProject,
  };
}

// 트리에서 폴더를 찾는다(경로 → 노드).
export function findFolder(roots: FolderCountTreeNode[], path: string): FolderCountTreeNode | null {
  const pending = [...roots];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.path === path) return node;
    if (node.children) pending.push(...node.children);
  }
  return null;
}

export function allFolderPaths(roots: FolderCountTreeNode[]): string[] {
  const out: string[] = [];
  const pending = [...roots];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.path) out.push(node.path);
    if (node.children) pending.push(...node.children);
  }
  return out;
}
