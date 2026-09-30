// 메인 화면 부품 — 힉스필드 엔터프라이즈 화면과 같은 틀(Jay 2026-09-29): 크레딧 풀 카드 + 서브 워크스페이스 표.
// 풀: 할당됨(추정) = 사용(우리 기록 전체) + 미사용(서브 잔액 합), 할당 가능 = 메인 잔액. 힉스필드는 과거 할당 총액을 주지 않는다.
import { useState } from "react";
import { formatDecimal } from "../../../lib/creditPlan";
import { formatCredits } from "../../../lib/formatCredits";
import { manageApi } from "../../../lib/manageApi";
import { paginateUsageItems, USAGE_PAGE_SIZES } from "../../../lib/usagePagination";
import { UsagePagination } from "../WorkspaceUsageDashboard";
import { periodSummary, STATUS_LABEL, type ConsoleOverview, type ConsoleStatus, type ConsoleSub } from "../../../lib/workspaceConsole";

export function PoolCard({ data, canEdit, onChanged }: { data: ConsoleOverview; canEdit: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const pool = data.main?.balance ?? null;
  const { allocated, spent, unused, source, base, base_day: baseDay } = data.allocation;
  // 막대 = 할당된 크레딧만(사용 | 미사용). 할당 가능은 범례에만 — 힉스필드 'Allocated usage' 와 같은 모양.
  const pct = (v: number) => (allocated > 0 ? `${(Math.max(v, 0) / allocated) * 100}%` : "0%");
  const allocTile = (
    <>
      <strong>{formatCredits(allocated)}</strong>
      <span>할당된 크레딧 {source === "estimate" ? <em>추정 · 눌러서 힉스필드 값 입력</em> : <em className="ok">기준 {baseDay?.slice(5)} {formatCredits(base)}</em>}</span>
    </>
  );
  return (
    <div className="usage-card wc-pool">
      <div className="wc-pool-head">엔터프라이즈 크레딧 풀 <span>잔액 {data.main?.balance_seen_at?.slice(5, 16) ?? "보고 없음"} 보고값</span></div>
      <div className="wc-pool-tiles">
        <div><strong>{formatCredits(pool)}</strong><span>크레딧 풀</span></div>
        {canEdit ? <button type="button" className="wc-pool-edit" onClick={() => setEditing(true)} title="힉스필드의 할당된 크레딧 입력">{allocTile}</button> : <div>{allocTile}</div>}
        <div><strong>{formatCredits(pool)}</strong><span>할당 가능</span></div>
      </div>
      <div className="wc-pool-usage">
        <div className="wc-pool-title">할당 사용 현황</div>
        <div className="wc-pool-bar" aria-hidden="true">
          <i className="spent" style={{ width: pct(spent) }} /><i className="unused" style={{ width: pct(unused) }} />
        </div>
        <div className="wc-pool-legend">
          <span><i className="spent" /><b>{formatCredits(spent)}</b> 사용</span>
          <span><i className="unused" /><b>{formatCredits(unused)}</b> 미사용(서브 잔액)</span>
          <span><i className="avail" /><b>{formatCredits(pool)}</b> 할당 가능</span>
        </div>
        <div className="wc-note">{source === "baseline"
          ? `할당된 크레딧 = 기준값(${baseDay}) + 그 뒤 기록된 추가 크레딧·지나간 자동 정기 크레딧 · 사용 = 할당 − 미사용(서브 잔액 합)`
          : "힉스필드 값이 없어 이 앱이 기록한 사용으로 추정합니다(앱 도입 전 사용은 빠짐) · 할당된 크레딧을 눌러 힉스필드 값을 넣으면 맞춰집니다"}</div>
      </div>
      {editing ? <AllocBaseDialog base={base} today={data.today} onClose={() => setEditing(false)} onSaved={onChanged} /> : null}
    </div>
  );
}

function AllocBaseDialog({ base, today, onClose, onSaved }: { base: number | null; today: string; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState(base == null ? "" : formatDecimal(String(base)));
  const [day, setDay] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const value = Number(text.replace(/,/g, ""));
  const valid = text.trim() !== "" && Number.isFinite(value) && value >= 0 && /^\d{4}-\d{2}-\d{2}$/.test(day);
  const submit = async (credits: number | null) => {
    setBusy(true); setError("");
    try { await manageApi.consoleAllocBase(credits, credits == null ? null : day); onSaved(); onClose(); }
    catch (reason) { setError(String(reason).replace(/^Error:\s*/, "")); }
    finally { setBusy(false); }
  };
  return (
    <div className="credit-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="wc-dialog" role="dialog" aria-label="할당된 크레딧 기준값">
        <h3>할당된 크레딧 · 힉스필드 값</h3>
        <p>힉스필드 엔터프라이즈 화면의 'Allocated credits' 를 그 날짜와 함께 적습니다. 그 뒤로는 여기 기록한 추가 크레딧과 지나간 자동 정기 크레딧이 더해지고, 사용 = 할당 − 서브 잔액 합으로 계산됩니다.</p>
        <label>기준 날짜<input id="wc-alloc-day" type="date" max={today} value={day} onChange={(e) => setDay(e.target.value)} /></label>
        <label>할당된 크레딧<input id="wc-alloc" inputMode="decimal" value={text} onChange={(e) => setText(formatDecimal(e.target.value))} placeholder="예: 189,424"
          onKeyDown={(e) => { if (e.key === "Enter" && valid && !busy) void submit(value); }} /></label>
        {error ? <div className="wc-error">{error}</div> : null}
        <footer>
          {base != null ? <button type="button" onClick={() => void submit(null)} disabled={busy}>기준값 지우기</button> : null}
          <button type="button" onClick={onClose} disabled={busy}>취소</button>
          <button type="button" className="pri" disabled={!valid || busy} onClick={() => void submit(value)}>저장</button>
        </footer>
      </div>
    </div>
  );
}

function createdLabel(day: string | null | undefined): string {
  if (!day) return "";
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  return `${y}년 ${m}월 ${d}일 연결`;
}

/** 상태 알약 — 누르면 활성·비활성·완료 메뉴(편집 권한이 있을 때). 표시용이라 계산에는 영향 없다. */
function StatusPill({ status, editable, onChange }: { status: ConsoleStatus; editable: boolean; onChange: (next: ConsoleStatus) => void }) {
  const [open, setOpen] = useState(false);
  if (!editable) return <span className={`wc-status ${status}`}>{STATUS_LABEL[status]}</span>;
  return (
    <span className="wc-status-wrap">
      <button type="button" className={`wc-status ${status}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {STATUS_LABEL[status]} <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <>
          <div className="wc-menu-backdrop" onMouseDown={() => setOpen(false)} />
          <div className="wc-menu wc-status-menu" role="menu">
            {(Object.keys(STATUS_LABEL) as ConsoleStatus[]).map((s) => (
              <button key={s} type="button" role="menuitemradio" aria-checked={s === status} className={s === status ? "on" : ""}
                onClick={() => { setOpen(false); onChange(s); }}>
                <span className={`wc-status ${s}`}>{STATUS_LABEL[s]}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </span>
  );
}

export function SubTable({ data, canEdit, busy, onSelect, onMove, onCredit, onFolder, onPeriod, onStatus, onArchive, onAdd }: {
  data: ConsoleOverview;
  canEdit: boolean;
  busy: boolean;
  onSelect: (id: string) => void;
  onMove: (fromId: string, toId: string) => void; // 이름 앞 ⠿ 끌기 — 왼쪽 목록 끌기와 같은 moveSub
  onCredit: (sub: ConsoleSub) => void;
  onFolder: (sub: ConsoleSub) => void;
  onPeriod: (sub: ConsoleSub) => void;
  onStatus: (sub: ConsoleSub, status: ConsoleStatus) => void;
  onArchive: (sub: ConsoleSub) => void;
  onAdd: () => void;
}) {
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  // 프로젝트 관리 창과 같은 끌기 — ⠿ 를 누른 동안만 줄이 끌린다(이름·단추 클릭을 막지 않게)
  const [dragArmed, setDragArmed] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const canMove = canEdit && !busy;
  const q = query.trim().toLowerCase();
  const [paging, setPaging] = useState({ page: 1, pageSize: USAGE_PAGE_SIZES[0] as number });
  const matched = data.subs.filter((s) => !q || s.name.toLowerCase().includes(q));
  const view = paginateUsageItems(matched, paging.page, paging.pageSize);
  const rows = view.items;
  return (
    <div className="usage-card">
      <div className="usage-card-head">
        <div className="wc-subs-head">
          <h3>서브 워크스페이스</h3><span className="wc-count">{data.subs.length}</span>
          <input id="wc-sub-search" className="wc-search" placeholder="이름 검색" value={query} onChange={(e) => { setQuery(e.target.value); setPaging((p) => ({ ...p, page: 1 })); }} />
        </div>
        {canEdit ? <button type="button" className="wc-add-btn" onClick={onAdd}>＋ 추가</button> : null}
      </div>
      <table className="usage-table wc-subs">
        <thead><tr><th>이름</th><th>기간</th><th>남은 크레딧 / 할당 크레딧</th><th>다음 할당일</th><th>상태</th><th /></tr></thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id} draggable={canMove && dragArmed}
              className={dragId === s.id ? "row-dragging" : overId === s.id && dragId !== s.id ? "row-dragover" : undefined}
              onDragStart={(e) => { e.dataTransfer.setData("text/plain", s.id); e.dataTransfer.effectAllowed = "move"; setDragId(s.id); }}
              onDragOver={(e) => { if (dragId && dragId !== s.id) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOverId(s.id); } }}
              onDrop={(e) => { e.preventDefault(); const from = dragId; setDragId(null); setOverId(null); setDragArmed(false); if (from && from !== s.id) onMove(from, s.id); }}
              onDragEnd={() => { setDragId(null); setOverId(null); setDragArmed(false); }}>
              <td>
                <div className="wc-name-cell">
                  {canMove ? (
                    <span className="proj-drag-handle" title="드래그해서 순서 변경" aria-label={`${s.name} 순서 변경`}
                      onMouseDown={() => setDragArmed(true)} onMouseUp={() => setDragArmed(false)}>⠿</span>
                  ) : null}
                  {canEdit ? (
                    <button type="button" className="wc-credit-plus" onClick={() => onFolder(s)} aria-label={`${s.name} 렌더 폴더`} title="렌더 폴더">
                      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M1.5 3.5h4l1.2 1.4h5.8v6.1h-11z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
                    </button>
                  ) : null}
                  <div>
                    {/* 프로젝트 관리 창처럼 '프로젝트 이름 [워크스페이스]' — 서브 = 워크스페이스, 이름은 그 서브의 프로젝트 */}
                    <button type="button" className="wc-link wc-sub-name" onClick={() => onSelect(s.id)}>
                      {(s.projects.find((p) => !p.archived) ?? s.projects[0])?.name ?? s.name}
                    </button>
                    <span className="admin-badge proj-workspace-badge">{s.name}</span>
                    {s.projects.length > 1 ? <span className="credit-est"> 외 {s.projects.length - 1}</span> : null}
                    {s.projects.length > 0 && s.projects.every((p) => p.archived) ? <span className="admin-badge">보관됨</span> : null}
                    <div className="credit-est">{createdLabel(s.first_seen_at)}</div>
                  </div>
                </div>
              </td>
              <td>
                <div className="wc-name-cell">
                  {canEdit ? (
                    <button type="button" className="wc-credit-plus" disabled={busy} onClick={() => onPeriod(s)} aria-label={`${s.name} 프로젝트 기간`} title="프로젝트 기간">
                      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="1.8" y="2.8" width="10.4" height="9.4" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M1.8 5.8h10.4M4.6 1.6v2.4M9.4 1.6v2.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
                    </button>
                  ) : null}
                  <span className={periodSummary(s.projects) ? "" : "mtable-muted"} title={s.projects.map((p) => `${p.name} ${p.start_date ?? "?"} ~ ${p.due_date ?? "?"}`).join("\n")}>
                    {periodSummary(s.projects) ?? "—"}{s.projects.length > 1 ? <span className="credit-est"> · 프로젝트 {s.projects.length}</span> : null}
                  </span>
                </div>
              </td>
              <td>
                {canEdit ? <button type="button" className="wc-credit-plus" disabled={busy} onClick={() => onCredit(s)} aria-label={`${s.name} 크레딧`}>
                  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                </button> : null}
                <b className={s.balance != null && s.balance < 0 ? "mtable-over" : ""}>{formatCredits(s.balance)}</b>
                <span className="wc-alloc"> / {s.monthly_topup ? formatCredits(s.monthly_topup) : "없음"}</span>
              </td>
              <td>{!s.recurring_auto ? <span className="wc-chip">수동</span> : s.monthly_topup && s.next_topup_day ? <><span className="wc-next">Next</span>{s.next_topup_day}</> : "—"}</td>
              <td><StatusPill status={s.status ?? "active"} editable={canEdit && !busy} onChange={(next) => onStatus(s, next)} /></td>
              <td className="wc-menu-cell">
                {canEdit ? (
                  <button type="button" className="wc-dots" aria-label={`${s.name} 메뉴`} disabled={busy} onClick={() => setMenu(menu === s.id ? null : s.id)}>⋯</button>
                ) : null}
                {menu === s.id ? (
                  <>
                    <div className="wc-menu-backdrop" onMouseDown={() => setMenu(null)} />
                    <div className="wc-menu" role="menu">
                      <button type="button" role="menuitem" onClick={() => { setMenu(null); onCredit(s); }}>크레딧 설정</button>
                      <button type="button" role="menuitem" onClick={() => { setMenu(null); onSelect(s.id); }}>그룹·참가자 관리</button>
                      <button type="button" role="menuitem" className="danger" onClick={() => { setMenu(null); onArchive(s); }}>콘솔에서 내리기</button>
                    </div>
                  </>
                ) : null}
              </td>
            </tr>
          ))}
          {!rows.length ? <tr><td colSpan={6} className="mtable-muted">{q ? "검색 결과가 없습니다." : "서브가 없습니다."}</td></tr> : null}
        </tbody>
      </table>
      <UsagePagination label="서브 워크스페이스" page={view.page} pageSize={view.pageSize} totalPages={view.totalPages}
        onPageChange={(page) => setPaging((p) => ({ ...p, page }))} onPageSizeChange={(pageSize) => setPaging({ page: 1, pageSize })} />
    </div>
  );
}
