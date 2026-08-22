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
import { isHttpStatus, isRouteMissing } from "../../lib/http";
import { thumbUrl } from "../../lib/media";
import { loadJSON, loadString, saveJSON, saveString } from "../../lib/storage";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import {
  createKeyedMutationQueue,
  createLatestMutationQueue,
  type KeyedMutationQueue,
} from "../../lib/mutationQueue";
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
  taskIsReadOnly,
  type WorkFilters,
  WORK_FILTER_FIELDS,
  type WorkViewProps,
} from "./types";

export function taskWriteErrorMessage(action: string, error: unknown): string {
  if (isHttpStatus(error, 404)) {
    return `${action} 실패: 작업 목록이 다른 사용자에 의해 변경되었습니다. 최신 목록을 다시 불러옵니다.`;
  }
  if (isHttpStatus(error, 409)) {
    return `${action} 실패: 프로젝트 또는 워크스페이스가 변경되어 이 작업은 더 이상 수정할 수 없습니다. 최신 목록을 다시 불러옵니다.`;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `${action} 실패: ${detail}`;
}

// 전체 선택/해제 — ids 마다 tasks 를 훑으면 O(n²)(수천 행에서 체감). id→작업을 한 번만 인덱싱한다.
// 같은 id 가 여러 번 있으면 tasks.find 와 같게 '첫 항목'을 쓴다(읽기전용 판정이 뒤집히지 않게).
export function applyTaskSelectAll(
  selected: Set<string>,
  ids: string[],
  on: boolean,
  tasks: Task[],
  readOnly: boolean,
): Set<string> {
  const next = new Set(selected);
  const taskById = new Map<string, Task>();
  for (const item of tasks) if (!taskById.has(item.id)) taskById.set(item.id, item);
  for (const id of ids) {
    const task = taskById.get(id);
    if (task && !taskIsReadOnly(task, readOnly)) on ? next.add(id) : next.delete(id);
  }
  return next;
}

export async function recoverTaskWriteFailure(
  action: string,
  error: unknown,
  notify: (message: string) => void,
  reload: () => Promise<void>,
): Promise<void> {
  notify(taskWriteErrorMessage(action, error));
  await reload();
}

type ScopedMutationError = {
  mutationScope: string;
  cause: unknown;
};

function scopedMutationError(mutationScope: string, cause: unknown): ScopedMutationError {
  return { mutationScope, cause };
}

function isScopedMutationError(error: unknown): error is ScopedMutationError {
  return (
    !!error &&
    typeof error === "object" &&
    typeof (error as Partial<ScopedMutationError>).mutationScope === "string" &&
    "cause" in error
  );
}

// 화면을 닫거나 워크스페이스/과거 기록 범위를 바꾼 뒤 끝난 저장은 서버 결과만 유지한다.
// 이전 화면의 알림·재조회·낙관 상태가 현재 화면에 섞이지 않게 UI 후속 처리만 버린다.
export function mutationErrorsForScope(errors: unknown[], activeScope: string): unknown[] {
  return errors.flatMap((error) => {
    if (!isScopedMutationError(error)) return [error];
    return error.mutationScope === activeScope ? [error.cause] : [];
  });
}

// 전체 작업 재조회가 시작된 뒤 다른 저장이 끝났다면 그 응답은 저장 전 스냅샷일 수 있다.
// 같은 화면 범위여도 데이터 revision 이 달라졌으면 적용하지 않고 후속 재조회를 예약한다.
export function taskLoadResultIsCurrent(
  requestScope: string,
  activeScope: string,
  requestRevision: number,
  activeRevision: number,
): boolean {
  return requestScope === activeScope && requestRevision === activeRevision;
}

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
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
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
  useEffect(() => setSelected(new Set()), [showHistory, workspaceId]);
  const toggleSelect = (id: string) => {
    const task = tasks.find((item) => item.id === id);
    if (!task || taskIsReadOnly(task, showHistory)) return;
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };
  const toggleSelectAll = (ids: string[], on: boolean) =>
    setSelected((s) => applyTaskSelectAll(s, ids, on, tasks, showHistory));
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
  // ★스코프(워크스페이스×이력)별 저장 큐 — 하나의 latest 큐를 공유하면 A 스코프의 대기 중
  //   순서 저장을 B 스코프 저장이 덮어써 A 의 마지막 드래그가 영구 유실된다(적대 리뷰 P1).
  const orderSaveQueuesRef = useRef(
    new Map<string, ReturnType<typeof createLatestMutationQueue>>(),
  );
  // 스코프 큐는 나뉘어도 실제 네트워크 PUT 은 하나로 직렬화한다 — personal 스코프가 워크스페이스
  // 작업을 포함하므로, 병렬 PUT 은 느린 옛 스냅샷이 나중에 도착해 최신 순서를 덮을 수 있다(검증 P2).
  const orderWriteChainRef = useRef<Promise<void>>(Promise.resolve());
  const serializeOrderWrite = (op: () => Promise<void>): Promise<void> => {
    const run = orderWriteChainRef.current.then(op);
    orderWriteChainRef.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const taskPatchQueueRef = useRef<KeyedMutationQueue<string> | null>(null);
  const taskDataRevisionRef = useRef(0);
  const orderRevisionRef = useRef(0);
  const optimisticOrderRef = useRef<{
    revision: number;
    scope: string;
    tasks: Task[];
  } | null>(null);
  const scopeIsActive = (requestScope: string): boolean =>
    mountedRef.current && scopeKeyRef.current === requestScope;
  const loadAll = (): Promise<void> => {
    if (!mountedRef.current) return Promise.resolve();
    if (loadingRef.current) {
      pendingLoadRef.current = true; // 진행 중 들어온 변경 신호들은 후속 1회로 합친다.
      return loadPromiseRef.current || Promise.resolve();
    }
    const ps = projectsRef.current;
    if (!ps.length) {
      if (mountedRef.current) setTasks((previous) => reconcileArrayState(previous, []));
      return Promise.resolve();
    }
    const my = ++reqRef.current;
    const requestScope = scopeKey;
    const requestDataRevision = taskDataRevisionRef.current;
    loadingRef.current = true;
    setErr(null);
    const finish = (tasks: Task[]) => {
      if (mountedRef.current && reqRef.current === my) {
        if (
          !taskLoadResultIsCurrent(
            requestScope,
            scopeKeyRef.current,
            requestDataRevision,
            taskDataRevisionRef.current,
          )
        ) {
          if (scopeKeyRef.current === requestScope) pendingLoadRef.current = true;
          return;
        }
        const ordered = tasks.sort(bySort);
        // 30초 안전망·실시간 신호가 같은 JSON을 돌려줘도 작업표 전체를 다시 그리지 않는다.
        setTasks((previous) => reconcileArrayState(previous, ordered));
      }
    };
    // 프로젝트별 fan-out은 순차 배포 중 구서버에 배치 라우트가 없을 때만 사용한다.
    // 개별 요청 하나라도 실패하면 불완전한 작업표를 정상처럼 표시하지 않는다.
    const fanout = () =>
      Promise.all(
        ps.map((p) =>
          manageApi
            .listTasks(p.pid, workspaceId, showHistory)
            .then((r) => r.map((t) => ({ ...t, project_name: p.name }))),
        ),
      ).then((all) => finish(all.flat()));
    // 우선 1요청(tasks-batch). 서버가 pid 별 read 게이트를 적용해 {pid: tasks} 반환.
    const request = manageApi
      .listTasksBatch(ps.map((p) => p.pid), workspaceId, showHistory)
      .then((byPid) => {
        finish(ps.flatMap((p) => (byPid[p.pid] || []).map((t) => ({ ...t, project_name: p.name }))));
      })
      .catch((error) => {
        if (!isRouteMissing(error)) throw error;
        return fanout();
      })
      .catch((error) => {
        // 초기 진입뿐 아니라 수정·삭제·실시간 신호 뒤 재조회 실패도 화면에 표시한다.
        // 빈 배열로 바꾸지 않아 장애를 "작업 없음"으로 오인하지 않게 한다.
        if (
          mountedRef.current &&
          reqRef.current === my &&
          scopeKeyRef.current === requestScope
        ) {
          setErr(String(error?.message || error));
        }
      })
      .finally(async () => {
        if (reqRef.current === my) {
          loadingRef.current = false;
          loadPromiseRef.current = null;
          if (pendingLoadRef.current) {
            pendingLoadRef.current = false;
            if (mountedRef.current) await loadAllRef.current();
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
  // 실패 복구는 '저장을 시작한 스코프'에 귀속 — 전환 후 도착한 실패가 현재 화면을 흔들지 않는다.
  const orderQueueFor = (scope: string) => {
    const queues = orderSaveQueuesRef.current;
    let queue = queues.get(scope);
    if (!queue) {
      queue = createLatestMutationQueue(async (error) => {
        if (!mountedRef.current) return;
        // 떠난 스코프의 뒤늦은 실패로 현재 화면에 경고창을 띄우지 않는다(검증 P3) —
        // 그 스코프로 돌아가면 loadAll 재조회가 서버 정본으로 화면을 맞춘다.
        if (!scopeIsActive(scope)) return;
        const activeErrors = mutationErrorsForScope([error], scope);
        if (!activeErrors.length) return;
        const [activeError] = activeErrors;
        const revisionBeforeReload = orderRevisionRef.current;
        await recoverTaskWriteFailure(
          "순서 저장",
          activeError,
          (message) => window.alert(message),
          async () => {
            if (scopeIsActive(scope)) await loadProjectsRef.current();
          },
        );
        const optimistic = optimisticOrderRef.current;
        if (
          scopeIsActive(scope) &&
          optimistic?.scope === scope &&
          optimistic.revision !== revisionBeforeReload
        ) {
          setTasks(optimistic.tasks);
        }
      });
      queues.set(scope, queue);
    }
    return queue;
  };

  const loadProjects = (): Promise<void> => {
    if (!mountedRef.current) return Promise.resolve();
    const requestId = ++projectReqRef.current;
    const requestScope = scopeKey;
    setErr(null);
    const projectRows = workspaceId
      ? manageApi
          .taskProjects(workspaceId, showHistory)
          .then((result) => result.projects)
          .catch((error) => {
            // 순차 배포 중 구서버(새 라우트 없음)만 기존 현재-프로젝트 목록으로 폴백한다.
            // 권한/서버 오류는 숨기지 않는다.
            if (!isRouteMissing(error)) throw error;
            return api.projects("team", showHistory, workspaceId).then((result) => result.projects);
          })
      : api.projects("team", showHistory, workspaceId).then((result) => result.projects);
    return projectRows
      .then((rows) => {
        if (
          !mountedRef.current ||
          projectReqRef.current !== requestId ||
          scopeKeyRef.current !== requestScope
        )
          return;
        const ps = rows.map((p) => ({ pid: p.id, name: p.name }));
        projectsRef.current = ps;
        setProjects(ps);
        return loadAllRef.current();
      })
      .catch((e) => {
        if (
          mountedRef.current &&
          projectReqRef.current === requestId &&
          scopeKeyRef.current === requestScope
        )
          setErr(String(e?.message || e));
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
    // 새 범위 응답이 오기 전까지 이전 범위의 행을 과거/현재 데이터처럼 보여주지 않는다.
    projectsRef.current = [];
    setProjects([]);
    setTasks([]);
    void loadProjectsRef.current();
  }, [showHistory]);

  const writeBlocked = (tid?: string): boolean => {
    const task = tid ? tasks.find((item) => item.id === tid) : undefined;
    if (!task) {
      window.alert("작업 목록이 변경되었습니다. 새로 불러온 뒤 다시 시도해 주세요.");
      return true;
    }
    if (!showHistory && !taskIsReadOnly(task)) return false;
    window.alert(
      task?.workspace_unresolved
        ? "워크스페이스 귀속 확인이 필요한 작업은 수정할 수 없습니다."
        : "과거 워크스페이스 기록은 읽기 전용입니다.",
    );
    return true;
  };

  const recoverWriteFailure = async (
    action: string,
    error: unknown,
    requestScope = scopeKey,
  ) => {
    if (!scopeIsActive(requestScope)) return;
    await recoverTaskWriteFailure(
      action,
      error,
      (message) => window.alert(message),
      async () => {
        if (scopeIsActive(requestScope)) await loadProjectsRef.current();
      },
    );
  };

  if (!taskPatchQueueRef.current) {
    taskPatchQueueRef.current = createKeyedMutationQueue(async (_tid, errors) => {
      if (!mountedRef.current) return;
      const requestScope = scopeKeyRef.current;
      const activeErrors = mutationErrorsForScope(errors, requestScope);
      if (!activeErrors.length) return;
      const error =
        activeErrors.find((item) => isHttpStatus(item, 409)) ??
        activeErrors.find((item) => isHttpStatus(item, 404)) ??
        activeErrors[activeErrors.length - 1];
      await recoverWriteFailure("작업 수정", error, requestScope);
    });
  }

  const onPatch = (tid: string, patch: Partial<Task>) => {
    if (writeBlocked(tid)) return;
    const requestScope = scopeKey;
    void taskPatchQueueRef.current!.enqueue(tid, async () => {
      try {
        await manageApi.updateTask(tid, patch);
        taskDataRevisionRef.current += 1;
      } catch (error) {
        throw scopedMutationError(requestScope, error);
      }
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
      if (!scopeIsActive(requestScope)) return;
      if (simpleOnly) {
        setTasks((prev) => prev.map((t) => (t.id === tid ? { ...t, ...patch } : t)));
      } else {
        await loadAllRef.current();
      }
    });
  };
  const onDelete = (tid: string) => {
    if (writeBlocked(tid)) return;
    const requestScope = scopeKey;
    void (async () => {
      try {
        await manageApi.deleteTask(tid);
        taskDataRevisionRef.current += 1;
        if (scopeIsActive(requestScope)) await loadAllRef.current();
      } catch (error) {
        await recoverWriteFailure("작업 삭제", error, requestScope);
      }
    })();
  };
  const onLinkGen = (tid: string, genId: string) => {
    if (writeBlocked(tid)) return;
    const requestScope = scopeKey;
    void (async () => {
      try {
        await manageApi.linkGenerations(tid, [genId]);
        taskDataRevisionRef.current += 1;
        if (scopeIsActive(requestScope)) await loadAllRef.current();
      } catch (error) {
        await recoverWriteFailure("생성물 연결", error, requestScope);
      }
    })();
  };
  const onUnlinkGen = (tid: string, genId: string) => {
    if (writeBlocked(tid)) return;
    const requestScope = scopeKey;
    void (async () => {
      try {
        await manageApi.unlinkGeneration(tid, genId);
        taskDataRevisionRef.current += 1;
        if (scopeIsActive(requestScope)) await loadAllRef.current();
      } catch (error) {
        await recoverWriteFailure("생성물 연결 해제", error, requestScope);
      }
    })();
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
  // '내 작업'은 실제 생성물 creator_uid 기준 자동 파생만 사용한다(수동 배정 폐기). 개인 모드에서는
  // 각 행의 생성물·크레딧·시간·기간도 본인 컷만으로 다시 계산해 팀 전체 수치가 섞이지 않게 한다.
  const visibleScope = useMemo(
    () => (mineOnly && myUid ? scopeTasksToCreator(effective, myUid) : effective),
    [effective, mineOnly, myUid],
  );
  const filtered = useMemo(
    () => visibleScope.filter((task) => matchTask(task, filters)),
    [filters, visibleScope],
  );

  // 필터·검색·내 작업 보기 중에는 드래그 정렬을 막는다 — 숨겨진 작업과의 상대 순서를 알 수 없어
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
    if (writeBlocked(draggedId) || writeBlocked(targetId)) return;
    if (filterActive) {
      window.alert("필터·검색 중에는 순서를 바꿀 수 없습니다. 필터를 해제한 뒤 정렬해 주세요.");
      return;
    }
    // 전체 스냅샷 계약이라 페이로드에 미확정(귀속 확인 필요) 행이 섞이면 서버가 요청 전체를
    // 409 로 거절한다 — 옮기는 두 행만 검사하면 남의 미확정 행 때문에 조용히 실패한다(합의 C-2).
    // 미확정 행만 뺀 부분 전송은 상대 앵커를 훼손하므로, 스코프에 하나라도 있으면 정렬을 막는다.
    if (filtered.some((t) => t.workspace_unresolved)) {
      window.alert(
        "귀속 확인이 필요한 작업이 있어 순서를 바꿀 수 없습니다. 해당 작업의 워크스페이스 귀속을 먼저 정리해 주세요.",
      );
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
    const requestScope = scopeKey;
    optimisticOrderRef.current = { revision, scope: requestScope, tasks: optimisticTasks };
    setTasks(optimisticTasks);
    // 실행 중 1건은 유지하되 대기 중인 중간 스냅샷은 '같은 스코프의' 최신 순서 하나로 교체하고,
    // 실제 PUT 은 전역 체인으로 직렬화한다(겹치는 스코프의 병렬 PUT 순서 역전 방지 — 검증 P2).
    orderQueueFor(requestScope).enqueue(() =>
      serializeOrderWrite(async () => {
        try {
          await manageApi.updateTaskOrderSnapshot(ids);
          taskDataRevisionRef.current += 1;
          const latest = optimisticOrderRef.current;
          if (scopeIsActive(requestScope) && latest?.scope === requestScope) {
            setTasks(latest.tasks);
          }
        } catch (error) {
          throw scopedMutationError(requestScope, error);
        }
      }),
    );
  };

  // 선택 일괄 삭제 — 확인 후 작업 행 삭제. (폴더 자동 작업은 생성물이 남아 있으면 다음 동기화 때
  // 다시 생성됨 — 실질 삭제는 생성탭에서 생성물 자체를 지워야 함. 여기선 정리용.)
  const bulkDelete = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    if (ids.some((id) => writeBlocked(id))) return;
    if (!window.confirm(`선택한 작업 ${ids.length}개를 삭제할까요?`)) return;
    const requestScope = scopeKey;
    try {
      await manageApi.deleteTasksBatch(ids);
      taskDataRevisionRef.current += 1;
      if (!scopeIsActive(requestScope)) return;
      clearSel();
      await loadAllRef.current();
    } catch (e) {
      await recoverWriteFailure("작업 삭제", e, requestScope);
    }
  };

  if (err)
    return (
      <div className="manage-empty">
        <div>불러오기 실패: {err}</div>
        <button type="button" onClick={() => void loadProjectsRef.current()}>
          다시 시도
        </button>
      </div>
    );

  const viewProps: WorkViewProps = {
    tasks: filtered,
    seqOptions,
    myUid,
    readOnly: showHistory,
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
          {/* 실제로 만든 생성물을 현재 작업자 기준으로 표시한다. */}
          {myUid ? (
            <button
              className={"work-mine-toggle" + (mineOnly ? " on" : "")}
              onClick={() => setMineOnly((v) => !v)}
              title="내가 만든 작업만 보기"
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

      {showHistory && (
        <div className="work-readonly-notice" role="status">
          과거 워크스페이스 기록 · 조회만 가능하며 수정·정렬·연결·삭제는 할 수 없습니다.
        </div>
      )}

      {!projects.length ? (
        <div className="manage-empty">프로젝트를 먼저 만들어 생성물을 귀속하세요.</div>
      ) : view === "board" ? (
        <BoardView {...viewProps} />
      ) : view === "table" ? (
        <TableView {...viewProps} />
      ) : (
        <CalendarView {...viewProps} />
      )}

      {!showHistory && selected.size > 0 && (
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
