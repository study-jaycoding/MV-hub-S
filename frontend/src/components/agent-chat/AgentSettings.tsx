// MV Agent 사용량 원·설정 쪽(docs/status/MVAgent_모델설정사용량_2026-11-12.md — 시안 mvagent-aside/model-settings.png ②③).
//  사용량 = Claude CLI 가 차례마다 주는 값(주간 한도·문맥 토큰)을 마지막 답 기준으로 보인다. Codex 는 한도를 주지 않는다.
//  설정 = 연결 상태 · 새 대화 기본 모델·깊이 · 먼저 쓸 생성 모델(차례마다 gen_model 로 실림) · 사용량 — 이 브라우저에 남긴다.
import { useEffect, useState } from "react";
import { getAccountNamespace } from "../../lib/accountScope";
import type { AgentEngine } from "../../lib/agentChatApi";
import { useT } from "../../lib/i18n";
import { fetchModelCatalog } from "../../lib/modelCatalogCache";
import { saveJSON } from "../../lib/storage";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import { readDefaults, type AgentDefaults, type AgentUsage } from "../../lib/useAgentChat";

const EFFORT_NAMES: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max" };
const pct = (x: number) => Math.round(x * 100);
const tokens = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
const shareOf = (u: AgentUsage) => (u.context && u.context.window > 0 ? Math.min(1, u.context.used / u.context.window) : null);
const weeklyOf = (u: AgentUsage) => (u.weekly && u.weekly.account === getAccountNamespace() ? u.weekly : undefined);
const resetText = (sec: number | null) => (sec
  ? new Date(sec * 1000).toLocaleString("ko-KR", { month: "long", day: "numeric", weekday: "short", hour: "numeric", minute: "2-digit" })
  : null);

/** 입력칸 아래 사용량 원 — 지금 대화가 찬 정도. 누르면 사용량 창(UsagePop) */
export function UsageRing({ usage, open, onToggle }: { usage: AgentUsage; open: boolean; onToggle: () => void }) {
  const t = useT();
  const share = shareOf(usage);
  const r = 7.5;
  const len = 2 * Math.PI * r;
  return (
    <button type="button" className={`agent-usage${open ? " open" : ""}`} onClick={onToggle} aria-expanded={open}
      aria-label={t("사용량")} title={share === null ? t("사용량") : `${t("이 대화가 찬 정도")} ${pct(share)}%`}>
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        <circle cx="10" cy="10" r={r} className="agent-usage-track" />
        <circle cx="10" cy="10" r={r} className="agent-usage-fill" strokeDasharray={len} strokeDashoffset={len * (1 - (share ?? 0))}
          transform="rotate(-90 10 10)" />
      </svg>
    </button>
  );
}

function UsageRows({ usage }: { usage: AgentUsage }) {
  const t = useT();
  const share = shareOf(usage);
  const weekly = weeklyOf(usage);
  const left = weekly ? 1 - weekly.utilization : null;
  const reset = weekly ? resetText(weekly.resets_at) : null;
  return (
    <>
      <div className="agent-usage-row"><b>{share === null ? "—" : `${pct(share)}%`}</b><span>{t("이 대화가 찬 정도")}</span></div>
      <div className="agent-usage-bar"><i style={{ width: `${pct(share ?? 0)}%` }} /></div>
      <small className="agent-usage-note">{usage.context
        ? `${tokens(usage.context.used)} / ${tokens(usage.context.window)} ${t("토큰 · 차면 앞 대화를 줄여요")}`
        : t("답을 한 번 받으면 보여요")}</small>
      <div className="agent-menu-sep" />
      <div className="agent-usage-row"><b>{left === null ? "—" : `${pct(left)}%`}</b><span>{t("Claude 주간 남음")}</span></div>
      <div className="agent-usage-bar"><i style={{ width: `${pct(left ?? 0)}%` }} /></div>
      <small className="agent-usage-note">{weekly
        ? `${reset ? `${reset} ${t("에 초기화")} · ` : ""}${t("마지막 답 기준")}`
        : t("Claude 답을 한 번 받으면 보여요")}</small>
    </>
  );
}

/** 사용량 창 — 대화 찬 정도 · Claude 주간 남은 양(마지막 답 기준) */
export function UsagePop({ usage }: { usage: AgentUsage }) {
  const t = useT();
  return (
    <div className="agent-menu agent-usage-pop" role="dialog" aria-label={t("사용량")}>
      <UsageRows usage={usage} />
    </div>
  );
}

