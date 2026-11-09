// MV Agent 옆 칸(폭 520px 고정 — 시안 _shots/ask-agent-open-v2.png · 모델 칩 ask-agent-models.png). 머리('새 대화 ⌄' · 새 대화 ·
//  옆 칸 닫기) · 대화(또는 Claude 연결 안내) · 입력칸(지금 화면 · [모델 ⌄] [생각 깊이 ⌄] · 보내기). 칸을 닫아도 차례는 허브에서 계속 돈다.
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { AgentChoice, AgentMessage } from "../../lib/useAgentChat";
import { useAgentChat } from "../../lib/useAgentChat";
import type { AgentContext, AgentEngine, AgentEngineId } from "../../lib/agentChatApi";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { useOutsideMouseDown } from "../../lib/useOutsideMouseDown";
import { useT } from "../../lib/i18n";
import { AgentConnect } from "./AgentConnect";
import { AgentMarkdown } from "./AgentMarkdown";
import { AgentPlanCard } from "./AgentPlanCard";

interface Props {
  context: AgentContext;
  contextLabel: string; // 입력칸의 '지금 화면' 표시(예: 워크스페이스 › e001)
  onClose: () => void;
}

const GROUP: Record<AgentEngineId, string> = { claude: "Claude", codex: "ChatGPT" };
const EFFORT: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max" };
const FAST_MODEL = "opus"; // 빠른 모드 = Opus 5.5 만
// 허브 MCP 도구 이름 → 칸에 보이는 한 줄(MV Hub · 계획 저장)
const TOOL: Record<string, string> = {
  check_connection: "연결 확인",
  connect: "연결",
  read_context: "자료 조회",
  prepare_generation_plan: "계획 저장",
  get_plan: "계획 보기",
  estimate_plan: "견적",
};
const TOOL_STATE: Record<string, string> = { started: "하는 중", done: "끝", failed: "실패" };

