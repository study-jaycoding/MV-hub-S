// 카드의 폴더 이름표로 연 '폴더의 생성물' 창의 목록 — 본 목록(useGenerationLibraryData)과 따로 조회한다.
// 본 목록은 탭별 캐시·소유 탭·reload 합치기가 얽혀 있어, 창이 그 범위를 잠깐 빌리는 대신 자기 목록을 갖는다.
//
// 범위(코덱스 설계 검토 2026-10-07): 지금 탭(my|team)·지금 워크스페이스 범위에서 **볼 수 있는** 그 폴더 + 하위 폴더.
//  본 목록의 다른 필터(타입·컬러·태그·검색·검토·작성자)는 따라가지 않는다. 지운 것은 넣지 않는다.
//  프로젝트가 없는 폴더는 project_id="none" — 생략하면 다른 프로젝트의 같은 이름 폴더가 섞인다.
// 창은 **연 시점의 목록**이다 — 다시 열면 새로 받는다. 같은 창 변경 알림(APP_EVENTS.libraryChanged)은 따라가지 않는다:
//  공유 & 리뷰 탭에서는 변경이 없어도 15초마다 나는 신호라(useGenerationAutoRefresh), 따라가면 더 본 쪽이 주기적으로 접힌다
//  (코덱스 코드 리뷰 2026-10-07). 창은 보기 전용이고 크게 보기에도 지우는 조작이 없어, 열려 있는 동안 창 스스로 낡게 만들 일은 없다.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, GEN_PAGE, type GenCursor } from "../api";
import { workspaceFilterOf, type LibraryWorkspaceFilter } from "./libraryWorkspaceScope";
import type { GenQuery, Generation } from "../types";

export interface FolderTarget {
  tab: "my" | "team";
  projectId: string | null;
  path: string;
}

export function folderContentsQuery(target: FolderTarget, workspace: LibraryWorkspaceFilter): GenQuery {
  return {
    tab: target.tab,
    project_id: target.projectId ?? "none",
    folder_path: target.path,
    ...workspaceFilterOf(workspace),
  };
}

// 본 목록과 같은 문구 규칙(useGenerationLibraryData 의 loadError).
const errorText = (e: unknown) => String(e).replace(/^Error:\s*/, "");

const cursorOf = (page: Generation[]): GenCursor | null => {
  const last = page[page.length - 1];
  return last ? { ts: last.sort_ts ?? 0, id: last.id } : null;
};

export function useFolderContents(target: FolderTarget | null, workspace: LibraryWorkspaceFilter, ready = true) {
  const [rows, setRows] = useState<Generation[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = target ? folderContentsQuery(target, workspace) : null;
  const key = query && ready ? JSON.stringify(query) : null;
  const queryRef = useRef(query);
  queryRef.current = query;
  // 요청 순번 — 첫 쪽을 다시 받기 시작하면 그 전의 첫 쪽·더 보기 응답(성공·실패·finally 모두)은 버린다.
  const seq = useRef(0);
  const cursor = useRef<GenCursor | null>(null);
  const moreBusy = useRef(false);

  const load = useCallback(async () => {
    const current = queryRef.current;
    if (!current) return;
    const my = ++seq.current;
    moreBusy.current = false;
    setLoadingMore(false);
    setLoading(true);
    setRows([]);
    setHasMore(false);
    setError(null);
    try {
      const page = await api.listGenerations(current, null);
      if (my !== seq.current) return;
      cursor.current = cursorOf(page);
      setRows(page);
      setHasMore(page.length >= GEN_PAGE);
    } catch (e) {
      if (my !== seq.current) return;
      setError(errorText(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    const current = queryRef.current;
    if (!current || moreBusy.current || !cursor.current) return;
    moreBusy.current = true;
    setLoadingMore(true);
    const my = seq.current;
    try {
      const batch = await api.listGenerations(current, cursor.current);
      if (my !== seq.current) return;
      cursor.current = cursorOf(batch) ?? cursor.current;
      setRows((prev) => {
        const seen = new Set(prev.map((g) => g.id));
        return [...prev, ...batch.filter((g) => !seen.has(g.id))];
      });
      setHasMore(batch.length >= GEN_PAGE);
      setError(null);
    } catch (e) {
      if (my !== seq.current) return;
      setError(errorText(e)); // 목록·[더 보기]는 그대로 — 다시 누를 수 있다
    } finally {
      if (my === seq.current) {
        moreBusy.current = false;
        setLoadingMore(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!key) {
      seq.current += 1;
      setRows([]);
      setHasMore(false);
      setLoading(false);
      setLoadingMore(false);
      setError(null);
      return;
    }
    void load();
    return () => {
      seq.current += 1; // 닫히거나 대상이 바뀜 — 늦은 응답이 새 상태를 건드리지 못하게
    };
  }, [key, load]);

  return { rows, loading, loadingMore, hasMore, error, loadMore, reload: () => void load() };
}
