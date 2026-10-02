// 크레딧 달력 — 메인 화면의 월간 달력. 지난 3개월의 추가 크레딧 기록과 앞으로 약 3개월의 자동 크레딧을 날짜 칸에 보여 주고,
// 자동 충전이 있는 날(30일 안)에는 그 뒤 예상 메인 잔액을 적는다. 데이터는 GET /console/overview 의 calendar·schedule.
// 막대를 끌어 다른 날짜에 놓으면 날짜가 바뀐다(추가 = 그 기록의 날짜, 자동 = 충전일 — 오늘 이후만). 누르면 정보 창.
import { useEffect, useMemo, useState, type DragEvent } from "react";
import { formatDecimal, formatThousands } from "../../../lib/creditPlan";
import { formatCredits } from "../../../lib/formatCredits";
import { ManageEditCancelled } from "../useManageEditConflict";
import type { ConsoleOverview, ConsoleSub } from "../../../lib/workspaceConsole";
import { PERIOD_UNIT } from "../../../lib/workspaceConsole";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const PERIOD_COLORS = ["#6fb6ff", "#c79bff", "#4cd3c2", "#ff9f6e", "#f472b6", "#a3e635"];
const MAX_CHIPS = 3;
const DRAG_TYPE = "application/x-mvhub-credit-event";

type CalEvent = ConsoleOverview["calendar"]["events"][number];

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthOf = (day: string) => day.slice(0, 7);

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** 그 달을 덮는 주(일요일 시작)들의 날짜 — 앞뒤 달 날짜도 채운다. */
function monthGrid(month: string): string[] {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const start = new Date(y, m - 1, 1 - first.getDay());
  const last = new Date(y, m, 0);
  const days = Math.ceil((first.getDay() + last.getDate()) / 7) * 7;
  return Array.from({ length: days }, (_, i) => iso(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)));
}

export type EventPatch = { credits?: number; note?: string | null } | null; // null = 추가 기록 삭제

