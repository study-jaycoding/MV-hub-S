// 서브(또는 메인 자체) 워크스페이스 — 그룹 · 크레딧 · 참가자. 쓰기는 모두 기존 PUT credit-plan(409 병합 포함).
import { useCallback, useEffect, useState } from "react";
import { formatCredits } from "../../../lib/formatCredits";
import { manageApi } from "../../../lib/manageApi";
import {
  draftFromSettings,
  GROUP_COLOR_PALETTE,
  formatDecimal,
  formatThousands,
  groupColor,
  newDraftGroup,
  periodSuffix,
  remainingTone,
  type CreditPlanDraft,
  type CreditPlanSaveBody,
  type CreditPlanSettings,
  type CreditPlanView,
  type DraftGroup,
  type LimitPeriod,
} from "../../../lib/creditPlan";
import { api } from "../../../api";
import { groupAssignBody, groupColorBody, groupEditBody, type MemberTableData } from "../../../lib/memberTable";
import { PROJECT_ROLES } from "../../../types";
import { WorkSearchBox } from "../WorkFilterBar";
import { ConsoleFilterBar, emptyChipFilters, passesChipFilters, type ChipFilters, type FilterField } from "./ConsoleFilterBar";
import { EMAIL_RE, PERIOD_UNIT, recurringPlanBody, scheduleLabel, topupAddBody, type ConsoleSub } from "../../../lib/workspaceConsole";
import { GroupEditor } from "../CreditPlanFields";
import { ManageEditCancelled, useManageEditConflict } from "../useManageEditConflict";

type Pane = "groups" | "credits" | "people";
type Conflict = ReturnType<typeof useManageEditConflict>;

const errorText = (reason: unknown) => String(reason).replace(/^Error:\s*/, "");

/** 그룹 알약 — 그룹 색을 옅은 바탕·진한 글자로. 그룹이 없으면 회색 '그룹 없음'. */
function GroupPill({ name, color }: { name: string | null; color?: string | null }) {
  if (!name) return <span className="wc-gpill none">그룹 없음</span>;
  const c = groupColor(color);
  return <span className="wc-gpill" style={{ color: c, background: `${c}26`, borderColor: `${c}59` }}>{name}</span>;
}

const ROLE_SHORT: Record<string, string> = { project_manager: "PM", supervisor: "Sup", creator: "Creator" };

/** 프로젝트 역할 알약 — 관리 표와 같은 색(mtable-chip role-*). 역할이 없으면 회색 '없음'. */
function RolePills({ roles }: { roles: string[] }) {
  if (!roles.length) return <span className="wc-gpill none">없음</span>;
  return <span className="wc-role-pills">{PROJECT_ROLES.filter((r) => roles.includes(r)).map((r) => <span key={r} className={`mtable-chip role-${r}`}>{ROLE_SHORT[r]}</span>)}</span>;
}

/** 역할 켜고 끄기 — 누를 때마다 바로 저장. 마지막 역할을 끄면 프로젝트에서 빠지므로 한 번 더 확인한다. */
function RoleMenuBody({ roles, onSave, close }: { roles: string[]; onSave: (next: string[]) => void; close: () => void }) {
  const [confirmOut, setConfirmOut] = useState(false);
  return (
    <>
      {PROJECT_ROLES.map((r) => {
        const on = roles.includes(r);
        return (
          <button key={r} type="button" role="menuitemcheckbox" aria-checked={on} className={on ? "on" : ""} onClick={() => {
            const next = on ? roles.filter((x) => x !== r) : [...roles, r];
            if (!next.length) { setConfirmOut(true); return; }
            close(); onSave(next);
          }}>
            <span className={`mtable-chip role-${r}${on ? "" : " off"}`}>{ROLE_SHORT[r]}</span>
          </button>
        );
      })}
      {confirmOut ? (
        <button type="button" className="danger" onClick={() => { close(); onSave([]); }}>프로젝트에서 빼기</button>
      ) : null}
    </>
  );
}

