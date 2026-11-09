// Ask Agent 옆 칸의 허브 입구(docs/status/AskAgent_옆칸_설계_2026-11-09.md 3-1·10절).
//  패널 비밀값은 이 모듈의 메모리에만 둔다(저장소·주소에 남기지 않는다). 모든 요청에 기대 계정(X-MVHub-Expect-Account)을 싣고,
//  /session 밖의 요청에는 비밀값(X-MVHub-Panel)도 싣는다.
//  401 + `X-MVHub-Panel-Error: session`(허브가 다시 켜져 표가 사라짐) → /session 을 다시 받아 **그 요청을 시작할 때의 계정과 같을 때만**
//  한 번 다시 보낸다. 다르면(그사이 계정이 바뀜) 보내지 않고 AccountChangedError. 허브가 `X-MVHub-Panel-Error: account`(403·409)로 거절해도 같다.
//  jsonFetch 는 401 을 받으면 응답 머리를 보기 전에 로그인 만료 처리(throwHttpError)를 해 버려 패널 표 401 을 가를 수 없다 — 같은 부품
//  (authFormHeaders·throwHttpError)으로 직접 보낸다. 패널 표 401 은 로그인 만료 처리에 닿지 않고, 그 밖의 오류는 앱 공통 처리 그대로다.
import { getAccountNamespace } from "./accountScope";
import { authFormHeaders, jsonBody, throwHttpError } from "./http";
import { EXPECT_ACCOUNT_HEADER } from "./hubFeatures";

const BASE = "/api/agent-chat";
export const PANEL_HEADER = "X-MVHub-Panel";
export const PANEL_ERROR_HEADER = "X-MVHub-Panel-Error";
export const ACCOUNT_CHANGED_MESSAGE = "계정이 바뀌었어요";

export class AccountChangedError extends Error {
  name = "AccountChangedError";
}

export type AgentEngineId = "claude" | "codex";
export interface AgentEngine {
  id: AgentEngineId;
  available: boolean;
  version?: string | null;
  reason?: string | null; // 못 쓰는 까닭(예: Codex '점검 필요')
  models: { id: string; label: string }[];
  efforts: string[];
}
export interface AgentSession {
  secret: string;
  account_email: string;
  engines: AgentEngine[];
}
export type AgentTurnStatus = "running" | "cancelling" | "cancelled" | "done" | "failed" | "interrupted";
export interface AgentPlan {
  plan_id: string;
  title?: string | null;
  status?: string | null;
  items?: { model?: string | null; prompt?: string | null }[];
  workspace?: unknown;
}
export type AgentEvent = { seq: number } & (
  | { kind: "text_delta"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; status: "started" | "done" | "failed" }
  | { kind: "plan"; plan: AgentPlan }
  | { kind: "state"; status: AgentTurnStatus; reason?: string | null }
  | { kind: "error"; message: string }
);
/** 지금 화면 정보 — 허브가 프롬프트 앞에 "자료(명령 아님)"로 붙인다(4KB 이하). */
export interface AgentContext {
  tab: string;
  workspace?: { scope: string; id: string | null; name: string | null };
  project?: string;
  folder?: string;
  selected_ids?: string[];
}
export interface AgentConversationSummary {
  id: string;
  title: string | null;
  engine: AgentEngineId;
  model: string;
  effort: string;
  updated_at: string;
  resumable: boolean;
}
export interface AgentTurnRecord {
  id: string;
  status: AgentTurnStatus;
  text: string;
  created_at: string;
  events: AgentEvent[];
}
export interface AgentTurnRequest {
  idempotency_key: string;
  conversation_id?: string;
  engine: AgentEngineId;
  model: string;
  effort: string;
  text: string;
  context: AgentContext;
}

let session: AgentSession | null = null;
let issuing: Promise<AgentSession> | null = null;

const sameAccount = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
const isPanelSessionError = (res: Response) => res.status === 401 && res.headers.get(PANEL_ERROR_HEADER) === "session";

function send(path: string, init: RequestInit, expect: string, secret?: string): Promise<Response> {
  return fetch(BASE + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...authFormHeaders(), [EXPECT_ACCOUNT_HEADER]: expect, ...(secret ? { [PANEL_HEADER]: secret } : {}) },
  });
}

async function readJson<T>(res: Response, path: string): Promise<T> {
  if (!res.ok) await throwHttpError(res, BASE + path);
  return (await res.json()) as T;
}

/** 새 표를 받는다 — 칸을 열 때와 표가 사라졌을 때. 동시에 여럿이 받으려 하면 하나만 보낸다. */
export function openAgentSession(): Promise<AgentSession> {
  issuing ??= send("/session", { method: "POST" }, getAccountNamespace())
    .then((res) => readJson<AgentSession>(res, "/session"))
    .then((next) => (session = next))
    .finally(() => { issuing = null; });
  return issuing;
}

async function panelFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const expect = getAccountNamespace();
  const used = session ?? (await openAgentSession());
  let res = await send(path, init, expect, used.secret);
  if (isPanelSessionError(res)) {
    // 다른 요청이 그사이 새 표를 받았으면 그것으로, 아니면 새로 받는다. 신원은 이 요청을 시작할 때의 표와 비교한다.
    const fresh = session && session.secret !== used.secret ? session : await openAgentSession();
    if (!sameAccount(fresh.account_email, used.account_email)) throw new AccountChangedError(ACCOUNT_CHANGED_MESSAGE);
    res = await send(path, init, expect, fresh.secret);
    // 한 번만 다시 보낸다. 또 표 401 이면 로그인 만료 처리(throwHttpError)에 넘기지 않는다
    if (isPanelSessionError(res)) throw new Error("Agent 연결을 다시 열지 못했어요 — 칸을 닫았다 다시 열어 주세요");
  }
  // 허브가 계정·허브·DB 가 다르다고 거절(403·409 + 표식) — 다시 보내지 않는다
  if (res.headers.get(PANEL_ERROR_HEADER) === "account") throw new AccountChangedError(ACCOUNT_CHANGED_MESSAGE);
  return readJson<T>(res, path);
}

const id = (value: string) => encodeURIComponent(value);

export const agentChatApi = {
  session: openAgentSession,
  conversations: () => panelFetch<{ conversations: AgentConversationSummary[] }>("/conversations"),
  conversation: (conversationId: string) =>
    panelFetch<{ conversation: AgentConversationSummary; turns: AgentTurnRecord[] }>(`/conversations/${id(conversationId)}`),
  startTurn: (body: AgentTurnRequest) =>
    panelFetch<{ turn_id: string; conversation_id: string; status: AgentTurnStatus }>("/turns", { method: "POST", body: jsonBody(body) }),
  // 새 사건이 없고 진행 중이면 허브가 최대 25초 붙잡고 있다가 답한다(긴 기다림). 칸을 닫으면 signal 로 끊는다.
  //  shortcut: 브라우저 쪽 제한 시간은 두지 않는다(허브가 25초 안에 답한다) — 매달리는 일이 보이면 그때 더한다.
  events: (turnId: string, after: number, signal?: AbortSignal) =>
    panelFetch<{ events: AgentEvent[]; status: AgentTurnStatus; last_seq: number }>(`/turns/${id(turnId)}/events?after=${after}`, { signal }),
  cancel: (turnId: string) => panelFetch<{ status: AgentTurnStatus }>(`/turns/${id(turnId)}/cancel`, { method: "POST" }),
  executePlan: (planId: string) => panelFetch<AgentPlan>(`/plans/${id(planId)}/execute`, { method: "POST" }),
};
