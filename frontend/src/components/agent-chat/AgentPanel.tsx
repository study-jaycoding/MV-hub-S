// MV Agent 옆 칸(기본 폭 520px — 시안 _shots/ask-agent-open-v2.png · 모델 칩 ask-agent-models.png). 머리(왼쪽 [≡ 대화 목록][옆 칸 닫기] · 제목 ·
//  오른쪽 [새 대화][새 창]) · 대화(또는 Claude 연결 안내) · 입력칸(지금 화면 · [모델 ⌄] [생각 깊이 ⌄] · 보내기). 칸을 닫아도 차례는 허브에서 계속 돈다.
//  옆에 붙은 동안 왼쪽 끝선을 끌어 폭을 바꾸고, ≡ 는 대화 서랍(프로젝트별·설정), [새 창]은 Assets 같은 별도 창(AgentWindow)으로 뺀다
//  (Jay 11-10 시안 A안·② — docs/status/MVAgent_서랍_새창_2026-11-10.md).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { AgentChoice, AgentMessage } from "../../lib/useAgentChat";
import { useAgentChat } from "../../lib/useAgentChat";
import { agentChatApi, type AgentContext, type AgentConversationSummary, type AgentEngine, type AgentEngineId } from "../../lib/agentChatApi";
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
  const chat = useAgentChat(screenOn ? context : NO_SCREEN);
  const [text, setText] = useState("");
  const [revising, setRevising] = useState<{ title: string } | null>(null); // [고치기] — 입력칸의 '고칠 계획' 칩
  const [menu, setMenu] = useState<"model" | "effort" | null>(null);
  const [drawer, setDrawer] = useState(false); // ≡ 대화 서랍
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const effortRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeDrawer = useCallback(() => setDrawer(false), []);
  useEscapeClose(closeMenu, menu !== null);
  useEscapeClose(closeDrawer, drawer && menu === null);
  useOutsideMouseDown(menu === "effort" ? effortRef : modelRef, closeMenu, menu !== null);

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
          locked={chat.running || chat.sending} projectName={projectName}
          onNew={startNew}
          onOpen={(id) => { setDrawer(false); setScreenOn(true); setRevising(null); void chat.openConversation(id); }}
          onClose={closeDrawer} claude={engines.find((e) => e.id === "claude")} />
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

/** ≡ 대화 서랍 — [새 대화] · 프로젝트별 대화(고른 것 회색 칸 · 일하는 중 라임 점) · 맨 아래 한 줄(Claude · 요금제 / Claude Code 판·새 판).
 *  보내는 중·일하는 중에는 고르기만 잠근다. 설정 칸(새 대화 모델·칸 위치)은 넣지 않는다(Jay 11-10).
 *  요금제 = 허브가 Claude Code 설정의 표시 이름(Ultra 등)을 같은 계정일 때만 싣는다(docs/status/MVAgent_서랍아래줄_2026-11-10.md). */
function AgentDrawer({ conversations, currentId, running, locked, projectName, onNew, onOpen, onClose, claude }: {
  conversations: AgentConversationSummary[] | null;
  currentId: string | null;
  running: boolean;
  locked: boolean;
  projectName?: (id: string) => string | undefined;
  onNew: () => void;
  onOpen: (id: string) => void;
  onClose: () => void;
  claude?: AgentEngine;
}) {
  const t = useT();
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [version, setVersion] = useState<{ current: string | null; latest: string | null; newer: boolean } | null>(null);
  useEffect(() => { // 서랍을 열 때 한 번 — 허브가 최신 판을 6시간 기억한다
    let live = true;
    agentChatApi.claudeVersion().then((v) => { if (live) setVersion(v); }, () => {});
    return () => { live = false; };
  }, []);
  const noProject = t("프로젝트 없음");
  // 목록은 최근 순 — 묶음도 가장 최근 대화가 있는 순, '프로젝트 없음'은 맨 아래. 이름을 모르는 프로젝트(지금 공간 밖)는 한 묶음으로
  const groups: { label: string; items: AgentConversationSummary[] }[] = [];
  for (const c of conversations ?? []) {
    const label = c.project ? projectName?.(c.project) ?? t("다른 공간 프로젝트") : noProject;
    const group = groups.find((g) => g.label === label);
    if (group) group.items.push(c);
    else groups.push({ label, items: [c] });
  }
  groups.sort((a, b) => Number(a.label === noProject) - Number(b.label === noProject));
  const fold = (label: string) => setFolded((prev) => {
    const next = new Set(prev);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    return next;
  });
  return (
    <>
      <div className="agent-drawer-dim" onMouseDown={onClose} aria-hidden="true" />
      <nav className="agent-drawer" aria-label={t("대화 목록")}>
        <button type="button" className="agent-drawer-new" onClick={onNew} disabled={locked}>
          <NewChatIcon /><span>{t("새 대화")}</span>
        </button>
        <div className="agent-drawer-list">
          {conversations === null ? (
            <p className="agent-menu-note">{t("불러오는 중")}</p>
          ) : groups.length === 0 ? (
            <p className="agent-menu-note">{t("지난 대화가 없어요")}</p>
          ) : groups.map((g) => (
            <div key={g.label} className="agent-drawer-group">
              <button type="button" className="agent-drawer-ghead" aria-expanded={!folded.has(g.label)} onClick={() => fold(g.label)}>
                <span>{g.label}</span><Chevron />
              </button>
              {!folded.has(g.label) && (
                <div className="agent-drawer-items">
                  {g.items.map((c) => (
                    <button key={c.id} type="button" className={`agent-drawer-item${c.id === currentId ? " on" : ""}`}
                      disabled={locked} onClick={() => (c.id === currentId ? onClose() : onOpen(c.id))}>
                      <span>{c.title || t("제목 없음")}</span>
                      {!c.resumable && <small>{t("이어 가기 불가")}</small>}
                      {running && c.id === currentId && <i className="agent-drawer-dot" title={t("일하는 중")} />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
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
