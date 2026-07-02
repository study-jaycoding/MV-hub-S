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
  type WorkViewProps,
} from "./types";

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
  const [view, setView] = useState<"board" | "table" | "calendar">("board");
  const [filters, setFilters] = useState<WorkFilters>(emptyWorkFilters);
  const [err, setErr] = useState<string | null>(null);
  // d 로 비활성화(회색)된 생성물 id — localStorage 기준. 컷 회색 표시 + effective 생략 판정에 쓴다.
  const [disabled, setDisabled] = useState<Set<string>>(() => loadDisabledGen());

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
      if (reqRef.current === my) setTasks(all.flat());
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

  if (err) return <div className="manage-empty">불러오기 실패: {err}</div>;

  const viewProps: WorkViewProps = {
    tasks: filtered,
    seqOptions,
    thumb: taskThumb,
    disabled,
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
            <button className={view === "board" ? "on" : ""} onClick={() => setView("board")}>
              보드
            </button>
            <button className={view === "table" ? "on" : ""} onClick={() => setView("table")}>
              테이블
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
    </div>
  );
}
