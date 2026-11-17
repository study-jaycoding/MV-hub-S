import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../lib/i18n";
import { useEscapeClose } from "../lib/useEscapeClose";
import { useModalFocus } from "../lib/keyGate";
import { formatCredits } from "../lib/formatCredits";
import { usageBasisText, usagePeriodText } from "../lib/creditUsage";
import { useMyUsage, type MyUsage, type MyUsageRow, type UsageRange, type UsageSpace } from "../lib/myUsage";
import "../styles/my-usage.css";

// Jay 2026-11-17 고른 시안(https://claude.ai/artifact/NmJhau2k2c6SreQ3RHUHjM)대로 — 제목 줄 기간 칸·숫자 칸 4개·색 막대·짧은 시각·색 알약.
const RANGES: [UsageRange, string][] = [["today", "오늘"], ["week", "이번 주"], ["period", "이번 기간"], ["previous", "지난 기간"]];
// 만든 곳 막대 — 시안의 세 색 + 합계가 맞도록 차감·기타도 있을 때 보인다(2단계 D8: 기타·음수를 숨기지 않는다).
const GROUPS: { label: string; tone: string; sources: string[]; title?: string }[] = [
  { label: "MV 에서 만듦", tone: "mv", sources: ["mv"], title: "MV 기록에는 동기화로 가져온 기록도 포함될 수 있습니다" },
  { label: "힉스필드 웹", tone: "web", sources: ["web"] },
  { label: "Claude Code·MCP", tone: "cc", sources: ["claude_code", "mcp"] },
  { label: "생성 아닌 차감", tone: "etc", sources: ["charge"] },
];
const KNOWN = new Set(GROUPS.flatMap(g => g.sources));
const PILLS: Record<string, [string, string]> = {
  mv: ["MV", "mv"], web: ["웹", "web"], claude_code: ["Claude Code", "cc"], mcp: ["MCP", "cc"], charge: ["생성 아님", ""],
};

