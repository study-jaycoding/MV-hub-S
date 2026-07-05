// 통합 대시보드 — 2단 구조. 상단 '요약'(회사 전체 프로젝트: 제작일수·예산·진행율·인원·관리)
// → 프로젝트 클릭 → 하단 '상세'(그 프로젝트의 에피소드▸시퀀스 진행상황·컷 담당·참여자 3축).
// 요약 행 기준은 summary.projects(빈 프로젝트 포함), 진행율은 list_tasks 상태 롤업으로 통일.
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { manageApi, type TeamBucket, type TeamOverview } from "../../lib/manageApi";
import { projectApi } from "../../lib/projectApi";
import { useManageCaps } from "../../lib/useManageCaps";
import { PROJECT_ROLE_LABEL, type ProjectMember } from "../../types";
import {
  buildHierarchy,
  findNode,
  mergeProjectMembers,
  participantsOf,
  type DashNode,
  type Participant,
  type StatusDist,
} from "./dashboardModel";
import { ProjectManagerPanel } from "./ProjectManagerPanel";
import type { ManageProject, ManageSummary, Planning, Task } from "./types";

// 로컬(브라우저) 자정 기준 오늘 — UTC(toISOString)면 한국 새벽에 D-day 하루 어긋남(코덱스 지적).
function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const TODAY = todayStr();
function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function dayDiff(from: string, to: string): number {
  return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / 86400000);
}
// 제작일수 라벨 — 착수 N일차 · 마감 D-표기
function scheduleLabel(pl?: Planning | null): { text: string; danger: boolean } {
  if (!pl) return { text: "—", danger: false };
  const parts: string[] = [];
  if (pl.start_date) parts.push(`착수 ${dayDiff(pl.start_date, TODAY) + 1}일차`);
  let danger = false;
  if (pl.due_date) {
    const d = dayDiff(TODAY, pl.due_date);
    const done = pl.status === "done";
    if (d > 0) parts.push(`D-${d}`);
    else if (d === 0) { parts.push("D-day"); danger = !done; }
    else { parts.push(`D+${-d} 지남`); danger = !done; }
  }
  return { text: parts.length ? parts.join(" · ") : "—", danger };
}

