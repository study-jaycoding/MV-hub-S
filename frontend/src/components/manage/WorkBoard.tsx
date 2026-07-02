// 작업 탭 컨테이너 — 프로젝트 선택 · 보드/테이블 뷰 전환 · 필터 · 생성물(컷 드래그 소스) 패널.
// 데이터·핸들러를 소유하고 BoardView/TableView 에 주입한다.
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { addDisabledGen, DISABLED_EVENT, loadDisabledGen } from "../../lib/deactivated";
import { onLibraryChanged } from "../../lib/libraryBroadcast";
import { manageApi } from "../../lib/manageApi";
import { thumbOf as generationThumbOf, thumbUrl } from "../../lib/media";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import type { Generation } from "../../types";
import { CalendarView } from "./CalendarView";
import { BoardView } from "./KanbanBoard";
import { TableView } from "./TableView";
import { useT } from "../../lib/i18n";
import {
  GEN_MIME,
  groupLabel,
  SELECTABLE_STATUSES,
  STATUS_GROUPS,
  type Task,
  statusText,
  type WorkViewProps,
} from "./types";

function taskThumb(path?: string | null): string | undefined {
  return thumbUrl(path, 256) ?? undefined;
}

// 서버가 변형 없이 저장만 하는 필드 — 이것만 담긴 PATCH 는 로컬 상태 갱신으로 끝내고 재호출 생략.
// (status=파생 재계산, sequence=컷 재매칭, assignee=이름 해석 → 여기 없음 → 재호출 유지)
const SIMPLE_PATCH_FIELDS = new Set([
  "name",
  "note",
  "description",
  "start_date",
  "due_date",
  "sort_order",
]);

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
  // d 로 비활성화(회색)된 생성물 id — localStorage 기준. 컷 회색 표시 + 자동 생략 판정에 쓴다.
  const [disabled, setDisabled] = useState<Set<string>>(() => loadDisabledGen());

  // 비활성화 집합 최신화 — 같은 창(생성탭이 같은 페이지)은 DISABLED_EVENT, 다른 창(별도 생성탭
  // 창)은 storage 이벤트로 감지한다(둘 다 같은 localStorage 를 본다).
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

  useEffect(() => {
    // 프로젝트 목록만 필요 → 무거운 summary()(전체 생성물 scan) 대신 가벼운 프로젝트 목록 API.
    api
      .projects("team")
      .then((r) => {
        const ps = r.projects.map((p) => ({ pid: p.id, name: p.name }));
        setProjects(ps);
        setPid((cur) => cur || (ps[0]?.pid ?? ""));
      })
      .catch((e) => setErr(String(e?.message || e)));
    api.facets().then((f) => setSeqOptions(f.auto_tags || [])).catch(() => {});
    api.provider().then((p) => setMyUid(p.uid || null)).catch(() => {});
  }, []);

  // 현재 pid — 폴링/브로드캐스트로 여러 요청이 겹칠 때, 느린 이전 프로젝트 응답이
  // 뒤늦게 도착해 현재 화면을 덮지 않도록 응답 시점에 pid 를 대조한다.
  const pidRef = useRef(pid);
  useEffect(() => {
    pidRef.current = pid;
  }, [pid]);
  const loadTasks = (p: string) => {
    if (!p) return;
    manageApi
      .listTasks(p)
      .then((r) => {
        if (pidRef.current === p) setTasks(r);
      })
      .catch((e) => setErr(String(e?.message || e)));
  };
  const loadGens = (p: string) => {
    if (!p) return;
    api
      .listGenerations({ tab: "my", project_id: p }, null, 200)
      .then((r) => {
        if (pidRef.current === p) setGens(r);
      })
      .catch(() => {
        if (pidRef.current === p) setGens([]);
      });
  };
  useEffect(() => {
    if (pid) {
      loadTasks(pid);
      loadGens(pid);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  // 실시간 반영 — 내 조작은 즉시(브로드캐스트), 팀원(다른 PC) 변경은 폴링으로.
  useEffect(() => {
    if (!pid) return;
    let debounce: number | undefined;
    const reload = () => {
      if (debounce) clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        loadTasks(pid);
        loadGens(pid);
      }, 300);
    };
    // 팀원 변경 폴링 — 관리탭이 화면에 보일 때만(숨겨진 창은 부하 안 줌).
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, 12000);
    // 창이 다시 보이면 즉시 최신화(폴링 주기 안 기다리게).
    const onVis = () => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", onVis);
    // 내 조작 즉시 반영 — 생성탭(다른 창)에서 담기/폴더·최종·공유·삭제 시 신호.
    const offBroadcast = onLibraryChanged(reload);
    return () => {
      if (debounce) clearTimeout(debounce);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVis);
      offBroadcast();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  const onPatch = async (tid: string, patch: Partial<Task>) => {
    await manageApi.updateTask(tid, patch);
    // '생략'으로 옮기면 그 작업의 컷(생성물)을 모두 비활성화(d 누른 효과) — 라이브러리에 회색 반영.
    if (patch.status === "omit") {
      const t = tasks.find((x) => x.id === tid);
      const ids = (t?.cuts || []).map((c) => c.id);
      addDisabledGen(ids);
    }
    // 서버가 값을 '그대로 저장만' 하는 단순 필드면 로컬 상태만 갱신하고 전체 재호출 생략(빠름).
    // 상태·시퀀스·컷연결은 서버가 파생/재매칭하므로 재호출(폴더 자동 상태와 어긋나지 않게). 애매하면 재호출.
    const keys = Object.keys(patch);
    const simpleOnly =
      keys.length > 0 && keys.every((k) => SIMPLE_PATCH_FIELDS.has(k));
    if (simpleOnly) {
      setTasks((prev) => prev.map((t) => (t.id === tid ? { ...t, ...patch } : t)));
    } else {
      loadTasks(pid);
    }
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

  // 자동 생략 — 작업의 컷이 전부 비활성화(d)되면(컷 1개면 그게 꺼질 때 포함) 그 작업을 '생략'으로.
  // omitReqRef 로 in-flight 중복 요청을 막는다(patch→addDisabledGen→이벤트→재실행 순간 이중 호출 방지).
  const omitReqRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!disabled.size) return;
    for (const t of tasks) {
      const cuts = t.cuts || [];
      const allOff = cuts.length > 0 && cuts.every((c) => disabled.has(c.id));
      if (t.status === "omit" || !allOff) {
        omitReqRef.current.delete(t.id); // 이미 생략됐거나 조건 해제 → 재요청 가능 상태로
        continue;
      }
      if (omitReqRef.current.has(t.id)) continue; // 이미 요청 중
      omitReqRef.current.add(t.id);
      onPatch(t.id, { status: "omit" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, disabled]);

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
          {STATUS_GROUPS.map((g) => {
            const opts = SELECTABLE_STATUSES.filter((s) => s.group === g);
            if (!opts.length) return null; // '시작 전'만 있던 그룹은 통째로 숨김
            return (
              <optgroup key={g} label={groupLabel(g)}>
                {opts.map((s) => (
                  <option key={s.v} value={s.v}>
                    {statusText(s)}
                  </option>
                ))}
              </optgroup>
            );
          })}
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
