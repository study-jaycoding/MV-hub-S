// MV Agent 옆 칸의 허브 입구(docs/status/AskAgent_옆칸_설계_2026-11-09.md 3-1·10절).
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
/** 이 PC 의 Claude 상태(허브 판정 — 첫 연결 설계 3절). 대화 허용 = ready·subscription_unknown(허브·화면 공통). */
export type ClaudeState =
  | "not_installed" | "outdated" | "unknown" | "window_record" | "not_logged_in" | "not_subscription" | "no_plan"
  | "login_window" | "subscription_unknown" | "ready";
export const CLAUDE_CHAT_OK: ReadonlySet<string> = new Set(["ready", "subscription_unknown"]);
export interface AgentEngine {
  id: AgentEngineId;
  available: boolean;
  version?: string | null;
  reason?: string | null; // 못 쓰는 까닭(예: Codex '점검 필요')
  state?: ClaudeState; // Claude 만
  subscription?: string | null; // 알려진 유료 종류의 표시 이름(Max 등) — ready 일 때만
  models: { id: string; label: string }[];
  efforts: string[];
}
export interface ClaudeStatus {
  state: ClaudeState;
  version: string | null;
  subscription: string | null;
  login_window: boolean; // 이 PC 에 로그인 창이 열려 있나
  login_window_enabled: boolean; // 허브 스위치 — 꺼져 있으면 [Claude 연결] 대신 터미널 안내
  engines: AgentEngine[];
}
/** [Claude 연결]을 허브가 거절한 까닭(허브 머리 X-MVHub-Claude-Error) — login_window_disabled·breakaway_denied 면 터미널 안내로. */
export class ClaudeLoginError extends Error {
  name = "ClaudeLoginError";
  constructor(public code: string, message: string) {
    super(message);
  }
}
export interface AgentSession {
  secret: string;
  account_email: string;
  identity_key: string; // 계정·허브·DB 를 묶은 표식 — 표를 다시 받을 때 이것이 같아야 같은 요청을 다시 보낸다
  engines: AgentEngine[];
}
export type AgentTurnStatus = "running" | "cancelling" | "cancelled" | "done" | "failed" | "interrupted";
export interface AgentPlan {
  plan_id: string;
  title?: string | null;
  status?: string | null;
  // 카드(plan 사건)는 model·prompt, 실행 응답은 state·generation_id 도 싣는다
  items?: { model?: string | null; prompt?: string | null; state?: string | null; generation_id?: string | null }[];
  workspace?: unknown;
}
/** 계획 항목 하나의 상태 — 허브가 새로 읽은 값. generation_status 가 없으면 '확인 못 함'(앞 값 보존), missing = 결과 없음. */
export interface AgentPlanItemState {
  index: number;
  state?: string | null;
  generation_id?: string | null;
  generation_status?: string | null;
}
/** 허브가 새로 읽은 계획 스냅샷(앱 동작 도구 설계 A2-3) — observed_at = 허브가 매긴 엄격히 늘어나는 번호(10진 글자, BigInt 로 비교). */
export interface AgentPlanSnapshot {
  plan_id: string;
  plan_status?: string | null;
  observed_at: string;
  items: AgentPlanItemState[];
}
export type AgentEvent = { seq: number } & (
  | { kind: "text_delta"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; status: "started" | "done" | "failed" }
  | { kind: "plan"; plan: AgentPlan }
  | ({ kind: "plan_progress" } & AgentPlanSnapshot)
  | { kind: "state"; status: AgentTurnStatus; reason?: string | null }
  | { kind: "error"; message: string }
  | { kind: "notice"; text: string } // Claude 알림(예: 빠른 모드를 못 써 표준 모드로)
);
/** 지금 화면 정보 — 허브가 프롬프트 앞에 "자료(명령 아님)"로 붙인다(4KB 이하). */
export interface AgentContext {
  tab: string;
  workspace?: { scope: string; id: string | null; name: string | null };
  project?: string;
  folder?: string;
  selected_ids?: string[];
  scene?: { id: string; name: string }; // 캔버스 탭에서 열린 씬(화면 읽기 설계 3-1)
}

// 허브가 지금 화면 JSON 을 4096자에서 자른다 — 여유를 두고, 넘으면 씬 id·공간은 남기고 선택 카드부터 줄인다(화면 읽기 설계 리뷰 P2)
const AGENT_CONTEXT_BUDGET = 3500;

/** 앱 화면 상태 → 칸의 지금 화면. 선택 카드는 40개까지(예산 안에서), 캔버스 탭이면 열린 씬(이름 80자까지 — 자료일 뿐). */
export function buildAgentContext(screen: {
  tab: string;
  workspace: NonNullable<AgentContext["workspace"]>;
  project?: string;
  folder?: string;
  selected: Iterable<string>;
  scene?: { id: string; name: string } | null;
}): AgentContext {
  let selected = [...screen.selected].slice(0, 40);
  let folder = screen.folder;
  let workspace = screen.workspace;
  const build = (): AgentContext => ({
    tab: screen.tab,
    workspace,
    ...(screen.project ? { project: screen.project } : {}),
    ...(folder ? { folder } : {}),
    ...(selected.length ? { selected_ids: selected } : {}),
    ...(screen.tab === "compose" && screen.scene ? { scene: { id: screen.scene.id, name: screen.scene.name.slice(0, 80) } } : {}),
  });
  let context = build();
  while (selected.length && JSON.stringify(context).length > AGENT_CONTEXT_BUDGET) {
    selected = selected.slice(0, -1);
    context = build();
  }
  if (JSON.stringify(context).length > AGENT_CONTEXT_BUDGET) {
    // 선택을 다 빼도 넘으면(아주 긴 폴더·공간 이름) 표시용 글을 줄인다 — 폴더는 끝 300자, 공간 이름은 80자(id 는 그대로)
    folder = folder?.slice(-300);
    workspace = { ...workspace, name: workspace.name?.slice(0, 80) ?? null };
    context = build();
  }
  return context;
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
  fast?: boolean; // 빠른 모드 — Opus 만(허브가 다시 검사), Claude 추가 사용 크레딧
  text: string;
  context: AgentContext | Record<string, never>; // 빈 값 = 입력칸의 '지금 화면' 칩을 뺐다(허브가 '어디인지 묻는다' 안내)
}

