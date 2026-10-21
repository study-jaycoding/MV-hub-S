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
import { getGenerationReadModel, storeGenerationRows } from "../features/library/api";

export const EDIT_LIST_CAP = 2000; // ponytail: 시퀀스 하나에 이보다 많으면 '최대 2,000건 표시' — 넘는 팀이 생기면 컷 단위 조회로

// 워크스페이스가 확인돼야 공유 목록을 묻는다(공유 & 리뷰 탭과 같은 조건).
export function editWorkspaceReady(workspace: WorkspaceContext): boolean {
  return workspace.scope === "personal" || (workspace.scope === "team" && !!workspace.id);
}

const errorText = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^Error:\s*/, "");

// ── 공유 생성물 ─────────────────────────────────────────────────────────────────────────────────

export type EditListState = "idle" | "loading" | "ok" | "error" | "capped";
// 조회 출발과 태그 저장 끝의 앞뒤를 가리는 순번 — 풀의 태그 덧입힘은 '그 카드의 저장이 끝난 뒤 출발한 조회'의 결과가 들어와야 걷는다
//  (목록 배열이 다시 만들어진 것·저장 전에 출발한 늦은 응답으로 걷으면 다음 저장이 태그를 잃었다 — Codex 리뷰 10-15). 시각이 아니라 순번이라 같은 값이 없다.
let editTicks = 0;
export const editTick = () => ++editTicks;
export interface EditList {
  state: EditListState;
  gens: Generation[]; // 쓸 수 있는 것만(완료 + 영상/이미지)
  error: string | null;
  complete: boolean; // 끝까지 받았다 — 여기 없는 클립은 '없음'으로 판정해도 된다
  // 지금 든 gens 가 이 문맥을 끝까지 받은 결과다 — gens 로 '빈 폴더'를 가려도 된다. 다시 받는 동안·실패한 뒤에도 남는다
  // (그동안 gens 는 마지막으로 끝까지 받은 것 그대로다. complete 와 달리 내려가지 않아, 빈 폴더 숨기기가 새로 고칠 때마다
  //  출렁이지 않는다). 잘린 결과(capped)로 바뀌면 거짓이다.
  known: boolean;
  startedAt: number; // 지금 든 gens 를 낸 조회가 출발한 순번(editTick) — 0 = 아직 받은 것 없음
  settledSeq: Record<string, number>; // 두 태그를 확인한 부분 조회의 출발 순번(카드별)
}

