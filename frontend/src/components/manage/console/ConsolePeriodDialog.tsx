// 프로젝트 기간 창 — 서브 표 '기간' 열의 달력 단추. 그 서브의 프로젝트마다 시작일·종료일을 적는다.
// 저장은 프로젝트 기획(planning)의 기존 API — 읽은 기획을 기준으로 두 칸만 바꿔 보내고, 409 면 기존 병합 창(savePlanning).
import { useEffect, useState } from "react";
import type { Planning } from "../types";
import { manageApi } from "../../../lib/manageApi";
import type { ConsoleSub } from "../../../lib/workspaceConsole";
import { ManageEditCancelled } from "../useManageEditConflict";

type Row = { id: string; name: string; start: string; due: string; days: string; initialStart: string; initialDue: string; initialDays: string;
  state: "loading" | "ready" | "saving" | "saved" | "error"; error?: string };

const errorText = (reason: unknown) => String(reason).replace(/^Error:\s*/, "");

export function ConsolePeriodDialog({ sub, savePlanning, onClose, onSaved }: {
  sub: ConsoleSub;
  savePlanning: (projectId: string, baseline: Planning, body: Planning) => Promise<Planning>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => sub.projects.map((p) => ({
    id: p.id, name: p.archived ? `${p.name} (보관)` : p.name, start: p.start_date ?? "", due: p.due_date ?? "", days: "",
    initialStart: p.start_date ?? "", initialDue: p.due_date ?? "", initialDays: "", state: "loading",
  })));
  const patch = (id: string, next: Partial<Row>) => setRows((cur) => cur.map((r) => (r.id === id ? { ...r, ...next } : r)));
  useEffect(() => {
    let alive = true;
    for (const p of sub.projects) {
      manageApi.getPlanning(p.id).then((pl) => {
        const days = String(pl.archive_after_days ?? 30);
        if (alive) patch(p.id, { days, initialDays: days, state: "ready" });
      }).catch(() => alive && patch(p.id, { days: "30", initialDays: "30", state: "ready" }));
    }
    return () => { alive = false; };
  }, [sub.projects]);
  const save = async (row: Row) => {
    if (row.start && row.due && row.start > row.due) { patch(row.id, { state: "error", error: "종료일이 시작일보다 앞입니다." }); return; }
    const days = Number(row.days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) { patch(row.id, { state: "error", error: "자동 보관 일수는 1~3650 사이 정수입니다." }); return; }
    patch(row.id, { state: "saving", error: "" });
    try {
      const baseline = await manageApi.getPlanning(row.id);
      const saved = await savePlanning(row.id, baseline, { ...baseline, start_date: row.start || null, due_date: row.due || null, archive_after_days: days });
      const savedDays = String(saved.archive_after_days ?? days);
      patch(row.id, { start: saved.start_date ?? "", due: saved.due_date ?? "", days: savedDays, initialStart: saved.start_date ?? "",
        initialDue: saved.due_date ?? "", initialDays: savedDays, state: "saved" });
      onSaved();
    } catch (reason) {
      patch(row.id, { state: reason instanceof ManageEditCancelled ? "ready" : "error", error: reason instanceof ManageEditCancelled ? "" : errorText(reason) });
    }
  };
  return (
    <div className="credit-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="wc-dialog wc-folder-dialog" role="dialog" aria-label="프로젝트 기간">
        <h3>프로젝트 기간 · {sub.name}</h3>
        <p>프로젝트마다 시작일·종료일과 작업 자동 보관 일수를 정합니다. 달력의 '기간'에 막대로 나옵니다. 작업 탭의 작업은 새 생성물이 이 일수만큼
          없으면 보관되며, 종료일 전에는 보관하지 않습니다.</p>
        {!rows.length ? <div className="wc-hint">이 서브에 연결된 프로젝트가 없습니다.</div> : null}
        {rows.map((row) => {
          const changed = row.start !== row.initialStart || row.due !== row.initialDue || row.days !== row.initialDays;
          return (
            <div key={row.id} className="wc-period-row">
              <div className="wc-folder-name">{row.name}</div>
              <input id={`wc-start-${row.id}`} type="date" value={row.start} aria-label={`${row.name} 시작일`} onChange={(e) => patch(row.id, { start: e.target.value, state: "ready" })} />
              <span className="wc-hint">~</span>
              <input id={`wc-due-${row.id}`} type="date" value={row.due} min={row.start || undefined} aria-label={`${row.name} 종료일`} onChange={(e) => patch(row.id, { due: e.target.value, state: "ready" })} />
              <label className="wc-days" title="작업 자동 보관(일)"><input id={`wc-days-${row.id}`} type="number" min={1} max={3650} value={row.days}
                disabled={row.state === "loading"} aria-label={`${row.name} 작업 자동 보관 일수`} onChange={(e) => patch(row.id, { days: e.target.value, state: "ready" })} />일</label>
              <button type="button" className="wc-btn" disabled={!changed || row.state === "saving" || row.state === "loading"} onClick={() => void save(row)}>{row.state === "saving" ? "저장 중" : "저장"}</button>
              {row.state === "saved" ? <span className="wc-chip ok">저장됨</span> : null}
              {row.state === "error" ? <span className="wc-error">{row.error}</span> : null}
            </div>
          );
        })}
        <footer><button type="button" onClick={onClose}>닫기</button></footer>
      </div>
    </div>
  );
}