/** 설정 쪽 — 칸 안을 덮는다(← 와 Esc 로 돌아감, Esc 는 칸이 건다) */
export function AgentSettings({ engines, usage, onBack, onConnectClaude, onSetCodexEnabled, codexBusy, codexError }: {
  engines: AgentEngine[];
  usage: AgentUsage;
  onBack: () => void;
  onConnectClaude: () => void; // 지금의 Claude 연결 흐름(대화 칸의 연결 안내)으로
  onSetCodexEnabled: (enabled: boolean) => void;
  codexBusy: boolean;
  codexError: string | null;
}) {
  const t = useT();
  const [d, setD] = useState<AgentDefaults>(() => readDefaults());
  const [gens, setGens] = useState<{ code: string; name: string }[] | null>(null);
  useEffect(() => {
    let live = true;
    fetchModelCatalog().then(
      (ms) => { if (live) setGens(ms.filter((m) => m.type === "image" || m.type === "video").map((m) => ({ code: m.job_set_type, name: m.display_name }))); },
      () => { if (live) setGens([]); },
    );
    return () => { live = false; };
  }, []);
  const save = (next: AgentDefaults) => {
    setD(next);
    saveJSON(STORAGE_KEYS.agentDefaults, next);
  };
  const claude = engines.find((e) => e.id === "claude");
  const codex = engines.find((e) => e.id === "codex");
  const efforts = [...new Set(engines.flatMap((e) => e.efforts))];
  const modelValue = d.model ? `${d.model.engine}:${d.model.model}` : "";
  const known = gens?.some((g) => g.code === d.gen_model) ?? false;
  return (
    <section className="agent-settings" aria-label={t("설정")}>
      <header className="agent-settings-head">
        <button type="button" className="agent-ic" onClick={onBack} title={t("돌아가기")} aria-label={t("돌아가기")}>←</button>
        <h3>{t("설정 · 모델")}</h3>
      </header>
      <div className="agent-settings-body">
        <div className="agent-settings-grp">
          <h4>{t("연결")}</h4>
          <div className="agent-settings-card">
            <div className="agent-settings-line">
              <span className="agent-settings-logo claude" aria-hidden="true">✳</span>
              <span className="agent-settings-t">Claude<small>
                {[claude?.subscription ? `${t("구독")} ${claude.subscription}` : null, claude?.version ? `Claude Code ${claude.version}` : null]
                  .filter(Boolean).join(" · ")}
                {claude?.available ? <> · <span className="ok">{t("연결됨")}</span></> : null}
              </small></span>
              {!claude?.available && <button type="button" className="agent-settings-btn" onClick={onConnectClaude}>{t("연결")}</button>}
            </div>
            <div className="agent-settings-line">
              <span className="agent-settings-logo" aria-hidden="true">◎</span>
              <span className="agent-settings-t">ChatGPT (Codex)<small>
                {codex?.version ? `Codex ${codex.version} · ` : ""}
                {codex?.enabled ? t("이 PC 에서 켬") : t("꺼짐")}{" · "}
                {codex?.available ? <span className="ok">{t("연결됨")}</span> : <span className="warn">{codex?.reason || t("쓸 수 없음")}</span>}
              </small>{codexError && <small className="agent-codex-error" role="alert">{codexError}</small>}</span>
              <button type="button" className="agent-settings-btn" disabled={codexBusy}
                aria-label={codex?.enabled ? t("Codex 끄기") : t("Codex 연결")}
                onClick={() => onSetCodexEnabled(!codex?.enabled)}>
                {codexBusy ? t("확인하는 중") : codex?.enabled ? t("끄기") : t("연결")}
              </button>
            </div>
          </div>
        </div>
        <div className="agent-settings-grp">
          <h4>{t("기본값")}</h4>
          <div className="agent-settings-card">
            <label className="agent-settings-line">
              <span className="agent-settings-t">{t("새 대화 모델")}<small>{t("새 대화를 시작할 때 고를 모델")}</small></span>
              <select className="agent-settings-sel" value={modelValue} aria-label={t("새 대화 모델")}
                onChange={(e) => {
                  const [engine, model] = e.target.value.split(":");
                  const rest = { ...d };
                  delete rest.model;
                  save(e.target.value ? { ...rest, model: { engine: engine as AgentEngine["id"], model } } : rest);
                }}>
                <option value="">{t("마지막에 쓴 모델")}</option>
                {engines.map((e) => e.models.map((m) => (
                  <option key={`${e.id}:${m.id}`} value={`${e.id}:${m.id}`} disabled={!e.available}>{m.label}</option>
                )))}
              </select>
            </label>
            <label className="agent-settings-line">
              <span className="agent-settings-t">{t("새 대화 생각 깊이")}</span>
              <select className="agent-settings-sel" value={d.effort ?? ""} aria-label={t("새 대화 생각 깊이")}
                onChange={(e) => {
                  const rest = { ...d };
                  delete rest.effort;
                  save(e.target.value ? { ...rest, effort: e.target.value } : rest);
                }}>
                <option value="">{t("마지막에 쓴 깊이")}</option>
                {efforts.map((level) => <option key={level} value={level}>{t(EFFORT_NAMES[level] ?? level)}</option>)}
              </select>
            </label>
            <label className="agent-settings-line">
              <span className="agent-settings-t">{t("먼저 쓸 생성 모델")}<small>{t("그림·영상을 모델 없이 말하면 AI 가 이걸로 계획")}</small></span>
              <select className="agent-settings-sel" value={d.gen_model ?? ""} aria-label={t("먼저 쓸 생성 모델")}
                onChange={(e) => {
                  const rest = { ...d };
                  delete rest.gen_model;
                  save(e.target.value ? { ...rest, gen_model: e.target.value } : rest);
                }}>
                <option value="">{t("정하지 않음")}</option>
                {d.gen_model && !known && <option value={d.gen_model}>{d.gen_model}</option>}
                {(gens ?? []).map((g) => <option key={g.code} value={g.code}>{g.name}</option>)}
              </select>
            </label>
          </div>
        </div>
        <div className="agent-settings-grp">
          <h4>{t("사용량")}</h4>
          <div className="agent-settings-card agent-settings-usage">
            <UsageRows usage={usage} />
            <div className="agent-menu-sep" />
            <small className="agent-usage-note">{t("ChatGPT(Codex)는 한도를 알려 주지 않아 보이지 않아요")}</small>
          </div>
        </div>
      </div>
    </section>
  );
}
