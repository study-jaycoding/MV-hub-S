// 워크스페이스 콘솔(서브스페이스 — 대시보드의 워크스페이스 판) — 왼쪽 목록(메인·서브) + 메인=서브별 크레딧 조율 / 서브=그룹·크레딧·참가자.
// 설계: docs/WORKSPACE_CONSOLE_DESIGN.md. 할당은 계획·기록이다 — 실제 이체는 힉스필드가 충전일에 한다.
import { useCallback, useEffect, useRef, useState } from "react";
import { fillReorder } from "../../../lib/memberTable";
import { api } from "../../../api";
import { isRouteMissing } from "../../../lib/http";
import { manageApi } from "../../../lib/manageApi";
import type { ManageCaps } from "../../../lib/useManageCaps";
import type { CreditPlanSaveBody, CreditPlanSettings } from "../../../lib/creditPlan";
import { creditDialogSub, recurringPlanBody, STATUS_LABEL, syncConsoleStatus, topupAddBody, topupPatchBody, type ConsoleOverview, type ConsoleStatus, type ConsoleSub } from "../../../lib/workspaceConsole";
import { ManageEditCancelled, useManageEditConflict } from "../useManageEditConflict";
import { ConsoleSubView, CreditDialog } from "./ConsoleSubView";
import { ConsoleFolderDialog } from "./ConsoleFolderDialog";
import { ConsolePeriodDialog } from "./ConsolePeriodDialog";
import { CreditCalendar } from "./CreditCalendar";
import { PoolCard, SubTable } from "./ConsoleMainParts";

const errorText = (reason: unknown) => String(reason).replace(/^Error:\s*/, "");

/** selectedId·onSelectedChange = 대시보드 머리의 워크스페이스 선택과 맞물림(Jay 2026-09-30) — 서브스페이스에서 고르면 머리가 따라가고,
 *  머리에서 고른 것이 메인·서브면 서브스페이스도 그쪽을 보인다. 머리가 '전체'·개인·연결 안 된 곳이면 workingId(내가 작업하던 워크스페이스)가
 *  메인·서브일 때 그쪽, 아니면 메인을 열고 머리에도 알린다. onSelectedChange 가 없으면 제 선택(처음엔 메인)을 둔다. */
