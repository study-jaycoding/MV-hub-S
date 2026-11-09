// MV Agent 옆 칸의 상태(docs/status/AskAgent_옆칸_설계_2026-11-09.md 3-5·10절 · 첫 연결 AskAgent_첫연결_설계_2026-11-09.md 5·9·13절).
//  · 칸 닫기 ≠ 취소 — 닫으면(언마운트) 긴 기다림만 끊고 차례는 허브에서 계속 돈다. 다시 열면 마지막 대화를 읽고 마지막 사건 순번 뒤부터 다시 붙는다.
//  · 계정이 바뀌면 그 전에 시작한 요청의 늦은 답을 버린다(요청을 시작할 때의 계정 범위와 비교 + 대화를 바꿀 때마다 올리는 차례 번호).
//  · 엔진을 바꾸면 새 대화(CLI 세션은 엔진마다 따로다).
import { useCallback, useEffect, useRef, useState } from "react";
import { getAccountNamespace } from "./accountScope";
import {
  AccountChangedError,
  ACCOUNT_CHANGED_MESSAGE,
  agentChatApi,
  CLAUDE_CHAT_OK,
  ClaudeLoginError,
  type AgentContext,
  type AgentConversationSummary,
  type AgentEngine,
  type AgentEngineId,
  type AgentEvent,
  type AgentPlan,
  type AgentSession,
  type AgentTurnStatus,
  type ClaudeStatus,
} from "./agentChatApi";
import { AGENT_CHAT_CONNECT_FEATURE, hubHasFeature } from "./hubFeatures";
import { errorDetail, isHttpStatus } from "./http";
import { loadJSON, saveJSON } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";

export type AgentMessage =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; open: boolean } // open = 아직 조각을 받는 덩어리
  | { kind: "tool"; id: string; name: string; status: "started" | "done" | "failed" }
  | { kind: "plan"; id: string; plan: AgentPlan; exec?: { state: "running" | "done" | "failed"; message?: string };
      estimate?: { credits: number | null } } // 없으면 견적 확인 중 · credits null = 확인하지 못함
  | { kind: "error"; id: string; message: string }
  | { kind: "notice"; id: string; text: string };

export interface AgentChoice {
  engine: AgentEngineId;
  model: string;
  effort: string;
  fast?: boolean; // 빠른 모드 — Opus 만 · 기억하지 않는다(대화마다 기본 꺼짐) · Claude 추가 사용 크레딧
}

export const TERMINAL_TURN = new Set<AgentTurnStatus>(["cancelled", "done", "failed", "interrupted"]);

/** 사건 하나를 대화에 반영한다(순수). text_delta 는 열린 글 덩어리에 붙이고, text 는 그 덩어리를 최종본으로 바꾸고 닫는다(다음 조각은 새 덩어리). */
export function applyAgentEvent(messages: AgentMessage[], event: AgentEvent, turnId: string): AgentMessage[] {
  const id = `${turnId}:${event.seq}`;
  const last = messages[messages.length - 1];
  const open = last?.kind === "assistant" && last.open ? last : null;
  const head = open ? messages.slice(0, -1) : messages;
  switch (event.kind) {
    case "text_delta":
      return [...head, open ? { ...open, text: open.text + event.text } : { kind: "assistant", id, text: event.text, open: true }];
    case "text":
      return [...head, open ? { ...open, text: event.text, open: false } : { kind: "assistant", id, text: event.text, open: false }];
    case "tool": {
      if (event.status !== "started") {
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const m = messages[i];
          if (m.kind === "tool" && m.name === event.name && m.status === "started") {
            return messages.map((item, at) => (at === i ? { ...m, status: event.status } : item));
          }
        }
      }
      return [...messages, { kind: "tool", id, name: event.name, status: event.status }];
    }
    case "plan": {
      const at = messages.findIndex((m) => m.kind === "plan" && m.plan.plan_id === event.plan.plan_id);
      if (at >= 0) return messages.map((m, i) => (i === at && m.kind === "plan" ? { ...m, plan: event.plan } : m));
      return [...messages, { kind: "plan", id, plan: event.plan }];
    }
    case "state":
      return event.reason ? [...messages, { kind: "error", id, message: event.reason }] : messages;
    case "error":
      return [...messages, { kind: "error", id, message: event.message }];
    case "notice":
      return [...messages, { kind: "notice", id, text: event.text }];
    default:
      return messages; // 모르는 사건은 넘긴다
  }
}

