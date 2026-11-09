// Ask Agent 옆 칸(폭 520px 고정 — 시안 _shots/ask-agent-open-v2.png). 머리('새 대화 ⌄' · 새 대화 · 옆 칸 닫기) · 대화 · 입력칸(지금 화면 ·
//  모델/생각 깊이 · 보내기). 칸을 닫아도 차례는 허브에서 계속 돈다(lib/useAgentChat).
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { AgentChoice, AgentMessage } from "../../lib/useAgentChat";
import { useAgentChat } from "../../lib/useAgentChat";
import type { AgentContext, AgentEngine, AgentEngineId } from "../../lib/agentChatApi";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { useOutsideMouseDown } from "../../lib/useOutsideMouseDown";
import { useT } from "../../lib/i18n";
import { AgentPlanCard } from "./AgentPlanCard";

interface Props {
  context: AgentContext;
  contextLabel: string; // 입력칸의 '지금 화면' 표시(예: 워크스페이스 › e001)
  onClose: () => void;
}

const GROUP: Record<AgentEngineId, string> = { claude: "Claude", codex: "GPT" };
const EFFORT: Record<string, string> = { low: "낮음", medium: "보통", high: "높음" };
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
  const [menu, setMenu] = useState<"history" | "model" | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  useEscapeClose(closeMenu, menu !== null);
  useOutsideMouseDown(menu === "history" ? historyRef : modelRef, closeMenu, menu !== null);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [chat.messages]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (await chat.send(text)) setText("");
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

  return (
    <aside className="agent-panel" aria-label="Ask Agent">
      <header className="agent-head">
        <div className="agent-history-wrap" ref={historyRef}>
          <button type="button" className="agent-title" onClick={openHistory} disabled={chat.running}
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
          <button type="button" className="agent-ic" onClick={() => { chat.newConversation(); setText(""); }} disabled={chat.running}
            title={t("새 대화")} aria-label={t("새 대화")}>
            <NewChatIcon />
          </button>
          <button type="button" className="agent-ic" onClick={onClose} title={t("옆 칸 닫기")} aria-label={t("옆 칸 닫기")}>
            <SidePanelIcon />
          </button>
        </div>
      </header>

      <div className="agent-log" ref={logRef} aria-live="polite">
        {chat.messages.length === 0 ? (
          <div className="agent-empty">
            <span className="agent-empty-mark" aria-hidden="true">⬡</span>
            <p>{t("지금 보는 화면을 같이 보면서 일해요")}</p>
          </div>
        ) : chat.messages.map((m) => (
          <Message key={m.id} message={m} onExecute={chat.executePlan} onRevise={revise} />
        ))}
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
        <textarea ref={inputRef} className="agent-input" rows={2} value={text}
          placeholder={t("Agent 에게 일을 맡기거나 물어보세요")} aria-label={t("Agent 에게 보낼 말")}
          onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} />
        <div className="agent-composer-foot">
          <div className="agent-model-wrap" ref={modelRef}>
            <button type="button" className="agent-model-btn" disabled={!chat.choice || chat.running}
              onClick={() => setMenu(menu === "model" ? null : "model")} aria-haspopup="true" aria-expanded={menu === "model"}
              aria-label={t("모델과 생각 깊이 고르기")}>
              <span>{modelLabel}</span>
              {chat.choice && <span className="agent-model-effort">{t(EFFORT[chat.choice.effort] ?? chat.choice.effort)}</span>}
              <Chevron />
            </button>
            {menu === "model" && chat.choice && (
              <ModelMenu engines={engines} choice={chat.choice}
                onChoose={(next, close) => { chat.choose(next); if (close) setMenu(null); }} />
            )}
          </div>
          {chat.running ? (
            <button type="button" className="agent-send agent-stop" onClick={() => void chat.cancel()}
              disabled={chat.turn?.status === "cancelling"} title={t("멈추기")} aria-label={t("멈추기")}>
              <span className="agent-stop-mark" aria-hidden="true" />
            </button>
          ) : (
            <button type="submit" className="agent-send" disabled={blocked || !chat.choice || !text.trim()}
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
      return <div className="agent-msg agent-assistant">{m.text}</div>;
    case "tool":
      return (
        <div className={`agent-tool is-${m.status}`}>
          MV Hub · {t(TOOL[m.name] ?? m.name)} <span className="agent-tool-state">{t(TOOL_STATE[m.status] ?? m.status)}</span>
        </div>
      );
    case "plan":
      return <AgentPlanCard plan={m.plan} exec={m.exec} onExecute={() => onExecute(m.plan.plan_id)} onRevise={() => onRevise(m.plan.title ?? "")} />;
    case "error":
      return <div className="agent-msg agent-msg-error" role="alert">{m.message}</div>;
  }
}

function ModelMenu({ engines, choice, onChoose }: {
  engines: AgentEngine[];
  choice: AgentChoice;
  onChoose: (next: AgentChoice, close: boolean) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const current = engines.find((e) => e.id === choice.engine);
  const effortFor = (e: AgentEngine) => e.efforts.includes(choice.effort) ? choice.effort : e.efforts.includes("medium") ? "medium" : e.efforts[0] ?? "medium";
  return (
    <div className="agent-menu agent-model-menu" role="dialog" aria-label={t("모델 고르기")}>
      <input className="agent-model-search" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus
        placeholder={t("모델 찾기")} aria-label={t("모델 찾기")} />
      {engines.map((e) => {
        const models = e.models.filter((m) => !q || m.label.toLowerCase().includes(q));
        if (!models.length) return null;
        return (
          <div key={e.id} className="agent-model-group" role="group" aria-label={GROUP[e.id] ?? e.id}>
            <div className="agent-model-group-head">
              {GROUP[e.id] ?? e.id}
              {!e.available && <span className="agent-model-reason">{e.reason || t("쓸 수 없음")}</span>}
            </div>
            {models.map((m) => {
              const on = choice.engine === e.id && choice.model === m.id;
              return (
                <button key={m.id} type="button" className={`agent-model-item${on ? " on" : ""}`} disabled={!e.available}
                  aria-pressed={on} onClick={() => onChoose({ engine: e.id, model: m.id, effort: effortFor(e) }, true)}>
                  <span>{m.label}</span>
                  {on && <span className="agent-model-check" aria-hidden="true">✓</span>}
                </button>
              );
            })}
          </div>
        );
      })}
      {current && current.efforts.length > 0 && (
        <div className="agent-effort">
          <div className="agent-model-group-head">{t("생각 깊이")}</div>
          <div className="agent-effort-seg" role="radiogroup" aria-label={t("생각 깊이")}>
            {current.efforts.map((level) => (
              <button key={level} type="button" role="radio" aria-checked={choice.effort === level}
                className={choice.effort === level ? "on" : ""} onClick={() => onChoose({ ...choice, effort: level }, false)}>
                {t(EFFORT[level] ?? level)}
              </button>
            ))}
          </div>
        </div>
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