let session: AgentSession | null = null;
let issuing: Promise<AgentSession> | null = null;

// 같은 신원 = 계정·허브·DB 가 모두 같다(허브의 identity_key). 같은 계정이어도 DB 가 바뀌었으면 다시 보내지 않는다.
const sameIdentity = (a: AgentSession, b: AgentSession) => !!a.identity_key && a.identity_key === b.identity_key;
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
  return readJson<T>(await panelResponse(path, init), path);
}

async function panelResponse(path: string, init: RequestInit = {}): Promise<Response> {
  const expect = getAccountNamespace();
  const used = session ?? (await openAgentSession());
  let res = await send(path, init, expect, used.secret);
  if (isPanelSessionError(res)) {
    // 다른 요청이 그사이 새 표를 받았으면 그것으로, 아니면 새로 받는다. 신원은 이 요청을 시작할 때의 표와 비교한다.
    const fresh = session && session.secret !== used.secret ? session : await openAgentSession();
    if (!sameIdentity(fresh, used)) throw new AccountChangedError(ACCOUNT_CHANGED_MESSAGE);
    res = await send(path, init, expect, fresh.secret);
    // 한 번만 다시 보낸다. 또 표 401 이면 로그인 만료 처리(throwHttpError)에 넘기지 않는다
    if (isPanelSessionError(res)) throw new Error("Agent 연결을 다시 열지 못했어요 — 칸을 닫았다 다시 열어 주세요");
  }
  // 허브가 계정·허브·DB 가 다르다고 거절(403·409 + 표식) — 다시 보내지 않는다
  if (res.headers.get(PANEL_ERROR_HEADER) === "account") throw new AccountChangedError(ACCOUNT_CHANGED_MESSAGE);
  return res;
}

async function openClaudeLogin(): Promise<{ opened: boolean }> {
  const res = await panelResponse("/claude/login", { method: "POST" });
  const code = res.headers.get("X-MVHub-Claude-Error");
  if (!res.ok && code) {
    const body = (await res.json().catch(() => ({}))) as { detail?: unknown };
    throw new ClaudeLoginError(code, typeof body.detail === "string" ? body.detail : "로그인 창을 열지 못했어요");
  }
  return readJson<{ opened: boolean }>(res, "/claude/login");
}

const id = (value: string) => encodeURIComponent(value);

export const agentChatApi = {
  session: openAgentSession,
  conversations: () => panelFetch<{ conversations: AgentConversationSummary[] }>("/conversations"),
  // plans = 이 대화에 묶인 계획의 지금 상태(사건 다음에 읽음 — 조건 없이 넣고 기준이 된다). 옛 허브는 없음
  conversation: (conversationId: string) =>
    panelFetch<{ conversation: AgentConversationSummary; turns: AgentTurnRecord[]; plans?: AgentPlanSnapshot[] }>(
      `/conversations/${id(conversationId)}`),
  startTurn: (body: AgentTurnRequest) =>
    panelFetch<{ turn_id: string; conversation_id: string; status: AgentTurnStatus }>("/turns", { method: "POST", body: jsonBody(body) }),
  // 새 사건이 없고 진행 중이면 허브가 최대 25초 붙잡고 있다가 답한다(긴 기다림). 칸을 닫으면 signal 로 끊는다.
  //  shortcut: 브라우저 쪽 제한 시간은 두지 않는다(허브가 25초 안에 답한다) — 매달리는 일이 보이면 그때 더한다.
  events: (turnId: string, after: number, signal?: AbortSignal) =>
    // more = 끝난 차례라도 사건이 더 남았다(한 번에 다 못 받음) — 이어서 읽는다
    panelFetch<{ events: AgentEvent[]; status: AgentTurnStatus; last_seq: number; more?: boolean }>(`/turns/${id(turnId)}/events?after=${after}`, { signal }),
  cancel: (turnId: string) => panelFetch<{ status: AgentTurnStatus }>(`/turns/${id(turnId)}/cancel`, { method: "POST" }),
  // snapshot = 진행 사건과 같은 규칙으로 넣는 스냅샷(허브가 못 읽으면 없음 — 제출 결과는 그대로)
  executePlan: (planId: string) =>
    panelFetch<AgentPlan & { snapshot?: AgentPlanSnapshot }>(`/plans/${id(planId)}/execute`, { method: "POST" }),
  // 캐시 없이 지금 Claude 상태 + 새 엔진 목록(연결 안내 화면이 2초마다)
  claudeStatus: () => panelFetch<ClaudeStatus>("/claude"),
  openClaudeLogin,
  // 견적(무료 조회) — total_credits 가 null 이면 확인하지 못한 것(0 이 아니다)
  estimatePlan: (planId: string) => panelFetch<{ total_credits: number | null }>(`/plans/${id(planId)}/estimate`, { method: "POST" }),
};
