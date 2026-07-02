// 프로젝트별 분석 — 요약에서 프로젝트명을 클릭하면 그 프로젝트의 추이 차트 + 작업자별 기여를 인라인 표시.
// (기존 전역 분석 탭을 대체) 외부 차트 라이브러리 없이 CSS 막대.
import { useEffect, useState } from "react";
import { manageApi } from "../../lib/manageApi";
import type { MatrixData, TimePoint } from "./types";

type Metric = "credits" | "count";

export function ProjectAnalyticsPanel({ pid, name }: { pid: string; name: string }) {
  const [bucket, setBucket] = useState<"day" | "week">("day");
  const [metric, setMetric] = useState<Metric>("credits");
  const [series, setSeries] = useState<TimePoint[] | null>(null);
  const [mtx, setMtx] = useState<MatrixData | null>(null);

  useEffect(() => {
    setSeries(null);
    manageApi.timeseries(bucket, pid).then(setSeries).catch(() => setSeries([]));
  }, [bucket, pid]);
  useEffect(() => {
    manageApi.matrix().then(setMtx).catch(() => setMtx(null));
  }, []);

  const max = series && series.length ? Math.max(...series.map((p) => p[metric] || 0), 1) : 1;
  // 이 프로젝트에 기여한 작업자만(매트릭스 셀에서 pid 열 추출).
  const workerRows = mtx
    ? mtx.workers
        .map((w) => ({ name: w.name, cell: mtx.cells[w.uid || ""]?.[pid] }))
        .filter((r) => r.cell)
    : [];

  return (
    <section className="manage-section manage-proj-analytics">
      <div className="manage-analytics-head">
        <h2>{name} · 분석</h2>
        <div className="manage-toggles">
          <button className={metric === "credits" ? "on" : ""} onClick={() => setMetric("credits")}>
            크레딧
          </button>
          <button className={metric === "count" ? "on" : ""} onClick={() => setMetric("count")}>
            건수
          </button>
          <span className="manage-tog-sep" />
          <button className={bucket === "day" ? "on" : ""} onClick={() => setBucket("day")}>
            일별
          </button>
          <button className={bucket === "week" ? "on" : ""} onClick={() => setBucket("week")}>
            주별
          </button>
        </div>
      </div>

      <h3 className="manage-sub-h">
        {metric === "credits" ? "크레딧" : "생성"} 추이 ({bucket === "day" ? "일별" : "주별"})
      </h3>
      {!series ? (
        <div className="manage-empty">불러오는 중…</div>
      ) : !series.length ? (
        <div className="manage-empty">데이터 없음</div>
      ) : (
        <div className="chart">
          {series.map((p) => (
            <div className="chart-col" key={p.bucket} title={`${p.bucket}: ${p[metric]}`}>
              <div
                className="chart-bar"
                style={{ height: `${Math.round(((p[metric] || 0) / max) * 100)}%` }}
              />
              <div className="chart-x">{p.bucket.slice(5)}</div>
            </div>
          ))}
        </div>
      )}

      <h3 className="manage-sub-h">작업자별 기여</h3>
      {!mtx ? (
        <div className="manage-empty">불러오는 중…</div>
      ) : !workerRows.length ? (
        <div className="manage-empty">데이터 없음</div>
      ) : (
        <table className="manage-table">
          <thead>
            <tr>
              <th>작업자</th>
              <th>생성</th>
              <th>게시</th>
              <th>완료</th>
              <th>크레딧</th>
            </tr>
          </thead>
          <tbody>
            {workerRows.map((r) => (
              <tr key={r.name}>
                <td className="manage-name">{r.name}</td>
                <td>{r.cell?.count ?? 0}</td>
                <td>{r.cell?.shared_count ?? 0}</td>
                <td>{r.cell?.final_count ?? 0}</td>
                <td>{(r.cell?.credits ?? 0).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