export function CreditCalendar({ data, canEdit, busy, onMove, onEdit, loadNote }: {
  data: ConsoleOverview;
  canEdit: boolean;
  busy: boolean;
  onMove: (event: CalEvent, day: string) => void;
  onEdit: (event: CalEvent, patch: EventPatch) => Promise<void>;
  loadNote: (event: CalEvent) => Promise<string | null>;
}) {
  const [month, setMonth] = useState(monthOf(data.today));
  const [dragging, setDragging] = useState<CalEvent | null>(null);
  const [overDay, setOverDay] = useState<string | null>(null);
  const [info, setInfo] = useState<{ event: CalEvent; note: string | null | undefined; noteFailed?: boolean } | null>(null);
  const [show, setShow] = useState({ period: true, credit: true }); // 필터 — 기간(프로젝트 시작~종료) · 크레딧
  // 프로젝트 기간 막대 — 시작·종료가 둘 다 있으면 그 사이 매일, 하나만 있으면 그날 하루. 색은 프로젝트마다 고정.
  const periods = useMemo(() => {
    const out: { id: string; label: string; start: string; end: string; color: string }[] = [];
    data.subs.forEach((s) => s.projects.forEach((p) => {
      if (!p.start_date && !p.due_date) return;
      const start = p.start_date ?? (p.due_date as string);
      const end = p.due_date ?? start;
      out.push({ id: p.id, label: s.projects.length > 1 || p.name !== s.name ? `${s.name} · ${p.name}` : p.name, start, end: end < start ? start : end,
        color: PERIOD_COLORS[out.length % PERIOD_COLORS.length] });
    }));
    return out;
  }, [data.subs]);
  const byDay = useMemo(() => {
    const map = new Map<string, CalEvent[]>();
    for (const e of data.calendar.events) map.set(e.day, [...(map.get(e.day) ?? []), e]);
    return map;
  }, [data.calendar.events]);
  const balanceAfter = useMemo(() => new Map(data.schedule.map((r) => [r.day, r.balance_after])), [data.schedule]);
  const subById = useMemo(() => new Map(data.subs.map((s) => [s.id, s])), [data.subs]);
  const minMonth = monthOf(data.calendar.from);
  const maxMonth = monthOf(data.calendar.to);
  const [y, m] = month.split("-").map(Number);

  const canDropOn = (e: CalEvent | null, day: string) => !!e && day !== e.day && (e.kind === "topup" || day >= data.today);
  const drop = (event: DragEvent, day: string) => {
    event.preventDefault();
    const moving = dragging;
    setDragging(null); setOverDay(null);
    if (moving && canDropOn(moving, day)) onMove(moving, day);
  };
  const openInfo = (e: CalEvent) => {
    setInfo({ event: e, note: e.kind === "topup" && canEdit ? undefined : null });
    // 편집할 수 있으면 자동 크레딧도 열 때 한 번 읽는다 — 부모가 이때 읽은 설정을 저장 기준으로 쓴다(2026-10-03 점검 CXF-7). 메모는 추가 기록만.
    if (e.kind === "recurring" && canEdit) loadNote(e).catch(() => {});
    if (e.kind === "topup" && canEdit) {
      loadNote(e).then((note) => setInfo((cur) => (cur && cur.event === e ? { event: e, note } : cur)))
        // 못 읽은 것을 '메모 없음'(null)으로 확정하면 금액만 고쳐 저장해도 기존 메모가 지워졌다(2026-10-03 CXF-2)
        .catch(() => setInfo((cur) => (cur && cur.event === e ? { event: e, note: null, noteFailed: true } : cur)));
    }
  };

  return (
    <div className="usage-card">
      <div className="usage-card-head">
        <div className="wc-cal-nav">
          <h3>달력</h3>
          <span className="usage-segmented wc-cal-filter" role="group" aria-label="보기">
            <button type="button" aria-pressed={show.period} className={show.period ? "on" : ""} onClick={() => setShow((v) => ({ ...v, period: !v.period }))}>기간</button>
            <button type="button" aria-pressed={show.credit} className={show.credit ? "on" : ""} onClick={() => setShow((v) => ({ ...v, credit: !v.credit }))}>크레딧</button>
          </span>
          <button type="button" className="wc-mini" disabled={month <= minMonth} onClick={() => setMonth(shiftMonth(month, -1))} aria-label="이전 달">‹</button>
          <strong>{y}년 {m}월</strong>
          <button type="button" className="wc-mini" disabled={month >= maxMonth} onClick={() => setMonth(shiftMonth(month, 1))} aria-label="다음 달">›</button>
          {month !== monthOf(data.today) ? <button type="button" className="wc-mini" onClick={() => setMonth(monthOf(data.today))}>오늘</button> : null}
        </div>
        <span className="wc-cal-legend">{show.period ? <><i className="per" />프로젝트 기간 </> : null}{show.credit ? <><i className="rec" />자동 크레딧(예정) <i className="top" />추가 크레딧(기록){canEdit ? " · 크레딧 막대를 끌어 날짜 변경" : ""}</> : null}</span>
      </div>
      <div className="wc-cal" role="grid" aria-label={`${y}년 ${m}월 크레딧 달력`}>
        {WEEKDAYS.map((w, i) => <div key={w} className={`wc-cal-wd${i === 0 ? " sun" : ""}`}>{w}</div>)}
        {monthGrid(month).map((day) => {
          const events = show.credit ? byDay.get(day) ?? [] : [];
          const dayPeriods = show.period ? periods.filter((pp) => pp.start <= day && day <= pp.end) : [];
          const weekStart = new Date(`${day}T00:00:00`).getDay() === 0;
          const after = balanceAfter.get(day);
          const droppable = canDropOn(dragging, day);
          const cls = ["wc-cal-cell", monthOf(day) !== month ? "out" : "", day === data.today ? "today" : "", day < data.today ? "past" : "",
            dragging && droppable ? "drop-ok" : "", dragging && overDay === day && droppable ? "drop-over" : ""].join(" ");
          return (
            <div key={day} className={cls} role="gridcell"
              onDragOver={(e) => { if (droppable) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOverDay(day); } }}
              onDragLeave={() => setOverDay((cur) => (cur === day ? null : cur))}
              onDrop={(e) => drop(e, day)}>
              <div className="wc-cal-day">{Number(day.slice(8))}</div>
              {dayPeriods.map((pp) => (
                <div key={pp.id} className={`wc-cal-period${pp.start === day ? " first" : ""}${pp.end === day ? " last" : ""}`}
                  style={{ background: `${pp.color}33`, borderColor: pp.color, color: pp.color }} title={`${pp.label} · ${pp.start} ~ ${pp.end}`}>
                  {pp.start === day || weekStart ? <span>{pp.label}</span> : null}
                </div>
              ))}
              {events.slice(0, MAX_CHIPS).map((e, i) => (
                <div key={`${e.kind}-${e.sub_id}-${e.topup_id ?? i}`} className={`wc-cal-chip ${e.kind === "recurring" ? "rec" : "top"}`}
                  role="button" tabIndex={0} draggable={canEdit && !busy}
                  onDragStart={(ev) => { ev.dataTransfer.setData(DRAG_TYPE, e.sub_id); ev.dataTransfer.effectAllowed = "move"; setDragging(e); }}
                  onDragEnd={() => { setDragging(null); setOverDay(null); }}
                  onClick={() => openInfo(e)} onKeyDown={(ev) => { if (ev.key === "Enter") openInfo(e); }}
                  title={`${e.kind === "recurring" ? "자동 크레딧" : "추가 크레딧"} · ${e.name} · ${formatCredits(e.credits)}`}>
                  <span>{e.name}</span><b>+{formatCredits(e.credits)}</b>
                </div>
              ))}
              {events.length > MAX_CHIPS ? <div className="wc-cal-more">+{events.length - MAX_CHIPS}건 더</div> : null}
              {after != null ? <div className={`wc-cal-bal${after < 0 ? " neg" : ""}`}>잔액 {formatCredits(after)}</div> : null}
            </div>
          );
        })}
      </div>
      <div className="wc-note">보고 잔액 기준 추정 · 자동 크레딧은 자동 충전 예정일, 추가 크레딧은 기록된 날 · 잔액은 30일 안의 자동 충전일에만 · 음수면 빨간색</div>
      {info ? <EventInfo key={`${info.event.kind}-${info.event.topup_id ?? info.event.day}`} info={info}
        sub={subById.get(info.event.sub_id)} canEdit={canEdit} onEdit={(patch) => onEdit(info.event, patch)} onClose={() => setInfo(null)} /> : null}
    </div>
  );
}