/** 알약을 누르면 뜨는 작은 메뉴(바깥을 누르면 닫힘). */
function PillMenu({ trigger, disabled, children }: { trigger: React.ReactNode; disabled?: boolean; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="wc-status-wrap" onClick={(e) => e.stopPropagation()}>
      <button type="button" className="wc-pill-btn" disabled={disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {trigger}
      </button>
      {open ? (
        <>
          <div className="wc-menu-backdrop" onMouseDown={() => setOpen(false)} />
          <div className="wc-menu wc-status-menu" role="menu">{children(() => setOpen(false))}</div>
        </>
      ) : null}
    </span>
  );
}

/** 참가시키기 창 — 이메일 + 그룹 알약 하나 고르기. 힉스필드 보고 전이어도 넣을 수 있다('확인 전'). 관리 표 크레딧 시트도 쓴다(§16). */
export function AddMemberDialog({ groups, onClose, onSave }: {
  groups: CreditPlanSettings["groups"];
  onClose: () => void;
  onSave: (email: string, groupId: string) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [gid, setGid] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const addr = email.trim().toLowerCase();
  const valid = EMAIL_RE.test(addr) && !!gid;
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true); setError("");
    try { await onSave(addr, gid); onClose(); }
    catch (reason) { if (!(reason instanceof ManageEditCancelled)) setError(errorText(reason)); }
    finally { setBusy(false); }
  };
  return (
    <div className="credit-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="wc-dialog" role="dialog" aria-label="참가시키기">
        <h3>참가시키기</h3>
        <p>이메일을 그룹에 넣어 할당 크레딧을 줍니다. 그 사람의 앱이 이 워크스페이스를 보고하기 전이면 '확인 전'으로 보입니다.</p>
        <label>이메일<input id="wc-add-email" className="wc-left" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com"
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} /></label>
        <div className="wc-hint">그룹</div>
        <div className="wc-pill-pick" role="radiogroup" aria-label="그룹">
          {groups.map((g) => (
            <button key={g.id} type="button" role="radio" aria-checked={gid === g.id} className={gid === g.id ? "on" : ""} onClick={() => setGid(g.id)}>
              <GroupPill name={g.name} color={g.color} />
            </button>
          ))}
          {!groups.length ? <span className="wc-hint">그룹이 없습니다. 그룹 탭에서 먼저 만드세요.</span> : null}
        </div>
        {error ? <div className="wc-error">{error}</div> : null}
        <footer>
          <button type="button" onClick={onClose} disabled={busy}>취소</button>
          <button type="button" className="pri" disabled={!valid || busy} onClick={() => void submit()}>참가시키기</button>
        </footer>
      </div>
    </div>
  );
}

/** 크레딧 창 — 메인 표의 ＋. 자동(힉스필드가 주기마다 넣음)·수동(반복 없음) = 정기 설정, 추가 = 이번에 더 넣은 크레딧 한 건 기록.
 *  금액을 비우면 프로젝트 월 예산 합(파생)으로 돌아간다. 월 주기의 날짜는 '매월 그 날'이며 이 서브의 달 경계도 옮긴다. */