export function AgentPanel({ context, contextLabel, onClose }: Props) {
  const t = useT();
  const chat = useAgentChat(context);
  const [text, setText] = useState("");
  const [menu, setMenu] = useState<"history" | "model" | "effort" | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const effortRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  useEscapeClose(closeMenu, menu !== null);
  useOutsideMouseDown(menu === "history" ? historyRef : menu === "effort" ? effortRef : modelRef, closeMenu, menu !== null);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [chat.messages, chat.connect.state]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (await chat.send(text)) {
      setText("");
      chat.connect.dismissConnected();
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 한글 조합 중의 Enter 는 글자 확정이다 — 보내지 않는다
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };
  const openHistory = () => {
    if (menu === "history") return setMenu(null);
    setMenu("history");
    void chat.loadConversations();
  };
  const revise = (title: string) => {
    setText(`${t("「{title}」 계획을 이렇게 고쳐 주세요").replace("{title}", title || t("계획"))}: `);
    inputRef.current?.focus();
  };

  const engines = chat.session?.engines ?? [];
  const engine = engines.find((e) => e.id === chat.choice?.engine);
  const modelLabel = engine?.models.find((m) => m.id === chat.choice?.model)?.label ?? chat.choice?.model ?? t("모델 없음");
  const blocked = chat.running || chat.sending;
  // Claude 를 아직 못 쓰면 연결 안내 + 입력칸 잠금(허브의 차례 허용 조건과 같다 — available)
  const needsConnect = chat.connect.supported && !chat.connect.allowed && chat.choice?.engine !== "codex";
  const locked = needsConnect || !chat.choice;

  return (
    <aside className="agent-panel" aria-label="MV Agent">
      <header className="agent-head">
        <div className="agent-history-wrap" ref={historyRef}>
          <button type="button" className="agent-title" onClick={openHistory} disabled={chat.running || chat.sending}
            aria-haspopup="true" aria-expanded={menu === "history"} aria-label={t("지난 대화 보기")}>
            <span>{chat.title || t("새 대화")}</span>
            <Chevron />
          </button>
          {menu === "history" && (
            <div className="agent-menu agent-history" role="menu" aria-label={t("지난 대화")}>
              {chat.conversations === null ? (
                <p className="agent-menu-note">{t("불러오는 중")}</p>
              ) : chat.conversations.length === 0 ? (
                <p className="agent-menu-note">{t("지난 대화가 없어요")}</p>
              ) : chat.conversations.map((c) => (
                <button key={c.id} type="button" role="menuitem"
                  className={`agent-history-item${c.id === chat.conversationId ? " on" : ""}`}
                  onClick={() => { setMenu(null); void chat.openConversation(c.id); }}>
                  <span>{c.title || t("제목 없음")}</span>
                  <small>{GROUP[c.engine] ?? c.engine} · {c.model}{c.resumable ? "" : ` · ${t("이어 가기 불가")}`}</small>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="agent-head-actions">
          <button type="button" className="agent-ic" onClick={() => { chat.newConversation(); setText(""); }} disabled={chat.running || chat.sending}
            title={t("새 대화")} aria-label={t("새 대화")}>
            <NewChatIcon />
          </button>
          <button type="button" className="agent-ic" onClick={onClose} title={t("옆 칸 닫기")} aria-label={t("옆 칸 닫기")}>
            <SidePanelIcon />
          </button>
        </div>
      </header>

      <div className="agent-log" ref={logRef} aria-live="polite">
        {chat.connect.connected && (
          <div className="cn-done" role="status">
            <b aria-hidden="true">✓</b>{t("Claude 가 연결됐어요")}
            <small>{chat.connect.connected.subscription
              ? `Claude ${chat.connect.connected.subscription} ${t("구독")}`
              : t("구독 종류는 확인하지 못했어요")}</small>
          </div>
        )}
        {chat.messages.length === 0 && !needsConnect && (
          <div className="agent-empty">
            <span className="agent-empty-mark" aria-hidden="true">⬡</span>
            <p>{t("지금 보는 화면을 같이 보면서 일해요")}</p>
          </div>
        )}
        {chat.messages.map((m) => (
          <Message key={m.id} message={m} onExecute={chat.executePlan} onRevise={revise} />
        ))}
        {needsConnect && (
          <AgentConnect state={chat.connect.state} version={chat.connect.version} loginWindowEnabled={chat.connect.loginWindowEnabled}
            waiting={chat.connect.waiting} note={chat.connect.note} onConnect={() => void chat.connect.connect()}
            onRecheck={() => void chat.connect.recheck()} onStopWaiting={chat.connect.stopWaiting} />
        )}
        {chat.running && <p className="agent-working" role="status">{chat.turn?.status === "cancelling" ? t("멈추는 중") : t("일하는 중")}</p>}
      </div>

      {chat.error && <p className="agent-error" role="alert">{chat.error}</p>}

      <form className="agent-composer" onSubmit={submit}>
        <div className="agent-context">
          <span className="agent-context-mark" aria-hidden="true">⬡</span>
          <span className="agent-context-text">
            <b>MV Hub</b>
            <small>{contextLabel}</small>
          </span>
        </div>
        <textarea ref={inputRef} className="agent-input" rows={2} value={text} disabled={needsConnect}
          placeholder={needsConnect ? t("Claude 를 연결하면 쓸 수 있어요") : t("Agent 에게 일을 맡기거나 물어보세요")}
          aria-label={t("Agent 에게 보낼 말")}
          onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} />
        <div className="agent-composer-foot">
          <div className="agent-model-wrap" ref={modelRef}>
            <button type="button" className="agent-model-btn" disabled={!chat.choice || blocked}
              onClick={() => setMenu(menu === "model" ? null : "model")} aria-haspopup="true" aria-expanded={menu === "model"}
              aria-label={t("모델 고르기")}>
              <span className="agent-co" aria-hidden="true">✳</span>
              <span>{modelLabel}</span>
              <Chevron />
            </button>
            {menu === "model" && chat.choice && (
              <ModelMenu engines={engines} choice={chat.choice}
                onChoose={(next) => { chat.choose(next); setMenu(null); }} />
            )}
          </div>
          <div className="agent-model-wrap" ref={effortRef}>
            <button type="button" className="agent-effort-btn" disabled={!chat.choice || blocked}
              onClick={() => setMenu(menu === "effort" ? null : "effort")} aria-haspopup="true" aria-expanded={menu === "effort"}
              aria-label={t("생각 깊이 고르기")}>
              <span>{chat.choice ? t(EFFORT[chat.choice.effort] ?? chat.choice.effort) : ""}</span>
              {chat.choice?.fast && <span className="agent-fast-mark">{t("빠름")}</span>}
              <Chevron />
            </button>
            {menu === "effort" && chat.choice && engine && (
              <EffortMenu engine={engine} choice={chat.choice} onChoose={(next, close) => { chat.choose(next); if (close) setMenu(null); }} />
            )}
          </div>
          {chat.running ? (
            <button type="button" className="agent-send agent-stop" onClick={() => void chat.cancel()}
              disabled={chat.turn?.status === "cancelling"} title={t("멈추기")} aria-label={t("멈추기")}>
              <span className="agent-stop-mark" aria-hidden="true" />
            </button>
          ) : (
            <button type="submit" className="agent-send" disabled={blocked || locked || !text.trim()}
              title={t("보내기")} aria-label={t("보내기")}>
              <span aria-hidden="true">↑</span>
            </button>
          )}
        </div>
      </form>
    </aside>
  );
}

function Message({ message: m, onExecute, onRevise }: {
  message: AgentMessage;
  onExecute: (planId: string) => void;
  onRevise: (title: string) => void;
}) {
  const t = useT();
  switch (m.kind) {
    case "user":
      return <div className="agent-msg agent-user">{m.text}</div>;
    case "assistant":
      return <div className="agent-msg agent-assistant"><AgentMarkdown text={m.text} /></div>;
    case "tool":
      return (
        <div className={`agent-tool is-${m.status}`}>
          MV Hub · {t(TOOL[m.name] ?? m.name)} <span className="agent-tool-state">{t(TOOL_STATE[m.status] ?? m.status)}</span>
        </div>
      );
    case "plan":
      return <AgentPlanCard plan={m.plan} exec={m.exec} estimate={m.estimate} onExecute={() => onExecute(m.plan.plan_id)}
        onRevise={() => onRevise(m.plan.title ?? "")} />;
    case "notice":
      return <div className="agent-notice" role="status">{m.text}</div>;
    case "error":
      return <div className="agent-msg agent-msg-error" role="alert">{m.message}</div>;
  }
}

/** [모델 ⌄] — 맨 위 회사(Claude ⌄ — 누르면 회사 목록, ChatGPT 는 잠금이면 까닭), 아래 그 회사의 모델. */
function ModelMenu({ engines, choice, onChoose }: {
  engines: AgentEngine[];
  choice: AgentChoice;
  onChoose: (next: AgentChoice) => void;
}) {
  const t = useT();
  const [companies, setCompanies] = useState(false);
  const current = engines.find((e) => e.id === choice.engine);
  const effortFor = (e: AgentEngine) => e.efforts.includes(choice.effort) ? choice.effort : e.efforts.includes("medium") ? "medium" : e.efforts[0] ?? "medium";
  return (
    <div className="agent-menu agent-model-menu" role="dialog" aria-label={t("모델 고르기")}>
      <button type="button" className="agent-company-head" aria-expanded={companies} onClick={() => setCompanies((v) => !v)}>
        <span className="agent-co" aria-hidden="true">✳</span>{GROUP[choice.engine] ?? choice.engine}<span className="agent-sp" /><Chevron />
      </button>
      {companies && (
        <div className="agent-company-list" role="group" aria-label={t("회사 고르기")}>
          {engines.map((e) => (
            <button key={e.id} type="button" className={`agent-model-item${e.id === choice.engine ? " on" : ""}`} disabled={!e.available}
              onClick={() => { if (e.id !== choice.engine && e.models[0]) onChoose({ engine: e.id, model: e.models[0].id, effort: effortFor(e), fast: false }); else setCompanies(false); }}>
              <span>{GROUP[e.id] ?? e.id}</span>
              {e.id === choice.engine ? <span className="agent-model-check" aria-hidden="true">✓</span>
                : !e.available && <span className="agent-model-reason">{e.reason || t("쓸 수 없음")}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="agent-menu-sep" />
      {(current?.models ?? []).map((m) => {
        const on = choice.model === m.id;
        return (
          <button key={m.id} type="button" className={`agent-model-item${on ? " on" : ""}`} disabled={!current?.available}
            aria-pressed={on} onClick={() => onChoose({ ...choice, model: m.id })}>
            <span>{GROUP[choice.engine] ?? ""} {m.label}</span>
            {on && <span className="agent-model-check" aria-hidden="true">✓</span>}
          </button>
        );
      })}
    </div>
  );
}

/** [생각 깊이 ⌄] — Low~Max + 빠른 모드(Opus 만 · Claude 추가 사용 크레딧). */
function EffortMenu({ engine, choice, onChoose }: {
  engine: AgentEngine;
  choice: AgentChoice;
  onChoose: (next: AgentChoice, close: boolean) => void;
}) {
  const t = useT();
  const fastShown = engine.id === "claude" && choice.model === FAST_MODEL;
  return (
    <div className="agent-menu agent-effort-menu" role="dialog" aria-label={t("생각 깊이 고르기")}>
      <div role="radiogroup" aria-label={t("생각 깊이")}>
        {engine.efforts.map((level) => (
          <button key={level} type="button" role="radio" aria-checked={choice.effort === level}
            className={`agent-model-item${choice.effort === level ? " on" : ""}`} onClick={() => onChoose({ ...choice, effort: level }, true)}>
            <span>{t(EFFORT[level] ?? level)}</span>
            {choice.effort === level && <span className="agent-model-check" aria-hidden="true">✓</span>}
          </button>
        ))}
      </div>
      {fastShown && (
        <>
          <div className="agent-menu-sep" />
          <div className="agent-model-group-head">Options</div>
          <button type="button" role="switch" aria-checked={!!choice.fast} className={`agent-fast${choice.fast ? " on" : ""}`}
            onClick={() => onChoose({ ...choice, fast: !choice.fast }, false)}>
            <span>{t("빠른 모드")}</span><span className="agent-switch" aria-hidden="true" />
          </button>
          <p className="agent-menu-note">{t("Claude 추가 사용 크레딧이 들어요 · 칸을 열 때마다 꺼짐")}</p>
        </>
      )}
    </div>
  );
}
function Chevron() {
  return (
    <svg className="agent-chevron" viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth={1.6}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 4.5 6 7.5 9 4.5" />
    </svg>
  );
}

function NewChatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.7}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" />
      <path d="M17.6 3.6a2 2 0 0 1 2.8 2.8L12 14.8l-3.6.8.8-3.6Z" />
    </svg>
  );
}

function SidePanelIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.7}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M14.5 4.5v15" />
    </svg>
  );
}
