// MV Agent 옆 칸(기본 폭 520px — 시안 _shots/ask-agent-open-v2.png · 모델 칩 ask-agent-models.png). 머리(왼쪽 [≡ 대화 목록][옆 칸 닫기] · 제목 ·
//  오른쪽 [새 대화][새 창]) · 대화(또는 Claude 연결 안내) · 입력칸(지금 화면 · [모델 ⌄] [생각 깊이 ⌄] · 보내기). 칸을 닫아도 차례는 허브에서 계속 돈다.
//  옆에 붙은 동안 왼쪽 끝선을 끌어 폭을 바꾸고, ≡ 는 대화 서랍(프로젝트별·설정), [새 창]은 Assets 같은 별도 창(AgentWindow)으로 뺀다
//  (Jay 11-10 시안 A안·② — docs/status/MVAgent_서랍_새창_2026-11-10.md).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { AgentChoice, AgentMessage } from "../../lib/useAgentChat";
import { useAgentChat } from "../../lib/useAgentChat";
import {
  agentChatApi, type AgentContext, type AgentConversationPatch, type AgentConversationSummary, type AgentEngine, type AgentEngineId,
  type AgentSessionFileResult,
} from "../../lib/agentChatApi";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { useOutsideMouseDown } from "../../lib/useOutsideMouseDown";
import { useT } from "../../lib/i18n";
import { loadJSON, saveJSON } from "../../lib/storage";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import type { Generation, PreviewTarget } from "../../types";
import { AgentConnect } from "./AgentConnect";
import { AgentMarkdown } from "./AgentMarkdown";
import { AgentPlanCard } from "./AgentPlanCard";