export function CreditDialog({ name, sub, today, onClose, onSave, onAdd }: {
  name: string;
  sub: { monthly_topup: number | null; monthly_topup_source: ConsoleSub["monthly_topup_source"]; recurring_auto: boolean;
    recurring_period: LimitPeriod; recurring_anchor: string | null; topup_day: number; next_topup_day: string | null };
  today: string;
  onClose: () => void;
  onSave: (plan: { value: number | null; auto: boolean; period: LimitPeriod; date: string }) => Promise<void>;
  onAdd: (topup: { day: string; credits: number; note: string | null }) => Promise<void>;
}) {
  const current = sub.monthly_topup_source === "manual" ? sub.monthly_topup : null;
  // 칸에는 오늘을 보여 주되(Jay 2026-09-29), 손대지 않으면 기존 충전일(다음 충전일)을 그대로 보낸다 —
  // 금액만 고쳐 저장했는데 충전일이 오늘로 바뀌는 일을 막는다.
  const startDate = sub.next_topup_day && sub.next_topup_day >= today ? sub.next_topup_day : today;
  const [mode, setMode] = useState<"auto" | "manual" | "add">(sub.recurring_auto ? "auto" : "manual");
  const [period, setPeriod] = useState<LimitPeriod>(sub.recurring_period);
  const [text, setText] = useState(current == null ? "" : formatDecimal(String(current)));
  const [date, setDate] = useState(today);
  const [dateTouched, setDateTouched] = useState(false);
  const [addDay, setAddDay] = useState(today);
  const [addText, setAddText] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const auto = mode === "auto";
  const adding = mode === "add";
  const raw = text.replace(/,/g, "").trim();
  const value = raw ? Number(raw) : null;
  const addAmount = Number(addText.replace(/,/g, ""));
  const effDate = dateTouched ? date : startDate;
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(effDate);
  const valid = adding
    ? /^\d{4}-\d{2}-\d{2}$/.test(addDay) && Number.isInteger(addAmount) && addAmount > 0
    : validDate && (value === null || (Number.isFinite(value) && value >= 0));
  const monthly = !auto || period === "month";
  const dayOfMonth = validDate ? Number(effDate.slice(8, 10)) : sub.topup_day;
  const weekday = validDate ? "일월화수목금토"[new Date(`${effDate}T00:00:00`).getDay()] : "";
  const changed = adding || value !== current || auto !== sub.recurring_auto || effDate !== startDate
    || (auto && period !== sub.recurring_period);
  const unit = monthly ? "월" : PERIOD_UNIT[period];
  const save = async () => {
    if (!valid || !changed || busy) return;
    setBusy(true); setError("");
    try {
      if (adding) await onAdd({ day: addDay, credits: addAmount, note: note.trim() || null });
      else await onSave({ value, auto, period, date: effDate });
      onClose();
    } catch (reason) { if (!(reason instanceof ManageEditCancelled)) setError(errorText(reason)); }
    finally { setBusy(false); }
  };
  const dateLabel = !auto ? "주기 기준일 (매월 이 날짜)" : period === "month" ? "충전일 (매월 이 날짜)"
    : period === "week" ? "충전일 (매주 이 요일)" : "시작일 (이날부터 매일)";
  const repeat = period === "month" ? `이후 매월 ${dayOfMonth}일` : period === "week" ? `이후 매주 ${weekday}요일` : "이후 매일";
  const hint = mode === "auto" ? "충전일마다 힉스필드가 자동으로 넣습니다. 메인 잔액 예정표에 잡힙니다."
    : mode === "manual" ? "반복 충전하지 않습니다. 넣을 때마다 '추가'로 기록하세요. 예정표에서 빠집니다."
    : "힉스필드에서 이번에 더 넣은 크레딧을 기록합니다. 정기 설정은 바뀌지 않습니다. 이 기록은 실제 이체가 아닙니다.";
  return (
    <div className="credit-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="wc-dialog" role="dialog" aria-label="크레딧">
        <h3>크레딧 · {name}</h3>
        <p>이 서브로 나갈 크레딧을 정합니다. 실제 이체는 힉스필드가 합니다.</p>
        <div className="wc-seg" role="radiogroup" aria-label="크레딧 방식">
          {([["auto", "자동"], ["manual", "수동"], ["add", "추가"]] as const).map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={mode === v} className={mode === v ? "on" : ""} onClick={() => setMode(v)}>{label}</button>
          ))}
        </div>
        <p className="wc-hint">{hint}</p>
        {adding ? (
          <>
            <label>날짜<input id="wc-add-day" type="date" value={addDay} onChange={(e) => setAddDay(e.target.value)} /></label>
            <label>크레딧<input id="wc-add-credits" inputMode="numeric" value={addText} onChange={(e) => setAddText(formatThousands(e.target.value))} placeholder="예: 8,000"
              onKeyDown={(e) => { if (e.key === "Enter") void save(); }} /></label>
            <label>메모<input id="wc-add-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="선택" /></label>
          </>
        ) : (
          <>
            <label>{dateLabel}
              <span className="wc-date-row">
                {auto ? (
                  <span className="wc-seg" role="radiogroup" aria-label="충전 주기">
                    {(["month", "week", "day"] as LimitPeriod[]).map((p) => (
                      <button key={p} type="button" role="radio" aria-checked={period === p} className={period === p ? "on" : ""}
                        onClick={() => setPeriod(p)}>{PERIOD_UNIT[p]}</button>
                    ))}
                  </span>
                ) : null}
                <input id="wc-recurring-day" type="date" min={today} value={date} onChange={(e) => { setDate(e.target.value); setDateTouched(true); }} />
              </span>
            </label>
            <label>크레딧 / {unit}<input id="wc-recurring" inputMode="decimal" value={text} onChange={(e) => setText(formatDecimal(e.target.value))}
              placeholder={sub.monthly_topup_source === "derived" && sub.monthly_topup ? `비우면 프로젝트 월 예산 합 ${formatCredits(sub.monthly_topup)}` : "예: 60,000"}
              onKeyDown={(e) => { if (e.key === "Enter") void save(); }} /></label>
            {auto && validDate ? <div className="wc-hint"><span className="wc-next">Next</span>{effDate} · {repeat}{dateTouched ? "" : " (지금 충전일 유지 — 날짜를 고르면 바뀝니다)"}</div> : null}
            {monthly && dayOfMonth !== sub.topup_day ? <div className="wc-hint">충전일을 바꾸면 이 서브의 이번 주기(사용량·그룹 기간) 경계도 {dayOfMonth}일 기준으로 바뀝니다.</div> : null}
          </>
        )}
        {error ? <div className="wc-error">{error}</div> : null}
        <footer>
          <button type="button" onClick={onClose} disabled={busy}>취소</button>
          <button type="button" className="pri" disabled={!valid || !changed || busy} onClick={() => void save()}>{adding ? "기록" : "저장"}</button>
        </footer>
      </div>
    </div>
  );
}

