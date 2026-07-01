// 작업 탭 컨테이너 — 프로젝트 선택 · 보드/테이블 뷰 전환 · 필터 · 생성물(컷 드래그 소스) 패널.
// 데이터·핸들러를 소유하고 BoardView/TableView 에 주입한다.
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { manageApi } from "../../lib/manageApi";
import { thumbOf as generationThumbOf, thumbUrl } from "../../lib/media";
import type { Generation } from "../../types";
import { CalendarView } from "./CalendarView";
import { BoardView } from "./KanbanBoard";
import { TableView } from "./TableView";
import { useT } from "../../lib/i18n";
import {
  GEN_MIME,
  groupLabel,
  STATUS_GROUPS,
  STATUSES,
  statusText,
  type Task,
  type WorkViewProps,
} from "./types";

function taskThumb(path?: string | null): string | undefined {
  return thumbUrl(path, 256) ?? undefined;
}

export function WorkBoard() {
  useT(); // 언어 토글 시 필터·라벨 리렌더
  const [projects, setProjects] = useState<{ pid: string; name: string }[]>([]);
  const [pid, setPid] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [gens, setGens] = useState<Generation[]>([]);
  const [seqOptions, setSeqOptions] = useState<string[]>([]);
  const [view, setView] = useState<"board" | "table" | "calendar">("board");
  const [myUid, setMyUid] = useState<string | null>(null);
  const [fStatus, setFStatus] = useState("");
  const [fMine, setFMine] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    manageApi
      .summary()
      .then((s) => {
        const ps = s.projects
          .filter((p) => p.pid)
          .map((p) => ({ pid: p.pid as string, name: p.name }));
        setProjects(ps);
        setPid((cur) => cur || (ps[0]?.pid ?? ""));
      })
      .catch((e) => setErr(String(e?.message || e)));
    api.facets().then((f) => setSeqOptions(f.auto_tags || [])).catch(() => {});
    api.provider().then((p) => setMyUid(p.uid || null)).catch(() => {});
  }, []);

  const loadTasks = (p: string) => {
    if (p) manageApi.listTasks(p).then(setTasks).catch((e) => setErr(String(e?.message || e)));
  };
  const loadGens = (p: string) => {
    if (p)
      api
        .listGenerations({ tab: "my", project_id: p }, null, 200)
        .then(setGens)
        .catch(() => setGens([]));
  };
  useEffect(() => {
    if (pid) {
      loadTasks(pid);
      loadGens(pid);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  const onCreate = async (status: string, name: string) => {
    if (!name.trim() || !pid) return;
    await manageApi.createTask({ project_id: pid, name: name.trim(), status });
    loadTasks(pid);
  };
  const onPatch = async (tid: string, patch: Partial<Task>) => {
    await manageApi.updateTask(tid, patch);
    loadTasks(pid);
  };
  const onDelete = async (tid: string) => {
    await manageApi.deleteTask(tid);
    loadTasks(pid);
  };
  const onLinkGen = async (tid: string, genId: string) => {
    await manageApi.linkGenerations(tid, [genId]);
    loadTasks(pid);
  };
  const onUnlinkGen = async (tid: string, genId: string) => {
    await manageApi.unlinkGeneration(tid, genId);
    loadTasks(pid);
  };

  const filtered = useMemo(
    () =>
      tasks.filter((t) => {
        if (fStatus && t.status !== fStatus) return false;
        if (fMine && myUid && !(t.cuts || []).some((c) => c.creator_uid === myUid)) return false;
        return true;
      }),
    [tasks, fStatus, fMine, myUid],
  );

  if (err) return <div className="manage-empty">불러오기 실패: {err}</div>;

  const viewProps: WorkViewProps = {
    tasks: filtered,
    seqOptions,
    thumb: taskThumb,
    onCreate,
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
          <select className="manage-proj-select" value={pid} onChange={(e) => setPid(e.target.value)}>
            {!projects.length && <option value="">(프로젝트 없음)</option>}
            {projects.map((p) => (
              <option key={p.pid} value={p.pid}>
                {p.name}
              </option>
            ))}
          </select>
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

      <div className="work-filterbar">
        <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
          <option value="">상태 전체</option>
          {STATUS_GROUPS.map((g) => (
            <optgroup key={g} label={groupLabel(g)}>
              {STATUSES.filter((s) => s.group === g).map((s) => (
                <option key={s.v} value={s.v}>
                  {statusText(s)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <label className="work-mine">
          <input type="checkbox" checked={fMine} onChange={(e) => setFMine(e.target.checked)} /> 내
          작업만
        </label>
        <button className="work-panel-toggle" onClick={() => setPanelOpen((o) => !o)}>
          {panelOpen ? "생성물 패널 ▲" : "생성물 패널 ▼"}
        </button>
      </div>

      {panelOpen && (
        <div className="work-gen-panel">
          <span className="work-gen-hint">↓ 컷으로 드래그해 연결</span>
          <div className="work-gen-strip">
            {gens.map((g) => {
              const th = generationThumbOf(g, 256);
              return (
                <div
                  key={g.id}
                  className="work-gen-item"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(GEN_MIME, g.id);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  title={g.prompt || g.id}
                >
                  {th ? <img src={th} alt="" loading="lazy" /> : <div className="work-gen-ph">{g.status}</div>}
                </div>
              );
            })}
            {!gens.length && <div className="work-gen-empty">이 프로젝트 생성물 없음</div>}
          </div>
        </div>
      )}

      {!pid ? (
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