function EventInfo({ info, sub, canEdit, onEdit, onClose }: {
  info: { event: CalEvent; note: string | null | undefined; noteFailed?: boolean };
  sub?: ConsoleSub;
  canEdit: boolean;
  onEdit: (patch: EventPatch) => Promise<void>;
  onClose: () => void;
}) {
  const { event, note } = info;
  const noteFailed = !!info.noteFailed; // 메모를 못 읽었다 — 금액만 저장하고 메모는 보내지 않는다(서버의 기존 메모 유지)
  const recurring = event.kind === "recurring";
  const [creditsText, setCreditsText] = useState(recurring ? formatDecimal(String(event.credits)) : formatThousands(String(event.credits)));
  const [noteText, setNoteText] = useState(note ?? "");
  // 메모는 창을 연 뒤 늦게 도착한다 — 창을 다시 만들면 '정말 삭제' 확인·입력이 초기화되므로 칸만 채운다.
  useEffect(() => { if (note !== undefined) setNoteText(note ?? ""); }, [note]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const credits = Number(creditsText.replace(/,/g, ""));
  const validCredits = recurring ? Number.isFinite(credits) && credits >= 0 : Number.isInteger(credits) && credits > 0;
  const noteReady = recurring || note !== undefined;
  const changed = credits !== event.credits || (!recurring && !noteFailed && noteReady && noteText.trim() !== (note ?? ""));
  const repeat = sub && recurring
    ? sub.recurring_period === "month" ? `매월 ${sub.topup_day}일` : sub.recurring_period === "week" ? "매주 같은 요일" : "매일"
    : null;
  const run = async (patch: EventPatch) => {
    setBusy(true); setError("");
    try { await onEdit(patch); onClose(); }
    catch (reason) { if (!(reason instanceof ManageEditCancelled)) setError(String(reason).replace(/^Error:\s*/, "")); }
    finally { setBusy(false); }
  };
  const save = () => {
    if (!validCredits || !changed || busy || !noteReady) return;
    // 추가 기록은 바꾼 금액만 싣는다 — 안 고친 금액을 화면(개요)의 옛 값으로 실으면 연 순간 설정의 금액(다른 관리자가 고친 값)을 덮었다
    // (2026-10-03 Codex 코드 리뷰 A-1). 메모는 연 순간 설정에서 읽은 값이라 그대로 실어도 같다.
    void run(recurring || noteFailed ? { credits } : { ...(credits !== event.credits ? { credits } : {}), note: noteText.trim() || null });
  };
  return (
    <div className="credit-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="wc-dialog wc-event-info" role="dialog" aria-label="크레딧 정보">
        <h3><span className={`wc-cal-chip ${recurring ? "rec" : "top"}`}>{recurring ? "자동 크레딧" : "추가 크레딧"}</span> {event.name}</h3>
        <dl>
          <dt>날짜</dt><dd>{event.day}{recurring ? " (예정)" : " (기록)"}</dd>
          {repeat ? <><dt>반복</dt><dd>{repeat}</dd></> : null}
          {sub ? <><dt>서브 잔액</dt><dd>{formatCredits(sub.balance)} <span className="credit-est">{sub.balance_seen_at?.slice(5, 16)} 보고</span></dd></> : null}
          {!canEdit ? (
            <>
              <dt>크레딧</dt><dd>+{formatCredits(event.credits)}{recurring && sub ? ` / ${PERIOD_UNIT[sub.recurring_period]}` : ""}</dd>
              {!recurring ? <><dt>메모</dt><dd>{note || "—"}</dd></> : null}
            </>
          ) : null}
        </dl>
        {canEdit ? (
          <>
            <label>크레딧{recurring && sub ? ` / ${PERIOD_UNIT[sub.recurring_period]} (정기 금액이 바뀝니다)` : ""}
              <input id="wc-event-credits" inputMode={recurring ? "decimal" : "numeric"} value={creditsText}
                onChange={(e) => setCreditsText(recurring ? formatDecimal(e.target.value) : formatThousands(e.target.value))}
                onKeyDown={(e) => { if (e.key === "Enter") save(); }} /></label>
            {!recurring ? (
              <label>메모<input id="wc-event-note" value={noteText} disabled={!noteReady || noteFailed}
                placeholder={noteFailed ? "메모를 읽지 못했습니다 — 창을 닫았다가 다시 여세요" : noteReady ? "선택" : "불러오는 중..."}
                onChange={(e) => setNoteText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") save(); }} /></label>
            ) : <p className="wc-hint">반복을 끄거나 주기·날짜를 바꾸려면 서브 표의 ＋ 크레딧 창을 쓰세요. 날짜는 막대를 끌어서 옮깁니다.</p>}
          </>
        ) : null}
        {error ? <div className="wc-error">{error}</div> : null}
        <footer>
          {canEdit && !recurring ? (
            confirmDelete
              ? <button type="button" className="danger" disabled={busy} onClick={() => void run(null)}>정말 삭제</button>
              : <button type="button" className="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>삭제</button>
          ) : null}
          <button type="button" onClick={onClose} disabled={busy}>{canEdit ? "취소" : "닫기"}</button>
          {canEdit ? <button type="button" className="pri" disabled={!validCredits || !changed || busy || !noteReady} onClick={save}>저장</button> : null}
        </footer>
      </div>
    </div>
  );
}
