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
import { readDefaults, type AgentDefaults, type AgentUsage, type useAgentChat } from "../../lib/useAgentChat";
import { CopyLine, InstallControls, InstallNote, LoginWindowGuide, ManualInstall, ManualLogin, Terminal } from "./AgentConnect";

const EFFORT_NAMES: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max" };
const pct = (x: number) => Math.round(x * 100);
const tokens = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
const shareOf = (u: AgentUsage) => (u.context && u.context.window > 0 ? Math.min(1, u.context.used / u.context.window) : null);
const weeklyOf = (u: AgentUsage) => (u.weekly && u.weekly.account === getAccountNamespace() ? u.weekly : undefined);
const resetText = (sec: number | null) => (sec
  ? new Date(sec * 1000).toLocaleString("ko-KR", { month: "long", day: "numeric", weekday: "short", hour: "numeric", minute: "2-digit" })
  : null);

/** ChatGPT(Codex) 표시 아이콘 — Tabler brand-openai 선 아이콘 경로 그대로(MIT). 글자 크기를 따라간다 */
export function OpenAIIcon({ size = "1em" }: { size?: string | number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: "block", margin: "0 auto" }}>
      <path d="M11.217 19.384a3.501 3.501 0 0 0 6.783 -1.217v-5.167l-6 -3.35" />
      <path d="M5.214 15.014a3.501 3.501 0 0 0 4.446 5.266l4.34 -2.534v-6.946" />
      <path d="M6 7.63c-1.391 -.236 -2.787 .395 -3.534 1.689a3.474 3.474 0 0 0 1.271 4.745l4.263 2.514l6 -3.348" />
      <path d="M12.783 4.616a3.501 3.501 0 0 0 -6.783 1.217v5.067l6 3.45" />
      <path d="M18.786 8.986a3.501 3.501 0 0 0 -4.446 -5.266l-4.34 2.534v6.946" />
      <path d="M18 16.302c1.391 .236 2.787 -.395 3.534 -1.689a3.474 3.474 0 0 0 -1.271 -4.745l-4.308 -2.514l-5.955 3.42" />
    </svg>
  );
}

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
export function AgentSettings({ engines, usage, connection, codexConnection, onBack, onConnectClaude, onSetCodexEnabled, codexBusy, codexError }: {
  engines: AgentEngine[];
  usage: AgentUsage;
  connection: ReturnType<typeof useAgentChat>["connect"];
  codexConnection: ReturnType<typeof useAgentChat>["codex"];
  onBack: () => void;
  onConnectClaude: () => void;
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
  const state = connection.state;
  const needsLogin = state === "not_logged_in" || state === "not_subscription" || state === "no_plan";
  const reconnect = state === "not_subscription" || state === "no_plan";
  const recheck = () => { void connection.recheck(); };
  const claudeInstalled = claude?.installed ?? (state !== null && state !== "not_installed" && state !== "unknown");
  const rawClaudeInstall = connection.installs.claude ?? connection.install;
  const claudeInstall = claudeInstalled && rawClaudeInstall?.state !== "running" ? null : rawClaudeInstall;
  const managedClaude = !claudeInstalled && (state === "not_installed" || (state === "unknown" && claudeInstall?.state === "failed"))
    && (claude?.install_blocked !== undefined || !!connection.installs.claude);
  const codexInstall = connection.installs.codex ?? codex?.install;
  const codexInstalling = codexInstall?.state === "running";
  const codexWaiting = codexConnection.login?.state === "running";
  const codexLoginFailed = codexConnection.login?.state === "failed";
  const codexReconnect = codexConnection.login?.state === "not_subscription";
  const codexManual = codexConnection.login?.state === "manual";
  const codexNeedsInstall = codex?.installed === false || codexInstalling;
  const guide = (() => {
    if (connection.waiting || state === "login_window") return <LoginWindowGuide waiting={connection.waiting} note={connection.note} onRecheck={recheck} onStopWaiting={connection.stopWaiting} />;
    if (state === "window_record") return <><p>{t("열린 Claude 로그인 창을 닫고 [다시 확인]을 눌러 주세요")}</p><button type="button" className="cn-ghost" onClick={recheck}>{t("다시 확인")}</button></>;
    if (needsLogin) return <>
      {reconnect && <p className="cn-warn">{state === "no_plan" ? t("이 계정엔 Claude Code 를 쓸 수 있는 구독이 없어요") : t("구독 로그인이 아니에요")}</p>}
      {connection.note === "unfinished" && <p>{t("로그인을 마치지 못했어요 — 다시 해 주세요")}</p>}
      {connection.note === "terminal" || !connection.loginWindowEnabled ? <Terminal onRecheck={recheck} /> : <ManualLogin onRecheck={recheck} />}
      {reconnect && <p className="cn-note">{t("이 PC 에서 Claude 를 쓰는 다른 곳(터미널 등)의 로그인도 함께 바뀌어요")}</p>}
    </>;
    if (state === "not_installed") return <>
      {claudeInstall?.state === "running" ? <><p>{t("MV Hub 가 Claude Code 를 설치하는 중이에요")}</p><details className="cn-more"><summary>{t("직접 설치하려면")}</summary><ManualInstall onRecheck={recheck} /></details></>
        : <><p>{t("이 PC 에 Claude Code 가 없어요")}</p><InstallNote install={claudeInstall} /><ManualInstall onRecheck={recheck} /></>}
    </>;
    if (state === "outdated") return <><p>{t("Claude Code 를 업데이트해야 해요")}</p><CopyLine command="claude update" /><button type="button" className="cn-ghost" onClick={recheck}>{t("다시 확인")}</button></>;
    return <><p>{t("Claude 상태를 확인하지 못했어요")}</p><InstallNote install={claudeInstall} />
      {claudeInstall?.state === "failed" || claudeInstall?.state === "skipped" ? <ManualInstall onRecheck={recheck} /> : <button type="button" className="cn-ghost" onClick={recheck}>{t("다시 확인")}</button>}</>;
  })();
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
                {!claude?.available && (connection.waiting
                  ? <span className="agent-connect-wait"><i className="agent-connect-spin" aria-hidden="true" />{t("로그인 창 기다리는 중 — 브라우저에서 로그인")}</span>
                  : state === "not_logged_in" ? <span>{t("로그인 안 됨")}</span> : null)}
              </small></span>
              {!claude?.available && needsLogin && !connection.waiting && connection.loginWindowEnabled && connection.note !== "terminal" && <button type="button" className="agent-settings-btn agent-connect-go" disabled={connection.connecting} onClick={onConnectClaude}>{connection.connecting ? t("연결 요청 중") : reconnect ? t("다시 연결") : t("연결")}</button>}
            </div>
            {!claude?.available && <div className="agent-settings-connect">
              {connection.connectError && <p className="cn-warn" role="alert">{connection.connectError}</p>}
              {managedClaude ? <InstallControls engine="claude" install={claudeInstall}
                blocked={claude?.install_blocked} onInstall={() => { void connection.installEngine("claude"); }} onRecheck={recheck} /> : guide}
            </div>}
            <div className="agent-settings-line">
              <span className="agent-settings-logo" aria-hidden="true"><OpenAIIcon size={15} /></span>
              <span className="agent-settings-t">ChatGPT (Codex)<small>
                {codex?.version ? `Codex ${codex.version} · ` : ""}
                {!codexWaiting && !codexLoginFailed && !codexInstalling && codex?.installed !== false && <>{codex?.enabled ? t("이 PC 에서 켬") : t("꺼짐")}{" · "}</>}
                {codexWaiting ? <span className="agent-connect-wait"><i className="agent-connect-spin" aria-hidden="true" />{t("로그인 창 기다리는 중 — 브라우저에서 로그인")}</span>
                  : codexLoginFailed ? <span className="warn">{t(codexConnection.login?.reason === "login_unfinished" ? "로그인을 마치지 못했어요" : "로그인 창을 열지 못했어요")}</span>
                  : codexReconnect ? <span className="warn">{t("구독 로그인이 아니에요")}</span>
                  : codex?.available ? <span className="ok">{t("연결됨")}</span>
                  : codex?.installed !== false && !codexInstalling ? <span className="warn">{codex?.reason || t("쓸 수 없음")}</span> : null}
              </small>{codexError && <small className="agent-codex-error" role="alert">{codexError}</small>}</span>
              {!codexManual && (!codexNeedsInstall || codexWaiting || codexInstalling || codexLoginFailed) && <button type="button" className="agent-settings-btn" disabled={codexBusy && !codex?.enabled && !codexWaiting && !codexInstalling}
                aria-label={codex?.enabled ? t("Codex 끄기") : t("Codex 연결")}
                onClick={() => codex?.enabled || codexWaiting || codexInstalling || codexBusy ? onSetCodexEnabled(false)
                  : codex?.installed === true || codexLoginFailed ? void codexConnection.connect(undefined, codexReconnect) : onSetCodexEnabled(true)}>
                {codex?.enabled || codexWaiting || codexInstalling ? t("끄기") : codexBusy ? t("확인하는 중") : codexLoginFailed ? t("다시 시도") : codexReconnect ? t("다시 연결") : t("연결")}
              </button>}
            </div>
            {codexReconnect && <p className="cn-note">{t("이 PC 에서 Codex 를 쓰는 다른 곳(터미널 등)의 로그인도 함께 바뀌어요")}</p>}
            {codexManual && <div className="agent-settings-connect"><p>{t("터미널(PowerShell)에서 아래 명령을 실행해 브라우저로 로그인하세요. 끝나면 [다시 확인].")}</p>
              <CopyLine command="codex login" /><button type="button" className="cn-ghost" onClick={() => { void codexConnection.recheck(); }}>{t("다시 확인")}</button></div>}
            {codexNeedsInstall && !codexWaiting && !codexLoginFailed && <InstallControls engine="codex" install={codexInstall} version={codex?.install_version}
              blocked={codex?.install_blocked} onInstall={() => { void connection.installEngine("codex"); }} onRecheck={recheck} />}
            {codexWaiting && <div className="agent-settings-connect"><button type="button" className="cn-ghost" onClick={() => { void codexConnection.recheck(); }}>{t("다시 확인")}</button>
              <button type="button" className="cn-text" onClick={codexConnection.stopWaiting}>{t("그만두기")}</button><small className="cn-note">{t("자동 확인만 멈춰요 · 로그인 창은 직접 닫아 주세요")}</small></div>}
            {codexLoginFailed && codexConnection.login?.ports_busy && <p className="cn-note">{t("확인한 현재 상태: 로그인 포트 1455 와 1457 을 다른 프로세스가 사용 중이에요")}</p>}
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
