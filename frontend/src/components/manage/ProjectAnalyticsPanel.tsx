// 프로젝트별 세부 분석 — 요약에서 프로젝트명을 클릭하면 인라인 표시.
//  · 작업자 비중 도넛(건수/크레딧 토글) + 범례 %
//  · 작업자 조각 클릭 → 세부: 생성→게시→완료 퍼널 + 에피소드/시퀀스별 기여 + 시간 추이
//  · 에피소드별 진척도(그룹 막대) + 시퀀스별 완료율
// 외부 차트 라이브러리 없이 SVG/CSS 로만 그린다.
import { useEffect, useMemo, useState } from "react";
import { manageApi } from "../../lib/manageApi";
import type { BreakdownRow, MatrixCell, TimePoint } from "./types";

type Metric = "count" | "credits";

// 도넛/범례 색 팔레트(작업자 구분용, 8색 순환)
const PALETTE = [
  "#c5e14b", "#4b9de1", "#e17d4b", "#a04be1",
  "#4be1a0", "#e14b7d", "#e1c74b", "#7d7d7d",
];

function fmtInt(n: number): string {
  return (n || 0).toLocaleString();
}

// ── SVG 도넛 ────────────────────────────────────────────────────────────────
function Donut({
  segments,
  total,
  selected,
  onSelect,
}: {
  segments: { key: string; value: number; color: string }[];
  total: number;
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  const R = 52;
  const C = 2 * Math.PI * R;
  let acc = 0;
  return (
    <svg className="donut" viewBox="0 0 120 120" width={140} height={140}>
      <circle cx={60} cy={60} r={R} className="donut-track" />
      {total > 0 &&
        segments.map((s) => {
          const frac = s.value / total;
          const len = frac * C;
          const off = acc;
          acc += len;
          const dim = selected && selected !== s.key;
          return (
            <circle
              key={s.key}
              cx={60}
              cy={60}
              r={R}
              className={"donut-seg" + (dim ? " dim" : "")}
              stroke={s.color}
              strokeDasharray={`${len} ${C - len}`}
              strokeDashoffset={-off}
              onClick={() => onSelect(s.key)}
            />
          );
        })}
      <text x={60} y={56} className="donut-center-n">
        {fmtInt(total)}
      </text>
      <text x={60} y={72} className="donut-center-l">
        {total > 0 ? "total" : "—"}
      </text>
    </svg>
  );
}

// ── 생성→게시→완료 퍼널 ───────────────────────────────────────────────────────
function Funnel({ count, shared, final }: { count: number; shared: number; final: number }) {
  const steps = [
    { label: "생성", v: count, cls: "gen" },
    { label: "게시", v: shared, cls: "pub" },
    { label: "완료", v: final, cls: "done" },
  ];
  const max = Math.max(count, 1);
  return (
    <div className="funnel">
      {steps.map((s) => (
        <div className="funnel-row" key={s.label}>
          <span className="funnel-lbl">{s.label}</span>
          <div className="funnel-track">
            <div
              className={"funnel-bar " + s.cls}
              style={{ width: `${Math.round((s.v / max) * 100)}%` }}
            />
          </div>
          <span className="funnel-val">
            {s.v}
            {s.label !== "생성" && count > 0 && (
              <em className="funnel-pct"> {Math.round((s.v / count) * 100)}%</em>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ProjectAnalyticsPanel({ pid, name }: { pid: string; name: string }) {
  const [metric, setMetric] = useState<Metric>("count");
  const [bucket, setBucket] = useState<"day" | "week">("day");
  const [cells, setCells] = useState<Record<string, MatrixCell> | null>(null);
  const [workerNames, setWorkerNames] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<BreakdownRow[] | null>(null);
  const [selUid, setSelUid] = useState<string | null>(null);
  const [series, setSeries] = useState<TimePoint[] | null>(null);

  // 작업자 비중(매트릭스에서 이 프로젝트 열 추출)
  useEffect(() => {
    setSelUid(null);
    manageApi
      .matrix()
      .then((mtx) => {
        const c: Record<string, MatrixCell> = {};
        const nm: Record<string, string> = {};
        for (const w of mtx.workers) {
          const cell = mtx.cells[w.uid || ""]?.[pid];
          if (cell) {
            c[w.uid || ""] = cell;
            nm[w.uid || ""] = w.name;
          }
        }
        setCells(c);
        setWorkerNames(nm);
      })
      .catch(() => setCells({}));
  }, [pid]);

  // 폴더 세부(에피소드/시퀀스 × 작업자)
  useEffect(() => {
    setRows(null);
    manageApi.breakdown(pid).then((d) => setRows(d.rows)).catch(() => setRows([]));
  }, [pid]);

  // 시간 추이 — 작업자 선택 시 그 사람만, 아니면 프로젝트 전체
  useEffect(() => {
    setSeries(null);
    manageApi
      .timeseries(bucket, pid, selUid || undefined)
      .then(setSeries)
      .catch(() => setSeries([]));
  }, [bucket, pid, selUid]);

  const valOf = (c: MatrixCell) => (metric === "credits" ? c.credits : c.count);

  // 도넛 세그먼트 + 범례(값 큰 순)
  const workers = useMemo(() => {
    if (!cells) return [];
    return Object.entries(cells)
      .map(([uid, cell], i) => ({
        uid,
        name: workerNames[uid] || uid || "미상",
        cell,
        value: valOf(cell),
        color: PALETTE[i % PALETTE.length],
      }))
      .sort((a, b) => b.value - a.value);
  }, [cells, workerNames, metric]);

  const total = workers.reduce((s, w) => s + w.value, 0);

  // 에피소드별 진척(생성/게시/완료 합산)
  const episodes = useMemo(() => {
    if (!rows) return [];
    const m = new Map<string, { count: number; shared: number; final: number }>();
    for (const r of rows) {
      const e = m.get(r.episode) || { count: 0, shared: 0, final: 0 };
      e.count += r.count;
      e.shared += r.shared_count;
      e.final += r.final_count;
      m.set(r.episode, e);
    }
    return [...m.entries()].map(([ep, v]) => ({ ep, ...v })).sort((a, b) => b.count - a.count);
  }, [rows]);

  // 시퀀스별 완료율(folder_path 단위)
  const sequences = useMemo(() => {
    if (!rows) return [];
    const m = new Map<string, { label: string; count: number; final: number }>();
    for (const r of rows) {
      const key = r.folder_path || r.episode;
      const label = [r.episode, r.sequence].filter(Boolean).join(" / ") || "(미지정)";
      const e = m.get(key) || { label, count: 0, final: 0 };
      e.count += r.count;
      e.final += r.final_count;
      m.set(key, e);
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  }, [rows]);

  // 선택 작업자의 폴더별 기여
  const selFolders = useMemo(() => {
    if (!rows || !selUid) return [];
    return rows
      .filter((r) => (r.uid || "") === selUid)
      .map((r) => ({
        label: [r.episode, r.sequence].filter(Boolean).join(" / ") || "(미지정)",
        count: r.count,
        shared: r.shared_count,
        final: r.final_count,
      }))
      .sort((a, b) => b.count - a.count);
  }, [rows, selUid]);

  const selWorker = workers.find((w) => w.uid === selUid);
  const maxEp = Math.max(...episodes.map((e) => e.count), 1);
  const maxSeries = series && series.length ? Math.max(...series.map((p) => p[metric] || 0), 1) : 1;

  return (
    <section className="manage-section manage-proj-analytics">
      <div className="manage-analytics-head">
        <h2>{name} · 분석</h2>
        <div className="manage-toggles">
          <button className={metric === "count" ? "on" : ""} onClick={() => setMetric("count")}>
            건수
          </button>
          <button className={metric === "credits" ? "on" : ""} onClick={() => setMetric("credits")}>
            크레딧
          </button>
        </div>
      </div>

      {/* 작업자 비중 도넛 + 범례 */}
      <h3 className="manage-sub-h">작업자 비중 ({metric === "credits" ? "크레딧" : "건수"})</h3>
      {!cells ? (
        <div className="manage-empty">불러오는 중…</div>
      ) : !workers.length || total === 0 ? (
        <div className="manage-empty">
          {metric === "credits" ? "크레딧 데이터 없음(측정 커버리지 낮음)" : "데이터 없음"}
        </div>
      ) : (
        <div className="donut-wrap">
          <Donut
            segments={workers.map((w) => ({ key: w.uid, value: w.value, color: w.color }))}
            total={total}
            selected={selUid}
            onSelect={(k) => setSelUid((cur) => (cur === k ? null : k))}
          />
          <ul className="donut-legend">
            {workers.map((w) => (
              <li
                key={w.uid}
                className={"donut-leg" + (selUid === w.uid ? " on" : "")}
                onClick={() => setSelUid((cur) => (cur === w.uid ? null : w.uid))}
              >
                <span className="donut-sw" style={{ background: w.color }} />
                <span className="donut-leg-name">{w.name}</span>
                <span className="donut-leg-val">
                  {fmtInt(w.value)}
                  <em> {Math.round((w.value / total) * 100)}%</em>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 선택 작업자 세부 */}
      {selWorker && (
        <div className="manage-worker-detail">
          <h3 className="manage-sub-h">{selWorker.name} · 세부</h3>
          <Funnel
            count={selWorker.cell.count}
            shared={selWorker.cell.shared_count ?? 0}
            final={selWorker.cell.final_count ?? 0}
          />
          <div className="manage-sub-h2">에피소드 / 시퀀스별 기여</div>
          {!selFolders.length ? (
            <div className="manage-empty">폴더 데이터 없음</div>
          ) : (
            <table className="manage-table">
              <thead>
                <tr>
                  <th>폴더</th>
                  <th>생성</th>
                  <th>게시</th>
                  <th>완료</th>
                </tr>
              </thead>
              <tbody>
                {selFolders.map((f, i) => (
                  <tr key={f.label + i}>
                    <td className="manage-name">{f.label}</td>
                    <td>{f.count}</td>
                    <td>{f.shared}</td>
                    <td>{f.final}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* 시간 추이 */}
      <div className="manage-analytics-head">
        <h3 className="manage-sub-h">
          {selWorker ? `${selWorker.name} · ` : ""}
          {metric === "credits" ? "크레딧" : "생성"} 추이 ({bucket === "day" ? "일별" : "주별"})
        </h3>
        <div className="manage-toggles">
          <button className={bucket === "day" ? "on" : ""} onClick={() => setBucket("day")}>
            일별
          </button>
          <button className={bucket === "week" ? "on" : ""} onClick={() => setBucket("week")}>
            주별
          </button>
        </div>
      </div>
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
                style={{ height: `${Math.round(((p[metric] || 0) / maxSeries) * 100)}%` }}
              />
              <div className="chart-x">{p.bucket.slice(5)}</div>
            </div>
          ))}
        </div>
      )}

      {/* 에피소드별 진척도 */}
      <h3 className="manage-sub-h">에피소드별 진척도</h3>
      {!rows ? (
        <div className="manage-empty">불러오는 중…</div>
      ) : !episodes.length ? (
        <div className="manage-empty">데이터 없음</div>
      ) : (
        <div className="ep-progress">
          {episodes.map((e) => (
            <div className="ep-row" key={e.ep}>
              <span className="ep-name">{e.ep}</span>
              <div className="ep-bars">
                <span className="ep-seg gen" style={{ flex: e.count || 0.001 }} title={`생성 ${e.count}`} />
                <span className="ep-seg pub" style={{ flex: e.shared || 0.001 }} title={`게시 ${e.shared}`} />
                <span className="ep-seg done" style={{ flex: e.final || 0.001 }} title={`완료 ${e.final}`} />
                <span className="ep-rest" style={{ flex: Math.max(maxEp - e.count, 0) }} />
              </div>
              <span className="ep-nums">
                {e.count}/{e.shared}/{e.final}
              </span>
            </div>
          ))}
          <div className="ep-legend">
            <span><i className="ep-dot gen" />생성</span>
            <span><i className="ep-dot pub" />게시</span>
            <span><i className="ep-dot done" />완료</span>
          </div>
        </div>
      )}

      {/* 시퀀스별 완료율 */}
      <h3 className="manage-sub-h">시퀀스별 완료율</h3>
      {!rows ? (
        <div className="manage-empty">불러오는 중…</div>
      ) : !sequences.length ? (
        <div className="manage-empty">데이터 없음</div>
      ) : (
        <table className="manage-table">
          <thead>
            <tr>
              <th>시퀀스</th>
              <th>생성</th>
              <th>완료</th>
              <th>완료율</th>
            </tr>
          </thead>
          <tbody>
            {sequences.map((s, i) => {
              const rate = s.count ? Math.round((s.final / s.count) * 100) : 0;
              return (
                <tr key={s.label + i}>
                  <td className="manage-name">{s.label}</td>
                  <td>{s.count}</td>
                  <td>{s.final}</td>
                  <td>
                    <div className="rate-cell">
                      <div className="rate-track">
                        <div className="rate-fill" style={{ width: `${rate}%` }} />
                      </div>
                      <span className="rate-pct">{rate}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
