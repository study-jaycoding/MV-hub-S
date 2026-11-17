import { Fragment, useEffect, useRef, useState } from "react";
import { getAccountScope, getConnectionKey } from "../../../lib/accountScope";
import { formatBalanceAbsolute, formatBalanceTime } from "../../../lib/format";
import { formatCredits } from "../../../lib/formatCredits";
import { getBalanceLedger, getBalances } from "../../../lib/hfBalance";
import { getAuthToken, isHttpStatus } from "../../../lib/http";
import { t, useT } from "../../../lib/i18n";
import type { ManageCaps } from "../../../lib/useManageCaps";
import { useSyncStatus } from "../../../lib/useSyncStatus";
import type { BalanceChartPoint, BalanceInterval, BalanceLedgerResponse, BalanceMeta } from "../../../shared/contracts/hfBalance";

type Space = { id: string; name: string };
type Range = "week" | "month" | "previous";
const dayKey = (ms: number) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
const money = (c: number | null | undefined, signed = false) => c == null ? "—" : `${signed && c > 0 ? "+" : ""}${formatCredits(c / 100)}`;
const identity = () => JSON.stringify([getAccountScope(), getConnectionKey(), getAuthToken()]);
const text = (key: string, fields: Record<string, string | number>) => Object.entries(fields).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), t(key));

function dates(range: Range): [string, string] {
  const today = new Date(`${dayKey(Date.now())}T00:00:00Z`);
  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() + 1);
  const start = new Date(today);
  if (range === "week") start.setUTCDate(start.getUTCDate() - 6);
  else if (range === "month") start.setUTCDate(1);
  else { end.setTime(today.getTime()); end.setUTCDate(1); start.setUTCDate(1); start.setUTCMonth(start.getUTCMonth() - 1); }
  return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
}

function stateLabel(item: BalanceInterval): string {
  const {state, reason_codes: reasons} = item;
  if (state === "observation_uncertain") {
    if (item.opening_c == null || item.closing_c == null || reasons.includes("simultaneous_conflict")) return t("같은 시각 값이 다름");
    return t(reasons.includes("precision_unknown") ? "금액 오차 범위를 모름" : "확인 시각 불확실");
  }
  return t({ numeric_match: "맞음", residual_present: "차이 있음", api_pending: "사용 기록 모으는 중", comparison_unavailable: "비교 못 함" }[state]);
}
function candidateLabel(kind: string): string {
  return t(({ allocation_candidate: "배분 추정", topup_candidate: "충전 추정", refund_candidate: "환불 추정" } as Record<string, string>)[kind] || "모름");
}
function evidenceLine(item: BalanceInterval, spaces: Space[]): string {
  if (item.candidate_classification === "unclassified") return "";
  const evidence = item.candidate_evidence[0];
  if (evidence?.code === "opposite_observed_intervals") return text("같은 시각 {공간} {금액}", { 공간: spaces.find((s) => s.id === evidence.workspace_id)?.name || t("다른 공간"), 금액: money(evidence.residual_c, true) });
  if (evidence?.code === "current_plan_match") return `${text("입력한 추가 크레딧 {금액}과 같음", { 금액: money(evidence.credits_c) })} · ${text("현재 계획 일치 · 판 {판}", { 판: evidence.plan_revision ?? "—" })}`;
  if (evidence?.code === "refund_time_unknown") return text("앞서 실패한 생성 {금액}", { 금액: money(evidence.refunded_c) });
  return "";
}

// 10px 글자 폭 어림(한글·한자 10, 그 밖 5.5 — 실제보다 넉넉히). 빈 곳 폭이 글자 + 10 이상일 때만 글자를 쓰면
// 쓰인 글자끼리 가운데 사이도 그만큼 벌어져 겹치지 않는다 — 좁은 빈 곳마다 쓰면 '이번 달'에서 겹쳤다(11-18 눈 확인).
const labelWidth = (label: string) => [...label].reduce((w, c) => w + (c.charCodeAt(0) >= 0x1100 ? 10 : 5.5), 0);

