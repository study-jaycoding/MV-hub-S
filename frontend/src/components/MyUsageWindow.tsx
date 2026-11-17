import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../lib/i18n";
import { useEscapeClose } from "../lib/useEscapeClose";
import { useModalFocus } from "../lib/keyGate";
import { formatCredits } from "../lib/formatCredits";
import { useMyUsage, type UsageRange, type UsageSpace } from "../lib/myUsage";
import { UsageBasis } from "./common/UsageBasis";
import "../styles/my-usage.css";

const SOURCES: Record<string, string> = { mv: "MV에서 만듦 · 기록 기준", web: "힉스필드 웹", mcp: "MCP", claude_code: "Claude Code", charge: "생성 아닌 차감", other: "기타" };
const RANGES: [UsageRange, string][] = [["today", "오늘"], ["week", "이번 주"], ["period", "이번 기간"], ["previous", "지난 기간"]];

export function MyUsageWindow({ workspaceId, accountKey, onClose }: { workspaceId: string; accountKey: string; onClose: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useEscapeClose(onClose);
  useModalFocus(ref);
  const [range, setRange] = useState<UsageRange>("period");
  const [space, setSpace] = useState<UsageSpace>("this");
  const { value, error } = useMyUsage(workspaceId, accountKey, range, space);
  const api = value?.basis === "api";
  const max = Math.max(1, ...value?.sources.map(s => Math.abs(s.net)) ?? []);
  return createPortal(<div className="my-usage-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="my-usage-title" className="my-usage-window">
      <header><h2 id="my-usage-title">{t("내 사용량")}</h2><button type="button" onClick={onClose} aria-label={t("닫기")}>×</button></header>
      <nav aria-label={t("사용량 기간")}>{RANGES.map(([key, label]) => <button key={key} type="button" aria-pressed={range === key} onClick={() => setRange(key)}>{t(label)}</button>)}
        <select aria-label={t("조회 공간")} value={space} onChange={e => setSpace(e.target.value as UsageSpace)}><option value="this">{t("이 공간")}</option><option value="all">{t("모든 공간")}</option></select>
      </nav>
      {error ? <p role="alert">{t(error === "update" ? "서버 업데이트가 필요합니다" : "사용량을 확인할 수 없습니다")}</p> : !value ? <p role="status">{t("사용량 확인 중")}</p> : <>
        <UsageBasis value={value} />
        {api ? <>
          <div className="my-usage-tiles">
            {[[t("실제 사용 · 환불 뺀 값"), formatCredits(value.used_real)], [t("환불된 크레딧"), formatCredits(value.refunded)], [t("생성 수"), value.generation_count], [t("집계 전"), value.pending_count]].map(([label, amount]) => <div key={label}><strong>{amount}</strong><span>{label}</span></div>)}
          </div>
          {value.failed_refunded_count ? <p>{t("오류 보고 후 전액 환불 {count}건").replace("{count}", String(value.failed_refunded_count))}</p> : null}
          {value.failed_count ? <p>{t("오류 보고 {count}건 · 순값이 남은 행도 포함").replace("{count}", String(value.failed_count))}</p> : null}
          {(value.estimated_count ?? 0) > 0 && <p>≈ {formatCredits(value.used_estimated)} · {t("집계 전 {count}건").replace("{count}", String(value.estimated_count))}</p>}
          {(value.unknown_count ?? 0) > 0 && <p>{t("미확인 {count}건").replace("{count}", String(value.unknown_count))} · {t("60분 초과 {count}건").replace("{count}", String(value.overdue_pending_count))}</p>}
          <section aria-label={t("만든 곳")} className="my-usage-bars">{value.sources.map(s => <div key={s.source}><span>{t(SOURCES[s.source] ?? "기타")}</span><div className="track"><i style={{ width: `${Math.abs(s.net) / max * 100}%` }} /></div><b>{formatCredits(s.net)}</b></div>)}</section>
          <p className="my-usage-note">{t("MV 기록에는 동기화로 가져온 기록도 포함될 수 있습니다")}</p>
          {value.truncated && <p>{t("최근 1,000건 표시 · 합계는 전체")}</p>}
          <div className="my-usage-table"><table><thead><tr>{["시각", "만든 곳", "모델", "공간", "상태", "크레딧"].map(k => <th key={k}>{t(k)}</th>)}</tr></thead><tbody>
            {value.rows.map(r => <tr key={`${r.workspace_id}:${r.row_id}`}><td>{new Date(r.created_at).toLocaleString()}</td><td>{t(SOURCES[r.source] ?? "기타")}</td><td>{r.model ?? "—"}</td><td>{r.workspace_name || r.workspace_id}</td><td>{r.pending ? t("집계 전") : [r.status, r.state, r.error_code].filter(Boolean).join(" · ") || "—"}</td><td>{!r.pending && r.refunded != null && r.refunded !== 0 && <del>{formatCredits(r.charged)} </del>}{r.pending ? "≈ " : ""}{formatCredits(r.net)}</td></tr>)}
          </tbody></table></div>
        </> : <p>{value.basis === "facts" ? `${t("대체 사용 합계")} ${formatCredits(value.used)} · ${t("API 내역은 확인할 수 없습니다")}` : t("사용량을 확인할 수 없습니다")}</p>}
      </>}
    </div>
  </div>, document.body);
}
