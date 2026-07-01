// 분석 — 추이 차트(일/주별 건수·크레딧) + 작업자 × 프로젝트 매트릭스. 외부 차트 라이브러리 없이
// 순수 CSS 막대로 그린다(번들 가벼움).
import { useEffect, useState } from "react";
import { manageApi } from "../../lib/manageApi";
import type { MatrixData, TimePoint } from "./types";

type Metric = "credits" | "count";

export function AnalyticsView() {
  const [bucket, setBucket] = useState<"day" | "week">("day");
  const [metric, setMetric] = useState<Metric>("credits");
  const [series, setSeries] = useState<TimePoint[] | null>(null);
  const [mtx, setMtx] = useState<MatrixData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    manageApi.timeseries(bucket).then(setSeries).catch((e) => setErr(String(e?.message || e)));
  }, [bucket]);
  useEffect(() => {
    manageApi.matrix().then(setMtx).catch((e) => setErr(String(e?.message || e)));
  }, []);

  if (err) return <div className="manage-empty">불러오기 실패: {err}</div>;

  const max = series && series.length ? Math.max(...series.map((p) => p[metric] || 0), 1) : 1;

  return (
    <div className="manage-dash">
      <header className="manage-head">
        <h1>분석</h1>
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
      </header>

      <section className="manage-section">
        <h2>{metric === "credits" ? "크레딧" : "생성"} 추이 ({bucket === "day" ? "일별" : "주별"})</h2>
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
      </section>

      <section className="manage-section">
        <h2>작업자 × 프로젝트 (크레딧)</h2>
        {!mtx ? (
          <div className="manage-empty">불러오는 중…</div>
        ) : !mtx.workers.length ? (
          <div className="manage-empty">데이터 없음</div>
        ) : (
          <div className="manage-table-wrap">
            <table className="manage-table manage-matrix">
              <thead>
                <tr>
                  <th>작업자 \ 프로젝트</th>
                  {mtx.projects.map((p) => (
                    <th key={p.pid || "none"}>{p.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {mtx.workers.map((w) => (
                  <tr key={w.uid || "none"}>
                    <td className="manage-name">{w.name}</td>
                    {mtx.projects.map((p) => {
                      const c = mtx.cells[w.uid || ""]?.[p.pid || ""];
                      return (
                        <td key={p.pid || "none"}>
                          {c ? c.credits.toLocaleString() : "·"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