interface Props {
  context: AgentContext;
  contextLabel: string; // 입력칸의 '지금 화면' 표시(예: 워크스페이스 › e001)
  onClose: () => void;
  popout?: boolean; // 별도 창(?embed=agent) 안 — 창을 채우고, 폭 손잡이·[새 창] 대신 [옆 칸으로 붙이기]
  onPopOut?: () => void; // 옆 칸 → 새 창(없으면 단추도 없다)
  onDock?: () => void; // 새 창 → 옆 칸
  projectName?: (id: string) => string | undefined; // 서랍의 프로젝트 묶음 이름
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

type ToolMessage = Extract<AgentMessage, { kind: "tool" }>;
type Row = AgentMessage | { kind: "tools"; id: string; tools: ToolMessage[] };
/** 이어진 도구 알약을 한 줄로 묶는다(Aside 처럼 — 시안 A, docs/status/MVAgent_한줄묶기_2026-11-11.md). 사건·저장 형식은 그대로, 그리기만. */
function groupTools(messages: AgentMessage[]): Row[] {
  const rows: Row[] = [];
  for (const m of messages) {
    const last = rows[rows.length - 1];
    if (m.kind === "tool" && last?.kind === "tools") last.tools.push(m);
    else rows.push(m.kind === "tool" ? { kind: "tools", id: m.id, tools: [m] } : m);
  }
  return rows;
}

export function AgentPanel({ context, contextLabel, onClose, popout = false, onPopOut, onDock, projectName, findGeneration, onPreview }: Props) {
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

  const [screenOn, setScreenOn] = useState(true); // 기억하지 않는다 — 새 대화·지난 대화 열기마다 다시 붙는다
  const chat = useAgentChat(screenOn ? context : NO_SCREEN, { popout }); // 새 창이면 '새 창에서 열기' 요청을 받는다
  const [text, setText] = useState("");
  const [revising, setRevising] = useState<{ title: string } | null>(null); // [고치기] — 입력칸의 '고칠 계획' 칩
  const [menu, setMenu] = useState<"model" | null>(null); // 모델·생각 깊이·속도 한 메뉴(Aside 처럼)
  const [drawer, setDrawer] = useState(false); // ≡ 대화 서랍
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeDrawer = useCallback(() => setDrawer(false), []);
  useEscapeClose(closeMenu, menu !== null);
  useEscapeClose(closeDrawer, drawer && menu === null);
  useOutsideMouseDown(modelRef, closeMenu, menu !== null);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [chat.messages, chat.connect.state]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    // 칩이 있으면 AI 에게는 지금까지와 같은 문장으로 — 고칠 내용을 써야 보낸다(빈 문장 전송 막음)
    const body = revising && text.trim()
      ? `${t("「{title}」 계획을 이렇게 고쳐 주세요").replace("{title}", revising.title || t("계획"))}: ${text.trim()}`
      : text;
    if (await chat.send(body)) {
      setText("");
      setRevising(null);
      chat.connect.dismissConnected();
    }
  };
  const scrollToEnd = () => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 한글 조합 중의 Enter 는 글자 확정이다 — 보내지 않는다
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };
  const toggleDrawer = () => {
    if (drawer) return setDrawer(false);
    setMenu(null);
    setDrawer(true);
    void chat.loadConversations();
  };
  const startNew = () => { chat.newConversation(); setText(""); setRevising(null); setScreenOn(true); setDrawer(false); };
  const revise = (title: string) => {
    setRevising({ title });
    inputRef.current?.focus();
  };
  const reuse = (value: string) => { // 내 말 [고쳐 보내기] — 입력칸에 다시 채운다
    setText(value);
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
    <aside className={`agent-panel${popout ? " popout" : ""}${chat.running ? " is-running" : ""}`} aria-label="MV Agent">
      {!popout && (
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
      <header className="agent-head">
        <div className="agent-head-left">
          <button type="button" className={`agent-ic${drawer ? " on" : ""}`} onClick={toggleDrawer}
            aria-expanded={drawer} title={t("대화 목록")} aria-label={t("대화 목록")}>
            <MenuIcon />
          </button>
          {popout ? (
            onDock && (
              <button type="button" className="agent-ic" onClick={onDock} title={t("옆 칸으로 붙이기")} aria-label={t("옆 칸으로 붙이기")}>
                <SidePanelIcon />
              </button>
            )
          ) : (
            <button type="button" className="agent-ic" onClick={onClose} title={t("옆 칸 닫기")} aria-label={t("옆 칸 닫기")}>
              <SidePanelIcon />
            </button>
          )}
          <span className="agent-title"><span>{chat.title || t("새 대화")}</span></span>
        </div>
        <div className="agent-head-actions">
          <button type="button" className="agent-ic" onClick={startNew} disabled={chat.running || chat.sending}
            title={t("새 대화")} aria-label={t("새 대화")}>
            <NewChatIcon />
          </button>
          {!popout && onPopOut && (
            <button type="button" className="agent-ic" onClick={onPopOut} title={t("새 창으로 띄우기")} aria-label={t("새 창으로 띄우기")}>
              <PopOutIcon />
            </button>
          )}
        </div>
      </header>

      {drawer && (
        <AgentDrawer conversations={chat.conversations} currentId={chat.conversationId} running={chat.running}
          locked={chat.running || chat.sending} projectName={projectName} currentProject={context.project} truncated={chat.truncated}
          onNew={startNew}
          onOpen={(id) => { setDrawer(false); setScreenOn(true); setRevising(null); void chat.openConversation(id); }}
          onClose={closeDrawer} onPatch={chat.patchConversation} onDelete={chat.removeConversation}
          /* 새 창에서 열기 — 옆 칸에서만. 새 창이 받을 요청을 적고 지금 [새 창으로 띄우기] 길을 탄다(옆 칸의 지금 대화는 그대로) */
          onOpenInWindow={!popout && onPopOut ? (id) => { if (chat.requestOpenInWindow(id)) { setDrawer(false); onPopOut(); } } : undefined}
          claude={engines.find((e) => e.id === "claude")} />
      )}

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
        {groupTools(chat.messages).map((r) => (r.kind === "tools" ? <ToolGroup key={r.id} tools={r.tools} /> : (
          <Message key={r.id} message={r} onExecute={chat.executePlan} onRevise={revise} onReuse={reuse}
            findGeneration={findGeneration} onPreview={onPreview} />
        )))}
        {needsConnect && (
          <AgentConnect state={chat.connect.state} version={chat.connect.version} loginWindowEnabled={chat.connect.loginWindowEnabled}
            waiting={chat.connect.waiting} note={chat.connect.note} onConnect={() => void chat.connect.connect()}
            onRecheck={() => void chat.connect.recheck()} onStopWaiting={chat.connect.stopWaiting} />
        )}
      </div>

      {/* 대화 끝의 '일하는 중' 글 대신 입력칸 위에 떠 있는 점 알약 — 누르면 맨 아래로(Aside 'Working — scroll to bottom') */}
      {chat.running && (
        <div className="agent-float" role="status">
          <button type="button" className="agent-working" onClick={scrollToEnd} title={t("맨 아래로")}>
            <span className="agent-dots" aria-hidden="true"><i /><i /><i /></span>
            {chat.turn?.status === "cancelling" ? t("멈추는 중") : t("일하는 중")}
          </button>
        </div>
      )}

      {chat.error && <p className="agent-error" role="alert">{chat.error}</p>}
      {chat.notice && <p className="agent-notice" role="status">{chat.notice}</p>}

      <form className="agent-composer" onSubmit={submit}>
        <div className="agent-chips">
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
          {revising && (
            <div className="agent-context agent-revise">
              <span className="agent-context-mark" aria-hidden="true"><PencilIcon /></span>
              <span className="agent-context-text">
                <b>{t("고칠 계획")}</b>
                <small>{revising.title || t("이름 없는 계획")}</small>
              </span>
              <button type="button" className="agent-context-x" onClick={() => setRevising(null)}
                title={t("고치기 취소")} aria-label={t("고치기 취소")}>×</button>
            </div>
          )}
        </div>
        <textarea ref={inputRef} className="agent-input" rows={2} value={text} disabled={needsConnect}
          placeholder={needsConnect ? t("Claude 를 연결하면 쓸 수 있어요")
            : revising ? t("어떻게 고칠지 적어 주세요 — 예: 바나나만, 9:16 으로")
            : t("Agent 에게 일을 맡기거나 물어보세요")}
          aria-label={t("Agent 에게 보낼 말")}
          onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} />
        <div className="agent-composer-foot">
          {/* 모델 이름 + 생각 깊이(흐리게) 한 단추 — Aside 'GPT-6.1 Sol High ⌄' 처럼 */}
          <div className="agent-model-wrap" ref={modelRef}>
            <button type="button" className="agent-model-btn" disabled={!chat.choice || blocked}
              onClick={() => setMenu(menu === "model" ? null : "model")} aria-haspopup="true" aria-expanded={menu === "model"}
              aria-label={t("모델 고르기")}>
              <span className="agent-co" aria-hidden="true">{chat.choice?.engine === "codex" ? "◎" : "✳"}</span>
              <span>{modelLabel}</span>
              {chat.choice && <span className="agent-model-effort">{t(EFFORT[chat.choice.effort] ?? chat.choice.effort)}</span>}
              {chat.choice?.fast && <span className="agent-fast-mark">{t("빠름")}</span>}
              <Chevron />
            </button>
            {menu === "model" && chat.choice && (
              <ModelMenu engines={engines} choice={chat.choice}
                onChoose={(next) => { chat.choose(next); setMenu(null); }} />
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

function Message({ message: m, onExecute, onRevise, onReuse, findGeneration, onPreview }: {
  message: AgentMessage;
  onExecute: (planId: string) => void;
  onRevise: (title: string) => void;
  onReuse: (text: string) => void;
  findGeneration?: (id: string) => Generation | undefined;
  onPreview?: (target: PreviewTarget) => void;
}) {
  switch (m.kind) {
    case "user":
      return <UserMessage text={m.text} onReuse={onReuse} />;
    case "assistant":
      return <div className="agent-msg agent-assistant"><AgentMarkdown text={m.text} /></div>;
    case "tool":
      return <ToolGroup tools={[m]} />;
    case "plan":
      return <AgentPlanCard plan={m.plan} exec={m.exec} estimate={m.estimate} progress={m.progress} onExecute={() => onExecute(m.plan.plan_id)}
        onRevise={() => onRevise(m.plan.title ?? "")} findGeneration={findGeneration} onPreview={onPreview} />;
    case "notice":
      return <div className="agent-notice" role="status">{m.text}</div>;
    case "error":
      return <div className="agent-msg agent-msg-error" role="alert">{m.message}</div>;
  }
}

/** 도구 묶음 한 줄 — "MV Hub · 자료 조회 2번, 계획 저장 끝". 이름별 횟수(처음 나온 순서)를 앞 3개까지, 나머지는 "외 N".
 *  하나라도 도는 중이면 '하는 중', 실패가 있으면 '실패'. 누르면 하나씩 펼친다. */
function ToolGroup({ tools }: { tools: ToolMessage[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const counts = new Map<string, number>();
  for (const x of tools) counts.set(x.name, (counts.get(x.name) ?? 0) + 1);
  const labels = [...counts].map(([name, n]) => `${t(TOOL[name] ?? name)}${n > 1 ? ` ${n}${t("번")}` : ""}`);
  const summary = labels.slice(0, 3).join(", ") + (labels.length > 3 ? ` ${t("외")} ${labels.length - 3}` : "");
  const status = tools.some((x) => x.status === "started") ? "started" : tools.some((x) => x.status === "failed") ? "failed" : "done";
  return (
    <div className="agent-tools">
      <button type="button" className={`agent-tool is-${status}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="agent-tool-mark" aria-hidden="true" />
        {status === "started" && <span className="agent-tool-spin" aria-hidden="true" />}
        MV Hub · {summary} <span className="agent-tool-state">{t(TOOL_STATE[status])}</span>
        <Chevron />
      </button>
      {open && (
        <ul className="agent-tool-list">
          {tools.map((x) => (
            <li key={x.id} className={`is-${x.status}`}>
              <span className="agent-tool-li-mark" aria-hidden="true">{x.status === "done" ? "✓" : x.status === "failed" ? "✕" : "·"}</span>
              {t(TOOL[x.name] ?? x.name)} <small>{t(TOOL_STATE[x.status] ?? x.status)}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 내 말 — 올리면 [복사][고쳐 보내기](Aside Copy · Edit message). 고쳐 보내기는 입력칸에 다시 채울 뿐 바로 보내지 않는다. */
function UserMessage({ text, onReuse }: { text: string; onReuse: (text: string) => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }, () => {});
  };
  return (
    <div className="agent-user-wrap">
      <div className="agent-msg agent-user">{text}</div>
      <div className="agent-user-acts">
        <button type="button" className="agent-mini" onClick={copy} title={copied ? t("복사했어요") : t("복사")} aria-label={t("복사")}>
          {copied ? <span aria-hidden="true">✓</span> : <CopyIcon />}
        </button>
        <button type="button" className="agent-mini" onClick={() => onReuse(text)} title={t("고쳐 보내기")} aria-label={t("고쳐 보내기")}>
          <PencilIcon />
        </button>
      </div>
    </div>
  );
}

// 서랍 넓이(설계 docs/status/MVAgent_서랍메뉴_2026-11-12.md 2-4) — 최소 220 · 최대 = 칸 폭 − 40(칸이 좁으면 최대가 이긴다) · 기본 310
const DRAWER_BASE_W = 310;
const DRAWER_MIN_W = 220;
const clampDrawer = (w: number, panelW: number) => Math.round(Math.min(panelW - 40, Math.max(DRAWER_MIN_W, w)));
const SESSION_FILE_NOTE: Record<AgentSessionFileResult, string> = {
  deleted: "지웠어요 · Claude 기억(세션 파일)도 지웠어요",
  not_found: "지웠어요 · Claude 세션 파일은 확인하지 못해 남겨 뒀어요",
  failed: "지웠어요 · Claude 세션 파일은 지우지 못했어요",
  codex_kept: "지웠어요 · Codex 기록은 Codex 폴더에 남아요",
  none: "지웠어요",
};
// sub = 프로젝트 하위 메뉴, side = 펼칠 쪽(오른쪽 자리가 없으면 왼쪽, 둘 다 없으면 아래로 — 좁은 새 창, 독립 리뷰 P2)
type RowMenu = { id: string; top: number; left: number; sub: boolean; side?: "right" | "left" | "below" };
const ROW_MENU_W = 232;
const PIN_GROUP = "__pinned__";
const ARCHIVE_GROUP = "__archived__"; // 보관함 — 처음엔 접혀 있다
type RowAct = "pin" | "unread" | "rename" | "archive" | "delete";
const ROW_KEYS: Record<string, RowAct | undefined> = { KeyP: "pin", KeyU: "unread", KeyR: "rename", KeyA: "archive", KeyD: "delete" };

/** ≡ 대화 서랍 — [새 대화] · 고정됨 · 프로젝트별 대화(고른 것 회색 칸 · 일하는 중 라임 고리 · 읽지 않음 라임 점) · 보관함 ·
 *  맨 아래 한 줄(Claude · 요금제 / Claude Code 판·새 판). 행마다 ⋯ · 우클릭 메뉴(설계 2-1)와 오른쪽 끝선 넓이 조절(2-4).
 *  보내는 중·일하는 중에는 고르기와 그 대화의 바꾸는 항목만 잠근다. 설정 칸(새 대화 모델·칸 위치)은 넣지 않는다(Jay 11-10).
 *  요금제 = 허브가 Claude Code 설정의 표시 이름(Ultra 등)을 같은 계정일 때만 싣는다(docs/status/MVAgent_서랍아래줄_2026-11-10.md). */
function AgentDrawer({ conversations, currentId, running, locked, projectName, currentProject, truncated, onNew, onOpen, onClose,
  onPatch, onDelete, onOpenInWindow, claude }: {
  conversations: AgentConversationSummary[] | null;
  currentId: string | null;
  running: boolean;
  locked: boolean;
  projectName?: (id: string) => string | undefined;
  currentProject?: string;
  truncated: boolean;
  onNew: () => void;
  onOpen: (id: string) => void;
  onClose: () => void;
  onPatch: (id: string, body: AgentConversationPatch) => Promise<boolean>;
  onDelete: (id: string) => Promise<AgentSessionFileResult | null>;
  onOpenInWindow?: (id: string) => void;
  claude?: AgentEngine;
}) {
  const t = useT();
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set([ARCHIVE_GROUP]));
  const [version, setVersion] = useState<{ current: string | null; latest: string | null; newer: boolean } | null>(null);
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const [confirm, setConfirm] = useState<AgentConversationSummary | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => { // 서랍을 열 때 한 번 — 허브가 최신 판을 6시간 기억한다
    let live = true;
    agentChatApi.claudeVersion().then((v) => { if (live) setVersion(v); }, () => {});
    return () => { live = false; };
  }, []);

  // ── 넓이 — 고른 폭은 남기고 보이는 폭은 칸 폭에 맞춘다(칸 폭이 바뀌면 다시) ──
  const [width, setWidth] = useState(() => {
    const saved = loadJSON<unknown>(STORAGE_KEYS.agentDrawerWidth);
    return typeof saved === "number" && Number.isFinite(saved) ? saved : DRAWER_BASE_W;
  });
  const [panelW, setPanelW] = useState(() => (typeof window === "undefined" ? 520 : window.innerWidth));
  useLayoutEffect(() => {
    const panel = navRef.current?.parentElement;
    if (!panel) return;
    const measure = () => setPanelW(panel.clientWidth || window.innerWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  const shown = clampDrawer(width, panelW);
  const commitWidth = (next: number) => {
    const w = clampDrawer(next, panelW);
    setWidth(w);
    saveJSON(STORAGE_KEYS.agentDrawerWidth, w);
  };
  const drag = useRef<{ id: number; x: number; from: number } | null>(null);

  // ── 겹(Esc 한 번에 한 겹) — 하위 메뉴 → 행 메뉴 → 이름 바꾸기 → 확인 창 → 서랍 ──
  const menuNow = useRef(menu);
  menuNow.current = menu;
  const focusMore = (id: string) => window.requestAnimationFrame(() => navRef.current?.querySelector<HTMLButtonElement>(`[data-more="${id}"]`)?.focus());
  const closeMenu = useCallback(() => {
    const open = menuNow.current;
    setMenu(null);
    if (open) focusMore(open.id); // Esc·바깥 누름으로 닫으면 ⋯ 로 초점을 돌린다
  }, []);
  useEscapeClose(closeMenu, !!menu && !menu.sub);
  useEscapeClose(() => setMenu((m) => (m ? { ...m, sub: false } : m)), !!menu?.sub);
  useEscapeClose(() => setRenaming(null), !!renaming);
  useEscapeClose(() => setConfirm(null), !!confirm);
  useOutsideMouseDown(menuRef, closeMenu, !!menu);

  const byId = new Map((conversations ?? []).map((c) => [c.id, c]));
  const target = menu ? byId.get(menu.id) : undefined;
  const busyRow = (id: string) => locked && id === currentId; // 보내는 중·도는 대화는 바꾸지 않는다
  const openMenuAt = (id: string, row: DOMRect | null, point?: { x: number; y: number }) => {
    const nav = navRef.current?.getBoundingClientRect();
    if (!nav) return;
    setNote(null);
    const left = point ? point.x - nav.left : (row ? row.right - nav.left - 232 : 8);
    const top = point ? point.y - nav.top : (row ? row.bottom - nav.top + 2 : 8);
    setMenu({ id, left: Math.max(8, Math.min(left, nav.width - 240)), top: Math.max(8, top), sub: false });
  };
  useLayoutEffect(() => { // 아래로 넘치면 위로 올린다
    const el = menuRef.current, nav = navRef.current;
    if (!el || !nav || !menu) return;
    const over = el.offsetTop + el.offsetHeight - (nav.clientHeight - 8);
    if (over > 0) el.style.top = `${Math.max(8, el.offsetTop - over)}px`;
  }, [menu]);

  const act = async (kind: RowAct | "window", c: AgentConversationSummary) => {
    setMenu(null);
    if (kind === "window") return onOpenInWindow?.(c.id);
    if (busyRow(c.id)) return;
    if (kind === "pin") return void onPatch(c.id, { pinned: !c.pinned });
    if (kind === "unread") return void onPatch(c.id, { unread: !c.unread });
    if (kind === "archive") return void onPatch(c.id, { archived: !c.archived });
    if (kind === "rename") return setRenaming({ id: c.id, text: c.title ?? "" });
    setConfirm(c);
  };
  // 메뉴가 열린 동안 글자 단축키 — 자판과 무관하게 event.code, 입력·조합·수정키·반복은 무시, 누를 때 잠금을 다시 본다(설계 2-1)
  const keyAct = useRef({ act, target });
  keyAct.current = { act, target };
  const keysOn = !!menu && !menu.sub && !!target;
  useEffect(() => {
    if (!keysOn) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.repeat || e.isComposing || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const kind = ROW_KEYS[e.code];
      const { act: run, target: row } = keyAct.current;
      if (!kind || !row) return;
      e.preventDefault();
      void run(kind, row);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keysOn]);

  const saveRename = async () => {
    if (!renaming) return;
    const text = renaming.text.trim();
    if (text.length < 1 || text.length > 80) return; // 허브도 같은 규칙(1~80자)
    const id = renaming.id;
    if (await onPatch(id, { title: text })) setRenaming(null);
  };
  const doDelete = async () => {
    const c = confirm;
    if (!c) return;
    setConfirm(null);
    const result = await onDelete(c.id);
    if (result) setNote(t(SESSION_FILE_NOTE[result]));
  };

  // 프로젝트로 옮기기 후보 — 지금 화면 프로젝트 · 서랍에 이름이 보이는 프로젝트(id 별) · 없음. 이름 모르는 것은 고를 수 없다
  const candidates: { id: string; name: string }[] = [];
  for (const id of [currentProject, ...(conversations ?? []).map((c) => c.project)]) {
    const name = id ? projectName?.(id) : undefined;
    if (id && name && !candidates.some((p) => p.id === id)) candidates.push({ id, name });
  }

  const noProject = t("프로젝트 없음");
  // 고정됨 → 프로젝트 묶음(최근 순, '프로젝트 없음'은 뒤) → 보관함. 이름을 모르는 프로젝트(지금 공간 밖)는 한 묶음으로
  const pinned = (conversations ?? []).filter((c) => c.pinned && !c.archived);
  const archived = (conversations ?? []).filter((c) => c.archived);
  const groups: { key: string; label: string; items: AgentConversationSummary[] }[] = [];
  if (pinned.length) groups.push({ key: PIN_GROUP, label: t("고정됨"), items: pinned });
  const byProject: typeof groups = [];
  for (const c of conversations ?? []) {
    if (c.pinned || c.archived) continue;
    const label = c.project ? projectName?.(c.project) ?? t("다른 공간 프로젝트") : noProject;
    const group = byProject.find((g) => g.label === label);
    if (group) group.items.push(c);
    else byProject.push({ key: `p:${label}`, label, items: [c] });
  }
  byProject.sort((a, b) => Number(a.label === noProject) - Number(b.label === noProject));
  groups.push(...byProject);
  if (archived.length) groups.push({ key: ARCHIVE_GROUP, label: `${t("보관함")} ${archived.length}`, items: archived });
  const fold = (key: string) => setFolded((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  return (
    <>
      <div className="agent-drawer-dim" onMouseDown={onClose} aria-hidden="true" />
      <nav className="agent-drawer" aria-label={t("대화 목록")} ref={navRef} style={{ width: shown }}>
        <button type="button" className="agent-drawer-new" onClick={onNew} disabled={locked}>
          <NewChatIcon /><span>{t("새 대화")}</span>
        </button>
        <div className="agent-drawer-list">
          {conversations === null ? (
            <p className="agent-menu-note">{t("불러오는 중")}</p>
          ) : groups.length === 0 ? (
            <p className="agent-menu-note">{t("지난 대화가 없어요")}</p>
          ) : groups.map((g) => (
            <div key={g.key} className={`agent-drawer-group${g.key === ARCHIVE_GROUP ? " archive" : ""}`}>
              <button type="button" className="agent-drawer-ghead" aria-expanded={!folded.has(g.key)} onClick={() => fold(g.key)}>
                {g.key === ARCHIVE_GROUP && <ArchiveIcon />}<span>{g.label}</span><Chevron />
              </button>
              {!folded.has(g.key) && (
                <div className="agent-drawer-items">
                  {g.items.map((c) => (renaming?.id === c.id ? (
                    <div key={c.id} className="agent-drawer-row on">
                      <input className="agent-drawer-rename" autoFocus value={renaming.text} maxLength={80} aria-label={t("새 이름")}
                        onChange={(e) => setRenaming({ id: c.id, text: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void saveRename(); }
                        }}
                        onBlur={() => setRenaming(null)} />
                    </div>
                  ) : (
                    <div key={c.id} className={`agent-drawer-row${c.id === currentId ? " on" : ""}${menu?.id === c.id ? " menu" : ""}`}
                      onContextMenu={(e) => { e.preventDefault(); openMenuAt(c.id, null, { x: e.clientX, y: e.clientY }); }}>
                      <button type="button" className={`agent-drawer-item${c.id === currentId ? " on" : ""}`}
                        disabled={locked} onClick={() => (c.id === currentId ? onClose() : onOpen(c.id))}>
                        {c.pinned && !c.archived && <PinIcon />}
                        <span>{c.title || t("제목 없음")}</span>
                        {!c.resumable && <small>{t("이어 가기 불가")}</small>}
                        {running && c.id === currentId ? <i className="agent-drawer-dot" title={t("일하는 중")} />
                          : c.unread && <i className="agent-drawer-unread" title={t("읽지 않음")} />}
                      </button>
                      <button type="button" className="agent-drawer-more" data-more={c.id} aria-haspopup="menu" aria-expanded={menu?.id === c.id}
                        title={t("대화 메뉴")} aria-label={t("대화 메뉴")}
                        onClick={(e) => (menu?.id === c.id ? closeMenu() : openMenuAt(c.id, e.currentTarget.parentElement!.getBoundingClientRect()))}>
                        <DotsIcon />
                      </button>
                    </div>
                  )))}
                </div>
              )}
            </div>
          ))}
          {truncated && <p className="agent-menu-note">{t("최근 500개만 보여요")}</p>}
        </div>
        {note && <p className="agent-drawer-note" role="status">{note}</p>}

        {menu && target && (
          <div className={`agent-row-menu${menu.sub && menu.side === "below" ? " stacked" : ""}`} role="menu" aria-label={t("대화 메뉴")} ref={menuRef}
            style={{ top: menu.top, left: menu.left }}>
            {onOpenInWindow && (
              <>
                <button type="button" role="menuitem" className="agent-row-mi" onClick={() => void act("window", target)}>
                  <WindowIcon /><span>{t("새 창에서 열기")}</span>
                </button>
                <div className="agent-menu-sep" />
              </>
            )}
            <button type="button" role="menuitem" className="agent-row-mi" disabled={busyRow(target.id)} onClick={() => void act("pin", target)}>
              <PinIcon /><span>{t(target.pinned ? "고정 풀기" : "고정")}</span><kbd>P</kbd>
            </button>
            <button type="button" role="menuitem" className="agent-row-mi" disabled={busyRow(target.id)} onClick={() => void act("unread", target)}>
              <UnreadIcon /><span>{t(target.unread ? "읽음으로 표시" : "읽지 않음으로 표시")}</span><kbd>U</kbd>
            </button>
            <button type="button" role="menuitem" className="agent-row-mi" disabled={busyRow(target.id)} onClick={() => void act("rename", target)}>
              <PenIcon /><span>{t("이름 바꾸기")}</span><kbd>R</kbd>
            </button>
            <div className="agent-menu-sep" />
            <div className="agent-row-sub-wrap">
              <button type="button" role="menuitem" className={`agent-row-mi${menu.sub ? " on" : ""}`} aria-haspopup="menu" aria-expanded={menu.sub}
                disabled={busyRow(target.id)} onClick={() => {
                  // 칸(새 창이면 창) 안에서 오른쪽에 하위 메뉴 자리가 없으면 왼쪽, 그래도 없으면 메뉴 안 아래로
                  const nav = navRef.current;
                  const room = nav?.parentElement?.clientWidth || window.innerWidth;
                  const right = (nav?.offsetLeft ?? 0) + menu.left + ROW_MENU_W;
                  const side = right + ROW_MENU_W <= room ? "right" : (nav?.offsetLeft ?? 0) + menu.left >= ROW_MENU_W ? "left" : "below";
                  setMenu({ ...menu, sub: !menu.sub, side });
                }}>
                <FolderIcon /><span>{t("프로젝트로 옮기기")}</span><Chevron />
              </button>
              {menu.sub && (
                <div className={`agent-row-sub ${menu.side ?? "right"}`} role="menu" aria-label={t("프로젝트로 옮기기")}>
                  {candidates.map((p) => (
                    <button key={p.id} type="button" role="menuitemradio" aria-checked={target.project === p.id} className="agent-row-mi"
                      onClick={() => { setMenu(null); void onPatch(target.id, { project: p.id }); }}>
                      <span>{p.id === currentProject ? `${p.name} · ${t("지금 화면")}` : p.name}</span>
                      {target.project === p.id && <i className="agent-row-check" aria-hidden="true">✓</i>}
                    </button>
                  ))}
                  <button type="button" role="menuitemradio" aria-checked={!target.project} className="agent-row-mi"
                    onClick={() => { setMenu(null); void onPatch(target.id, { project: null }); }}>
                    <span>{noProject}</span>{!target.project && <i className="agent-row-check" aria-hidden="true">✓</i>}
                  </button>
                </div>
              )}
            </div>
            <div className="agent-menu-sep" />
            <button type="button" role="menuitem" className="agent-row-mi" disabled={busyRow(target.id)} onClick={() => void act("archive", target)}>
              <ArchiveIcon /><span>{t(target.archived ? "보관 풀기" : "보관")}</span><kbd>A</kbd>
            </button>
            <button type="button" role="menuitem" className="agent-row-mi danger" disabled={busyRow(target.id)} onClick={() => void act("delete", target)}>
              <TrashIcon /><span>{t("삭제")}</span><kbd>D</kbd>
            </button>
          </div>
        )}

        {confirm && (
          <div className="agent-drawer-confirm" role="dialog" aria-modal="true" aria-label={t("이 대화를 지울까요?")}>
            <h4>{t("이 대화를 지울까요?")}</h4>
            <p className="agent-confirm-title">「{confirm.title || t("제목 없음")}」</p>
            <p>{t("칸 기록과 이 대화의 Claude 기억(세션 파일)이 함께 지워지고 되돌릴 수 없어요. 만든 그림은 라이브러리에 그대로 남아요.")}</p>
            {confirm.engine === "codex" && <p>{t("Codex 대화는 Codex 기록이 Codex 폴더에 남아요.")}</p>}
            <div className="agent-confirm-acts">
              <button type="button" className="agent-confirm-btn" onClick={() => setConfirm(null)}>{t("취소")}</button>
              <button type="button" className="agent-confirm-btn danger" autoFocus onClick={() => void doDelete()}>{t("삭제")}</button>
            </div>
          </div>
        )}

        <div className="agent-drawer-resize" role="separator" tabIndex={0} aria-orientation="vertical"
          aria-label={t("대화 목록 너비 조절")} aria-valuemin={Math.min(DRAWER_MIN_W, panelW - 40)} aria-valuemax={panelW - 40} aria-valuenow={shown}
          title={t("드래그하여 너비 조절 · 더블클릭하여 기본 너비로 복원")}
          onPointerDown={(e) => {
            if (e.button !== 0 || !e.isPrimary || drag.current) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { id: e.pointerId, x: e.clientX, from: shown };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d || d.id !== e.pointerId) return;
            setWidth(clampDrawer(d.from + (e.clientX - d.x), panelW)); // 서랍은 왼쪽에 있어 오른쪽으로 끌면 넓어진다
          }}
          onPointerUp={(e) => {
            const d = drag.current;
            if (!d || d.id !== e.pointerId) return;
            drag.current = null;
            commitWidth(d.from + (e.clientX - d.x));
          }}
          onPointerCancel={() => { drag.current = null; }}
          onDoubleClick={() => commitWidth(DRAWER_BASE_W)}
          onKeyDown={(e) => {
            const step = e.key === "ArrowRight" ? 8 : e.key === "ArrowLeft" ? -8 : 0;
            if (!step) return;
            e.preventDefault();
            commitWidth(shown + step);
          }}
        />
        <div className="agent-drawer-foot">
          <span className="agent-drawer-plan">
            <span className="agent-co" aria-hidden="true">✳</span>
            {claude?.available ? <>Claude{claude.subscription && <small> · {claude.subscription}</small>}</> : t("Claude 연결 안 됨")}
          </span>
          {/* 지금 쓰는 판(v2.1.296) — 업데이트하면 올라간다. 새 판이 있으면 라임 글자 + 알림(Jay 11-10 "새 판 대신 앞에 v만").
              [업데이트] 단추는 docs/status/MVAgent_ClaudeCode업데이트_2026-11-10.md 설계·검토 뒤 이 자리에 */}
          {version?.current && (
            <span className={`agent-drawer-ver${version.newer ? " new" : ""}`}
              title={version.newer && version.latest ? `v${version.latest} ${t("이 나왔어요")}` : t("Claude Code 판")}>
              v{version.current}
            </span>
          )}
        </div>
      </nav>
    </>
  );
}

/** [모델 ⌄] 한 메뉴(Aside 모델 메뉴처럼) — 모델 찾기 · 회사별 모델(못 쓰는 회사는 머리에 까닭, 고를 수 없음) ·
 *  생각 깊이 · 속도(Opus 만 빠름 — Claude 추가 사용 크레딧). 하나 고르면 닫힌다. 다른 회사 모델을 고르면 새 대화(useAgentChat). */
function ModelMenu({ engines, choice, onChoose }: {
  engines: AgentEngine[];
  choice: AgentChoice;
  onChoose: (next: AgentChoice) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const current = engines.find((e) => e.id === choice.engine);
  const effortFor = (e: AgentEngine) => e.efforts.includes(choice.effort) ? choice.effort : e.efforts.includes("medium") ? "medium" : e.efforts[0] ?? "medium";
  const groups = engines.map((e) => ({ e, models: e.models.filter((m) => !q || `${GROUP[e.id] ?? e.id} ${m.label}`.toLowerCase().includes(q)) }))
    .filter((g) => g.models.length > 0);
  const fastShown = choice.engine === "claude" && choice.model === FAST_MODEL;
  const check = <span className="agent-model-check" aria-hidden="true">✓</span>;
  return (
    <div className="agent-menu agent-model-menu" role="dialog" aria-label={t("모델 고르기")}>
      <input className="agent-model-search" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus
        placeholder={t("모델 찾기")} aria-label={t("모델 찾기")} />
      {groups.length === 0 && <p className="agent-menu-note">{t("맞는 모델이 없어요")}</p>}
      {groups.map(({ e, models }) => (
        <div key={e.id} className="agent-model-group" role="group" aria-label={GROUP[e.id] ?? e.id}>
          <div className="agent-model-group-head">
            {GROUP[e.id] ?? e.id}
            {!e.available && <span className="agent-model-reason">{e.reason || t("쓸 수 없음")}</span>}
          </div>
          {models.map((m) => {
            const on = choice.engine === e.id && choice.model === m.id;
            return (
              <button key={m.id} type="button" className={`agent-model-item${on ? " on" : ""}`} disabled={!e.available} aria-pressed={on}
                onClick={() => onChoose(e.id === choice.engine ? { ...choice, model: m.id } : { engine: e.id, model: m.id, effort: effortFor(e), fast: false })}>
                <span className="agent-model-ic" aria-hidden="true">{e.id === "codex" ? "◎" : "✳"}</span>
                <span className="agent-model-name">{m.label}</span>
                {on && check}
              </button>
            );
          })}
        </div>
      ))}
      {current && (
        <>
          <div className="agent-menu-sep" />
          <div className="agent-model-group-head">{t("생각 깊이")}</div>
          <div role="radiogroup" aria-label={t("생각 깊이")}>
            {current.efforts.map((level) => (
              <button key={level} type="button" role="radio" aria-checked={choice.effort === level}
                className={`agent-model-item${choice.effort === level ? " on" : ""}`} onClick={() => onChoose({ ...choice, effort: level })}>
                <span className="agent-model-name">{t(EFFORT[level] ?? level)}</span>
                {choice.effort === level && check}
              </button>
            ))}
          </div>
        </>
      )}
      {fastShown && (
        <>
          <div className="agent-menu-sep" />
          <div className="agent-model-group-head">{t("속도")}</div>
          <div role="radiogroup" aria-label={t("속도")}>
            {[false, true].map((fast) => (
              <button key={String(fast)} type="button" role="radio" aria-checked={!!choice.fast === fast}
                className={`agent-model-item${!!choice.fast === fast ? " on" : ""}`} onClick={() => onChoose({ ...choice, fast })}>
                <span className="agent-model-name">{fast ? t("빠름") : t("기본")}</span>
                {!!choice.fast === fast && check}
              </button>
            ))}
          </div>
          <p className="agent-menu-note">{t("빠름은 Claude 추가 사용 크레딧이 들어요 · 칸을 열 때마다 꺼짐")}</p>
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

// 서랍 행 메뉴 아이콘(16px 칸에 14px 선) — 시안 drawer-menu.png
function MenuGlyph({ children }: { children: ReactNode }) {
  return (
    <svg className="agent-row-ic" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={1.3}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
  );
}
function DotsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.4" fill="currentColor" /><circle cx="8" cy="8" r="1.4" fill="currentColor" /><circle cx="12.5" cy="8" r="1.4" fill="currentColor" />
    </svg>
  );
}
function WindowIcon() { return <MenuGlyph><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M2 6h12" /></MenuGlyph>; }
function PinIcon() { return <MenuGlyph><path d="M9.5 2.5l4 4-2 1-2.5 2.5.3 2.5-1.3 1.3-2.4-2.4L2.5 14.5M4.6 7.6l2.3-2.3 1-2" /></MenuGlyph>; }
function UnreadIcon() { return <MenuGlyph><circle cx="8" cy="8" r="5.2" /><circle cx="8" cy="8" r="2" fill="currentColor" /></MenuGlyph>; }
function PenIcon() { return <MenuGlyph><path d="M11 2.5a1.4 1.4 0 0 1 2 2L5.3 12.2 2.5 13l.8-2.8Z" /></MenuGlyph>; }
function FolderIcon() { return <MenuGlyph><path d="M2 4.5c0-.8.6-1.5 1.5-1.5h3l1.5 1.6h4.5c.8 0 1.5.6 1.5 1.5v5.4c0 .8-.7 1.5-1.5 1.5h-9C2.6 13 2 12.3 2 11.5z" /></MenuGlyph>; }
function ArchiveIcon() { return <MenuGlyph><rect x="2" y="3" width="12" height="3" rx="1" /><path d="M3 6v6c0 .6.4 1 1 1h8c.6 0 1-.4 1-1V6M6.5 8.5h3" /></MenuGlyph>; }
function TrashIcon() { return <MenuGlyph><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2c0 .5.5.8 1 .8h3.8c.5 0 .9-.3 1-.8l.6-8.2" /></MenuGlyph>; }

/** 옆 칸 닫기(새 창에서는 옆 칸으로 붙이기) — 오른쪽 칸이 채워진 창(Jay 11-10 시안 — 이미지의 사이드바 단추를 오른쪽 칸으로) */
function SidePanelIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.7}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M14.5 4.5h3.5a2.5 2.5 0 0 1 2.5 2.5v10a2.5 2.5 0 0 1-2.5 2.5h-3.5Z" fill="currentColor" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={1.9}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={1.9}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>
  );
}

/** ≡ 대화 목록 — 왼쪽 맞춘 세 줄 */
function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.7}
      strokeLinecap="round" aria-hidden="true">
      <path d="M4 6.5h16M4 12h11M4 17.5h7" />
    </svg>
  );
}

/** 새 창으로 띄우기 — 겹친 두 창(Jay 11-10 시안 ②) */
function PopOutIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.7}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="8.5" y="3.5" width="12" height="10" rx="2" />
      <path d="M15.5 17v1.5a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V12a2 2 0 0 1 2-2H7" />
    </svg>
  );
}
