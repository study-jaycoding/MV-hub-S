// 통합 대시보드 — '요약'+'팀 전체'를 합친 탭. 상단 KPI + 중앙 프로젝트▸에피소드▸시퀀스 계층 트리.
// (2단계에서 우측 참여자 3축 패널 + 하단 추이 + 경고 추가 예정)
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { manageApi } from "../../lib/manageApi";
import { buildHierarchy, type DashNode, type StatusDist } from "./dashboardModel";
import type { Task } from "./types";

function fmtDur(sec: number): string {
  if (!sec || sec <= 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h${m ? m + "m" : ""}` : `${m || Math.floor(sec)}m`;
}
function fmtCr(n: number): string {
  return n ? Math.round(n).toLocaleString() : "—";
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

export function DashboardView() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    api
      .projects("team")
      .then((r) =>
        Promise.all(
          r.projects.map((p) =>
            manageApi
              .listTasks(p.id)
              .then((ts) => ts.map((t) => ({ ...t, project_name: p.name })))
              .catch(() => [] as Task[]),
          ),
        ),
      )
      .then((all) => {
        const flat = all.flat();
        setTasks(flat);
        // 프로젝트 노드는 기본 펼침
        setExpanded(new Set(flat.map((t) => t.project_id || "(none)")));
        setLoading(false);
      })
      .catch((e) => {
        setErr(String(e?.message || e));
        setLoading(false);
      });
  }, []);

  const { tree, totals } = useMemo(() => buildHierarchy(tasks), [tasks]);

  const toggle = (k: string) =>
    setExpanded((prev) => {
      const s = new Set(prev);
      s.has(k) ? s.delete(k) : s.add(k);
      return s;
    });

  if (loading) return <div className="manage-empty">불러오는 중…</div>;
  if (err) return <div className="manage-empty">불러오기 실패: {err}</div>;
  if (!tasks.length) return <div className="manage-empty">작업이 없습니다. 작업 탭에서 폴더를 연결하세요.</div>;

  return (
    <div className="dash-view">
      {/* 상단 KPI */}
      <div className="dash-kpis">
        <div className="dash-kpi">
          <div className="lab">총 크레딧</div>
          <div className="big tnum">{fmtCr(totals.credits)}</div>
        </div>
        <div className="dash-kpi">
          <div className="lab">총 제작 시간</div>
          <div className="big tnum">{fmtDur(totals.elapsed)}</div>
          <div className="sub">측정 {totals.elapsedKnown}/{totals.taskCount} 작업</div>
        </div>
        <div className="dash-kpi">
          <div className="lab">진척률 (작업상태)</div>
          <div className="big tnum">{Math.round(totals.progress * 100)}%</div>
          <StackBar dist={totals.dist} />
        </div>
        <div className="dash-kpi">
          <div className="lab">작업 수</div>
          <div className="big tnum">{totals.taskCount}</div>
        </div>
      </div>

      {/* 중앙 계층 트리 */}
      <div className="dash-tree-card">
        <div className="hd">
          <h2>프로젝트 ▸ 에피소드 ▸ 시퀀스</h2>
          <span className="meta">행 클릭 · ▸ 펼치기</span>
        </div>
        <div className="dash-tbl-scroll">
          <table className="dash-tree">
            <thead>
              <tr>
                <th className="l">이름</th>
                <th className="l">상태·진척</th>
                <th>작업</th>
                <th>크레딧</th>
                <th>제작시간</th>
              </tr>
            </thead>
            <tbody>
              {tree.map((n) => (
                <TreeRow
                  key={n.key}
                  node={n}
                  depth={0}
                  expanded={expanded}
                  onToggle={toggle}
                  selectedKey={selectedKey}
                  onSelect={(node) => setSelectedKey(node.key)}
                />
              ))}
            </tbody>
          </table>
        </div>
        <div className="dash-legend">
          <span><i className="s-done" /> 완료</span>
          <span><i className="s-pub" /> 게시</span>
          <span><i className="s-prog" /> 진행중</span>
          <span><i className="s-idle" /> 시작전</span>
          <span className="dim">· 진척 막대 = 작업상태 분포</span>
        </div>
      </div>
    </div>
  );
}
