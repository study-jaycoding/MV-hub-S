// 편집 탭의 조회 — 프로젝트·폴더 트리와, 한 시퀀스 폴더에 공유된 생성물 전부.
// 모집단 = '공유 & 리뷰' 탭이 자동 범위(지금 워크스페이스)에서 필터 없이 그 폴더에 보여 주는 것(일반 공유·보류·최종).
// 그 탭의 '전체 보기'처럼 allWorkspaces 를 켜면 워크스페이스 조건 없이 묻는다(워크스페이스를 못 정한 계정의 출구).
// 계약은 docs/EDIT_TAB.md.
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { api, GEN_PAGE, type GenCursor } from "../api";
import type { Generation, GenQuery, Project, WorkspaceContext } from "../types";
import { isUsableGen } from "./editTimeline";
import { buildFolderCountTree, type FolderCountTreeNode } from "./folderTreeModel";
import { t } from "./i18n";
import { matchesWorkspaceFilter, sharedWorkspaceFilter, workspaceViewKey } from "./libraryWorkspaceScope";
import { visibleProjectFolderRoots } from "./projectFolderTree";

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

export function useEditProjects({
  authKey,
  workspace,
  projectId,
}: {
  authKey: string;
  workspace: WorkspaceContext;
  projectId: string | null;
}): { projects: Project[]; projectsState: "loading" | "ok" | "error"; tree: EditTree; reload: () => void } {
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
  const [tree, setTree] = useState<{ ctx: string } & EditTree>({ ctx: "", ...EMPTY_TREE });

  useEffect(() => {
    if (!projectId || !listOk) return;
    let alive = true;
    setTree((prev) => (prev.ctx === treeCtx ? { ...prev, state: "loading" } : { ctx: treeCtx, ...EMPTY_TREE, state: "loading" }));
    void (async () => {
      const [folder, counts] = await Promise.all([
        isLinked ? api.projectFolder(projectId).catch(() => null) : Promise.resolve(undefined),
        api.projectFolderCountsBatch([projectId], "team").then((r) => r.counts?.[projectId] ?? {}, () => null),
      ]);
      if (!alive) return;
      const disk = folder?.tree && !folder.error ? visibleProjectFolderRoots(folder.tree) : [];
      const diskOk = linksKnown && (folder === undefined || (!!folder && !folder.error && !folder.truncated));
      const note =
        !linksKnown || folder === null || folder?.error ? t("폴더 정보를 불러오지 못했습니다 — 공유 기록에 있는 폴더만 보입니다.")
          : folder?.truncated ? t("폴더가 많아 일부만 읽었습니다.")
            : counts === null ? t("공유 기록의 폴더를 확인하지 못했습니다 — 이 PC 에서 보이는 폴더만 보입니다.") : null;
      if (!disk.length && counts === null) {
        setTree({ ctx: treeCtx, state: "error", roots: [], complete: false, note: t("폴더 정보를 불러오지 못했습니다.") });
        return;
      }
      setTree({
        ctx: treeCtx, state: "ready", note, complete: diskOk && counts !== null,
        roots: buildFolderCountTree(disk, counts ?? undefined),
      });
    })();
    return () => {
      alive = false;
    };
  }, [treeCtx, projectId, isLinked, linksKnown, listOk, nonce]);

  const projects = listed.ctx === listCtx ? listed.projects : [];
  const shownTree = useMemo<EditTree>(
    () => (!projectId ? EMPTY_TREE : tree.ctx === treeCtx ? tree : { ...EMPTY_TREE, state: "loading" }),
    [projectId, tree, treeCtx],
  );
  return {
    projects,
    projectsState: listed.ctx === listCtx ? listed.state : "loading",
    tree: shownTree,
    reload,
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
