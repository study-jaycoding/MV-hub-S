// MV Agent 옆 칸(기본 폭 520px — 시안 _shots/ask-agent-open-v2.png · 모델 칩 ask-agent-models.png). 머리('새 대화 ⌄' · 새 대화 ·
//  띄우기/붙이기 · 닫기) · 대화(또는 Claude 연결 안내) · 입력칸(지금 화면 · [모델 ⌄] [생각 깊이 ⌄] · 보내기). 칸을 닫아도 차례는 허브에서 계속 돈다.
//  옆에 붙은 동안 왼쪽 끝선을 끌어 폭을 바꾸고, 떠 있는 창으로 띄울 수 있다(Jay 11-10 — docs/status/MVAgent_칸폭_떠있는창_2026-11-10.md).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { AgentChoice, AgentMessage } from "../../lib/useAgentChat";
import { useAgentChat } from "../../lib/useAgentChat";
import type { AgentContext, AgentEngine, AgentEngineId } from "../../lib/agentChatApi";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { useOutsideMouseDown } from "../../lib/useOutsideMouseDown";
import { useT } from "../../lib/i18n";
import { loadJSON, makeStore, saveJSON } from "../../lib/storage";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import { useFloatingPanel } from "../../lib/useFloatingPanel";
import type { Generation, PreviewTarget } from "../../types";
import { AgentConnect } from "./AgentConnect";
import { AgentMarkdown } from "./AgentMarkdown";
import { AgentPlanCard } from "./AgentPlanCard";

interface Props {
  context: AgentContext;
  contextLabel: string; // 입력칸의 '지금 화면' 표시(예: 워크스페이스 › e001)
  onClose: () => void;
  floating?: boolean; // 떠 있는 창(앱이 기억한다 — 떠 있는 동안 앱 본문은 좁아지지 않는다)
  onToggleFloat?: () => void; // 없으면 띄우기 단추도 없다
  findGeneration?: (id: string) => Generation | undefined; // 계획 카드 썸네일 — 앱이 이미 읽은 라이브러리 카드
  onPreview?: (target: PreviewTarget) => void; // 썸네일을 누르면 기존 크게 보기
}

const NO_SCREEN: Record<string, never> = {}; // '지금 화면' 칩을 뺀 동안 보내는 빈 문맥(허브가 '어디인지 묻는다' 안내)

// 옆 칸 폭 — 필터 사이드바처럼 끝선을 끌어 바꾼다. 화면에 보이는 폭은 :root 의 --agent-w(앱 본문 여백 .app.agent-open 도 같이 읽는다)
const BASE_W = 520;
const MIN_W = 380;
const maxWidth = () => Math.max(MIN_W, Math.floor(window.innerWidth / 2));
const clampWidth = (w: number) => Math.max(MIN_W, Math.min(maxWidth(), Math.round(w)));
const showWidth = (w: number) => document.documentElement.style.setProperty("--agent-w", `${w}px`);
const FLOAT_LS = makeStore("mvhub.agentPanel."); // 떠 있는 창 자리(pos)·크기(size)

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
  execute_generation_plan: "생성 실행",
  wait_results: "결과 기다리기",
  add_to_canvas: "캔버스에 놓기",
};
const TOOL_STATE: Record<string, string> = { started: "하는 중", done: "끝", failed: "실패" };

