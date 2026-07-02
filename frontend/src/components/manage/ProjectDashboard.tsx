// PM 대시보드 본문 — 요약 카드 + 프로젝트별(일정·예산 편집) + 작업자별. 허브 스타일 재사용.
import { useEffect, useState } from "react";
import { manageApi } from "../../lib/manageApi";
import type { ManageProject, ManageSummary, Planning } from "./types";

function fmtDur(sec: number): string {
  if (!sec || sec <= 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h) return `${h}시간 ${m}분`;
  if (m) return `${m}분 ${s}초`;
  return `${s}초`;
}

function fmtCredits(n: number): string {
  return (n || 0).toLocaleString();
}

function fmtVideoSec(sec?: number): string {
  if (!sec || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m}분 ${s}초` : `${s}초`;
}

function pct(part: number, whole: number): number {
  return whole ? Math.round((100 * part) / whole) : 0;
}

const STATUS_OPTS: { v: string; label: string }[] = [
  { v: "active", label: "진행" },
  { v: "hold", label: "보류" },
  { v: "done", label: "완료" },
];
function statusLabel(s?: string | null): string {
  return STATUS_OPTS.find((o) => o.v === s)?.label ?? "—";
}

const TODAY = new Date().toISOString().slice(0, 10);
function isOverdue(p: ManageProject): boolean {
  const d = p.planning?.due_date;
  return !!d && p.planning?.status !== "done" && d < TODAY;
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="manage-card">
      <div className="manage-card-label">{label}</div>
      <div className="manage-card-value">{value}</div>
      {sub && <div className="manage-card-sub">{sub}</div>}
    </div>
  );
}

export function ProjectDashboard() {
  const [data, setData] = useState<ManageSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 일정·예산 편집 상태
  const [editPid, setEditPid] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [form, setForm] = useState<Planning>({});
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    manageApi
      .summary()
      .then((d) => {
        setData(d);
        setErr(null);
      })
      .catch((e) => setErr(String(e?.message || e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const openEdit = (p: ManageProject) => {
    if (!p.pid) return; // 미분류(pid 없음)는 일정 대상 아님
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
      load();
    } catch (e) {
      alert("저장 실패: " + String((e as Error)?.message || e));
    } finally {
      setSaving(false);
    }
  };

  if (err) return <div className="manage-empty">불러오기 실패: {err}</div>;
  if (!data) return <div className="manage-empty">불러오는 중…</div>;

  const t = data.totals;
  return (
    <div className="manage-dash">
      <header className="manage-head">
        <h1>프로젝트 관리</h1>
        <button className="manage-refresh" onClick={load} disabled={loading}>
          {loading ? "…" : "새로고침"}
        </button>
      </header>

      <section className="manage-cards">
        <Card label="총 생성물" value={String(t.gen_count)} sub={`완료 ${t.done_count}`} />
        <Card
          label="실제 크레딧"
          value={fmtCredits(t.real_credits)}
          sub={
            t.refund_credits
              ? `환불 ${fmtCredits(t.refund_credits)} · 순 ${fmtCredits(t.net_credits || 0)}`
              : `견적포함 ${fmtCredits(t.credits)}`
          }
        />
        <Card
          label="측정 커버리지"
          value={`${pct(t.metric_count, t.gen_count)}%`}
          sub={`${t.metric_count} / ${t.gen_count} 건`}
        />
        <Card
          label="총 제작시간"
          value={fmtDur(t.elapsed_total)}
          sub={t.video_seconds ? `영상 ${fmtVideoSec(t.video_seconds)}` : "AI 생성 소요"}
        />
      </section>

      {t.types && (
        <section className="manage-types">
          {(["image", "video", "3d", "audio"] as const).map((k) => (
            <span key={k} className="manage-type-chip">
              {{ image: "이미지", video: "영상", "3d": "3D", audio: "오디오" }[k]}{" "}
              <b>{t.types?.[k] ?? 0}</b>
            </span>
          ))}
        </section>
      )}

      <section className="manage-section">
        <h2>프로젝트별 · 일정/예산</h2>
        <table className="manage-table">
          <thead>
            <tr>
              <th>프로젝트</th>
              <th>생성</th>
              <th>게시</th>
              <th>완료</th>
              <th>크레딧</th>
              <th>예산</th>
              <th>마감</th>
              <th>상태</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.projects.map((p) => {
              const budget = p.planning?.budget_credits ?? null;
              const over = budget != null && p.credits > budget;
              return (
                <tr key={p.pid ?? "none"}>
                  <td className="manage-name">{p.name}</td>
                  <td>{p.gen_count}</td>
                  <td>{p.shared_count}</td>
                  <td>{p.final_count}</td>
                  <td>{fmtCredits(p.credits)}</td>
                  <td className={over ? "manage-over" : ""}>
                    {budget != null ? `${fmtCredits(p.credits)}/${fmtCredits(budget)}` : "—"}
                  </td>
                  <td className={isOverdue(p) ? "manage-overdue" : ""}>
                    {p.planning?.due_date ?? "—"}
                    {isOverdue(p) && " ⚠"}
                  </td>
                  <td>{statusLabel(p.planning?.status)}</td>
                  <td>
                    {p.pid ? (
                      <button className="manage-link" onClick={() => openEdit(p)}>
                        편집
                      </button>
                    ) : (
                      <span className="manage-muted">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {!data.projects.length && (
              <tr>
                <td colSpan={9} className="manage-empty-row">
                  데이터 없음
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {!!data.workspaces?.length && (
        <section className="manage-section">
          <h2>워크스페이스 크레딧 풀</h2>
          <table className="manage-table">
            <thead>
              <tr>
                <th>워크스페이스</th>
                <th>플랜</th>
                <th>역할</th>
                <th>잔여 크레딧</th>
              </tr>
            </thead>
            <tbody>
              {data.workspaces.map((w) => (
                <tr key={w.id}>
                  <td className="manage-name">{w.name}</td>
                  <td>{w.plan_type ?? "—"}</td>
                  <td>{w.user_role ?? "—"}</td>
                  <td>{w.credits != null ? fmtCredits(w.credits) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="manage-section">
        <h2>작업자별</h2>
        <table className="manage-table">
          <thead>
            <tr>
              <th>작업자</th>
              <th>생성</th>
              <th>크레딧</th>
              <th>제작시간</th>
            </tr>
          </thead>
          <tbody>
            {data.workers.map((w) => (
              <tr key={w.uid ?? "none"}>
                <td className="manage-name">{w.name}</td>
                <td>{w.gen_count}</td>
                <td>{fmtCredits(w.credits)}</td>
                <td>{fmtDur(w.elapsed_total)}</td>
              </tr>
            ))}
            {!data.workers.length && (
              <tr>
                <td colSpan={4} className="manage-empty-row">
                  데이터 없음
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <footer className="manage-foot">
        ※ 크레딧은 실제 차감액(거래 매칭) 우선, 미매칭은 견적. 제작시간은 허브 생성물의 AI 생성
        소요시간(요청→완료). 측정 커버리지가 낮으면 동기화·과거 생성물이 섞인 것입니다.
      </footer>

      {editPid && (
        <div className="manage-modal-back" onClick={() => setEditPid(null)}>
          <div className="manage-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{editName} — 일정·예산</h3>
            <label className="manage-field">
              <span>상태</span>
              <select
                value={form.status || "active"}
                onChange={(e) => upd("status", e.target.value)}
              >
                {STATUS_OPTS.map((o) => (
                  <option key={o.v} value={o.v}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="manage-field">
              <span>시작일</span>
              <input
                type="date"
                value={form.start_date || ""}
                onChange={(e) => upd("start_date", e.target.value)}
              />
            </label>
            <label className="manage-field">
              <span>마감일</span>
              <input
                type="date"
                value={form.due_date || ""}
                onChange={(e) => upd("due_date", e.target.value)}
              />
            </label>
            <label className="manage-field">
              <span>예산(크레딧)</span>
              <input
                type="number"
                min={0}
                value={form.budget_credits ?? ""}
                onChange={(e) => upd("budget_credits", e.target.value)}
              />
            </label>
            <label className="manage-field">
              <span>메모</span>
              <input
                type="text"
                value={form.note || ""}
                onChange={(e) => upd("note", e.target.value)}
              />
            </label>
            <div className="manage-modal-actions">
              <button onClick={() => setEditPid(null)} disabled={saving}>
                취소
              </button>
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