function LedgerChart({ data }: { data: BalanceLedgerResponse }) {
  const points = data.chart_points.slice(0, 1000).filter((p) => p.quality === "reported");
  if (!points.length) return <div className="bl-empty">{t("잔액 확인 없음")}</div>;
  const values = points.map((p) => p.credits_c);
  const low = Math.min(...values), high = Math.max(...values);
  const x = (at: number) => 35 + (at - data.requested_start_ms) / Math.max(1, data.requested_end_ms - data.requested_start_ms) * 930;
  const y = (c: number) => 105 - (c - low) / Math.max(1, high - low) * 80;
  const markers = data.intervals.filter((i) => i.state === "residual_present" && i.candidate_classification !== "unclassified");
  const gapLabel = t("잔액 확인 없음"), gapLabelMin = labelWidth(gapLabel) + 10;
  return <div className="bl-chart"><svg viewBox="0 0 1000 155" role="img" aria-label={t("확인한 잔액 변화")}>
    {[25, 65, 105].map((v) => <line key={v} x1="35" x2="965" y1={v} y2={v} className="bl-grid" />)}
    <text x="0" y="20">{money(high)}</text><text x="0" y="120">{money(low)}</text>
    {points.map((p, n) => { const before = points[n - 1]; const gap = before && data.chart_gaps.some((g) => g.start_ms < p.observed_at_ms && g.end_ms > before.observed_at_ms);
      const x1 = before ? x(before.observed_at_ms) : 0, x2 = x(p.observed_at_ms);
      return <g key={p.observation_id}>{before && <line x1={x1} y1={y(before.credits_c)} x2={x2} y2={y(p.credits_c)} className={gap ? "bl-gap" : "bl-line"}>{gap && <title>{gapLabel}</title>}</line>}
        {gap && x2 - x1 >= gapLabelMin && <text x={(x1 + x2) / 2} y="136" textAnchor="middle">{gapLabel}</text>}
        <circle cx={x(p.observed_at_ms)} cy={y(p.credits_c)} r="2"><title>{formatBalanceAbsolute(p.observed_at_ms)} · {money(p.credits_c)}</title></circle></g>; })}
    {markers.map((i) => { const p: BalanceChartPoint | undefined = points.find((point) => point.observation_id === i.to_observation_id); return p ? <text key={i.to_observation_id} className="bl-marker" x={Math.min(810, x(p.observed_at_ms))} y={Math.max(15, y(p.credits_c) - 9)}>{i.residual_c! > 0 ? "▲" : "▼"} {candidateLabel(i.candidate_classification)} {money(i.residual_c, true)}</text> : null; })}
    <text x="35" y="152">{formatBalanceAbsolute(data.requested_start_ms)}</text><text x="965" y="152" textAnchor="end">{formatBalanceAbsolute(data.requested_end_ms)}</text>
  </svg></div>;
}