export function ConsoleSubView({ workspaceId, name, tier, sub, today, canEdit, conflict, onChanged }: {
  workspaceId: string;
  name: string;
  tier: "main" | "sub";
  sub?: ConsoleSub; // 메인 개요의 이 서브 한 줄 — 충전 방식·할당 주기 숫자를 메인 표와 똑같이 쓰려고
  today: string;
  canEdit: boolean;
  conflict: Conflict;
  onChanged: () => void;
}) {
  const [pane, setPane] = useState<Pane>("people");
  const [view, setView] = useState<CreditPlanView | null>(null);
  const [settings, setSettings] = useState<CreditPlanSettings | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<{ draft: CreditPlanDraft; group: DraftGroup } | null>(null);
  const [creditOpen, setCreditOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [roleTable, setRoleTable] = useState<MemberTableData | null>(null);
  const [projectId, setProjectId] = useState("");
  const [memberQuery, setMemberQuery] = useState("");
  const [memberFilters, setMemberFilters] = useState<ChipFilters>(emptyChipFilters);

  const load = useCallback(async () => {
    try {
      const [v, s] = await Promise.all([
        manageApi.creditPlan(workspaceId),
        canEdit ? manageApi.creditPlanSettings(workspaceId) : Promise.resolve(null),
      ]);
      setView(v); setSettings(s); setError("");
    } catch (reason) {
      setError(`불러오지 못했습니다. ${errorText(reason)}`);
    }
  }, [workspaceId, canEdit]);
  useEffect(() => { void load(); }, [load]);
  const loadRoles = useCallback(async () => {
    try {
      const table = await manageApi.memberTable(workspaceId);
      setRoleTable(table.caps.project_roles ? table : null);
      setProjectId((cur) => (table.projects.some((p) => p.id === cur) ? cur : table.projects[0]?.id ?? ""));
    } catch { setRoleTable(null); }
  }, [workspaceId]);
  useEffect(() => { if (canEdit) void loadRoles(); }, [canEdit, loadRoles]);
  const roleRowOf = (email: string) => roleTable?.rows.find((r) => r.email.toLowerCase() === email.toLowerCase());
  const saveRoles = async (name: string, uid: string, next: string[]) => {
    const project = roleTable?.projects.find((p) => p.id === projectId);
    if (!project) return;
    setBusy(true); setNotice("");
    try {
      if (next.length) await api.setProjectRoles(project.id, uid, next);
      else await api.removeProjectMember(project.id, uid);
      setNotice(`저장됨 · ${project.name} 역할 (${name})`);
    } catch (reason) {
      setNotice(`역할을 저장하지 못했습니다. ${errorText(reason)}`);
    } finally {
      setBusy(false);
      await loadRoles();
    }
  };

  /** 저장 한 건 — 방금 읽은 settings 를 기준으로 보내고(409 면 병합 창), 결과로 화면을 갱신한다. */
  const save = async (label: string, body: (s: CreditPlanSettings) => CreditPlanSaveBody) => {
    if (!settings) return;
    setBusy(true); setNotice("");
    try {
      const saved = await conflict.saveCredit(workspaceId, settings, body(settings));
      setSettings(saved);
      setNotice(`저장됨 · ${label}`);
      setView(await manageApi.creditPlan(workspaceId));
      onChanged();
    } catch (reason) {
      if (!(reason instanceof ManageEditCancelled)) setNotice(`저장하지 못했습니다. ${errorText(reason)}`);
      await load();
      throw reason;
    } finally {
      setBusy(false);
    }
  };
  const quiet = (p: Promise<unknown>) => { void p.catch(() => {}); };

  const pool = view?.pool;
  const unit = sub ? (sub.recurring_auto ? PERIOD_UNIT[sub.recurring_period] : "월") : "월";
  const cycleText = sub ? `${sub.cycle_start.slice(5)} ~ ${sub.cycle_end.slice(5)}` : view?.cycle_start ? `${view.cycle_start.slice(5)} ~` : "";
  const groups = settings?.groups ?? view?.groups ?? [];
  const quotaTotal = groups.reduce<number | null>((sum, g) => (g.quota_total == null ? sum : (sum ?? 0) + g.quota_total), null);
  const members = settings?.members ?? [];
  const groupNameOf = (gid: string | null) => settings?.groups.find((g) => g.id === gid)?.name ?? "그룹 없음";
  const memberValue = (m: CreditPlanSettings["members"][number], key: string) =>
    key === "group" ? groupNameOf(m.group_id) : key === "hf" ? (m.is_available ? "확인" : "확인 전")
      : m.remaining != null && m.remaining < 0 ? "초과" : "여유";
  const memberFilterFields: FilterField[] = [
    { key: "group", label: "그룹", options: [...new Set(members.map((m) => groupNameOf(m.group_id)))].sort() },
    { key: "hf", label: "힉스필드", options: ["확인", "확인 전"].filter((v) => members.some((m) => memberValue(m, "hf") === v)) },
    { key: "over", label: "잔여 크레딧", options: ["초과", "여유"].filter((v) => members.some((m) => memberValue(m, "over") === v)) },
  ];
  const q = memberQuery.trim().toLowerCase();
  const shownMembers = members.filter((m) =>
    (!q || m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q)) && passesChipFilters(m, memberFilters, memberValue));

  return (
    <div className="usage-dashboard">
      <div className="usage-head">
        <div className="usage-title">
          <div className="usage-avatar">{name.slice(0, 1).toUpperCase()}</div>
          <div>
            <div className="wc-title">{name} <span className={`wc-chip${tier === "main" ? " ok" : ""}`}>{tier === "main" ? "메인" : "서브"}</span></div>
            <p>그룹을 만들고 크레딧을 나누고 참가자를 넣습니다{sub ? ` · 충전 ${scheduleLabel(sub)}` : ""}</p>
          </div>
        </div>
        <div className="usage-segmented wc-subtabs" role="tablist">
          {([["groups", "그룹"], ["people", "참가자"], ["credits", "크레딧"]] as [Pane, string][]).map(([v, label]) => (
            <button key={v} type="button" role="tab" aria-selected={pane === v} className={pane === v ? "on" : ""} onClick={() => setPane(v)}>{label}</button>
          ))}
        </div>
      </div>
      {error ? <div className="wc-error">{error}</div> : null}
      {notice ? <div className="wc-notice">{notice}</div> : null}

      <div className="usage-card credit-card">
        <div className="credit-pool-grid">
          <div><span>잔액(보고)</span><strong>{formatCredits(pool?.balance)}</strong><em>{pool?.balance_seen_at?.slice(5, 16) ?? "보고 없음"}</em></div>
          <div><span>크레딧 / {unit}</span><strong>{sub?.monthly_topup ? formatCredits(sub.monthly_topup) : sub ? "없음" : formatCredits(pool?.monthly_topup)}</strong><em>{sub ? scheduleLabel(sub) : ""}</em></div>
          <div><span>추가 크레딧(이번 주기)</span><strong>{formatCredits(sub?.topups_cycle.credits ?? pool?.topups_month.credits ?? 0)}</strong><em>{sub?.topups_cycle.count ?? pool?.topups_month.count ?? 0}건</em></div>
          <div><span>이번 주기 사용</span><strong>{formatCredits(sub?.used_cycle ?? pool?.used_month)}</strong><em>{cycleText}{(sub?.unknown_cycle ?? pool?.unknown_month) ? ` · 미상 ${sub?.unknown_cycle ?? pool?.unknown_month}건` : ""}</em></div>
          <div><span>그룹 할당 크레딧 합계</span><strong>{formatCredits(quotaTotal)}</strong><em>{groups.some((g) => g.quota_total == null) ? "∞ 그룹 제외" : `그룹 ${groups.length}개`}</em></div>
        </div>
      </div>

      {!canEdit ? <div className="wc-note">보기 전용입니다 — 그룹·크레딧·참가자 편집은 프로젝트 생성 권한(PM)이 있어야 합니다.</div> : null}

      {pane === "groups" && (
        <div className="usage-card">
          <div className="usage-card-head">
            <div><h3>그룹</h3></div>
            {canEdit && settings ? (
              <button type="button" className="wc-btn" disabled={busy} onClick={() => setEditor({ draft: draftFromSettings(settings), group: newDraftGroup() })}>＋ 그룹 만들기</button>
            ) : null}
          </div>
          <table className="usage-table">
            <thead><tr><th>그룹</th><th>그룹 크레딧</th><th>기간</th><th>인원</th><th>이번 기간 사용</th><th>남음</th></tr></thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.id} className={canEdit ? "wc-click" : ""} onClick={() => {
                  if (!canEdit || !settings || busy) return;
                  const draft = draftFromSettings(settings);
                  const group = draft.groups.find((d) => d.id === g.id);
                  if (group) setEditor({ draft, group });
                }}>
                  <td>
                    {canEdit && settings ? (
                      <PillMenu trigger={<GroupPill name={g.name} color={g.color} />} disabled={busy}>
                        {(close) => (
                          <div className="wc-palette" role="group" aria-label={`${g.name} 색`}>
                            {GROUP_COLOR_PALETTE.map((c) => (
                              <button key={c} type="button" className={groupColor(g.color) === c ? "on" : ""} style={{ background: c }} aria-label={c}
                                onClick={() => { close(); if (groupColor(g.color) !== c) quiet(save(`${g.name} 색`, (st) => groupColorBody(st, g.id, c))); }} />
                            ))}
                          </div>
                        )}
                      </PillMenu>
                    ) : <GroupPill name={g.name} color={g.color} />}
                  </td>
                  <td>{g.monthly_limit == null ? "∞" : formatCredits(g.monthly_limit)}</td>
                  <td>{periodSuffix(g.limit_period).slice(1)}</td>
                  <td>{g.member_count}</td>
                  <td>{formatCredits(g.used_period ?? g.used_month)}</td>
                  <td>{g.remaining == null ? "—" : <span className={`credit-pct tone-${remainingTone(g.remaining, g.quota_total ?? null)}`}>{formatCredits(g.remaining)}</span>}</td>
                </tr>
              ))}
              {!groups.length ? <tr><td colSpan={6} className="mtable-muted">아직 그룹이 없습니다.</td></tr> : null}
            </tbody>
          </table>
          {canEdit ? <div className="wc-note">그룹 줄을 누르면 이름·한도·기간·허용 모델·참가자를 고칩니다.</div> : null}
        </div>
      )}

      {pane === "credits" && (
        <div className="usage-card">
          <div className="usage-card-head">
            <div><h3>크레딧</h3></div>
            {canEdit && settings && sub ? <button type="button" className="wc-btn" disabled={busy} onClick={() => setCreditOpen(true)}>＋ 크레딧</button> : null}
          </div>
          <table className="usage-table wc-kv">
            <tbody>
              <tr><td>크레딧</td><td>{sub?.monthly_topup ? `${formatCredits(sub.monthly_topup)} / ${unit}` : "없음"}</td></tr>
              <tr>
                <td>충전</td>
                <td>
                  {sub ? scheduleLabel(sub) : "—"}
                  {sub?.recurring_auto && sub.monthly_topup && sub.next_topup_day ? <> · <span className="wc-next">Next</span>{sub.next_topup_day}</> : null}
                </td>
              </tr>
              <tr><td>이번 주기</td><td>{sub ? `${sub.cycle_start} ~ ${sub.cycle_end}` : `${view?.cycle_start ?? "—"} ~ ${view?.cycle_end ?? "—"}`}</td></tr>
            </tbody>
          </table>
          <div className="usage-card-head"><div><h3>추가 크레딧 기록</h3></div><span>최근순</span></div>
          <table className="usage-table">
            <thead><tr><th>날짜</th><th>크레딧</th><th>메모</th></tr></thead>
            <tbody>
              {(settings?.topups ?? view?.topups ?? []).map((t) => (
                <tr key={t.id}><td>{t.day}</td><td>{formatCredits(t.credits)}</td><td>{t.note ?? ""}</td></tr>
              ))}
              {!(settings?.topups ?? view?.topups ?? []).length ? <tr><td colSpan={3} className="mtable-muted">기록이 없습니다.</td></tr> : null}
            </tbody>
          </table>
        </div>
      )}

      {pane === "people" && (
        <div className="usage-card">
          <div className="usage-card-head">
            <div className="wc-people-head">
              <h3>참가자</h3><span className="wc-count">{shownMembers.length}/{members.length}</span>
              {roleTable && roleTable.projects.length > 1 ? (
                <label className="wc-proj-pick">역할 프로젝트
                  <select id="wc-role-project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                    {roleTable.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
              ) : roleTable && roleTable.projects.length === 1 ? <span className="credit-est">역할 = {roleTable.projects[0].name}</span> : null}
            </div>
            <div className="wc-people-head">
              <WorkSearchBox value={memberQuery} onChange={setMemberQuery} />
              <ConsoleFilterBar fields={memberFilterFields} filters={memberFilters} onChange={setMemberFilters} />
              {canEdit && settings ? <button type="button" className="wc-btn" disabled={busy} onClick={() => setAddOpen(true)}>＋ 참가시키기</button> : null}
            </div>
          </div>
          {settings ? (
            <table className="usage-table">
              <thead><tr><th>이름 · 이메일</th>{roleTable ? <th>역할</th> : null}<th>그룹</th><th>할당 크레딧</th><th>이번 기간 사용</th><th>잔여 크레딧</th><th>힉스필드</th></tr></thead>
              <tbody>
                {shownMembers.map((m) => (
                  <tr key={m.email}>
                    <td>{m.name} <span className="credit-est">{m.email}</span></td>
                    {roleTable ? (() => {
                      const row = roleRowOf(m.email);
                      const roles = row?.projects[projectId] ?? [];
                      const locked = !row?.uid || !row.project_editable || !projectId;
                      const why = !row ? "이 워크스페이스 계정 명단에 없는 이메일" : !row.uid ? "앱 계정과 아직 연결되지 않음" : row.project_lock === "uid_conflict" ? "계정 연결이 엉켜 있어 관리 표에서 정리 필요" : "";
                      return (
                        <td>
                          {locked ? <span title={why}><RolePills roles={roles} /></span> : (
                            <PillMenu disabled={busy} trigger={<RolePills roles={roles} />}>
                              {(close) => <RoleMenuBody roles={roles} close={close} onSave={(next) => void saveRoles(m.name, row!.uid as string, next)} />}
                            </PillMenu>
                          )}
                        </td>
                      );
                    })() : null}
                    <td>
                      <PillMenu disabled={busy} trigger={<GroupPill name={settings.groups.find((g) => g.id === m.group_id)?.name ?? null}
                        color={settings.groups.find((g) => g.id === m.group_id)?.color} />}>
                        {(close) => (
                          <>
                            {settings.groups.map((g) => (
                              <button key={g.id} type="button" role="menuitemradio" aria-checked={g.id === m.group_id} className={g.id === m.group_id ? "on" : ""}
                                onClick={() => { close(); if (g.id !== m.group_id) quiet(save(`${m.name} 그룹`, (st) => groupAssignBody(st, m.email, g.id))); }}>
                                <GroupPill name={g.name} color={g.color} />
                              </button>
                            ))}
                            <button type="button" role="menuitemradio" aria-checked={!m.group_id} className={!m.group_id ? "on" : ""}
                              onClick={() => { close(); if (m.group_id) quiet(save(`${m.name} 그룹`, (st) => groupAssignBody(st, m.email, null))); }}>
                              <GroupPill name={null} />
                            </button>
                          </>
                        )}
                      </PillMenu>
                    </td>
                    <td>{!m.group_id ? "—" : m.quota_effective == null ? "∞" : formatCredits(m.quota_effective)}</td>
                    <td>{formatCredits(m.used_period)}</td>
                    <td className={m.remaining != null && m.remaining < 0 ? "mtable-over" : ""}>{formatCredits(m.remaining)}</td>
                    <td><span className={`wc-chip${m.is_available ? " ok" : " pend"}`}>{m.is_available ? "확인" : "확인 전"}</span></td>
                  </tr>
                ))}
                {!shownMembers.length ? <tr><td colSpan={roleTable ? 7 : 6} className="mtable-muted">{members.length ? "조건에 맞는 참가자가 없습니다." : "보고된 참가자가 없습니다."}</td></tr> : null}
              </tbody>
            </table>
          ) : <div className="wc-note">참가자 명단은 편집 권한(PM)이 있어야 보입니다.</div>}
          <div className="wc-note">'확인 전' = 그룹에는 넣었지만 그 사람의 앱이 아직 이 워크스페이스를 보고하지 않음 · 초과해도 막지 않고 경고만(실제 한도는 힉스필드)</div>
        </div>
      )}

      {editor ? (
        <GroupEditor
          draft={editor.draft}
          group={editor.group}
          busy={busy}
          onClose={() => setEditor(null)}
          onApply={(next, emails) => quiet(
            save(`그룹 ${next.name.trim()}`, (s) => groupEditBody(s, next, emails)).then(() => setEditor(null)),
          )}
        />
      ) : null}
      {addOpen && settings ? (
        <AddMemberDialog groups={settings.groups} onClose={() => setAddOpen(false)}
          onSave={(email, gid) => save(`참가자 ${email}`, (st) => groupAssignBody(st, email, gid))} />
      ) : null}
      {creditOpen && sub ? (
        <CreditDialog name={name} sub={sub} today={today} onClose={() => setCreditOpen(false)}
          onSave={(plan) => save("크레딧", (s) => recurringPlanBody(s, plan))}
          onAdd={(t) => save("추가 크레딧", (s) => topupAddBody(s, t))} />
      ) : null}
    </div>
  );
}