export function AgentPanel({ context, contextLabel, onClose, floating = false, onToggleFloat, findGeneration, onPreview }: Props) {
  const t = useT();

  // 옆 칸 폭 — 고른 폭은 남기고, 보이는 폭은 지금 창 폭의 절반까지(창을 줄였다 키우면 고른 폭으로 돌아간다 — ResizableSidebar 와 같다)
  const [width, setWidth] = useState(() => {
    const saved = loadJSON<unknown>(STORAGE_KEYS.agentPanelWidth);
    return typeof saved === "number" && Number.isFinite(saved) ? saved : BASE_W;
  });
  useLayoutEffect(() => {
    const apply = () => showWidth(clampWidth(width));
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [width]);
  const commitWidth = (next: number) => {
    next = clampWidth(next);
    setWidth(next);
    showWidth(next);
    saveJSON(STORAGE_KEYS.agentPanelWidth, next);
  };
  // 끄는 동안은 :root 변수만 바꾼다(앱을 다시 그리지 않는다) — 놓을 때 한 번 남긴다
  const drag = useRef<{ id: number; x: number; from: number; now: number } | null>(null);
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>, keep: boolean) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    drag.current = null; // releasePointerCapture 가 lostpointercapture 를 보내도 두 번 처리하지 않는다
    event.currentTarget.classList.remove("resizing");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (keep && d.now !== d.from) commitWidth(d.now);
    else showWidth(clampWidth(width));
  };

  // 떠 있는 창 — 앱의 다른 떠 있는 창과 같은 부품(자리·크기 저장, 화면 밖 보정, 앞뒤 띠 152~159)
  const float = useFloatingPanel(FLOAT_LS, "pos", "size", floating);
  const panelNode = useRef<HTMLElement | null>(null);
  const setPanel = useCallback((node: HTMLElement | null) => {
    panelNode.current = node;
    float.panelRef(node as HTMLDivElement | null);
  }, [float.panelRef]);
  // 띄운 순간의 크기 — 떠 있는 동안 모서리로 바꾸는 크기는 브라우저가 쥔다(인라인으로 다시 덮지 않는다 · EditTrimPop 과 같다).
  //  폭·높이는 늘 인라인에 둔다: 붙일 때 React 가 지워야 브라우저가 적은 크기까지 같이 지워진다.
  const openSize = useRef<{ w: number; h: number } | null>(null);
  if (!floating) openSize.current = null;
  else if (!openSize.current) openSize.current = float.size ?? { w: BASE_W, h: Math.max(360, Math.min(720, window.innerHeight - 96)) };
  const at = float.pos ?? { x: Math.max(8, window.innerWidth - (openSize.current?.w ?? BASE_W) - 24), y: 64 };
  const floatStyle: CSSProperties | undefined = floating && openSize.current
    ? { left: at.x, top: at.y, width: openSize.current.w, height: openSize.current.h }
    : undefined;
  // 붙이면 부품이 준 앞뒤(z 152~)를 걷는다 — 옆 칸은 CSS 의 61
  useLayoutEffect(() => { if (!floating) panelNode.current?.style.removeProperty("z-index"); }, [floating]);
  const onHeadMouseDown = (event: ReactMouseEvent) => {
    if (!floating || event.button !== 0 || (event.target as HTMLElement).closest("button, .agent-menu")) return;
    float.onHeadMouseDown(event, at);
  };

  const [screenOn, setScreenOn] = useState(true); // 기억하지 않는다 — 새 대화·지난 대화 열기마다 다시 붙는다
  const chat = useAgentChat(screenOn ? context : NO_SCREEN);
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
    <aside ref={setPanel} className={floating ? "agent-panel floating" : "agent-panel"} aria-label="MV Agent" style={floatStyle}>
      {!floating && (
        <div className="agent-resize" role="separator" tabIndex={0} aria-orientation="vertical"
          aria-label={t("MV Agent 칸 너비 조절")} aria-valuemin={MIN_W} aria-valuemax={maxWidth()} aria-valuenow={clampWidth(width)}
          title={t("드래그하여 너비 조절 · 더블클릭하여 기본 너비로 복원")}
          onPointerDown={(event) => {
            if (event.button !== 0 || !event.isPrimary || drag.current) return;
            event.preventDefault(); // 초점을 옮기지 않는다 — 손잡이에 남으면 ←·→ 가 칸 폭을 바꾼다
            event.currentTarget.setPointerCapture(event.pointerId);
            event.currentTarget.classList.add("resizing");
            const from = clampWidth(width);
            drag.current = { id: event.pointerId, x: event.clientX, from, now: from };
          }}
          onPointerMove={(event) => {
            const d = drag.current;
            if (!d || d.id !== event.pointerId) return;
            d.now = clampWidth(d.from - (event.clientX - d.x)); // 칸이 오른쪽에 있어 왼쪽으로 끌면 넓어진다
            showWidth(d.now);
          }}
          onPointerUp={(event) => endDrag(event, true)}
          onPointerCancel={(event) => endDrag(event, false)}
          onLostPointerCapture={(event) => endDrag(event, false)}
          onDoubleClick={() => commitWidth(BASE_W)}
          onKeyDown={(event) => {
            const step = event.key === "ArrowLeft" ? 8 : event.key === "ArrowRight" ? -8 : 0;
            if (!step) return;
            event.preventDefault();
            commitWidth(clampWidth(width) + step);
          }}
        />
      )}
      <header className="agent-head" onMouseDown={onHeadMouseDown}>
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
                  onClick={() => { setMenu(null); setScreenOn(true); void chat.openConversation(c.id); }}>
                  <span>{c.title || t("제목 없음")}</span>
                  <small>{GROUP[c.engine] ?? c.engine} · {c.model}{c.resumable ? "" : ` · ${t("이어 가기 불가")}`}</small>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="agent-head-actions">
          <button type="button" className="agent-ic" onClick={() => { chat.newConversation(); setText(""); setScreenOn(true); }} disabled={chat.running || chat.sending}
            title={t("새 대화")} aria-label={t("새 대화")}>
            <NewChatIcon />
          </button>
          {onToggleFloat && (
            <button type="button" className="agent-ic" onClick={onToggleFloat}
              title={t(floating ? "옆에 붙이기" : "떠 있는 창으로 띄우기")} aria-label={t(floating ? "옆에 붙이기" : "떠 있는 창으로 띄우기")}>
              {floating ? <DockIcon /> : <PopOutIcon />}
            </button>
          )}
          <button type="button" className="agent-ic" onClick={onClose}
            title={t(floating ? "창 닫기" : "옆 칸 닫기")} aria-label={t(floating ? "창 닫기" : "옆 칸 닫기")}>
            {floating ? <CloseIcon /> : <SidePanelIcon />}
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
          <Message key={m.id} message={m} onExecute={chat.executePlan} onRevise={revise} findGeneration={findGeneration} onPreview={onPreview} />
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
        {screenOn ? (
          <div className="agent-context">
            <span className="agent-context-mark" aria-hidden="true">⬡</span>
            <span className="agent-context-text">
              <b>MV Hub</b>
              <small>{contextLabel}</small>
            </span>
            {/* Aside 처럼 올리면(키보드 초점도) 보인다 — 빼면 다음 메시지부터 지금 화면 정보를 안 보낸다(앱 동작 도구 설계 A4) */}
            <button type="button" className="agent-context-x" onClick={() => setScreenOn(false)}
              title={t("지금 화면 정보 빼기")} aria-label={t("지금 화면 정보 빼기")}>×</button>
          </div>
        ) : (
          <button type="button" className="agent-context-add" onClick={() => setScreenOn(true)} aria-label={t("지금 화면 정보 다시 붙이기")}>
            ＋ {t("지금 화면")}
          </button>
        )}
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

function Message({ message: m, onExecute, onRevise, findGeneration, onPreview }: {
  message: AgentMessage;
  onExecute: (planId: string) => void;
  onRevise: (title: string) => void;
  findGeneration?: (id: string) => Generation | undefined;
  onPreview?: (target: PreviewTarget) => void;
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
      return <AgentPlanCard plan={m.plan} exec={m.exec} estimate={m.estimate} progress={m.progress} onExecute={() => onExecute(m.plan.plan_id)}
        onRevise={() => onRevise(m.plan.title ?? "")} findGeneration={findGeneration} onPreview={onPreview} />;
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

/** 떠 있는 창으로 띄우기 — 큰 창 안의 작은 창(화면 속 화면) */
function PopOutIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.7}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <rect x="11.5" y="11.5" width="6" height="5" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 옆에 붙이기 — 오른쪽 칸이 채워진 창 */
function DockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.7}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M14.5 4.5h3.5a2.5 2.5 0 0 1 2.5 2.5v10a2.5 2.5 0 0 1-2.5 2.5h-3.5Z" fill="currentColor" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.7}
      strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}
