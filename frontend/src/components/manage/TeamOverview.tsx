// 팀 전체 매니징(manage-T4) — 서버 manage_hub.db 집계를 매니저가 보는 화면.
// 합계 카드 + 작업자별/프로젝트별 표 + 작업자×프로젝트 매트릭스 + 기간별 추이.
// 데이터는 각 작업자 로컬 허브가 자동 push 한 메타(프롬프트·미디어 없음)를 서버가 모은 것.
import { useCallback, useEffect, useMemo, useState } from "react";
import { manageApi } from "../../lib/manageApi";
import type {
  TeamBucket,
  TeamFilters,
  TeamOverview as TeamOverviewData,
} from "../../lib/manageApi";

function fmtDur(sec: number): string {
  if (!sec || sec <= 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return `${h}시간 ${m}분`;
  if (m) return `${m}분`;
  return `${Math.floor(sec)}초`;
}
const fmtCredits = (n: number) => (n || 0).toLocaleString();

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="manage-card">
      <div className="manage-card-label">{label}</div>
      <div className="manage-card-value">{value}</div>
      {sub && <div className="manage-card-sub">{sub}</div>}
    </div>
  );
}

type Bucket = "day" | "week" | "month";

export function TeamOverview() {
  const [ov, setOv] = useState<TeamOverviewData | null>(null);
  const [buckets, setBuckets] = useState<TeamBucket[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [bucket, setBucket] = useState<Bucket>("day");
  // 행 클릭으로 좁혀보기(작업자/프로젝트) — 백엔드 필터로 전달.
  const [creatorUid, setCreatorUid] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);

  const filters: TeamFilters = useMemo(
    () => ({
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      creatorUid: creatorUid || undefined,
      projectId: projectId || undefined,
    }),
    [dateFrom, dateTo, creatorUid, projectId],
  );

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([manageApi.teamOverview(filters), manageApi.teamTimeseries(bucket, filters)])
      .then(([o, ts]) => {
        setOv(o);
        setBuckets(ts.buckets || []);
        setErr(null);
      })
      .catch((e) => setErr(String(e?.message || e)))
      .finally(() => setLoading(false));
  }, [filters, bucket]);
  useEffect(() => {
    load();
  }, [load]);

  const maxBucket = useMemo(
    () => Math.max(1, ...buckets.map((b) => b.credits)),
    [buckets],
  );

  // 매트릭스 피벗 — 행=작업자, 열=프로젝트.
  const pivot = useMemo(() => {
    if (!ov) return null;
    const workers = ov.by_worker.map((w) => ({ uid: w.creator_uid, name: w.creator_name }));
    const projects = ov.by_project.map((p) => ({ pid: p.project_id, name: p.project_name }));
    const cell = new Map<string, number>();
    for (const m of ov.matrix) cell.set(`${m.creator_uid}|${m.project_id}`, m.credits);
    return { workers, projects, cell };
  }, [ov]);

  if (err) return <div className="manage-empty">불러오기 실패: {err}</div>;
  if (!ov) return <div className="manage-empty">불러오는 중…</div>;
  const t = ov.totals;
  const activeFilter = creatorUid || projectId;

  return (
    <div className="manage-dash">
      <header className="manage-head">
        <h1>팀 전체</h1>
        <div className="manage-head-actions">
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            title="시작일"
          />
          <span className="manage-muted">~</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            title="종료일"
          />
          <button className="manage-icon-btn" onClick={load} disabled={loading} title="새로고침">
            {loading ? "…" : "↻"}
          </button>
        </div>
      </header>

      {activeFilter && (
        <div className="team-filter-chip">
          필터: <b>{creatorUid ? "작업자" : "프로젝트"}</b>
          <button
            className="manage-link"
            onClick={() => {
              setCreatorUid(null);
              setProjectId(null);
            }}
          >
            × 해제
          </button>
        </div>
      )}

      <section className="manage-cards">
        <Card label="총 생성물" value={String(t.count)} sub={`최종 ${t.final_count}`} />
        <Card
          label="크레딧"
          value={fmtCredits(t.credits)}
          sub={t.estimated_count ? `견적 대체 ${t.estimated_count}건 포함` : "실제 차감액"}
        />
        <Card label="총 제작시간" value={fmtDur(t.elapsed_seconds)} sub="AI 생성 소요 합" />
        <Card label="작업자 · 프로젝트" value={`${t.workers} · ${t.projects}`} sub="참여 규모" />
      </section>

      <section className="manage-section">
        <h2>기간별 추이 (크레딧)</h2>
        <div className="team-bucket-toggle">
          {(["day", "week", "month"] as Bucket[]).map((b) => (
            <button
              key={b}
              className={bucket === b ? "on" : ""}
              onClick={() => setBucket(b)}
            >
              {{ day: "일", week: "주", month: "월" }[b]}
            </button>
          ))}
        </div>
        <div className="team-chart">
          {buckets.map((b) => (
            <div className="team-bar-col" key={b.bucket} title={`${b.bucket} · ${fmtCredits(b.credits)} 크레딧 · ${b.count}건`}>
              <div className="team-bar" style={{ height: `${(100 * b.credits) / maxBucket}%` }} />
              <div className="team-bar-x">{b.bucket.slice(5)}</div>
            </div>
          ))}
          {!buckets.length && <div className="manage-empty-row">데이터 없음</div>}
        </div>
      </section>

      <section className="manage-section">
        <h2>작업자별</h2>
        <table className="manage-table">
          <thead>
            <tr>
              <th>작업자</th>
              <th>생성</th>
              <th>최종</th>
              <th>크레딧</th>
              <th>제작시간</th>
            </tr>
          </thead>
          <tbody>
            {ov.by_worker.map((w) => (
              <tr key={w.creator_uid ?? "none"}>
                <td className="manage-name">
                  <button
                    className={"manage-proj-link" + (creatorUid === w.creator_uid ? " on" : "")}
                    onClick={() =>
                      setCreatorUid((c) => (c === w.creator_uid ? null : w.creator_uid))
                    }
                    title="클릭 — 이 작업자만 보기"
                  >
                    {w.creator_name || "(미상)"}
                  </button>
                </td>
                <td>{w.count}</td>
                <td>{w.final_count}</td>
                <td>{fmtCredits(w.credits)}</td>
                <td>{fmtDur(w.elapsed_seconds)}</td>
              </tr>
            ))}
            {!ov.by_worker.length && (
              <tr>
                <td colSpan={5} className="manage-empty-row">
                  데이터 없음
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="manage-section">
        <h2>프로젝트별</h2>
        <table className="manage-table">
          <thead>
            <tr>
              <th>프로젝트</th>
              <th>생성</th>
              <th>최종</th>
              <th>크레딧</th>
              <th>제작시간</th>
            </tr>
          </thead>
          <tbody>
            {ov.by_project.map((p) => (
              <tr key={p.project_id ?? "none"}>
                <td className="manage-name">
                  <button
                    className={"manage-proj-link" + (projectId === p.project_id ? " on" : "")}
                    onClick={() =>
                      setProjectId((c) => (c === p.project_id ? null : p.project_id))
                    }
                    title="클릭 — 이 프로젝트만 보기"
                  >
                    {p.project_name || "(미분류)"}
                  </button>
                </td>
                <td>{p.count}</td>
                <td>{p.final_count}</td>
                <td>{fmtCredits(p.credits)}</td>
                <td>{fmtDur(p.elapsed_seconds)}</td>
              </tr>
            ))}
            {!ov.by_project.length && (
              <tr>
                <td colSpan={5} className="manage-empty-row">
                  데이터 없음
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {pivot && pivot.workers.length > 0 && pivot.projects.length > 0 && (
        <section className="manage-section">
          <h2>작업자 × 프로젝트 (크레딧)</h2>
          <div className="team-matrix-scroll">
            <table className="manage-table team-matrix">
              <thead>
                <tr>
                  <th>작업자 \ 프로젝트</th>
                  {pivot.projects.map((p) => (
                    <th key={p.pid ?? "none"}>{p.name || "(미분류)"}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pivot.workers.map((w) => (
                  <tr key={w.uid ?? "none"}>
                    <td className="manage-name">{w.name || "(미상)"}</td>
                    {pivot.projects.map((p) => {
                      const v = pivot.cell.get(`${w.uid}|${p.pid}`) || 0;
                      return (
                        <td key={p.pid ?? "none"} className={v ? "" : "manage-muted"}>
                          {v ? fmtCredits(v) : "·"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <footer className="manage-foot">
        ※ 각 작업자 로컬 허브가 자동으로 올린 메타(프롬프트·미디어 제외) 집계입니다. 크레딧은 실제
        차감액 우선, 미매칭은 견적. 이동·공유·최종 변경은 다음 동기화 때 반영됩니다.
      </footer>
    </div>
  );
}