const EMPTY_LIST: EditList = { state: "idle", gens: [], error: null, complete: false, known: false, startedAt: 0, settledSeq: {} };

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
}): EditList & { reload: () => void; reloadIds: (ids: string[]) => void } {
  const ready = !!projectId && !!seq && (allWorkspaces || editWorkspaceReady(workspace));
  const ctx = JSON.stringify([authKey, workspaceViewKey(workspace), allWorkspaces, projectId, seq]);
  const [held, setHeld] = useState<{ ctx: string } & EditList>({ ctx: "", ...EMPTY_LIST });
  const [nonce, requestFull] = useReducer((n: number) => n + 1, 0);
  const [batchNonce, requestBatch] = useReducer((n: number) => n + 1, 0);
  const runRef = useRef(0);
  const currentCtx = useRef(ctx);
  currentCtx.current = ctx;
  const batch = useRef<{ ctx: string; ids: string[]; run: number } | null>(null);
  const pending = useRef({ ctx, ids: new Set<string>() });
  if (pending.current.ctx !== ctx) {
    pending.current = { ctx, ids: new Set() };
    batch.current = null; // 옛 요청이 새 문맥의 대기열을 막지 않는다.
  }
  const fullPending = useRef(true);
  const reload = useCallback(() => {
    fullPending.current = true;
    // 예약 즉시 무효화한다 — effect가 출발하기 전 도착한 부분 응답도 옛 응답이다.
    runRef.current++;
    requestFull();
  }, []);
  const reloadIds = useCallback((ids: string[]) => {
    if (!partialCapability.current.supported) { if (ids.length) reload(); return; }
    ids.forEach((id) => pending.current.ids.add(id));
    requestBatch();
  }, [reload]);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const records = getGenerationReadModel(authKey, "team");
  const partialCapability = useRef({ records, current: records.captureSession(), supported: true });
  if (partialCapability.current.records !== records || !partialCapability.current.current()) {
    partialCapability.current = { records, current: records.captureSession(), supported: true };
  }

  useEffect(() => {
    const run = ++runRef.current;
    if (!ready) return;
    fullPending.current = true;
    const alive = () => run === runRef.current && currentCtx.current === ctx;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let finishWait: (() => void) | undefined;
    // 같은 문맥의 마지막 성공 결과는 다시 받는 동안에도, 실패해도 그대로 둔다.
    // 다만 다시 받는 동안은 '끝까지 받음'이 아니다 — 그 사이 여기 없는 클립을 '없음'으로 판정하지 않는다.
    setHeld((prev) => (prev.ctx === ctx ? { ...prev, state: "loading", complete: false } : { ctx, ...EMPTY_LIST, state: "loading" }));
    void (async () => {
      const query: GenQuery = {
        tab: "team", ...(allWorkspaces ? {} : sharedWorkspaceFilter(workspaceRef.current)),
        project_id: projectId!, folder_path: seq!,
      };
      const retired = Symbol("retired edit read");
      // 재시도는 같은 run 안에서 제한한다 — reload()로 시작하면 상한이 초기화된다.
      for (let attempt = 0; attempt < 3 && alive(); attempt++) {
        const read = records.beginRead();
        const startedAt = editTick();
        const checkRead = () => { if (!alive() || !records.isCurrent(read)) throw retired; };
        try {
          const gens: Generation[] = [];
          let cursor: GenCursor | null = null;
          let rows = 0;
          let capped = false;
          for (;;) {
            // 상한까지 받았으면 다음 쪽이 있는지만 한 줄로 묻는다 — 표시는 2,000건까지, 딱 2,000건이면 끝까지 받은 것이다(81회차 M2-3)
            const probe = rows >= EDIT_LIST_CAP;
            const page: Generation[] = await (probe ? api.listGenerations(query, cursor, 1) : api.listGenerations(query, cursor));
            checkRead();
            if (probe) {
              capped = page.length > 0;
              break;
            }
            rows += page.length;
            const stored = storeGenerationRows(records, page, read);
            // 축출 묘비로 거절된 행을 빼고 '끝까지 받음'으로 확정하지 않는다.
            if (stored.length !== page.filter(row => typeof row.id === "string" && !!row.id).length) throw retired;
            gens.push(...stored.filter((gen) => isUsableGen(gen) && matchesWorkspaceFilter(gen, query)));
            checkRead(); // 저장 알림을 받는 쪽이 전체 무효화·clear를 할 수도 있다.
            // 커서와 끝 판정은 거르기 전 원본 쪽으로 — 쓸 수 있는 것이 0개인 쪽에서 멈추면 뒤가 통째로 빠진다.
            const last = page[page.length - 1];
            if (!last || page.length < GEN_PAGE) break;
            cursor = { ts: last.sort_ts ?? 0, id: last.id };
          }
          checkRead();
          // known 은 지금 든 gens 가 온전한가다 — 잘린 결과로 바꾸면 전에 끝까지 받았더라도 거짓이다.
          setHeld({ ctx, state: capped ? "capped" : "ok", gens, error: null, complete: !capped, known: !capped, startedAt, settledSeq: {} });
          return;
        } catch (error) {
          if (!alive()) return;
          if (error !== retired && records.isCurrent(read)) throw error;
          if (attempt === 2) throw new Error(t("목록이 계속 변경되어 불러오지 못했습니다. 다시 시도해 주세요."));
          await new Promise<void>((resolve) => {
            finishWait = resolve;
            retryTimer = setTimeout(resolve, 400);
          });
          retryTimer = undefined;
          finishWait = undefined;
        }
      }
    })().catch((error) => {
      if (!alive()) return;
      setHeld((prev) => ({
        ctx, state: "error", error: errorText(error),
        gens: prev.ctx === ctx ? prev.gens : [], complete: false, known: prev.ctx === ctx && prev.known,
        startedAt: prev.ctx === ctx ? prev.startedAt : 0, // 실패는 새 gens 가 아니다
        settledSeq: prev.ctx === ctx ? prev.settledSeq : {},
      }));
    }).finally(() => {
      if (!alive()) return;
      fullPending.current = false;
      requestBatch();
    });
    return () => {
      runRef.current++;
      clearTimeout(retryTimer);
      finishWait?.();
    };
  }, [ctx, ready, projectId, seq, allWorkspaces, nonce, records]);

  useEffect(() => {
    if (!ready || !partialCapability.current.supported || fullPending.current || held.ctx !== ctx || held.state === "error" || !held.startedAt || batch.current || !pending.current.ids.size) return;
    const queue = pending.current;
    const members = new Set(held.gens.map((gen) => gen.id));
    const ids = [...pending.current.ids].filter((id) => members.has(id));
    if (!ids.length) { pending.current.ids.clear(); return; }
    if (ids.some(id => !records.read(id))) { reload(); return; }
    pending.current.ids.clear();
    const requested = new Set(ids);
    const attempt = { ctx, ids, run: runRef.current };
    batch.current = attempt;
    const alive = () => pending.current === queue && currentCtx.current === ctx && runRef.current === attempt.run && !fullPending.current;
    const startedAt = editTick();
    const read = records.beginRead(["tags", "auto_tags"]);
    let capabilityFallback = false;
    void api.getGenerationsBatch(ids, () => {
      if (!alive()) throw new Error("Edit tag query superseded");
    }, { allowPartial: true, authority: "team" }).then((result) => {
      if (!alive() || !records.isCurrent(read)) return;
      const unavailable = new Set([...(result.missing ?? []), ...(result.unavailable ?? [])]);
      const updated = new Set(records.store(Object.fromEntries(Object.entries(result.items).filter(([id, item]) =>
        requested.has(id) && item.id === id && !unavailable.has(id) && Array.isArray(item.tags) && Array.isArray(item.auto_tags))), read));
      if (!records.isCurrent(read)) return;
      setHeld((prev) => {
        if (prev.ctx !== ctx || !alive() || !records.isCurrent(read)) return prev;
        const settledSeq = { ...prev.settledSeq };
        const gens = prev.gens.map((gen) => {
          const item = records.read(gen.id);
          if (!updated.has(gen.id) || !item || item.id !== gen.id) return gen;
          settledSeq[gen.id] = startedAt;
          return { ...gen, tags: item.tags, auto_tags: item.auto_tags };
        });
        return { ...prev, gens, settledSeq };
      });
    }).catch((error) => {
      if (alive() && (error as { status?: number } | null)?.status === 409) {
        capabilityFallback = true; partialCapability.current.supported = false; reload();
      }
      // 다른 실패는 기존 목록과 덧입힘을 보존한다.
    }).finally(() => {
      if (batch.current !== attempt) return;
      if (!capabilityFallback && pending.current === queue && (!alive() || !records.isCurrent(read))) ids.forEach((id) => queue.ids.add(id));
      batch.current = null;
      requestBatch();
    });
  }, [ctx, ready, held, batchNonce, records, reload]);

  const list = !ready ? EMPTY_LIST : held.ctx === ctx ? held : { ...EMPTY_LIST, state: "loading" as const };
  return {
    state: list.state, gens: list.gens, error: list.error, complete: list.complete, known: list.known, startedAt: list.startedAt,
    settledSeq: list.settledSeq, reload, reloadIds,
  };
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
  countsRun: number; // 이 숫자를 가져온 조회의 순번 — 더 뒤에 떠난 조회의 것만 덮는다
  complete: boolean;
  note: string | null;
}
const EMPTY_DATA: TreeData = { state: "idle", disk: [], counts: null, review: null, countsRun: 0, complete: false, note: null };

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
  reloadFresh: () => void;
} {
  const [nonce, reload] = useReducer((n: number) => n + 1, 0);
  const workspaceId = workspace.scope === "team" ? workspace.id || undefined : undefined;
  const listCtx = JSON.stringify([authKey, workspaceId ?? null]);
  // linked = 폴더가 연결된 프로젝트. null = 연결 조회에 실패해 모른다(연결 없음으로 치지 않는다).
  // received = 이 문맥의 목록을 한 번은 받았다 — 트리 조회는 이것에 기댄다(마지막 조회의 성공·실패·진행 중이 아니라). 재조회가 돌거나 실패해도 받아 둔
  //  목록과 돌고 있는 트리 조회는 그대로다(Codex 코드 리뷰 — state 에 기대면 재조회 중 트리 조회가 끊기고, 프로젝트 실패가 폴더 응답보다 먼저 오면
  //  폴더가 '로딩…'에 남는다).
  const [listed, setListed] = useState<{ ctx: string; state: "loading" | "ok" | "error"; projects: Project[]; linked: Set<string> | null; received?: boolean }>(
    { ctx: "", state: "loading", projects: [], linked: null },
  );

  // 프로젝트 목록이 성공한 뒤에 폴더 연결을 읽는다 — 로컬 허브는 목록 조회 때 서버의 프로젝트 정의를 받아 둔다.
  useEffect(() => {
    let alive = true;
    // 같은 문맥의 다시 조회('다시 시도'·reload)도 곧바로 '조회 중'이다 — 전엔 실패 표시가 그대로 남아 시작됐는지 알 수 없었고, 계속 누르면 새 조회가
    //  앞 응답을 버렸다(조작 규칙 52). 이미 받은 목록(과 received)은 둔다 — 사이드바가 비지 않게, 트리 조회가 끊기지 않게.
    setListed((prev) => (prev.ctx === listCtx ? (prev.state === "loading" ? prev : { ...prev, state: "loading" }) : { ctx: listCtx, state: "loading", projects: [], linked: null }));
    void (async () => {
      const { projects } = await api.projects("team", false, workspaceId);
      const links = await api.projectFolderLinks().then((r) => r.links, () => null);
      if (alive) setListed({ ctx: listCtx, state: "ok", projects, linked: links ? new Set(Object.keys(links)) : null, received: true });
    })().catch(() => {
      if (alive) setListed((prev) => ({ ...prev, ctx: listCtx, state: "error" }));
    });
    return () => {
      alive = false;
    };
  }, [listCtx, workspaceId, nonce]);

  const listOk = listed.ctx === listCtx && !!listed.received;
  const linksKnown = listed.linked !== null;
  const isLinked = !!projectId && !!listed.linked?.has(projectId);
  const treeCtx = JSON.stringify([listCtx, projectId, isLinked, linksKnown]);
  const [tree, setTree] = useState<{ ctx: string } & TreeData>({ ctx: "", ...EMPTY_DATA });
  // 개수 조회의 순번 — 트리 조회와 '숫자만 다시 받기'가 같이 쓴다. 숫자는 더 뒤에 떠난 조회의 것만 덮는다: 늦게 온 옛 응답도,
  //  트리를 처음 받는 사이에 먼저 도착한 '다시 받기'의 숫자를 덮는 트리 조회도 막는다(Codex 코드 리뷰).
  const countRun = useRef(0);

  useEffect(() => {
    if (!projectId || !listOk) return;
    let alive = true;
    const run = ++countRun.current;
    setTree((prev) => (prev.ctx === treeCtx ? { ...prev, state: "loading" } : { ctx: treeCtx, ...EMPTY_DATA, state: "loading" }));
    void (async () => {
      const [folder, counted] = await Promise.all([
        isLinked ? api.projectFolder(projectId).catch(() => null) : Promise.resolve(undefined),
        fetchFolderCounts(projectId),
      ]);
      if (!alive) return;
      const disk = folder?.tree && !folder.error ? visibleProjectFolderRoots(folder.tree) : [];
      const diskOk = linksKnown && (folder === undefined || (!!folder && !folder.error && !folder.truncated));
      setTree((prev) => {
        // 그사이 '숫자만 다시 받기'가 더 새 숫자를 적어 뒀으면 그것을 쓴다 — 이 조회의 숫자가 늦게 왔든 실패했든(실패 판정도
        //  그 숫자를 보고 한다: 안 보면 방금 받은 폴더까지 지운다, Codex 코드 리뷰).
        const newer = prev.ctx === treeCtx && prev.countsRun > run && prev.counts ? prev : null;
        const counts = newer ? newer.counts : counted?.counts ?? null;
        if (!disk.length && !counts) return { ctx: treeCtx, ...EMPTY_DATA, state: "error", note: t("폴더 정보를 불러오지 못했습니다.") };
        const note =
          !linksKnown || folder === null || folder?.error ? t("폴더 정보를 불러오지 못했습니다 — 공유 기록에 있는 폴더만 보입니다.")
            : folder?.truncated ? t("폴더가 많아 일부만 읽었습니다.")
              : !counts ? t("공유 기록의 폴더를 확인하지 못했습니다 — 이 PC 에서 보이는 폴더만 보입니다.") : null;
        return {
          ctx: treeCtx, state: "ready", note, complete: diskOk && !!counts, disk, counts,
          review: newer ? newer.review : counted?.review ?? null, countsRun: newer ? newer.countsRun : run,
        };
      });
    })();
    return () => {
      alive = false;
    };
  }, [treeCtx, projectId, isLinked, linksKnown, listOk, nonce]);

  // 새 항목(+N) — 공유 & 리뷰 사이드바와 같은 원천(기준선 이후 공유된 목록)에서 확인(클릭)한 것을 뺀다. 기준선은 공유 &
  //  리뷰에 처음 들어갈 때 생긴다 — 없으면 묻지 않는다. 구버전 서버(라우트 없음)·실패는 배지만 숨긴다.
  const [fresh, setFresh] = useState<{ ctx: string; items: TeamFreshItem[] }>({ ctx: "", items: [] });
  const freshRun = useRef(0);
  const loadFresh = useCallback(() => {
    const since = getTeamBase();
    if (!since) return;
    const run = ++freshRun.current;
    const put = (items: TeamFreshItem[]) => {
      // 마지막에 떠난 조회의 답만 쓴다 — 문맥 글자만 비교하면 공간을 A→B→A 로 오갈 때 처음 A 의 늦은 답이 새 답을 덮는다
      if (run === freshRun.current) setFresh({ ctx: listCtx, items });
    };
    api.teamFreshAll(since, listCtx).then(put, () => put([]));
  }, [listCtx]);
  useEffect(loadFresh, [loadFresh, nonce]);
  const live = useRef({ treeCtx, projectId, loadFresh, failed: false });
  live.current = { treeCtx, projectId, loadFresh, failed: tree.ctx === treeCtx && tree.state === "error" };
  const reloadCounts = useCallback(() => {
    const { treeCtx: ctx, projectId: pid } = live.current;
    // 트리를 못 받은 상태면 숫자만으로는 못 살린다(디스크 폴더·온전성을 모른다) — 처음부터 다시 받는다.
    if (live.current.failed) return reload();
    live.current.loadFresh();
    if (!pid) return;
    const run = ++countRun.current;
    void fetchFolderCounts(pid).then((counted) => {
      // 실패하면 마지막으로 받은 숫자를 그대로 둔다. 문맥이 바뀌었거나 더 뒤에 떠난 조회의 숫자가 이미 있으면 버린다.
      //  트리를 받는 중(loading)이어도 적어 둔다 — 그 트리 조회가 끝날 때 이 숫자를 지킨다.
      if (!counted) return;
      setTree((prev) => (prev.ctx === ctx && (prev.state === "ready" || prev.state === "loading") && run > prev.countsRun
        ? { ...prev, ...counted, countsRun: run } : prev));
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
    reloadFresh: loadFresh,
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