export function WorkspaceConsole({ caps, reloadSignal, selectedId, onSelectedChange, workingId }: {
  caps: ManageCaps;
  reloadSignal: number;
  selectedId?: string;
  onSelectedChange?: (id: string) => void;
  workingId?: string;
}) {
  const [data, setData] = useState<ConsoleOverview | null>(null);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);
  const [selected, setSelectedRaw] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  // 편집 창(크레딧 창·달력 정보 창)을 연 순간 읽은 설정 — 창의 처음 값이자 저장 기준(saveSub 의 base). 못 읽으면 저장하지 않는다.
  const [recurringFor, setRecurringFor] = useState<{ sub: ConsoleSub; base: CreditPlanSettings } | null>(null);
  const eventBase = useRef<{ event: unknown; base: Promise<CreditPlanSettings | null> } | null>(null);
  const [folderFor, setFolderFor] = useState<ConsoleSub | null>(null);
  const [periodFor, setPeriodFor] = useState<ConsoleSub | null>(null);
  const [notice, setNotice] = useState("");
  // 다른 워크스페이스로 옮기면 앞 화면의 저장 알림을 지운다(남아 있으면 지금 화면 얘기처럼 읽힌다).
  const setSelected = (id: string | null) => { setNotice(""); setSelectedRaw(id); if (id) onSelectedChange?.(id); };
  const [busy, setBusy] = useState(false);
  const conflict = useManageEditConflict();
  const canEdit = caps.authOff || caps.createProject;
  const canSetMain = caps.authOff || caps.system;

  const load = useCallback(async (): Promise<ConsoleOverview | null> => {
    try {
      const next = await manageApi.consoleOverview();
      setData(next); setError(""); setMissing(false);
      setSelectedRaw((current) => current ?? next.main?.id ?? next.subs[0]?.id ?? null);
      return next;
    } catch (reason) {
      if (isRouteMissing(reason)) setMissing(true);
      else setError(`불러오지 못했습니다. ${errorText(reason)}`);
      return null;
    }
  }, []);
  const [dragSub, setDragSub] = useState<string | null>(null);
  useEffect(() => { void load(); }, [load, reloadSignal]);
  // 머리 선택이 서브스페이스의 메인·서브면 그쪽. 아니면(대시보드에서만) 내가 작업하던 워크스페이스 → 메인 순으로 열고 머리에도 알린다.
  useEffect(() => {
    if (!data) return;
    const linked = (id?: string): id is string => Boolean(id) && (data.main?.id === id || data.subs.some((sub) => sub.id === id));
    if (linked(selectedId)) { setSelectedRaw(selectedId); return; }
    if (!onSelectedChange) return;
    const next = linked(workingId) ? workingId : data.main?.id;
    if (next) { setSelectedRaw(next); onSelectedChange(next); }
  }, [selectedId, data]); // eslint-disable-line react-hooks/exhaustive-deps -- 새 머리 선택·새 목록일 때만(작업 중 워크스페이스는 여는 순간의 값)

  if (missing) return <div className="manage-empty">공유 서버를 업데이트한 뒤 사용할 수 있습니다.</div>;
  if (!data) return <div className="manage-empty">{error || "불러오는 중..."}</div>;

  const main = data.main;
  const sub = data.subs.find((s) => s.id === selected);
  const mainSelected = !!main && selected === main.id;

  /** 메인 표의 칸 저장 — 기준은 base(편집 창을 연 순간 읽은 설정). base 가 없는 것은 끌어 옮기기 같은 즉시 동작뿐 — **방금** 읽는다.
   *  note·topups 전체를 되보내야 한다(Codex §9). 저장 직전에 다시 읽은 revision 에 옛 창 값을 붙이면 그사이 다른 관리자의 변경을
   *  충돌 없이 덮었다 — 연 순간 기준이면 409 병합 창으로 간다(2026-10-03 점검 CXF-7). */
  const saveSub = async (ws: ConsoleSub, label: string, body: (settings: CreditPlanSettings) => CreditPlanSaveBody, base?: CreditPlanSettings) => {
    setBusy(true); setNotice("");
    try {
      const settings = base ?? await manageApi.creditPlanSettings(ws.id);
      await conflict.saveCredit(ws.id, settings, body(settings));
      setNotice(`저장됨 · ${ws.name} ${label}`);
      await load();
    } catch (reason) {
      if (!(reason instanceof ManageEditCancelled)) setNotice(`저장하지 못했습니다. ${errorText(reason)}`);
      throw reason;
    } finally {
      setBusy(false);
    }
  };
  /** 크레딧 창은 설정을 받은 뒤에 연다 — 창의 처음 값과 저장 기준(revision)이 같은 응답이어야 한다. 못 읽으면 열지 않는다
   *  (저장 때 다시 읽어 대신하면 옛 화면 값이 최신 revision 으로 실렸다 — 2026-10-03 Codex 코드 리뷰 A-1). */
  const openCredit = async (ws: ConsoleSub) => {
    setBusy(true); setNotice("");
    try { setRecurringFor({ sub: ws, base: await manageApi.creditPlanSettings(ws.id) }); }
    catch (reason) { setNotice(`${ws.name} 크레딧 설정을 읽지 못했습니다 — 다시 눌러 주세요. ${errorText(reason)}`); }
    finally { setBusy(false); }
  };
  /** 서브 상태를 그 서브 프로젝트에 반영 — 관리 표와 같은 공용 `syncConsoleStatus`(§16). */
  const syncStatus = (sub: ConsoleSub, status: ConsoleStatus) => syncConsoleStatus(sub.id, sub.projects, status, {
    consoleSetStatus: manageApi.consoleSetStatus, updateProject: api.updateProject, getPlanning: manageApi.getPlanning, savePlanning: conflict.savePlanning,
  });
  const changeStatus = async (sub: ConsoleSub, status: ConsoleStatus) => {
    setBusy(true); setNotice("");
    try { await syncStatus(sub, status); setNotice(`${sub.name} 상태를 바꿨습니다`); }
    catch (reason) {
      if (!(reason instanceof ManageEditCancelled)) setNotice(`${sub.name} 상태 반영이 끝나지 않았습니다 — 같은 상태를 다시 눌러 주세요. ${errorText(reason)}`);
    } finally { setBusy(false); await load(); }
  };
  /** 왼쪽 목록 끌기 — 관리 창처럼 **전체 프로젝트 목록**을 새 순서로 다시 쓴다: 서브들의 프로젝트를 새 서브 순서로 앞에, 나머지는 그대로 뒤에. */
  const moveSub = async (fromId: string, toId: string) => {
    if (!data || fromId === toId) return;
    const order = data.subs.filter((x) => x.id !== fromId);
    const moved = data.subs.find((x) => x.id === fromId);
    if (!moved) return;
    // 아래로 끌면 놓은 줄 **뒤**, 위로 끌면 **앞** — 맨 끝 자리로도 옮길 수 있게
    const down = data.subs.findIndex((x) => x.id === fromId) < data.subs.findIndex((x) => x.id === toId);
    order.splice(order.findIndex((x) => x.id === toId) + (down ? 1 : 0), 0, moved);
    setBusy(true); setNotice("");
    try {
      const all = await api.projects("team", true);
      const subIds = order.flatMap((x) => x.projects.map((p) => p.id));
      const taken = new Set(subIds);
      const allIds = all.projects.map((p) => p.id);
      // 서브 프로젝트들이 있던 자리에만 새 순서를 채운다 — 서브가 아닌 프로젝트(블룸메이커 등)는 제자리(관리 표 끌기와 같은 fillReorder).
      // 목록이 그 사이 바뀌어 자리가 안 맞으면 종전처럼 서브를 앞에 모은다.
      await api.reorderProjects(fillReorder(allIds, subIds) ?? [...subIds, ...allIds.filter((pid) => !taken.has(pid))]);
      setNotice(`순서를 바꿨습니다 · ${moved.name}`);
    } catch (reason) { setNotice(`순서를 바꾸지 못했습니다. ${errorText(reason)}`); }
    finally { setBusy(false); await load(); }
  };
  const act = async (label: string, run: () => Promise<unknown>) => {
    setBusy(true); setNotice("");
    try { await run(); setNotice(label); await load(); }
    catch (reason) { setNotice(`실패했습니다. ${errorText(reason)}`); }
    finally { setBusy(false); }
  };

  return (
    <div className="wc">
      {conflict.dialog}
      <aside className="wc-rail">
        <h4>메인</h4>
        {main ? (
          <button type="button" className={`wc-ws${selected === main.id ? " on" : ""}`} onClick={() => setSelected(main.id)}>
            <span><span className="wc-star">★</span>{main.name}</span><span className="wc-tag">메인</span>
          </button>
        ) : (
          data.main_orphan ? (
            // 메인은 한 번 정하면 바뀌지 않는다 — 목록에서 사라졌으면 다른 곳을 고르게 하지 않고 복구를 청한다(Codex 검토)
            <div className="wc-pending" role="alert">메인 워크스페이스를 찾을 수 없습니다 — 힉스필드 목록에서 사라졌습니다. 메인은 바꿀 수 없으니 관리자에게 복구를 요청하세요.</div>
          ) : (
            <div className="wc-pending">메인이 정해지지 않았습니다.{canSetMain ? " 아래에서 지정하세요." : " 관리자에게 지정을 요청하세요."}</div>
          )
        )}
        <div className="wc-sep" />
        <h4>서브 워크스페이스</h4>
        {canEdit ? (
          <button type="button" className="wc-create" onClick={() => setLinkOpen(true)}>
            ＋ 서브 워크스페이스{data.pending.length ? <span className="wc-create-badge" title="연결 대기">{data.pending.length}</span> : null}
          </button>
        ) : null}
        {(Object.keys(STATUS_LABEL) as ConsoleStatus[]).map((status) => {
          const items = data.subs.filter((x) => (x.status ?? "active") === status);
          return (
            <div key={status} className="wc-rail-group">
              <div className="wc-rail-status"><span className={`wc-status ${status}`}>{STATUS_LABEL[status]}</span><small>{items.length}</small></div>
              {items.map((x) => (
                <button type="button" key={x.id} className={`wc-ws${selected === x.id ? " on" : ""}${dragSub && dragSub !== x.id ? " drop-ok" : ""}`}
                  onClick={() => setSelected(x.id)} draggable={canEdit && !busy} title={canEdit ? "끌어서 순서 변경" : undefined}
                  onDragStart={(e) => { e.dataTransfer.setData("text/plain", x.id); e.dataTransfer.effectAllowed = "move"; setDragSub(x.id); }}
                  onDragEnd={() => setDragSub(null)}
                  onDragOver={(e) => { if (dragSub && dragSub !== x.id) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } }}
                  onDrop={(e) => { e.preventDefault(); const from = dragSub; setDragSub(null); if (from) void moveSub(from, x.id); }}>
                  <span>{x.name}</span><small>{x.participants.reported + x.participants.unconfirmed}명</small>
                </button>
              ))}
              {!items.length ? <div className="wc-rail-empty">—</div> : null}
            </div>
          );
        })}
        {!main && !data.main_orphan && canSetMain && data.pending.length + data.subs.length ? (
          <label className="wc-pending">메인 지정
            <select id="wc-set-main" value="" disabled={busy} onChange={(e) => {
              const id = e.target.value;
              if (id) void act("메인을 지정했습니다", () => manageApi.consoleSetMain(id));
            }}>
              <option value="">선택</option>
              {[...data.subs, ...data.pending].map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
        ) : null}
      </aside>

      <section className="wc-body">
        {notice ? <div className="wc-notice">{notice}</div> : null}
        {mainSelected && main ? (
          <div className="usage-dashboard">
            <div className="usage-head">
              <div className="usage-title">
                <div className="usage-avatar">{main.name.slice(0, 1).toUpperCase()}</div>
                <div>
                  <div className="wc-title">{main.name} <span className="wc-chip ok">메인</span></div>
                  <p>서브 워크스페이스에 나갈 크레딧을 조율합니다 · 잔액은 {main.balance_seen_at?.slice(5, 16) ?? "보고 없음"} 보고값</p>
                </div>
              </div>
            </div>
            <PoolCard data={data} canEdit={canEdit} onChanged={() => void load()} />
            <SubTable data={data} canEdit={canEdit} busy={busy} onSelect={setSelected} onMove={(from, to) => void moveSub(from, to)} onCredit={(s) => void openCredit(s)} onFolder={setFolderFor} onPeriod={setPeriodFor}
              onStatus={(s, status) => void changeStatus(s, status)}
              onAdd={() => setLinkOpen(true)}
              onArchive={(s) => void act(`${s.name} 을(를) 내렸습니다`, () => manageApi.consoleArchive(s.id, true))} />
            <CreditCalendar data={data} canEdit={canEdit} busy={busy}
              onMove={(event, day) => {
                const sub = data.subs.find((x) => x.id === event.sub_id);
                if (!sub) return;
                if (event.kind === "topup" && event.topup_id) {
                  void saveSub(sub, `추가 크레딧 날짜 → ${day}`, (settings) => topupPatchBody(settings, event.topup_id as string, { day })).catch(() => {});
                } else if (event.kind === "recurring") {
                  // 방식은 기준 설정의 값 그대로 — 자동으로 못 박으면 그사이 수동으로 바뀐 것을 되돌렸다(Codex 2라운드 A-1)
                  void saveSub(sub, `충전일 → ${day}`, (settings) => recurringPlanBody(settings, {
                    value: settings.plan.recurring_topup ?? null, auto: settings.plan.recurring_auto ?? true,
                    period: settings.plan.recurring_period ?? "month", date: day,
                  })).catch(() => {});
                }
              }}
              onEdit={async (event, patch) => {
                const sub = data.subs.find((x) => x.id === event.sub_id);
                if (!sub) throw new Error("서브를 찾지 못했습니다. 새로고침 뒤 다시 해 주세요.");
                // 정보 창을 연 순간의 설정(CXF-7). 못 읽었으면 저장하지 않는다 — 저장 직전에 다시 읽어 대신하면 옛 화면 값이
                // 최신 revision 으로 실렸다(Codex 2라운드 A-1).
                const base = eventBase.current?.event === event ? await eventBase.current.base : null;
                if (!base) throw new Error("설정을 읽지 못해 저장하지 않았습니다 — 창을 닫았다가 다시 여세요.");
                if (event.kind === "recurring") {
                  // 금액만 — 날짜를 빼서 충전일·기준 날짜는 서버 값 그대로(2026-10-03 점검 CXF-3), 방식·주기는 기준 설정의 값 그대로
                  return saveSub(sub, "크레딧 금액", (settings) => recurringPlanBody(settings, {
                    value: patch?.credits ?? null, auto: settings.plan.recurring_auto ?? true, period: settings.plan.recurring_period ?? "month",
                  }), base);
                }
                return saveSub(sub, patch === null ? "추가 크레딧 삭제" : "추가 크레딧 수정",
                  (settings) => topupPatchBody(settings, event.topup_id as string, patch), base);
              }}
              loadNote={async (event) => {
                // 정보 창을 열 때 한 번 — 이 설정이 메모이자 저장 기준이다(CXF-7)
                const base = manageApi.creditPlanSettings(event.sub_id).catch(() => null);
                eventBase.current = { event, base };
                const settings = await base;
                if (!settings) throw new Error("설정을 읽지 못했습니다.");
                return settings.topups.find((t) => t.id === event.topup_id)?.note ?? null;
              }} />
          </div>
        ) : sub ? (
          <ConsoleSubView key={sub.id} workspaceId={sub.id} name={sub.name} tier="sub" sub={sub} today={data.today} canEdit={canEdit} conflict={conflict} onChanged={() => void load()} reloadSignal={reloadSignal} />
        ) : (
          <div className="manage-empty">왼쪽에서 워크스페이스를 고르세요.</div>
        )}
      </section>

      {linkOpen ? <LinkDialog pending={data.pending} onClose={() => setLinkOpen(false)} onLink={async (id) => {
        const linked = await manageApi.consoleLink(id) as { project_error?: string | null };
        const fresh = await load();
        const sub = fresh?.subs.find((x) => x.id === id);
        // 재연결이면 보관된 프로젝트도 활성으로(관리 창의 보관 해제와 같은 경로). 실패(이름 충돌 409 등)는 숨기지 않는다(Codex 코드 리뷰).
        let syncError = "";
        if (sub) await syncStatus(sub, "active").catch((reason) => { syncError = errorText(reason); });
        await load();
        setNotice(linked.project_error ? `서브로 연결했지만 프로젝트를 만들지 못했습니다 — 다시 연결을 눌러 주세요. ${linked.project_error}`
          : syncError ? `서브로 연결했지만 프로젝트를 활성으로 되돌리지 못했습니다 — 상태 '활성'을 다시 눌러 주세요. ${syncError}` : "서브로 연결했습니다");
        setSelectedRaw(id);
        onSelectedChange?.(id);
      }} /> : null}
      {periodFor ? <ConsolePeriodDialog sub={periodFor} savePlanning={conflict.savePlanning} onClose={() => setPeriodFor(null)} onSaved={() => void load()} /> : null}
      {folderFor ? <ConsoleFolderDialog workspaceId={folderFor.id} name={folderFor.name} onClose={() => setFolderFor(null)} /> : null}
      {recurringFor ? (
        <CreditDialog name={recurringFor.sub.name} sub={creditDialogSub(recurringFor.base, data.today)} today={data.today} onClose={() => setRecurringFor(null)}
          onSave={(plan) => saveSub(recurringFor.sub, "크레딧", (settings) => recurringPlanBody(settings, plan), recurringFor.base)}
          onAdd={(t) => saveSub(recurringFor.sub, "추가 크레딧", (settings) => topupAddBody(settings, t), recurringFor.base)} />
      ) : null}
    </div>
  );
}

