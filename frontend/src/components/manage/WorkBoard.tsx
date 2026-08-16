// 작업 탭 컨테이너 — 전체 프로젝트의 작업을 병합해 보여주고, 노션식 칩 필터(프로젝트/에피소드/
// 시퀀스/상태/생성자)+검색으로 좁힌다. 보드/테이블/캘린더에 데이터·핸들러를 주입한다.
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import {
  addDisabledGen,
  DISABLED_EVENT,
  isFolderDisabled,
  loadDisabledFolders,
  loadDisabledGen,
  removeDisabledGen,
} from "../../lib/deactivated";
import { manageApi } from "../../lib/manageApi";
import { thumbUrl } from "../../lib/media";
import { loadJSON, loadString, saveJSON, saveString } from "../../lib/storage";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import { createLatestMutationQueue } from "../../lib/mutationQueue";
import { reconcileArrayState } from "../../lib/stateReconciliation";
import { CalendarView } from "./CalendarView";
import { BoardView } from "./KanbanBoard";
import { type ColorMap, loadColorMap, saveColorMap } from "./manageColors";
import { scopeTasksToCreator } from "./personalWork";
import { TableView } from "./TableView";
import { WorkFilterBar } from "./WorkFilterBar";
import { useT } from "../../lib/i18n";
import {
  emptyWorkFilters,
  type Task,
  type WorkFilters,
  WORK_FILTER_FIELDS,
  type WorkViewProps,
} from "./types";

type WorkView = "board" | "table" | "calendar";

// 저장된 필터 복원 — 모양이 깨져도 안전하게 기본값과 병합(값은 필드별 배열 보장).
function loadFilters(): WorkFilters {
  const base = emptyWorkFilters();
  const saved = loadJSON<WorkFilters>(STORAGE_KEYS.manageWorkFilters);
  if (!saved) return base;
  const values = { ...base.values };
  for (const field of WORK_FILTER_FIELDS) {
    const selected = saved.values?.[field];
    values[field] = Array.isArray(selected)
      ? selected.filter((value): value is string => typeof value === "string")
      : [];
  }
  return {
    active: Array.isArray(saved.active)
      ? saved.active.filter((f) => WORK_FILTER_FIELDS.includes(f))
      : [],
    values,
    search: typeof saved.search === "string" ? saved.search : "",
  };
}

function taskThumb(path?: string | null): string | undefined {
  return thumbUrl(path, 256) ?? undefined;
}

// 서버가 변형 없이 저장만 하는 필드 — 이것만 담긴 PATCH 는 로컬 상태 갱신으로 끝내고 재호출 생략.
const SIMPLE_PATCH_FIELDS = new Set([
  "name",
  "note",
  "description",
  "start_date",
  "due_date",
  "sort_order",
]);

// 병합 뷰의 표시 순서 — 수동 지정(sort_order) 우선, 없으면 생성일. 드래그 순서변경이 전 프로젝트에
// 걸쳐 일관되게 유지되도록 병합 후 전역 정렬한다.
function bySort(a: Task, b: Task): number {
  const sa = a.sort_order ?? 1e9;
  const sb = b.sort_order ?? 1e9;
  if (sa !== sb) return sa - sb;
  return (a.created_at || "").localeCompare(b.created_at || "");
}