export function BalanceLedger({ caps, spaces, selectedId, reloadSignal = 0 }: { caps: ManageCaps; spaces: Space[]; selectedId?: string; reloadSignal?: number }) {
  const translate = useT();
  const allowed = caps.loaded && caps.system && !caps.authOff;
  const [space, setSpace] = useState(selectedId || spaces[0]?.id || "");
  const [range, setRange] = useState<Range>("week");
  const [help, setHelp] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{ key: string; data: BalanceLedgerResponse; balance: BalanceMeta | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestId = useRef(0);
  const abort = useRef<AbortController>();
  const [start, end] = dates(range);
  const accountKey = identity();
  const spacesKey = JSON.stringify(spaces.map((s) => s.id));
  const key = JSON.stringify([caps.contextKey, accountKey, caps.viewerUid, caps.system, caps.authOff, spacesKey, selectedId, space, start, end, reloadSignal]);
  const liveKey = useRef(key); liveKey.current = key;
  const sync = useSyncStatus(allowed, key);
  const data = result?.key === key ? result.data : null;
  const balance = result?.key === key ? result.balance : null;

  useEffect(() => {
    const ids = JSON.parse(spacesKey) as string[];
    setSpace((current) => selectedId && ids.includes(selectedId) ? selectedId : ids.includes(current) ? current : ids[0] || "");
  }, [selectedId, spacesKey]);

  const load = async (cursor: string | null = null, restarting = false) => {
    const sequence = ++requestId.current;
    abort.current?.abort();
    const controller = new AbortController(); abort.current = controller;
    setBusy(true); setError("");
    const current = () => sequence === requestId.current && liveKey.current === key && identity() === accountKey && !controller.signal.aborted;
    try {
      const [page, snapshot] = await Promise.all([
        getBalanceLedger(space, start, end, cursor, controller.signal),
        getBalances(space, controller.signal).catch(() => null),
      ]);
      if (!current()) return;
      setResult((before) => ({ key, balance: snapshot?.balances.find((b) => b.workspace_id === space) || null,
        data: cursor && before?.key === key ? { ...page, intervals: [...before.data.intervals, ...page.intervals] } : page }));
    } catch (reason) {
      if (!current()) return;
      if (isHttpStatus(reason, 409) && cursor && !restarting) {
        setResult(null); setExpanded(new Set()); setNotice(translate("내용이 바뀌어 처음부터 다시 불러왔습니다"));
        await load(null, true); return;
      }
      setError(isHttpStatus(reason, 404) ? translate("서버 업데이트가 필요합니다") : translate("연결 실패"));
    } finally { if (current()) setBusy(false); }
  };

  useEffect(() => {
    setResult(null); setExpanded(new Set()); setNotice(""); setError("");
    if (allowed && space) void load();
    return () => { requestId.current += 1; abort.current?.abort(); };
    // Request scope includes account, server, permission, workspace and period.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, allowed]);

  if (!allowed) return null;
  const knownIntervals = data?.intervals.filter((i) => i.residual_c != null) ?? [];
  const partialSummary = data && (data.has_more || knownIntervals.length < data.intervals.length);
  const sum = (sign: 1 | -1) => !knownIntervals.length ? null : knownIntervals.reduce((value, i) => value + (i.state === "residual_present" && Math.sign(i.residual_c!) === sign ? i.residual_c! : 0), 0);
  const usage = data?.daily_api.length && data.daily_api.every((d) => d.net_c != null) ? data.daily_api.reduce((v, d) => v + d.net_c!, 0) : null;
  const rows = data?.daily_balances || [];
  const conflict = data?.chart_points.some((p) => p.quality === "conflict");
  const uncertainty = data?.chart_points.some((p) => !["reported", "conflict"].includes(p.quality));
  return <section className="usage-card balance-ledger" aria-label={translate("잔액 장부")}>
    <header className="bl-head"><h3>{translate("잔액 장부")} <button type="button" className="bl-help" aria-label={translate("잔액 장부 안내")} aria-expanded={help} onClick={() => setHelp(!help)}>?</button></h3>
      <div className="bl-tools"><select aria-label={translate("장부 공간")} value={space} onChange={(e) => setSpace(e.target.value)}>{spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <div className="bl-ranges">{([['week', '최근 7일'], ['month', '이번 달'], ['previous', '지난 달']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={range === value} onClick={() => setRange(value)}>{translate(label)}</button>)}</div></div></header>
    {help && <p className="bl-help-text">{translate("힉스필드 잔액을 확인한 값끼리 이어 보고, 그 사이 힉스필드 사용 기록을 빼서 맞지 않는 차이를 보여 줍니다. 추정 원인은 금액·시각으로 짐작한 것이며 확정이 아닙니다. 사용 기록은 수집이 끝난 날만 비교합니다.")}</p>}
    {notice && <p role="status" className="bl-notice">{notice}</p>}
    {error && <p role="alert" className="wc-error">{error} <button type="button" onClick={() => void load()}>{translate("다시 시도")}</button></p>}
    {!spaces.length ? <p className="bl-empty">{translate("잔액 확인 없음")}</p> : !data ? <p role="status" className="bl-empty">{busy ? translate("불러오는 중") : translate("잔액 확인 없음")}</p> : <>
      <div className="bl-summary">
        <div><strong>{money(balance?.credits_c)}</strong><span>{translate("지금 잔액")} · {formatBalanceTime(balance)}</span></div>
        <div><strong>{money(usage == null ? null : -usage)}</strong><span>{translate("기간 사용 기록 합")}{data.daily_api.some((d) => !d.complete) ? ` · ${translate("사용 기록 모으는 중")}` : ''}</span></div>
        {([1, -1] as const).map((sign) => <div key={sign}><strong className={sign > 0 ? 'bl-positive' : 'bl-negative'}>{money(sum(sign), true)}</strong><span>{translate(sign > 0 ? "설명 안 된 증가" : "설명 안 된 감소")} · {text("추정 {건수}건", { 건수: knownIntervals.filter((i) => i.state === 'residual_present' && Math.sign(i.residual_c!) === sign && i.candidate_classification !== 'unclassified').length })}</span>{partialSummary && <span className="wc-chip">{translate("일부 구간만")}</span>}</div>)}
      </div>
      {conflict && <p role="status" className="bl-notice">{translate("같은 시각 값이 다름")}</p>}
      {uncertainty && <p role="status" className="bl-notice">{translate("확인 시각 불확실")}</p>}
      {data.has_more && <p className="bl-notice">{translate("현재 불러온 구간 기준")}</p>}
      <LedgerChart data={data} />
      <div className="bl-table-wrap"><table className="bl-table"><thead><tr>{['구간 (KST)', '시작 잔액', '끝 잔액', '잔액 변화', '사용 기록', '설명 안 된 차이', '추정 원인', '상태'].map((s) => <th key={s}>{translate(s)}</th>)}</tr></thead><tbody>
        {[...rows].reverse().map((day) => {
          const intervals = data.intervals.filter((i) => dayKey(i.end_ms) === day.day);
          const daily = data.daily_api.find((d) => d.day === day.day);
          // A midnight-crossing interval is not a daily residual. Incomplete pages are not totals.
          const known = !data.has_more && intervals.length > 0 && intervals.every((i) => dayKey(i.start_ms) === day.day && i.residual_c != null);
          const residual = known ? intervals.reduce((v, i) => v + i.residual_c!, 0) : null;
          const uncertain = intervals.find((i) => i.state === 'observation_uncertain');
          const unavailable = intervals.some((i) => i.state === 'comparison_unavailable');
          const dayState = !day.observation_count ? translate("잔액 확인 없음") : day.time_uncertain_count ? translate("확인 시각 불확실") : uncertain ? stateLabel(uncertain) : unavailable ? translate("비교 못 함") : !daily?.complete ? translate("사용 기록 모으는 중") : !known ? translate("비교 못 함") : intervals.some((i) => i.state === 'residual_present') ? translate("차이 있음") : translate("맞음");
          const shown = expanded.has(day.day) ? intervals : intervals.filter((i) => i.state === 'residual_present');
          const toggleDay = () => setExpanded((before) => { const next = new Set(before); if (next.has(day.day)) next.delete(day.day); else next.add(day.day); return next; });
          return <Fragment key={day.day}><tr className="bl-day" onClick={toggleDay}><td><button type="button" aria-expanded={expanded.has(day.day)} onClick={(event) => { event.stopPropagation(); toggleDay(); }}>{day.day.slice(5).replace('-', '/')} · {text("확인 {횟수}번", { 횟수: day.observation_count })}</button></td>
            <td>{money(day.opening_c)}</td><td>{money(day.closing_c)}</td><td>{money(day.delta_c, true)}</td><td>{money(daily?.net_c == null ? null : -daily.net_c)}</td><td>{money(residual, true)}</td><td /><td><span className="wc-chip">{dayState}</span></td></tr>
            {shown.map((item) => <tr className="bl-interval" key={item.to_observation_id}><td>{formatBalanceAbsolute(item.start_ms)} → {formatBalanceAbsolute(item.end_ms)}</td><td>{money(item.opening_c)}</td><td>{money(item.closing_c)}</td><td>{money(item.delta_c, true)}</td><td>{money(item.api_created_net_c == null ? null : -item.api_created_net_c)}</td><td className={(item.residual_c || 0) > 0 ? 'bl-positive' : 'bl-negative'}>{money(item.residual_c, true)}</td><td><span className="wc-chip">{candidateLabel(item.candidate_classification)}</span><small>{evidenceLine(item, spaces)}</small></td><td><span className="wc-chip">{stateLabel(item)}</span></td></tr>)}
          </Fragment>;
        })}
      </tbody></table></div>
      <footer className="bl-foot"><span>{translate("설명 안 된 차이가 있는 구간만 펼쳐 보임 · 클릭하면 그날 구간 전체")}</span><span>{translate("마지막 잔액 확인")} {formatBalanceAbsolute(balance?.observed_at_ms ?? null)} · {text("서버에 아직 안 온 확인 {건수}건", { 건수: sync?.balance_pending ?? '—' })}</span></footer>
      {data.has_more && <button className="bl-more" type="button" disabled={busy} onClick={() => void load(data.next_cursor)}>{busy ? translate("불러오는 중") : translate("더 보기")}</button>}
    </>}
  </section>;
}