const two = (n: number) => String(n).padStart(2, "0");
function kst(ms: number) {
  const d = new Date(ms + 9 * 3_600_000);
  return { m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}
function periodShort(v: MyUsage | null): string {
  if (v?.period_start_ms == null || v.period_end_ms == null) return "";
  const a = kst(v.period_start_ms), b = kst(v.period_end_ms - 1);
  const start = `${a.m}/${a.d}`, end = `${b.m}/${b.d}`;
  return start === end ? start : `${start} ~ ${end}`;
}
function timeShort(ms: number): string {
  const p = kst(ms);
  return `${two(p.m)}/${two(p.d)} ${two(p.h)}:${two(p.mi)}`;
}
// 상태 — 힉스필드 원래 값(succeeded·failed …)을 한국어로. 모르는 값은 숨기지 않고 원래 글자 그대로.
function statusOf(r: MyUsageRow, t: (s: string) => string): [string, boolean] {
  if (r.pending) return [t("집계 전"), false];
  if (r.type === "charge") return [t("차감"), false];
  if (r.error_code) return [`${t("실패")} · ${r.error_code}`, true];
  const s = (r.state || r.status || "").toLowerCase();
  if (["succeeded", "success", "completed", "complete", "done"].includes(s)) return [t("완료"), false];
  if (["failed", "error"].includes(s)) return [t("실패"), true];
  if (["canceled", "cancelled"].includes(s)) return [t("취소됨"), false];
  if (["queued", "running", "pending", "in_progress", "processing"].includes(s)) return [t("진행 중"), false];
  return [[r.status, r.state].filter(Boolean).join(" · ") || "—", false];
}

export function MyUsageWindow({ workspaceId, accountKey, onClose }: { workspaceId: string; accountKey: string; onClose: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useEscapeClose(onClose);
  useModalFocus(ref);
  const [range, setRange] = useState<UsageRange>("period");
  const [space, setSpace] = useState<UsageSpace>("this");
  const [help, setHelp] = useState(false);
  const { value, error } = useMyUsage(workspaceId, accountKey, range, space);
  const api = value?.basis === "api";
  const period = periodShort(value);
  const basisTitle = value ? [
    [usageBasisText(value, t), usagePeriodText(value)].filter(Boolean).join(" · "),
    value.collected_at_ms != null ? `${t("수집 시각")} ${new Date(value.collected_at_ms).toLocaleString()}` : "",
  ].filter(Boolean).join("\n") : undefined;
  const groups = value ? [...GROUPS, { label: "기타", tone: "etc", sources: [] as string[] }].map(g => {
    const hits = value.sources.filter(s => (g.sources.length ? g.sources.includes(s.source) : !KNOWN.has(s.source)));
    return { ...g, hits: hits.length, net: hits.reduce((sum, s) => sum + s.net, 0) };
  }).filter(g => g.hits > 0) : [];
  const max = Math.max(1, ...groups.map(g => Math.abs(g.net)));
  // 오류 보고가 전액 환불 건수보다 많을 때만 — 그 차이는 '순값이 남은 건수'가 아니다(청구 0 인 오류도 전액 환불에서 빠진다, hf_org_usage.py 의 전액 환불 조건)
  const failedNote = (value?.failed_count ?? 0) > (value?.failed_refunded_count ?? 0);
  const unknownRest = (value?.unknown_count ?? 0) - (value?.overdue_pending_count ?? 0);
  // 드물게만 생기는 안내 — 있을 때만 표 위 한 줄
  const notes = value ? [
    failedNote ? t("오류 보고 {count}건").replace("{count}", String(value.failed_count)) : "",
    (value.overdue_pending_count ?? 0) > 0 ? t("오래된 미매칭 {count}건 (60분 초과)").replace("{count}", String(value.overdue_pending_count)) : "",
    unknownRest > 0 ? t("미확인 {count}건").replace("{count}", String(unknownRest)) : "",
    value.truncated ? t("최근 1,000건 표시 · 합계는 전체") : "",
  ].filter(Boolean) : [];
  return createPortal(<div className="my-usage-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="my-usage-title" className="my-usage-window">
      <header>
        <div className="my-usage-titlebar">
          <h2 id="my-usage-title" title={basisTitle}>{t("내 사용량")}{period && <span className="my-usage-period"> · {period}</span>}</h2>
          {/* 기준·수집 시각·동기화 안내 — 평소엔 숨기고(시안), 키보드로도 열 수 있게 단추로 */}
          {value && <button type="button" className="my-usage-help" aria-label={t("기준과 안내")} aria-expanded={help} aria-controls="my-usage-help" onClick={() => setHelp(v => !v)}>?</button>}
        </div>
        <div className="my-usage-tools">
          <nav aria-label={t("사용량 기간")} className="my-usage-seg">{RANGES.map(([key, label]) => <button key={key} type="button" aria-pressed={range === key} onClick={() => setRange(key)}>{t(label)}</button>)}</nav>
          <select aria-label={t("조회 공간")} value={space} onChange={e => setSpace(e.target.value as UsageSpace)}><option value="this">{t("이 공간")}</option><option value="all">{t("모든 공간")}</option></select>
          <button type="button" className="my-usage-close" onClick={onClose} aria-label={t("닫기")}>×</button>
        </div>
      </header>
      {value && help && <div id="my-usage-help" className="my-usage-help-pop" role="note">
        {basisTitle && <p>{basisTitle}</p>}
        {api && <p>{t("MV 기록에는 동기화로 가져온 기록도 포함될 수 있습니다")}</p>}
      </div>}
      {error ? <p role="alert">{t(error === "update" ? "서버 업데이트가 필요합니다" : "사용량을 확인할 수 없습니다")}</p> : !value ? <p role="status">{t("사용량 확인 중")}</p> : api ? <>
        <div className="my-usage-tiles">
          <div><strong>{formatCredits(value.used_real)}</strong><span>{t("실제 사용(환불 뺀 값)")}</span></div>
          <div className="good"><strong>{formatCredits(value.refunded)}</strong><span>{value.failed_refunded_count ? t("환불된 크레딧 · 실패 {count}건").replace("{count}", String(value.failed_refunded_count)) : t("환불된 크레딧")}</span></div>
          <div><strong>{value.generation_count}</strong><span>{t("생성 수")}</span></div>
          <div><strong>{value.estimated_count}</strong><span>{(value.estimated_count ?? 0) > 0 ? t("아직 집계 전(견적 ≈ {amount})").replace("{amount}", formatCredits(value.used_estimated)) : t("아직 집계 전")}</span></div>
        </div>
        {groups.length > 0 && <section aria-label={t("만든 곳")} className="my-usage-bars">{groups.map(g => <div key={g.label}>
          <span title={g.title ? t(g.title) : undefined}>{t(g.label)}</span>
          <div className="track"><i className={g.tone} style={{ width: `${Math.abs(g.net) / max * 100}%` }} /></div>
          <b>{formatCredits(g.net)}</b>
        </div>)}</section>}
        {notes.length > 0 && <p className="my-usage-note">{notes.join(" · ")}</p>}
        <div className="my-usage-table"><table><thead><tr>{["시각", "만든 곳", "모델", "공간", "상태", "크레딧"].map(k => <th key={k}>{t(k)}</th>)}</tr></thead><tbody>
          {value.rows.map(r => {
            const [status, failed] = statusOf(r, t);
            const [pill, tone] = PILLS[r.source] ?? ["기타", ""];
            return <tr key={`${r.workspace_id}:${r.row_id}`}>
              <td>{timeShort(r.created_at)}</td>
              <td><span className={`my-usage-pill ${tone}`}>{t(pill)}</span></td>
              <td>{r.model ?? "—"}</td>
              <td>{r.workspace_name || r.workspace_id}</td>
              <td className={failed ? "fail" : undefined}>{status}</td>
              <td>{!r.pending && r.refunded != null && r.refunded !== 0 && <del>{formatCredits(r.charged)} </del>}{r.pending ? "≈ " : ""}{formatCredits(r.net)}</td>
            </tr>;
          })}
        </tbody></table></div>
      </> : <div className="my-usage-empty">
        {/* 키 없음·연결 끊김 — 숫자 칸·표 없이 이유와 대체 합계만(0 으로 꾸미지 않는 2단계 계약) */}
        <b>{t(value.basis_reason === "not_configured" ? "힉스필드 사용량이 아직 연결되지 않았습니다" : "지금은 힉스필드 기준으로 확인할 수 없습니다")}</b>
        <span>{usageBasisText(value, t)}{value.basis === "facts" && value.used != null && <> · {t("대체 사용 합계")} {formatCredits(value.used)} · {t("웹·Claude Code 사용은 빠져 있습니다")}</>}</span>
      </div>}
    </div>
  </div>, document.body);
}