// 칩 필터 + 검색 매칭 — 같은 필드 값끼리 OR(포함), 서로 다른 필드끼리 AND. status 는 effective 반영본.
function matchTask(t: Task, f: WorkFilters): boolean {
  const v = f.values;
  // 개발 중 새 필터가 추가돼 메모리의 구버전 상태에 해당 키가 없어도 화면을 중단하지 않는다.
  const selected = (field: keyof WorkFilters["values"]) => v[field] ?? [];
  const project = selected("project");
  const episode = selected("episode");
  const sequence = selected("sequence");
  const status = selected("status");
  const creator = selected("creator");
  const model = selected("model");
  if (project.length && !project.includes(t.project_name || "")) return false;
  if (episode.length && !episode.includes(t.name)) return false;
  if (sequence.length && !sequence.includes(t.sequence || "")) return false;
  if (status.length && !status.includes(t.status)) return false;
  if (creator.length && !(t.creators || []).some((c) => creator.includes(c))) return false;
  if (
    model.length &&
    !(t.cuts || []).some((cut) => model.includes(cut.model?.trim() || "알 수 없음"))
  ) return false;
  const q = f.search.trim().toLowerCase();
  if (q) {
    const hay = [
      t.name,
      t.sequence,
      t.description,
      t.project_name,
      ...(t.creators || []),
      ...(t.cuts || []).map((cut) => cut.model),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export function WorkBoard({
  reloadSignal = 0,
  viewerUid = null,
  personalByDefault = false,
  workspaceId,
  workspaceName,
}: {
  reloadSignal?: number;
  viewerUid?: string | null;
  personalByDefault?: boolean;
  workspaceId?: string;
  workspaceName?: string;
}) {
  useT(); // 언어 토글 시 라벨 리렌더
  const [projects, setProjects] = useState<{ pid: string; name: string }[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]); // 전체 프로젝트 병합(project_name 부착)
  const [seqOptions, setSeqOptions] = useState<string[]>([]);
  const myUid = viewerUid;
  // 일반 작업자는 본인이 만든 생성물 기준 개인 작업표가 기본이다. read_all 관리자는 전체가 기본.
  const [mineOnly, setMineOnly] = useState(() => personalByDefault && !!viewerUid);
  const [view, setView] = useState<WorkView>(
    () => (loadString(STORAGE_KEYS.manageWorkView, "table") as WorkView) || "table",
  );
  const [filters, setFilters] = useState<WorkFilters>(loadFilters);
  const [err, setErr] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  // d 로 비활성화(회색)된 생성물 id — localStorage 기준. 컷 회색 표시 + effective 생략 판정에 쓴다.
  const [disabled, setDisabled] = useState<Set<string>>(() => loadDisabledGen());
  const [disabledFolders, setDisabledFolders] = useState(() => loadDisabledFolders()); // 폴더 단위 비활성
  // 값별 색 라벨(프로젝트/에피소드/시퀀스/생성자) — localStorage 기억, 창 간 동기.
  const [colorMap, setColorMap] = useState<ColorMap>(loadColorMap);
  const setColor = (field: string, value: string, key: string) => {
    setColorMap((prev) => {
      const next = { ...prev };
      const k = `${field}::${value}`;
      if (key === "default") delete next[k];
      else next[k] = key;
      saveColorMap(next);
      return next;
    });
  };
  // 테이블 행 다중선택(하단 선택바에서 일괄 삭제). 뷰 전환 시 초기화.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => setSelected(new Set()), [view]);
  const toggleSelect = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const toggleSelectAll = (ids: string[], on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      ids.forEach((id) => (on ? n.add(id) : n.delete(id)));
      return n;
    });
  const clearSel = () => setSelected(new Set());

  // 필터·뷰 영속 — 창을 닫았다 와도 마지막 설정을 기억한다(localStorage).
  useEffect(() => saveJSON(STORAGE_KEYS.manageWorkFilters, filters), [filters]);
  useEffect(() => saveString(STORAGE_KEYS.manageWorkView, view), [view]);

  // 비활성화 집합 최신화 — 같은 창은 DISABLED_EVENT, 다른 창(별도 생성탭)은 storage 이벤트.
  useEffect(() => {
    const refresh = () => {
      setDisabled(loadDisabledGen());
      setDisabledFolders(loadDisabledFolders());
    };
    const onStorage = (e: StorageEvent) => {
      if (
        e.key === STORAGE_KEYS.historyDisabled ||
        e.key === STORAGE_KEYS.disabledFolders ||
        e.key === null
      )
        refresh();
      if (e.key === STORAGE_KEYS.manageColorTags || e.key === null) setColorMap(loadColorMap());
    };
    window.addEventListener(DISABLED_EVENT, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(DISABLED_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // 전체 프로젝트 작업 병합 로드 — tasks-batch 1요청 우선, 구버전 서버만 프로젝트별 폴백.
  // reqRef 로 늦게 온 이전 요청이 최신 화면을 덮지 않게 한다(폴링/브로드캐스트 중첩 대비).
  const projectsRef = useRef(projects);
  const reqRef = useRef(0);
  const loadingRef = useRef(false);
  const loadPromiseRef = useRef<Promise<void> | null>(null);
  const pendingLoadRef = useRef(false);
  const scopeKey = `${workspaceId || "personal"}:${showHistory ? "history" : "active"}`;
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;
  const orderSaveRef = useRef<ReturnType<typeof createLatestMutationQueue> | null>(null);
  const orderRevisionRef = useRef(0);
  const optimisticOrderRef = useRef<{ revision: number; tasks: Task[] } | null>(null);
  const loadAll = (): Promise<void> => {
    if (loadingRef.current) {
      pendingLoadRef.current = true; // 진행 중 들어온 변경 신호들은 후속 1회로 합친다.
      return loadPromiseRef.current || Promise.resolve();
    }
    const ps = projectsRef.current;
    if (!ps.length) {
      setTasks((previous) => reconcileArrayState(previous, []));
      return Promise.resolve();
    }
    const my = ++reqRef.current;
    const requestScope = scopeKey;
    loadingRef.current = true;
    const finish = (tasks: Task[]) => {
      if (reqRef.current === my && scopeKeyRef.current === requestScope) {
        const ordered = tasks.sort(bySort);
        // 30초 안전망·실시간 신호가 같은 JSON을 돌려줘도 작업표 전체를 다시 그리지 않는다.
        setTasks((previous) => reconcileArrayState(previous, ordered));
      }
    };
    // 프로젝트별 fan-out(폴백) — 배치 실패(예: 롤아웃 중 구 공유서버에 tasks-batch 없음) 시
    // 프로젝트별 개별 조회로 부분성공 유지(하나 실패해도 나머지는 표시).
    const fanout = () =>
      Promise.all(
        ps.map((p) =>
          manageApi
            .listTasks(p.pid, workspaceId, showHistory)
            .then((r) => r.map((t) => ({ ...t, project_name: p.name })))
            .catch(() => [] as Task[]),
        ),
      ).then((all) => finish(all.flat()));
    // 우선 1요청(tasks-batch). 서버가 pid 별 read 게이트를 적용해 {pid: tasks} 반환.
    const request = manageApi
      .listTasksBatch(ps.map((p) => p.pid), workspaceId, showHistory)
      .then((byPid) => {
        finish(ps.flatMap((p) => (byPid[p.pid] || []).map((t) => ({ ...t, project_name: p.name }))));
      })
      .catch(() => fanout().catch(() => finish([])))
      .finally(async () => {
        if (reqRef.current === my) {
          loadingRef.current = false;
          loadPromiseRef.current = null;
          if (pendingLoadRef.current) {
            pendingLoadRef.current = false;
            await loadAllRef.current();
          }
        }
      });
    loadPromiseRef.current = request;
    return request;
  };
  const loadAllRef = useRef(loadAll);
  const loadProjectsRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const projectReqRef = useRef(0);
  const seenReloadSignalRef = useRef(reloadSignal);
  const seenHistoryRef = useRef(showHistory);
  loadAllRef.current = loadAll;
  if (!orderSaveRef.current) {
    orderSaveRef.current = createLatestMutationQueue(async () => {
      const revisionBeforeReload = orderRevisionRef.current;
      await loadAllRef.current();
      const optimistic = optimisticOrderRef.current;
      if (optimistic && optimistic.revision !== revisionBeforeReload) {
        setTasks(optimistic.tasks);
      }
    });
  }

  const loadProjects = (): Promise<void> => {
    const requestId = ++projectReqRef.current;
    setErr(null);
    return api
      .projects("team", showHistory, workspaceId)
      .then((r) => {
        if (projectReqRef.current !== requestId) return;
        const ps = r.projects.map((p) => ({ pid: p.id, name: p.name }));
        projectsRef.current = ps;
        setProjects(ps);
        return loadAllRef.current();
      })
      .catch((e) => {
        if (projectReqRef.current === requestId) setErr(String(e?.message || e));
      });
  };
  loadProjectsRef.current = loadProjects;

  useEffect(() => {
    projectsRef.current = [];
    setProjects([]);
    setTasks([]);
    void loadProjectsRef.current();
  }, [workspaceId]);

  useEffect(() => {
    api.facets().then((f) => setSeqOptions(f.auto_tags || [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (seenReloadSignalRef.current === reloadSignal) return;
    seenReloadSignalRef.current = reloadSignal;
    void loadProjectsRef.current();
  }, [reloadSignal]);

  useEffect(() => {
    if (seenHistoryRef.current === showHistory) return;
    seenHistoryRef.current = showHistory;
    // 과거 기록은 보관된 작업뿐 아니라 보관된 프로젝트도 포함한다.
    void loadProjectsRef.current();
  }, [showHistory]);

  const onPatch = async (tid: string, patch: Partial<Task>) => {
    await manageApi.updateTask(tid, patch);
    // 상태 이동과 컷 활성화 동기화(대칭): 생략→컷 비활성화, 생략에서 빼면→컷 재활성화.
    if (patch.status) {
      const t = tasks.find((x) => x.id === tid);
      const ids = (t?.cuts || []).map((c) => c.id);
      if (patch.status === "omit") {
        // 폴더 단위로 이미 생략된 작업이면 id store 를 건드리지 않는다 — 폴더를 다시 켤 때
        // 컷 비활성이 잔류해 계속 생략으로 남는 오염 방지(폴더 store 가 단일 소스).
        if (!isFolderDisabled(disabledFolders, t?.project_id, t?.folder_path)) addDisabledGen(ids);
      } else {
        const dset = loadDisabledGen();
        const wasOmit =
          t?.status === "omit" || (ids.length > 0 && ids.every((id) => dset.has(id)));
        if (wasOmit) removeDisabledGen(ids);
      }
    }
    const keys = Object.keys(patch);
    const simpleOnly = keys.length > 0 && keys.every((k) => SIMPLE_PATCH_FIELDS.has(k));
    if (simpleOnly) {
      setTasks((prev) => prev.map((t) => (t.id === tid ? { ...t, ...patch } : t)));
    } else {
      loadAll();
    }
  };
  const onDelete = async (tid: string) => {
    await manageApi.deleteTask(tid);
    loadAll();
  };
  const onLinkGen = async (tid: string, genId: string) => {
    await manageApi.linkGenerations(tid, [genId]);
    loadAll();
  };
  const onUnlinkGen = async (tid: string, genId: string) => {
    await manageApi.unlinkGeneration(tid, genId);
    loadAll();
  };
  // effective 상태 — 화면에서만 '생략'으로(서버 미기록, 재활성화 시 자동 복귀):
  //   (1) 이 작업의 폴더가 폴더 단위 비활성이면 생략, 또는 (2) 컷이 전부 비활성화(d)면 생략.
  const effective = useMemo(
    () =>
      tasks.map((t) => {
        if (t.status === "omit") return t;
        if (isFolderDisabled(disabledFolders, t.project_id, t.folder_path))
          return { ...t, status: "omit" };
        if (!disabled.size) return t;
        const cuts = t.cuts || [];
        const allOff = cuts.length > 0 && cuts.every((c) => disabled.has(c.id));
        return allOff ? { ...t, status: "omit" } : t;
      }),
    [tasks, disabled, disabledFolders],
  );
  // 컷 회색용 확장 집합 — id 직접 비활성 + 폴더 비활성 작업의 컷 전부(컷엔 folder_path 가 없으므로
  // 작업의 폴더 판정으로 파생). CutThumbs·CalendarView 가 이 집합으로 컷을 회색 처리.
  const disabledCuts = useMemo(() => {
    if (!Object.keys(disabledFolders).length) return disabled;
    const s = new Set(disabled);
    for (const t of tasks) {
      if (isFolderDisabled(disabledFolders, t.project_id, t.folder_path))
        (t.cuts || []).forEach((c) => s.add(c.id));
    }
    return s;
  }, [tasks, disabled, disabledFolders]);
  // '내 작업'은 수동 배정뿐 아니라 실제 생성물 creator_uid도 포함한다. 개인 모드에서는
  // 각 행의 생성물·크레딧·시간·기간도 본인 컷만으로 다시 계산해 팀 전체 수치가 섞이지 않게 한다.
  const visibleScope = useMemo(
    () => (mineOnly && myUid ? scopeTasksToCreator(effective, myUid) : effective),
    [effective, mineOnly, myUid],
  );
  const filtered = useMemo(
    () => visibleScope.filter((task) => matchTask(task, filters)),
    [filters, visibleScope],
  );

  // 필터·검색·내 배정 보기 중에는 드래그 정렬을 막는다 — 숨겨진 작업과의 상대 순서를 알 수 없어
  // 부분 목록 재정렬이 전역 순서를 임의로 바꾸게 된다(합의 설계: 전체 스냅샷일 때만 저장).
  const filterActive = useMemo(
    () =>
      mineOnly ||
      !!filters.search.trim() ||
      Object.values(filters.values).some((selectedValues) => selectedValues.length > 0),
    [filters, mineOnly],
  );

  // 드래그 순서변경 — 표시 순서에서 draggedId 를 targetId 앞으로 옮기고, 보드 전체 순서
  // 스냅샷(위치=순서)을 저장한다. delta 전송은 latest-merge 큐와 조합 시 대기 중 교체된
  // 중간 드래그의 변경분이 영영 전송되지 않는 유실이 있었다(코덱스 합의로 스냅샷 전환).
  const onReorder = (draggedId: string, targetId: string) => {
    if (filterActive) {
      window.alert("필터·검색 중에는 순서를 바꿀 수 없습니다. 필터를 해제한 뒤 정렬해 주세요.");
      return;
    }
    const ids = filtered.map((t) => t.id);
    if (draggedId === targetId || !ids.includes(draggedId) || !ids.includes(targetId)) return;
    const [moved] = ids.splice(ids.indexOf(draggedId), 1);
    ids.splice(ids.indexOf(targetId), 0, moved); // 제거 후 대상 위치를 다시 찾아 그 앞에 삽입
    const orderMap = new Map(ids.map((id, i) => [id, i * 10]));
    const optimisticTasks = tasks
      .map((t) => (orderMap.has(t.id) ? { ...t, sort_order: orderMap.get(t.id)! } : t))
      .sort(bySort);
    const revision = ++orderRevisionRef.current;
    optimisticOrderRef.current = { revision, tasks: optimisticTasks };
    setTasks(optimisticTasks);
    // 실행 중 1건은 유지하되 대기 중인 중간 스냅샷은 최신 순서 하나로 교체한다(전체 상태라 안전).
    orderSaveRef.current?.enqueue(() => manageApi.updateTaskOrderSnapshot(ids));
  };

  // 선택 일괄 삭제 — 확인 후 작업 행 삭제. (폴더 자동 작업은 생성물이 남아 있으면 다음 동기화 때
  // 다시 생성됨 — 실질 삭제는 생성탭에서 생성물 자체를 지워야 함. 여기선 정리용.)
  const bulkDelete = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    if (!window.confirm(`선택한 작업 ${ids.length}개를 삭제할까요?`)) return;
    try {
      await manageApi.deleteTasksBatch(ids);
      clearSel();
      loadAll();
    } catch (e) {
      window.alert("작업 삭제 실패: " + String(e));
    }
  };

  if (err) return <div className="manage-empty">불러오기 실패: {err}</div>;

  const viewProps: WorkViewProps = {
    tasks: filtered,
    seqOptions,
    myUid,
    thumb: taskThumb,
    disabled: disabledCuts,
    colorMap,
    selected,
    onToggleSelect: toggleSelect,
    onToggleSelectAll: toggleSelectAll,
    onReorder,
    onPatch,
    onDelete,
    onLinkGen,
    onUnlinkGen,
  };

  return (
    <div className="manage-dash work-root">
      <header className="manage-head">
        <div>
          <h1>작업</h1>
          <p className="work-source-label">
            공유 서버 작업 기록 · {workspaceName || (workspaceId ? "선택 워크스페이스" : "개인 · 전체 워크스페이스")}
          </p>
        </div>
        <div className="work-head-ctl">
          <button
            className={"work-history-toggle" + (showHistory ? " on" : "")}
            onClick={() => setShowHistory((value) => !value)}
            title="오래된 자동 작업 기록 포함"
          >
            과거 기록
          </button>
          {/* 실제로 만든 생성물 + 수동 배정 작업을 현재 작업자 기준으로 표시한다. */}
          {myUid ? (
            <button
              className={"work-mine-toggle" + (mineOnly ? " on" : "")}
              onClick={() => setMineOnly((v) => !v)}
              title="내가 만들었거나 배정받은 작업만 보기"
            >
              내 작업만
            </button>
          ) : null}
          <div className="manage-toggles">
            <button className={view === "table" ? "on" : ""} onClick={() => setView("table")}>
              테이블
            </button>
            <button className={view === "board" ? "on" : ""} onClick={() => setView("board")}>
              보드
            </button>
            <button
              className={view === "calendar" ? "on" : ""}
              onClick={() => setView("calendar")}
            >
              캘린더
            </button>
          </div>
        </div>
      </header>

      <WorkFilterBar
        tasks={visibleScope}
        filters={filters}
        onChange={setFilters}
        colorMap={colorMap}
        onSetColor={setColor}
      />

      {!projects.length ? (
        <div className="manage-empty">프로젝트를 먼저 만들어 생성물을 귀속하세요.</div>
      ) : view === "board" ? (
        <BoardView {...viewProps} />
      ) : view === "table" ? (
        <TableView {...viewProps} />
      ) : (
        <CalendarView {...viewProps} />
      )}

      {selected.size > 0 && (
        <div className="work-selbar">
          <span className="work-selbar-count">{selected.size}개 선택</span>
          <button className="work-selbar-btn" onClick={clearSel}>
            선택 해제
          </button>
          <button className="work-selbar-btn danger" onClick={bulkDelete}>
            🗑 삭제
          </button>
        </div>
      )}
    </div>
  );
}
