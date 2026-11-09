// Ask Agent 옆 칸의 상태(docs/status/AskAgent_옆칸_설계_2026-11-09.md 3-5·10절).
//  · 칸 닫기 ≠ 취소 — 닫으면(언마운트) 긴 기다림만 끊고 차례는 허브에서 계속 돈다. 다시 열면 마지막 대화를 읽고 마지막 사건 순번 뒤부터 다시 붙는다.
//  · 계정이 바뀌면 그 전에 시작한 요청의 늦은 답을 버린다(요청을 시작할 때의 계정 범위와 비교 + 대화를 바꿀 때마다 올리는 차례 번호).
//  · 엔진을 바꾸면 새 대화(CLI 세션은 엔진마다 따로다).
import { useCallback, useEffect, useRef, useState } from "react";
import { getAccountNamespace } from "./accountScope";
import {
  AccountChangedError,
  ACCOUNT_CHANGED_MESSAGE,
  agentChatApi,
  type AgentContext,
  type AgentConversationSummary,
  type AgentEngine,
  type AgentEngineId,
  type AgentEvent,
  type AgentPlan,
  type AgentSession,
  type AgentTurnStatus,
} from "./agentChatApi";
import { errorDetail, isHttpStatus } from "./http";
import { loadJSON, saveJSON } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";

export type AgentMessage =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; open: boolean } // open = 아직 조각을 받는 덩어리
  | { kind: "tool"; id: string; name: string; status: "started" | "done" | "failed" }
  | { kind: "plan"; id: string; plan: AgentPlan; exec?: { state: "running" | "done" | "failed"; message?: string } }
  | { kind: "error"; id: string; message: string };

export interface AgentChoice {
  engine: AgentEngineId;
  model: string;
  effort: string;
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
  return { engine: engine.id, model, effort };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const remembered = (): string | null => {
  const saved = loadJSON<{ account?: string; id?: string }>(STORAGE_KEYS.agentPanelConversation);
  return saved?.account === getAccountNamespace() && saved.id ? saved.id : null;
};
const remember = (id: string | null) => saveJSON(STORAGE_KEYS.agentPanelConversation, id ? { account: getAccountNamespace(), id } : null);

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
        if (TERMINAL_TURN.has(r.status)) break;
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
    drop();
    setError(null);
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
    }
  }, [drop, fail, follow]);

  // 칸을 열 때: 새 표·엔진 목록 → 지난 모델 고르기 → 마지막 대화가 있으면 이어 붙기. 닫을 때: 긴 기다림만 끊는다(취소하지 않는다).
  useEffect(() => {
    const stale = ticket();
    agentChatApi.session().then((s) => {
      if (stale()) return;
      setSession(s);
      setChoice(pickChoice(s.engines, loadJSON<AgentChoice>(STORAGE_KEYS.agentPanelModel)));
      const last = remembered();
      if (last) void openConversation(last);
    }).catch((e) => { if (!stale()) fail(e); });
    return () => {
      epoch.current += 1;
      poll.current?.abort();
    };
    // 칸을 열 때 한 번 — 계정이 바뀌면 App 이 칸을 새로 올린다(key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const newConversation = useCallback(() => {
    drop();
    remember(null);
    setError(null);
  }, [drop]);

  /** 모델·생각 깊이를 고른다. 엔진이 바뀌면 새 대화로 시작한다. */
  const choose = useCallback((next: AgentChoice) => {
    if (choice && next.engine !== choice.engine && (conversationId || messages.length)) newConversation();
    setChoice(next);
    saveJSON(STORAGE_KEYS.agentPanelModel, next);
  }, [choice, conversationId, messages.length, newConversation]);

  /** 보낸다. 받아들였으면 true(입력칸을 비운다). 보내는 중·진행 중이면 아무것도 하지 않는다. */
  const send = useCallback(async (text: string): Promise<boolean> => {
    const body = text.trim();
    if (!body || !choice || busy.current) return false;
    busy.current = true;
    setSending(true);
    setError(null);
    const stale = ticket();
    try {
      const r = await agentChatApi.startTurn({
        idempotency_key: crypto.randomUUID(),
        ...(conversationId ? { conversation_id: conversationId } : {}),
        engine: choice.engine, model: choice.model, effort: choice.effort,
        text: body, context: contextRef.current,
      });
      if (stale()) return false;
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

  /** [실행] — 사람만 누른다. 허브의 앱 입구가 계획을 다시 읽어 확인한 뒤 낸다(두 번 눌러도 한 번만 나간다 — 허브의 선점). */
  const executePlan = useCallback(async (planId: string) => {
    if (executing.current.has(planId)) return;
    executing.current.add(planId);
    setExec(planId, { state: "running" });
    const stale = ticket();
    try {
      const plan = await agentChatApi.executePlan(planId);
      if (stale()) return;
      setExec(planId, { state: "done" }, { ...plan, plan_id: plan.plan_id || planId });
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
  return {
    session, choice, choose, conversationId, title, messages, turn, running, sending, error,
    conversations, loadConversations, openConversation, newConversation, send, cancel, executePlan,
  };
}