function LinkDialog({ pending, onClose, onLink }: {
  pending: ConsoleOverview["pending"];
  onClose: () => void;
  onLink: (id: string) => Promise<void>;
}) {
  const [pick, setPick] = useState(pending[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="credit-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="wc-dialog" role="dialog" aria-label="워크스페이스 만들기">
        <h3>워크스페이스 만들기</h3>
        <p>힉스필드에서 만든 워크스페이스를 서브로 연결합니다. 목록에 없으면 힉스필드에서 먼저 만들고, 그 워크스페이스 멤버 한 명이 MV Hub 를 켜면 여기에 나타납니다.</p>
        {pending.map((w) => (
          <label key={w.id} className={`wc-choice${pick === w.id ? " on" : ""}`}>
            <span><input type="radio" name="wc-link" checked={pick === w.id} onChange={() => setPick(w.id)} /> {w.name}</span>
            <span className="wc-chip">{w.archived ? "내린 서브 · " : ""}보고 {w.reported}명{w.last_seen_at ? ` · ${w.last_seen_at.slice(5, 16)}` : ""}</span>
          </label>
        ))}
        {!pending.length ? <div className="wc-note">연결할 워크스페이스가 없습니다.</div> : null}
        {error ? <div className="wc-error">{error}</div> : null}
        <footer>
          <button type="button" onClick={onClose} disabled={busy}>취소</button>
          <button type="button" className="pri" disabled={!pick || busy} onClick={async () => {
            setBusy(true); setError("");
            try { await onLink(pick); onClose(); }
            catch (reason) { setError(errorText(reason)); }
            finally { setBusy(false); }
          }}>서브로 연결</button>
        </footer>
      </div>
    </div>
  );
}
