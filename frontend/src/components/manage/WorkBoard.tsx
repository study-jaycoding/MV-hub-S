// 작업 탭 컨테이너 — 전체 프로젝트의 작업을 병합해 보여주고, 노션식 칩 필터(프로젝트/에피소드/
// 시퀀스/상태/생성자)+검색으로 좁힌다. 보드/테이블/캘린더에 데이터·핸들러를 주입한다.
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import {
  addDisabledGen,
  DISABLED_EVENT,
  loadDisabledGen,
  removeDisabledGen,
} from "../../lib/deactivated";
import { onLibraryChanged } from "../../lib/libraryBroadcast";
import { manageApi } from "../../lib/manageApi";
import { thumbUrl } from "../../lib/media";
import { loadJSON, loadString, saveJSON, saveString } from "../../lib/storage";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import { CalendarView } from "./CalendarView";
import { BoardView } from "./KanbanBoard";
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
  return {
    active: Array.isArray(saved.active)
      ? saved.active.filter((f) => WORK_FILTER_FIELDS.includes(f))
      : [],
    values: { ...base.values, ...(saved.values || {}) },
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
  if (v.project.length && !v.project.includes(t.project_name || "")) return false;
  if (v.episode.length && !v.episode.includes(t.name)) return false;
  if (v.sequence.length && !v.sequence.includes(t.sequence || "")) return false;
  if (v.status.length && !v.status.includes(t.status)) return false;
  if (v.creator.length && !(t.creators || []).some((c) => v.creator.includes(c))) return false;
  const q = f.search.trim().toLowerCase();
  if (q) {
    const hay = [t.name, t.sequence, t.description, t.project_name, ...(t.creators || [])]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export function WorkBoard() {
  useT(); // 언어 토글 시 라벨 리렌더
  const [projects, setProjects] = useState<{ pid: string; name: string }[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]); // 전체 프로젝트 병합(project_name 부착)
  const [seqOptions, setSeqOptions] = useState<string[]>([]);
  const [view, setView] = useState<WorkView>(
    () => (loadString(STORAGE_KEYS.manageWorkView, "table") as WorkView) || "table",
  );
  const [filters, setFilters] = useState<WorkFilters>(loadFilters);
  const [err, setErr] = useState<string | null>(null);
  // d 로 비활성화(회색)된 생성물 id — localStorage 기준. 컷 회색 표시 + effective 생략 판정에 쓴다.
  const [disabled, setDisabled] = useState<Set<string>>(() => loadDisabledGen());
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
    const refresh = () => setDisabled(loadDisabledGen());
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.historyDisabled || e.key === null) refresh();
    };
    window.addEventListener(DISABLED_EVENT, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(DISABLED_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // 전체 프로젝트 작업 병합 로드 — 프로젝트별 listTasks 를 병렬 호출해 합친다(project_name 부착).
  // reqRef 로 늦게 온 이전 요청이 최신 화면을 덮지 않게 한다(폴링/브로드캐스트 중첩 대비).
  const projectsRef = useRef(projects);
  const reqRef = useRef(0);
  const loadAll = () => {
    const ps = projectsRef.current;
    if (!ps.length) {
      setTasks([]);
      return;
    }
    const my = ++reqRef.current;
    Promise.all(
      ps.map((p) =>
        manageApi
          .listTasks(p.pid)
          .then((r) => r.map((t) => ({ ...t, project_name: p.name })))
          .catch(() => [] as Task[]),
      ),
    ).then((all) => {
      if (reqRef.current === my) setTasks(all.flat().sort(bySort));
    });
  };

  useEffect(() => {
    api
      .projects("team")
      .then((r) => {
        const ps = r.projects.map((p) => ({ pid: p.id, name: p.name }));
        projectsRef.current = ps;
        setProjects(ps);
        loadAll();
      })
      .catch((e) => setErr(String(e?.message || e)));
    api.facets().then((f) => setSeqOptions(f.auto_tags || [])).catch(() => {});
  }, []);

  // 실시간 반영 — 내 조작은 즉시(브로드캐스트), 팀원(다른 PC) 변경은 폴링으로.
  useEffect(() => {
    let debounce: number | undefined;
    const reload = () => {
      if (debounce) clearTimeout(debounce);
      debounce = window.setTimeout(loadAll, 300);
    };
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, 12000);
    const onVis = () => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", onVis);
    const offBroadcast = onLibraryChanged(reload);
    return () => {
      if (debounce) clearTimeout(debounce);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVis);
      offBroadcast();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPatch = async (tid: string, patch: Partial<Task>) => {
    await manageApi.updateTask(tid, patch);
    // 상태 이동과 컷 활성화 동기화(대칭): 생략→컷 비활성화, 생략에서 빼면→컷 재활성화.
    if (patch.status) {
      const t = tasks.find((x) => x.id === tid);
      const ids = (t?.cuts || []).map((c) => c.id);
      if (patch.status === "omit") {
        addDisabledGen(ids);
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

  // effective 상태 — 컷이 전부 비활성화(d)면 화면에서만 '생략'으로. 재활성화 시 자동 복귀(서버 미기록).
  const effective = useMemo(
    () =>
      tasks.map((t) => {
        if (t.status === "omit" || !disabled.size) return t;
        const cuts = t.cuts || [];
        const allOff = cuts.length > 0 && cuts.every((c) => disabled.has(c.id));
        return allOff ? { ...t, status: "omit" } : t;
      }),
    [tasks, disabled],
  );
  const filtered = useMemo(() => effective.filter((t) => matchTask(t, filters)), [effective, filters]);

  // 드래그 순서변경 — 표시 순서에서 draggedId 를 targetId 앞으로 옮기고 sort_order 를 재부여(전역 유지).
  const onReorder = (draggedId: string, targetId: string) => {
    const ids = filtered.map((t) => t.id);
    if (draggedId === targetId || !ids.includes(draggedId) || !ids.includes(targetId)) return;
    const [moved] = ids.splice(ids.indexOf(draggedId), 1);
    ids.splice(ids.indexOf(targetId), 0, moved); // 제거 후 대상 위치를 다시 찾아 그 앞에 삽입
    const orderMap = new Map(ids.map((id, i) => [id, i * 10]));
    setTasks((prev) =>
      prev.map((t) => (orderMap.has(t.id) ? { ...t, sort_order: orderMap.get(t.id)! } : t)).sort(bySort),
    );
    ids.forEach((id) => {
      const cur = tasks.find((x) => x.id === id);
      const so = orderMap.get(id)!;
      if (cur && cur.sort_order !== so) manageApi.updateTask(id, { sort_order: so });
    });
  };

  // 선택 일괄 삭제 — 확인 후 작업 행 삭제. (폴더 자동 작업은 생성물이 남아 있으면 다음 동기화 때
  // 다시 생성됨 — 실질 삭제는 생성탭에서 생성물 자체를 지워야 함. 여기선 정리용.)
  const bulkDelete = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    if (!window.confirm(`선택한 작업 ${ids.length}개를 삭제할까요?`)) return;
    await Promise.all(ids.map((id) => manageApi.deleteTask(id).catch(() => {})));
    clearSel();
    loadAll();
  };

  if (err) return <div className="manage-empty">불러오기 실패: {err}</div>;

  const viewProps: WorkViewProps = {
    tasks: filtered,
    seqOptions,
    thumb: taskThumb,
    disabled,
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
        <h1>작업</h1>
        <div className="work-head-ctl">
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

      <WorkFilterBar tasks={effective} filters={filters} onChange={setFilters} />

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