function pickChoice(engines: AgentEngine[], saved: AgentChoice | null): AgentChoice | null {
  const usable = (e?: AgentEngine) => !!e?.available && e.models.length > 0;
  const preferred = engines.find((e) => e.id === saved?.engine);
  const engine = usable(preferred) ? preferred! : engines.find(usable);
  if (!engine) return null;
  const model = engine.models.find((m) => m.id === saved?.model)?.id ?? engine.models[0].id;
  const effort = saved && engine.efforts.includes(saved.effort) ? saved.effort
    : engine.efforts.includes("medium") ? "medium" : engine.efforts[0] ?? "medium";
  return { engine: engine.id, model, effort, fast: false };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const remembered = (): string | null => {
  const saved = loadJSON<{ account?: string; id?: string }>(STORAGE_KEYS.agentPanelConversation);
  return saved?.account === getAccountNamespace() && saved.id ? saved.id : null;
};
const remember = (id: string | null) => saveJSON(STORAGE_KEYS.agentPanelConversation, id ? { account: getAccountNamespace(), id } : null);

// 받아들였는지 모르는 채 실패한 마지막 보내기. 계정·대화·모델·글·화면 정보가 모두 같은 요청을 다시 보내면 같은 열쇠 —
//  허브가 이미 받은 차례면 그 차례를, 못 받았으면 새로 시작한다(어느 쪽이든 두 번 돌지 않는다). 칸을 닫았다 열어도 남는다(모듈 변수).
//  shortcut: 페이지를 새로 고치면 사라진다 — 새로 고침 뒤 복구가 필요해지면 sessionStorage 로 옮긴다
let pendingSend: { account: string; sig: string; key: string } | null = null;

export function useAgentChat(context: AgentContext) {
  const [session, setSession] = useState<AgentSession | null>(null);
  const [choice, setChoice] = useState<AgentChoice | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [turn, setTurn] = useState<{ id: string; status: AgentTurnStatus } | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<AgentConversationSummary[] | null>(null);

  const contextRef = useRef(context);
  contextRef.current = context;
  const epoch = useRef(0); // 새 대화·대화 바꿈·닫힘마다 올린다 — 그 전에 시작한 요청의 답은 버린다
  const poll = useRef<AbortController | null>(null);
  const busy = useRef(false); // 보내는 중·차례 진행 중 — 두 번 보내기 막음(상태보다 먼저 바뀐다)
  const executing = useRef(new Set<string>());
  const estimating = useRef(new Set<string>());

  // 지금 시작하는 요청의 표 — 답이 왔을 때 대화가 바뀌었거나 계정이 바뀌었으면 stale() 이 참
  const ticket = () => {
    const at = epoch.current, account = getAccountNamespace();
    return () => at !== epoch.current || account !== getAccountNamespace();
  };

  const drop = useCallback(() => {
    epoch.current += 1;
    poll.current?.abort();
    poll.current = null;
    busy.current = false;
    executing.current.clear();
    estimating.current.clear();
    setConversationId(null);
    setTitle(null);
    setMessages([]);
    setTurn(null);
    setSending(false);
  }, []);

  const fail = useCallback((e: unknown) => {
    if (e instanceof AccountChangedError) {
      drop();
      remember(null);
      setError(ACCOUNT_CHANGED_MESSAGE);
      return;
    }
    setError(errorDetail(e));
  }, [drop]);

  // 차례의 사건을 끝날 때까지 받는다. 답이 없으면(망·허브 재시작) 2초 뒤 다시, 세 번 연달아 안 되면 멈추고 알린다.
  const follow = useCallback(async (turnId: string, after: number) => {
    poll.current?.abort();
    const controller = new AbortController();
    poll.current = controller;
    busy.current = true;
    const stale = ticket();
    let seq = after;
    let failures = 0;
    while (!controller.signal.aborted) {
      try {
        const r = await agentChatApi.events(turnId, seq, controller.signal);
        if (controller.signal.aborted || stale()) return;
        failures = 0;
        if (r.events.length) setMessages((m) => r.events.reduce((acc, ev) => applyAgentEvent(acc, ev, turnId), m));
        seq = Math.max(seq, r.last_seq);
        setTurn({ id: turnId, status: r.status });
        if (TERMINAL_TURN.has(r.status) && !r.more) break; // 끝났어도 남은 사건(계획 카드 등)은 마저 받는다
      } catch (e) {
        if (controller.signal.aborted || stale()) return;
        failures += 1;
        const clientError = e instanceof AccountChangedError || isHttpStatus(e, 400, 401, 403, 404, 409);
        if (clientError || failures >= 3) {
          fail(e);
          break;
        }
        await sleep(2000);
      }
    }
    if (poll.current === controller) poll.current = null;
    busy.current = false;
  }, [fail]);

  const openConversation = useCallback(async (id: string) => {
    if (busy.current) return; // 보내는 중·진행 중엔 대화를 바꾸지 않는다 — 허브에서 시작한 차례를 놓치지 않게
    drop();
    setError(null);
    // 불러오는 동안 보내기·전환을 막는다 — 늦게 온 지난 대화가 그사이 보낸 새 차례를 덮지 않게(리뷰 2차)
    busy.current = true;
    setSending(true);
    const stale = ticket();
    try {
      const r = await agentChatApi.conversation(id);
      if (stale()) return;
      let rebuilt: AgentMessage[] = [];
      for (const t of r.turns) {
        rebuilt = [...rebuilt, { kind: "user", id: `${t.id}:user`, text: t.text }];
        rebuilt = t.events.reduce((acc, ev) => applyAgentEvent(acc, ev, t.id), rebuilt);
      }
      setMessages(rebuilt);
      setConversationId(id);
      setTitle(r.conversation.title);
      setChoice({ engine: r.conversation.engine, model: r.conversation.model, effort: r.conversation.effort });
      remember(id);
      const last = r.turns[r.turns.length - 1];
      if (last && !TERMINAL_TURN.has(last.status)) {
        setTurn({ id: last.id, status: last.status });
        void follow(last.id, last.events.length ? last.events[last.events.length - 1].seq : 0);
      }
    } catch (e) {
      if (stale()) return;
      if (isHttpStatus(e, 403, 404)) remember(null); // 지워졌거나 다른 신원의 대화 — 새 대화로 둔다
      fail(e);
    } finally {
      if (!stale()) {
        setSending(false);
        if (!poll.current) busy.current = false; // 진행 중 차례를 이어 받았으면 follow 가 끝날 때 푼다
      }
    }
  }, [drop, fail, follow]);

  // 칸을 열 때: 새 표·엔진 목록 → 지난 모델 고르기 → 마지막 대화가 있으면 이어 붙기. 닫을 때: 긴 기다림만 끊는다(취소하지 않는다).
  // ── Claude 연결(첫 연결 설계 5·9절) — 허브 상태를 보고, 로그인 창이 열린 동안 2초마다 다시 본다(10분까지) ──
  const connectSupported = hubHasFeature(AGENT_CHAT_CONNECT_FEATURE);
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [loginNote, setLoginNote] = useState<"terminal" | "expired" | "unfinished" | null>(null);
  const [connected, setConnected] = useState<{ subscription: string | null } | null>(null); // 막 연결됐다는 띠(한 번)
  const claudeTimer = useRef<number | null>(null);
  const lastClaudeState = useRef<string | null>(null);
  const claudeSeq = useRef(0); // 가장 나중에 보낸 확인만 반영 — 늦게 온 옛 답이 '연결됨'을 덮지 않게
  const claudeInFlight = useRef(false); // 2초 확인은 앞 확인이 끝나야 다음을 보낸다
  const mounted = useRef(true); // 닫힌 칸엔 답·타이머가 쓰지 않는다

  const stopWaiting = useCallback(() => {
    if (claudeTimer.current !== null) window.clearInterval(claudeTimer.current);
    claudeTimer.current = null;
    setWaiting(false);
  }, []);

  /** 캐시 없이 Claude 상태를 다시 본다 — 엔진 목록·모델 선택도 같이 바꾼다(입력칸이 잠긴 채 남지 않게). */
  const recheck = useCallback(async (): Promise<ClaudeStatus | null> => {
    const account = getAccountNamespace();
    const seq = ++claudeSeq.current;
    const current = () => mounted.current && seq === claudeSeq.current && account === getAccountNamespace();
    claudeInFlight.current = true;
    try {
      const status = await agentChatApi.claudeStatus();
      if (!current()) return null;
      const before = lastClaudeState.current;
      lastClaudeState.current = status.state;
      if (before && !CLAUDE_CHAT_OK.has(before) && CLAUDE_CHAT_OK.has(status.state)) setConnected({ subscription: status.subscription });
      setClaude(status);
      setSession((s) => (s ? { ...s, engines: status.engines } : s));
      setChoice((c) => c ?? pickChoice(status.engines, loadJSON<AgentChoice>(STORAGE_KEYS.agentPanelModel)));
      return status;
    } catch (e) {
      if (current()) setError(errorDetail(e));
      return null;
    } finally {
      if (seq === claudeSeq.current) claudeInFlight.current = false;
    }
  }, []);

  const startWaiting = useCallback(() => {
    stopWaiting();
    setWaiting(true);
    const startedAt = Date.now();
    claudeTimer.current = window.setInterval(() => {
      if (Date.now() - startedAt > 10 * 60_000) {
        stopWaiting();
        setLoginNote("expired"); // 창은 그대로 — 마치면 [다시 확인]
        return;
      }
      if (claudeInFlight.current) return;
      void recheck().then((status) => {
        if (!status) return;
        if (CLAUDE_CHAT_OK.has(status.state)) stopWaiting();
        else if (!status.login_window) {
          stopWaiting();
          setLoginNote("unfinished"); // 창이 닫혔는데 연결이 안 됨
        }
      });
    }, 2000);
  }, [recheck, stopWaiting]);

  /** [Claude 연결] — 허브가 보이는 로그인 창을 연다(스위치가 꺼졌거나 열 수 없으면 터미널 안내로). */
  const connect = useCallback(async () => {
    setLoginNote(null);
    setError(null);
    try {
      await agentChatApi.openClaudeLogin();
      if (!mounted.current) return; // 그새 칸이 닫혔으면 타이머를 새로 걸지 않는다
      startWaiting();
      void recheck();
    } catch (e) {
      if (!mounted.current) return;
      if (e instanceof ClaudeLoginError && ["login_window_disabled", "breakaway_denied", "spawn_failed"].includes(e.code)) {
        setLoginNote("terminal");
      } else if (e instanceof ClaudeLoginError && e.code === "login_window_open") {
        startWaiting();
      } else {
        setError(errorDetail(e));
      }
    }
  }, [recheck, startWaiting]);

  useEffect(() => {
    mounted.current = true; // 개발 모드의 두 번 올리기에서도 다시 켠다
    const stale = ticket();
    agentChatApi.session().then((s) => {
      if (stale()) return;
      setSession(s);
      setChoice(pickChoice(s.engines, loadJSON<AgentChoice>(STORAGE_KEYS.agentPanelModel)));
      const claudeEngine = s.engines.find((e) => e.id === "claude");
      lastClaudeState.current = claudeEngine?.state ?? null;
      // Claude 를 못 쓰면 연결 안내에 필요한 지금 상태(스위치 포함)를 받는다 — 로그인 창이 열려 있으면 기다림부터
      if (connectSupported && claudeEngine && !claudeEngine.available) {
        void recheck().then((status) => { if (status?.state === "login_window") startWaiting(); });
      }
      const last = remembered();
      if (last) void openConversation(last);
    }).catch((e) => { if (!stale()) fail(e); });
    return () => {
      mounted.current = false;
      epoch.current += 1;
      poll.current?.abort();
      if (claudeTimer.current !== null) window.clearInterval(claudeTimer.current);
      claudeTimer.current = null;
    };
    // 칸을 열 때 한 번 — 계정이 바뀌면 App 이 칸을 새로 올린다(key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const newConversation = useCallback(() => {
    if (busy.current) return; // 보내는 중·진행 중엔 막는다(단추도 잠긴다)
    drop();
    remember(null);
    setError(null);
  }, [drop]);

  /** 모델·생각 깊이를 고른다. 엔진이 바뀌면 새 대화로 시작한다(보내는 중·진행 중엔 엔진을 바꾸지 않는다). */
  const choose = useCallback((next: AgentChoice) => {
    if (choice && next.engine !== choice.engine && busy.current) return;
    if (choice && next.engine !== choice.engine && (conversationId || messages.length)) newConversation();
    const fixed = { ...next, fast: next.engine === "claude" && next.model === "opus" ? !!next.fast : false };
    setChoice(fixed);
    // 빠른 모드는 기억하지 않는다(돈이 드니 칸을 열 때마다 꺼짐)
    saveJSON(STORAGE_KEYS.agentPanelModel, { engine: fixed.engine, model: fixed.model, effort: fixed.effort });
  }, [choice, conversationId, messages.length, newConversation]);

  /** 보낸다. 받아들였으면 true(입력칸을 비운다). 보내는 중·진행 중이면 아무것도 하지 않는다. */
  const send = useCallback(async (text: string): Promise<boolean> => {
    const body = text.trim();
    if (!body || !choice || busy.current) return false;
    busy.current = true;
    setSending(true);
    setError(null);
    const stale = ticket();
    const account = getAccountNamespace();
    const fast = !!choice.fast && choice.engine === "claude" && choice.model === "opus";
    // 같은 요청인가 = 계정·대화·모델·깊이·빠른 모드·글·화면 정보가 모두 같은가(허브는 같은 열쇠면 내용 비교 없이 그 차례를 돌려준다)
    const sig = JSON.stringify([conversationId, choice.engine, choice.model, choice.effort, fast, body, contextRef.current]);
    const key = pendingSend?.account === account && pendingSend.sig === sig ? pendingSend.key : crypto.randomUUID();
    pendingSend = { account, sig, key }; // 받아들인 답을 화면에 붙이면 지운다
    const rememberedAtSend = remembered();
    try {
      const r = await agentChatApi.startTurn({
        idempotency_key: key,
        ...(conversationId ? { conversation_id: conversationId } : {}),
        engine: choice.engine, model: choice.model, effort: choice.effort, fast,
        text: body, context: contextRef.current,
      });
      if (stale()) {
        // 칸을 닫는 등 화면이 바뀐 뒤 온 접수 답 — 허브는 받아들였다. 같은 계정이고 그사이 사람이 다른 대화를 고르지 않았으면
        // 다음에 열 때 그 대화로 붙게 남긴다(더 최근 선택을 덮지 않게). 열쇠 기록은 남겨 둔다(같은 요청 재전송 = 같은 차례)
        if (getAccountNamespace() === account && remembered() === rememberedAtSend) remember(r.conversation_id);
        return false;
      }
      if (pendingSend?.key === key) pendingSend = null; // 받아들인 답을 화면에 붙였다
      setMessages((m) => [...m, { kind: "user", id: `${r.turn_id}:user`, text: body }]);
      setConversationId(r.conversation_id);
      remember(r.conversation_id);
      setTurn({ id: r.turn_id, status: r.status });
      void follow(r.turn_id, 0);
      return true;
    } catch (e) {
      if (stale()) return false;
      busy.current = false;
      fail(e);
      return false;
    } finally {
      if (!stale()) setSending(false);
    }
  }, [choice, conversationId, fail, follow]);

  const cancel = useCallback(async () => {
    if (!turn || TERMINAL_TURN.has(turn.status)) return;
    const stale = ticket();
    try {
      const r = await agentChatApi.cancel(turn.id);
      if (!stale()) setTurn((cur) => (cur?.id === turn.id && !TERMINAL_TURN.has(cur.status) ? { id: turn.id, status: r.status } : cur));
    } catch (e) {
      if (!stale()) fail(e);
    }
  }, [turn, fail]);

  const setExec = (planId: string, exec: Extract<AgentMessage, { kind: "plan" }>["exec"], plan?: AgentPlan) =>
    setMessages((list) => list.map((m) => (m.kind === "plan" && m.plan.plan_id === planId ? { ...m, exec, plan: plan ?? m.plan } : m)));

  // 계획 카드가 새로 보이면 견적을 한 번 묻는다(무료 조회). 실패해도 카드·실행은 그대로 — '확인하지 못했어요'로 보인다.
  useEffect(() => {
    for (const m of messages) {
      if (m.kind !== "plan" || m.estimate || estimating.current.has(m.plan.plan_id)) continue;
      const planId = m.plan.plan_id;
      estimating.current.add(planId);
      const stale = ticket();
      const put = (credits: number | null) => {
        if (stale()) return;
        setMessages((list) => list.map((x) => (x.kind === "plan" && x.plan.plan_id === planId ? { ...x, estimate: { credits } } : x)));
      };
      agentChatApi.estimatePlan(planId).then((r) => put(typeof r.total_credits === "number" ? r.total_credits : null), () => put(null));
    }
    // ticket 은 매번 새로 만드는 표라 넣지 않는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  /** [실행] — 사람만 누른다. 허브의 앱 입구가 계획을 다시 읽어 확인한 뒤 낸다(두 번 눌러도 한 번만 나간다 — 허브의 선점). */
  const executePlan = useCallback(async (planId: string) => {
    if (executing.current.has(planId)) return;
    executing.current.add(planId);
    setExec(planId, { state: "running" });
    const stale = ticket();
    try {
      const plan = await agentChatApi.executePlan(planId);
      if (stale()) return;
      const merged = { ...plan, plan_id: plan.plan_id || planId };
      // 200 이어도 접수됐다는 뜻은 아니다 — submitted 만 '보냈어요', attention(거절·접수 불명확)은 따로 알린다
      if (plan.status === "submitted") setExec(planId, { state: "done" }, merged);
      else setExec(planId, { state: "failed", message: plan.status === "attention"
        ? "일부 항목을 접수하지 못했거나 접수 여부를 확인하지 못했어요 — 다시 누르지 말고 라이브러리에서 확인하세요"
        : `실행 상태를 확인하지 못했어요(${plan.status ?? "알 수 없음"}) — 라이브러리에서 확인하세요` }, merged);
    } catch (e) {
      if (stale()) return;
      executing.current.delete(planId);
      if (e instanceof AccountChangedError) fail(e);
      else setExec(planId, { state: "failed", message: errorDetail(e) });
    }
  }, [fail]);

  const loadConversations = useCallback(async () => {
    const stale = ticket();
    try {
      const r = await agentChatApi.conversations();
      if (!stale()) setConversations(r.conversations);
    } catch (e) {
      if (!stale()) fail(e);
    }
  }, [fail]);

  const running = !!turn && !TERMINAL_TURN.has(turn.status);
  const claudeEngine = session?.engines.find((e) => e.id === "claude");
  const claudeState = claude?.state ?? claudeEngine?.state ?? null;
  return {
    session, choice, choose, conversationId, title, messages, turn, running, sending, error,
    conversations, loadConversations, openConversation, newConversation, send, cancel, executePlan,
    // Claude 연결 — 허브가 연결 경로를 알 때만 안내(옛 허브는 엔진 사유만)
    connect: {
      supported: connectSupported && !!claudeEngine,
      state: claudeState,
      version: claude?.version ?? claudeEngine?.version ?? null,
      allowed: !!claudeEngine?.available,
      loginWindowEnabled: !!claude?.login_window_enabled,
      waiting, note: loginNote, connected,
      recheck, connect, stopWaiting, dismissConnected: () => setConnected(null),
    },
  };
}