function fmtDur(sec: number): string {
  if (!sec || sec <= 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h${m ? m + "m" : ""}` : `${m || Math.floor(sec)}m`;
}
function fmtCr(n: number): string {
  return n ? Math.round(n).toLocaleString() : "—";
}
function roleShort(role: string): string {
  return (PROJECT_ROLE_LABEL[role] || role).split(" · ")[0];
}

const STATUS_OPTS: { v: string; label: string }[] = [
  { v: "active", label: "진행" },
  { v: "hold", label: "보류" },
  { v: "done", label: "완료" },
];
function statusLabel(s?: string | null): string {
  return STATUS_OPTS.find((o) => o.v === s)?.label ?? "—";
}

function StackBar({ dist }: { dist: StatusDist }) {
  const total = dist.done + dist.publish + dist.prog + dist.idle || 1;
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <span className="dash-stack" title={`완료 ${dist.done}·게시 ${dist.publish}·진행 ${dist.prog}·시작전 ${dist.idle}`}>
      <i className="s-done" style={{ width: pct(dist.done) }} />
      <i className="s-pub" style={{ width: pct(dist.publish) }} />
      <i className="s-prog" style={{ width: pct(dist.prog) }} />
      <i className="s-idle" style={{ width: pct(dist.idle) }} />
    </span>
  );
}

// 하단 상세 트리 행(에피소드▸시퀀스) — 담당·마감·작업·크레딧·제작시간
function TreeRow({
  node,
  depth,
  expanded,
  onToggle,
  selectedKey,
  onSelect,
}: {
  node: DashNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (k: string) => void;
  selectedKey: string | null;
  onSelect: (n: DashNode) => void;
}) {
  const hasChildren = !!node.children?.length;
  const open = expanded.has(node.key);
  return (
    <>
      <tr
        className={`dash-row dash-${node.kind}${selectedKey === node.key ? " sel" : ""}`}
        onClick={() => onSelect(node)}
      >
        <td className="l">
          <span className="dash-name" style={{ paddingLeft: depth * 18 }}>
            {hasChildren ? (
              <button
                className="dash-caret"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(node.key);
                }}
              >
                {open ? "▾" : "▸"}
              </button>
            ) : (
              <span className="dash-caret-sp" />
            )}
            {node.label}
          </span>
        </td>
        <td className="l">
          <span className="dash-prog-cell">
            <StackBar dist={node.dist} />
            <span className="dash-pct tnum">{Math.round(node.progress * 100)}%</span>
          </span>
        </td>
        <td className="l dash-asgn">{node.assigneeLabel}</td>
        <td className={node.dueDate && node.dueDate < TODAY ? "dash-due overdue" : "dash-due"}>
          {node.dueDate ? node.dueDate.slice(5) : "—"}
        </td>
        <td className="tnum">{node.taskCount}</td>
        <td className="tnum">{fmtCr(node.credits)}</td>
        <td className="tnum">
          {fmtDur(node.elapsed)}
          {node.elapsedKnown < node.taskCount ? (
            <span className="dash-cov" title="시간 측정 커버리지"> · {node.elapsedKnown}/{node.taskCount}</span>
          ) : null}
        </td>
      </tr>
      {open &&
        node.children?.map((c) => (
          <TreeRow
            key={c.key}
            node={c}
            depth={depth + 1}
            expanded={expanded}
            onToggle={onToggle}
            selectedKey={selectedKey}
            onSelect={onSelect}
          />
        ))}
    </>
  );
}

// 참여자 배지(역할 + 배정/예정/생성)
function Badges({ p }: { p: Participant }) {
  return (
    <span className="dash-badges">
      {(p.roles || []).map((r) => (
        <span key={r} className={`dash-bdg role ${r}`}>{roleShort(r)}</span>
      ))}
      {p.assign ? <span className="dash-bdg assign">배정</span> : null}
      {p.planned ? <span className="dash-bdg planned">예정</span> : null}
      {p.create ? <span className="dash-bdg create">생성</span> : null}
    </span>
  );
}

// ── 하단 상세: 선택 프로젝트 한 개의 에피소드▸시퀀스 트리 + 참여자 3축/롤
function ProjectDetail({
  pid,
  node,
  members,
  projName,
}: {
  pid: string | null;
  node: DashNode | null;
  members: ProjectMember[];
  projName: string;
}) {
  // 상세 내부 선택(시퀀스 클릭 → 참여자 좁힘)
  const [subKey, setSubKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 프로젝트가 바뀌거나 구조가 갱신되면 에피소드 전부 펼치고 하위 선택 초기화
  useEffect(() => {
    setSubKey(null);
    setExpanded(new Set((node?.children || []).map((c) => c.key)));
  }, [pid, node]);

  if (!pid) {
    return (
      <div className="dash-detail-empty">
        위 요약에서 <b>프로젝트를 클릭</b>하면 여기에 에피소드·시퀀스 진행상황과 담당(누가 어느 컷)이 나옵니다.
      </div>
    );
  }
  // 빈 프로젝트(작업 0개)면 node 가 없다 — 트리는 '작업 없음', 참여자는 멤버·역할만 표시.
  const subNode = node && subKey ? findNode(node.children || [], subKey) : null;
  const participants = subNode
    ? participantsOf(subNode)
    : mergeProjectMembers(node ? participantsOf(node) : [], members);
  const scopeLabel = subNode
    ? `${subNode.kind === "episode" ? "에피소드" : "시퀀스"} · ${subNode.label}`
    : `프로젝트 · ${projName}`;

  const toggle = (k: string) =>
    setExpanded((prev) => {
      const s = new Set(prev);
      s.has(k) ? s.delete(k) : s.add(k);
      return s;
    });

  return (
    <div className="dash-cols">
      <div className="dash-tree-card">
        <div className="hd">
          <h2>{projName} — 에피소드 ▸ 시퀀스</h2>
          <span className="meta">행 클릭 → 참여자 좁힘 · ▸ 펼치기</span>
        </div>
        {node && node.children?.length ? (
          <div className="dash-tbl-scroll">
            <table className="dash-tree">
              <thead>
                <tr>
                  <th className="l">이름</th>
                  <th className="l">상태·진척</th>
                  <th className="l">담당</th>
                  <th>마감</th>
                  <th>작업</th>
                  <th>크레딧</th>
                  <th>제작시간</th>
                </tr>
              </thead>
              <tbody>
                {node.children.map((c) => (
                  <TreeRow
                    key={c.key}
                    node={c}
                    depth={0}
                    expanded={expanded}
                    onToggle={toggle}
                    selectedKey={subKey}
                    onSelect={(n) => setSubKey((cur) => (cur === n.key ? null : n.key))}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="dash-part-empty">
            {node
              ? "폴더 라벨이 붙은 작업이 없습니다. 작업 탭에서 폴더를 연결하세요."
              : "이 프로젝트에 등록된 작업이 없습니다. 작업 탭에서 폴더를 연결하면 진행상황이 집계됩니다."}
          </div>
        )}
        <div className="dash-legend">
          <span><i className="s-done" /> 완료</span>
          <span><i className="s-pub" /> 게시</span>
          <span><i className="s-prog" /> 진행중</span>
          <span><i className="s-idle" /> 시작전</span>
          <span className="dim">· 크레딧·시간은 작업 연결 컷 기준</span>
        </div>
      </div>

      <div className="dash-side">
        <div className="hd">
          <h2>참여자</h2>
          <span className="meta">{scopeLabel}</span>
        </div>
        {participants.length ? (
          participants.map((p) => (
            <div className="dash-part" key={p.uid}>
              <span className="dash-part-nm">{p.name}</span>
              <Badges p={p} />
            </div>
          ))
        ) : (
          <div className="dash-part-empty">참여자 없음 — 담당 배정·예정 생성자 지정 필요</div>
        )}
        <div className="dash-part-note">
          {subNode
            ? "배정(PM 지정) · 예정(내가 할 작업) · 생성(실제 만듦). 선택한 행을 다시 누르면 프로젝트 전체로."
            : "PM·감독·제작(역할) + 배정·예정·생성. 소속 멤버는 작업이 없어도 표시됩니다."}
        </div>
      </div>
    </div>
  );
}

export function DashboardView() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [selectedPid, setSelectedPid] = useState<string | null>(null); // 하단 상세 대상
  const [trend, setTrend] = useState<TeamBucket[]>([]);
  const [summary, setSummary] = useState<ManageSummary | null>(null);
  const [team, setTeam] = useState<TeamOverview | null>(null);
  const [members, setMembers] = useState<Map<string, ProjectMember[]>>(new Map());
  const [showPanel, setShowPanel] = useState(false); // 프로젝트 관리 오버레이(＋프로젝트)
  const caps = useManageCaps();
  const canManageProjects = caps.createProject || caps.grantRole;

  // 일정·예산 편집 모달
  const [editPid, setEditPid] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [form, setForm] = useState<Planning>({});
  const [saving, setSaving] = useState(false);

  // 전체 재로딩(프로젝트 목록·작업·예산·멤버·팀) — 프로젝트/멤버 변경 후 즉시 반영.
  // 요약(summary)과 작업(tasks) 둘 다 끝나야 로딩 해제 — 초기 '프로젝트 없음' 깜빡임 방지.
  const reload = () => {
    const summaryP = manageApi
      .summary()
      .then((d) => setSummary(d))
      .catch(() => setSummary(null));
    const tasksP = api
      .projects("team")
      .then((r) => {
        projectApi
          .allProjectMembers()
          .then((byPid) => setMembers(new Map(Object.entries(byPid))))
          .catch(() => setMembers(new Map()));
        return Promise.all(
          r.projects.map((p) =>
            manageApi
              .listTasks(p.id)
              .then((ts) => ts.map((t) => ({ ...t, project_name: p.name })))
              .catch(() => [] as Task[]),
          ),
        );
      })
      .then((all) => setTasks(all.flat()));
    Promise.all([summaryP, tasksP])
      .then(() => setErr("")) // 성공하면 이전 에러 화면 해제
      .catch((e) => setErr(String(e?.message || e)))
      .finally(() => setLoading(false));
    manageApi.teamOverview().then(setTeam).catch(() => setTeam(null));
    manageApi
      .teamTimeseries("week")
      .then((r) => setTrend(r.buckets || []))
      .catch(() => setTrend([]));
  };
  useEffect(reload, []);

  const { tree, totals } = useMemo(() => buildHierarchy(tasks), [tasks]);
  // 프로젝트 id → 그 프로젝트 서브트리(진행율·컷 롤업) 조회용
  const treeByPid = useMemo(() => {
    const m = new Map<string, DashNode>();
    for (const n of tree) m.set(n.projectId, n);
    return m;
  }, [tree]);

  // 요약 행 = summary.projects(빈 프로젝트 포함) 기준 + 트리(진행율)·멤버(인원) 병합
  const rows = useMemo(() => {
    const list = summary?.projects || [];
    return list.map((p) => {
      const node = p.pid ? treeByPid.get(p.pid) : undefined;
      const memberCount = p.pid ? members.get(p.pid)?.length || 0 : 0;
      return { p, node, memberCount };
    });
  }, [summary, treeByPid, members]);

  // 상단 예산 대비(summary 크레딧 기준 — 프로젝트 전체 생성물)
  const budget = useMemo(() => {
    let total = 0, actual = 0, over = 0;
    for (const p of summary?.projects || []) {
      const b = p.planning?.budget_credits;
      if (b) {
        total += b;
        actual += p.credits;
        if (p.credits > b) over += 1;
      }
    }
    return { total, actual, over, pct: total ? actual / total : 0 };
  }, [summary]);

  const trendMax = useMemo(() => Math.max(1, ...trend.map((p) => p.credits)), [trend]);

  const selNode = selectedPid ? treeByPid.get(selectedPid) || null : null;
  const selName = summary?.projects.find((p) => p.pid === selectedPid)?.name || "";
  const selMembers = (selectedPid && members.get(selectedPid)) || [];

  // 편집 모달
  const openEdit = (p: ManageProject) => {
    if (!p.pid) return;
    setEditPid(p.pid);
    setEditName(p.name);
    setForm(p.planning || { status: "active" });
  };
  const upd = (k: keyof Planning, v: unknown) => setForm((f) => ({ ...f, [k]: v }));
  const save = async () => {
    if (!editPid) return;
    setSaving(true);
    try {
      const b = form.budget_credits;
      await manageApi.setPlanning(editPid, {
        status: form.status || null,
        start_date: form.start_date || null,
        due_date: form.due_date || null,
        budget_credits: b === undefined || b === null || (b as unknown) === "" ? null : Number(b),
        note: form.note || null,
      });
      setEditPid(null);
      reload();
    } catch (e) {
      alert("저장 실패: " + String((e as Error)?.message || e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="manage-empty">불러오는 중…</div>;
  if (err) return <div className="manage-empty">불러오기 실패: {err}</div>;

  return (
    <div className="dash-view">
      {/* 상단 KPI — 관리(작업 롤업) 기준 + 예산 */}
      <div className="dash-kpis">
        <div className="dash-kpi">
          <div className="lab">진척률 (작업상태)</div>
          <div className="big tnum">{Math.round(totals.progress * 100)}%</div>
          <StackBar dist={totals.dist} />
        </div>
        <div className="dash-kpi">
          <div className="lab">작업 크레딧</div>
          <div className="big tnum">{fmtCr(totals.credits)}</div>
          <div className="sub">작업 연결 컷 기준</div>
        </div>
        <div className="dash-kpi">
          <div className="lab">작업 제작 시간</div>
          <div className="big tnum">{fmtDur(totals.elapsed)}</div>
          <div className="sub">측정 {totals.elapsedKnown}/{totals.taskCount} 작업</div>
        </div>
        {budget.total ? (
          <div className="dash-kpi">
            <div className="lab">예산 대비</div>
            <div className="big tnum">{Math.round(budget.pct * 100)}%</div>
            <div className="sub">
              {fmtCr(budget.actual)} / {fmtCr(budget.total)}
              {budget.over ? <span className="over"> · 초과 {budget.over}건</span> : null}
            </div>
          </div>
        ) : (
          <div className="dash-kpi">
            <div className="lab">프로젝트 수</div>
            <div className="big tnum">{summary?.projects.filter((p) => p.pid).length || 0}</div>
          </div>
        )}
      </div>

      {/* 팀 전체(서버 집계) — 로컬 관리 기준과 분리. 미연결이면 숨김 */}
      {team && team.totals.count > 0 ? (
        <div className="dash-team-line">
          <span className="tl-lab">팀 전체(서버)</span>
          <span>생성물 <b className="tnum">{team.totals.count}</b></span>
          <span>크레딧 <b className="tnum">{fmtCr(team.totals.credits)}</b></span>
          <span>제작시간 <b className="tnum">{fmtDur(team.totals.elapsed_seconds)}</b></span>
          <span>작업자 <b className="tnum">{team.totals.workers}</b></span>
          <span>프로젝트 <b className="tnum">{team.totals.projects}</b></span>
        </div>
      ) : null}

      {/* ── 요약: 회사 전체 프로젝트 (관리) */}
      <div className="dash-tree-card">
        <div className="hd">
          <h2>프로젝트 요약</h2>
          <div className="dash-sum-actions">
            <span className="meta">행 클릭 → 아래 상세</span>
            {canManageProjects && (
              <button className="dash-newproj" onClick={() => setShowPanel(true)} title="프로젝트 생성·멤버·역할 관리">
                ＋ 프로젝트
              </button>
            )}
          </div>
        </div>
        <div className="dash-tbl-scroll">
          <table className="dash-tree dash-summary">
            <thead>
              <tr>
                <th className="l">프로젝트</th>
                <th className="l">제작일수</th>
                <th className="l">진행율</th>
                <th>예산(사용/한도)</th>
                <th>멤버</th>
                <th>상태</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ p, node, memberCount }) => {
                const sc = scheduleLabel(p.planning);
                const b = p.planning?.budget_credits ?? null;
                const over = b != null && p.credits > b;
                const prog = node ? Math.round(node.progress * 100) : null;
                return (
                  <tr
                    key={p.pid ?? "none"}
                    className={`dash-row${selectedPid === p.pid ? " sel" : ""}${p.pid ? " clickable" : ""}`}
                    onClick={() => p.pid && setSelectedPid((cur) => (cur === p.pid ? null : p.pid))}
                  >
                    <td className="l dash-name">{p.name}</td>
                    <td className={sc.danger ? "l dash-due overdue" : "l dash-sched"}>{sc.text}</td>
                    <td className="l">
                      {node ? (
                        <span className="dash-prog-cell">
                          <StackBar dist={node.dist} />
                          <span className="dash-pct tnum">{prog}%</span>
                        </span>
                      ) : (
                        <span className="dim">작업 없음</span>
                      )}
                    </td>
                    <td className={over ? "tnum dash-over" : "tnum"}>
                      {b != null ? `${fmtCr(p.credits)}/${fmtCr(b)}` : fmtCr(p.credits)}
                    </td>
                    <td className="tnum">{memberCount || "—"}</td>
                    <td>{statusLabel(p.planning?.status)}</td>
                    <td>
                      {p.pid ? (
                        <button
                          className="dash-link"
                          onClick={(e) => {
                            e.stopPropagation();
                            openEdit(p);
                          }}
                        >
                          편집
                        </button>
                      ) : (
                        <span className="dim">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!rows.length && (
                <tr>
                  <td colSpan={7} className="dash-part-empty">
                    프로젝트가 없습니다. {canManageProjects ? "＋ 프로젝트로 만드세요." : "관리자에게 생성을 요청하세요."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="dash-legend">
          <span className="dim">예산=프로젝트 전체 생성물 크레딧 · 진행율=작업상태 롤업 · 멤버=프로젝트 소속 인원</span>
        </div>
      </div>

      {/* ── 상세: 선택 프로젝트 한 개 */}
      <ProjectDetail pid={selectedPid} node={selNode} members={selMembers} projName={selName} />

      {/* 하단 추이 (팀 크레딧, 서버 집계) */}
      {trend.length ? (
        <div className="dash-tree-card">
          <div className="hd">
            <h2>기간별 크레딧 (팀)</h2>
            <span className="meta">주간</span>
          </div>
          <div className="dash-bars">
            {trend.map((p) => (
              <div className="dash-bar-col" key={p.bucket}>
                <div className="dash-bar-v tnum">{p.credits ? Math.round(p.credits).toLocaleString() : ""}</div>
                <div
                  className="dash-bar"
                  style={{ height: `${(p.credits / trendMax) * 100}%` }}
                  title={`${p.bucket}: ${Math.round(p.credits)} cr`}
                />
                <div className="dash-bar-l">{p.bucket.slice(5)}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* 프로젝트 관리 오버레이 — 생성·보관·삭제·멤버 역할 */}
      {showPanel && (
        <ProjectManagerPanel
          onClose={() => {
            setShowPanel(false);
            reload();
          }}
        />
      )}

      {/* 일정·예산 편집 모달 */}
      {editPid && (
        <div className="manage-modal-back" onClick={() => setEditPid(null)}>
          <div className="manage-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{editName} — 일정·예산</h3>
            <label className="manage-field">
              <span>상태</span>
              <select value={form.status || "active"} onChange={(e) => upd("status", e.target.value)}>
                {STATUS_OPTS.map((o) => (
                  <option key={o.v} value={o.v}>{o.label}</option>
                ))}
              </select>
            </label>
            <label className="manage-field">
              <span>시작일</span>
              <input type="date" value={form.start_date || ""} onChange={(e) => upd("start_date", e.target.value)} />
            </label>
            <label className="manage-field">
              <span>마감일</span>
              <input type="date" value={form.due_date || ""} onChange={(e) => upd("due_date", e.target.value)} />
            </label>
            <label className="manage-field">
              <span>예산(크레딧)</span>
              <input type="number" min={0} value={form.budget_credits ?? ""} onChange={(e) => upd("budget_credits", e.target.value)} />
            </label>
            <label className="manage-field">
              <span>메모</span>
              <input type="text" value={form.note || ""} onChange={(e) => upd("note", e.target.value)} />
            </label>
            <div className="manage-modal-actions">
              <button onClick={() => setEditPid(null)} disabled={saving}>취소</button>
              <button className="manage-primary" onClick={save} disabled={saving}>
                {saving ? "저장 중…" : "저장"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
