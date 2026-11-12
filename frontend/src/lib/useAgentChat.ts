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
  type AgentAttachment,
  type AgentAttachments,
  type AgentContext,
  type AgentConversationPatch,
  type AgentConversationSummary,
  type AgentSessionFileResult,
  type AgentEngine,
  type AgentEngineId,
  type AgentEvent,
  type AgentPlan,
  type AgentPlanItemState,
  type AgentPlanSnapshot,
  type AgentScreenStatus,
  type AgentSession,
  type AgentTurnStatus,
  type AgentWeeklyUsage,
  type ClaudeStatus,
} from "./agentChatApi";
import { runScreenAction, undoScreenAction, type ScreenHost, type ScreenUndo } from "./agentScreenActions";
import { AGENT_CHAT_CONNECT_FEATURE, hubHasFeature } from "./hubFeatures";
import { errorDetail, isHttpStatus } from "./http";
import { loadJSON, loadString, saveJSON, saveString } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";

// ── 서랍 메뉴(docs/status/MVAgent_서랍메뉴_2026-11-12.md 2-1·2-3·2-6) ──
interface OpenRequest { account: string; identity: string; id: string; nonce: string; at: number }
const OPEN_REQUEST_TTL = 30_000; // 새 창이 뜰 때는 만든 지 30초 안의 요청만(닫았다 다시 연 창이 지난 요청을 열지 않게)
function readOpenRequest(): OpenRequest | null {
  const r = loadJSON<Partial<OpenRequest>>(STORAGE_KEYS.agentPanelOpenRequest);
  return r && typeof r.account === "string" && typeof r.identity === "string" && typeof r.id === "string"
    && typeof r.nonce === "string" && typeof r.at === "number" ? (r as OpenRequest) : null;
}
const visible = () => typeof document === "undefined" || document.visibilityState === "visible";

export type AgentMessage =
  | { kind: "user"; id: string; text: string; attachments?: AgentAttachment[] } // attachments = 그 말과 함께 붙인 자료
  | { kind: "assistant"; id: string; text: string; open: boolean } // open = 아직 조각을 받는 덩어리
  | { kind: "tool"; id: string; name: string; status: "started" | "done" | "failed" }
  | { kind: "plan"; id: string; plan: AgentPlan; exec?: { state: "running" | "done" | "failed"; message?: string };
      estimate?: { credits: number | null }; // 없으면 견적 확인 중 · credits null = 확인하지 못함
      progress?: AgentPlanProgress }
  | { kind: "error"; id: string; message: string }
  | { kind: "notice"; id: string; text: string }
  // 화면 동작의 '한 일' 카드(docs/status/MVAgent_화면동작_2026-11-12.md 3-3) — 이 칸이 실행했으면 그 영수증(undo 있음), 아니면 허브 사건
  | { kind: "action"; id: string; actionId: string; ok: boolean; summary: string; status: AgentScreenStatus;
      undo?: ScreenUndo; account?: string; undone?: boolean; note?: string };

export interface AgentChoice {
  engine: AgentEngineId;
  model: string;
  effort: string;
  fast?: boolean; // 빠른 모드 — Opus 만 · 기억하지 않는다(대화마다 기본 꺼짐) · Claude 추가 사용 크레딧
}

export const TERMINAL_TURN = new Set<AgentTurnStatus>(["cancelled", "done", "failed", "interrupted"]);

/** 계획 카드의 진행(허브가 새로 읽은 스냅샷을 합친 것). observed = 마지막으로 넣은 스냅샷 번호(null = 기준 없음 — 다음 스냅샷을 받는다). */
export interface AgentPlanProgress {
  observed: string | null;
  planStatus?: string | null;
  items: Record<number, AgentPlanItemState>;
}
type PlanMessage = Extract<AgentMessage, { kind: "plan" }>;

function newer(next: string, current: string | null | undefined): boolean {
  if (current == null) return true;
  try {
    return BigInt(next) > BigInt(current);
  } catch {
    return false; // 번호 모양이 아니면 넣지 않는다
  }
}

/** 스냅샷을 계획 카드에 넣는다(설계 A2-3). 진행 사건·사람 [실행] 은 번호가 지금보다 클 때만, 대화 복원(force)은 조건 없이.
 *  생성 상태가 빠진 항목(허브가 잠깐 못 읽음)은 앞 값을 둔다. 상태 순위를 쓰지 않아 허브의 복구 전이(uncertain→submitted 등)도 그대로 보인다. */
export function applyPlanSnapshot(m: PlanMessage, snap: AgentPlanSnapshot, force = false): PlanMessage {
  if (!force && !newer(snap.observed_at, m.progress?.observed)) return m;
  const items = { ...(m.progress?.items ?? {}) };
  for (const it of snap.items) {
    const prev = items[it.index];
    items[it.index] = {
      index: it.index, state: it.state ?? null, generation_id: it.generation_id ?? null,
      generation_status: it.generation_status !== undefined ? it.generation_status : prev?.generation_status,
    };
  }
  return { ...m, progress: { observed: snap.observed_at, planStatus: snap.plan_status, items } };
}

/** 대화 복원 — 허브가 사건 다음에 읽은 스냅샷을 조건 없이 넣고 그 번호를 기준으로 삼는다. 스냅샷이 빠진 계획(예산 밖·실패)은
 *  기준만 비운다(재시작 전 큰 번호가 새 진행을 거르지 않게 — 사건으로 복원한 상태는 둔다). */
export function restorePlans(messages: AgentMessage[], plans: AgentPlanSnapshot[]): AgentMessage[] {
  const byId = new Map(plans.map((p) => [p.plan_id, p]));
  return messages.map((m) => {
    if (m.kind !== "plan") return m;
    const snap = byId.get(m.plan.plan_id);
    if (snap) return applyPlanSnapshot(m, snap, true);
    return m.progress ? { ...m, progress: { ...m.progress, observed: null } } : m;
  });
}

/** 스냅샷 없이 온 실행 응답(옛 허브·스냅샷 실패) — 그 카드에 아직 진행이 없을 때만 채운다(늦은 응답이 새 상태를 못 되돌림). */
export function fillPlanProgress(m: PlanMessage, plan: AgentPlan): PlanMessage {
  if (m.progress) return m;
  const items: Record<number, AgentPlanItemState> = {};
  (plan.items ?? []).forEach((it, index) => {
    items[index] = { index, state: it.state ?? null, generation_id: it.generation_id ?? null };
  });
  return { ...m, progress: { observed: null, planStatus: plan.status, items } };
}

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
    case "plan_progress":
      return messages.map((m) => (m.kind === "plan" && m.plan.plan_id === event.plan_id ? applyPlanSnapshot(m, event) : m));
    case "state":
      return event.reason ? [...messages, { kind: "error", id, message: event.reason }] : messages;
    case "error":
      return [...messages, { kind: "error", id, message: event.message }];
    case "notice":
      return [...messages, { kind: "notice", id, text: event.text }];
    case "ui_action_result":
      // 이 칸이 실행했으면 그 영수증 카드가 먼저다(되돌리기 자료가 있다) — 허브 사건은 다른 칸·복원·실행 안 됨·결과 불명일 때만 카드가 된다
      if (messages.some((m) => m.kind === "action" && m.actionId === event.action_id)) return messages;
      return [...messages, { kind: "action", id, actionId: event.action_id, ok: event.ok, summary: event.summary, status: event.status }];
    default:
      return messages; // 모르는 사건은 넘긴다(ui_action 은 follow 가 실행 여부를 정한다)
  }
}

// ── 칸 설정·사용량(docs/status/MVAgent_모델설정사용량_2026-11-12.md) ──
/** 새 대화 모델·생각 깊이(없으면 마지막에 쓴 것), 먼저 쓸 생성 모델(앱 모델 코드) — 이 브라우저에 남긴다 */
export interface AgentDefaults { model?: { engine: AgentEngineId; model: string }; effort?: string; gen_model?: string }
const GEN_MODEL_RE = /^[A-Za-z0-9_.:-]{1,100}$/; // 허브 TurnIn.gen_model 과 같은 글자
export function readDefaults(): AgentDefaults {
  const d = loadJSON<AgentDefaults>(STORAGE_KEYS.agentDefaults);
  if (!d || typeof d !== "object") return {};
  return {
    ...(d.model && typeof d.model.engine === "string" && typeof d.model.model === "string" ? { model: d.model } : {}),
    ...(typeof d.effort === "string" ? { effort: d.effort } : {}),
    ...(typeof d.gen_model === "string" && GEN_MODEL_RE.test(d.gen_model) ? { gen_model: d.gen_model } : {}),
  };
}
/** 새 대화의 모델 — 설정이 있으면 그것을 지금 쓸 수 있는 것으로 맞춘다(못 쓰면 pickChoice 가 쓸 수 있는 것으로) */
function withDefaults(engines: AgentEngine[], c: AgentChoice | null, d: AgentDefaults): AgentChoice | null {
  if (!d.model && !d.effort) return c;
  const base = d.model ? { engine: d.model.engine, model: d.model.model, effort: d.effort ?? c?.effort ?? "medium" }
    : c && { ...c, effort: d.effort ?? c.effort };
  return base ? pickChoice(engines, base) : c;
}
/** 사용량 원 — 지금 대화가 찬 정도(그 대화의 마지막 답)와 Claude 주간 한도(계정별 마지막 값) */
export interface AgentUsage { context?: { used: number; window: number }; weekly?: AgentWeeklyUsage & { at: number; account: string } }
function savedWeekly(): AgentUsage["weekly"] {
  const s = loadJSON<{ account?: string; weekly?: AgentWeeklyUsage; at?: number }>(STORAGE_KEYS.agentUsage);
  return s?.account === getAccountNamespace() && s.weekly && typeof s.weekly.utilization === "number" && typeof s.at === "number"
    ? { ...s.weekly, at: s.at, account: s.account } : undefined;
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

export function useAgentChat(context: AgentContext | Record<string, never>, // 빈 값 = '지금 화면' 칩을 뺐다
  // popout = 새 창(?embed=agent) — '새 창에서 열기' 요청을 받는 쪽 · screen = 이 창의 캔버스 손잡이(옆 칸만, 화면 동작 실행)
  options: { popout?: boolean; screen?: ScreenHost } = {}) {
  const [session, setSession] = useState<AgentSession | null>(null);
  const [choice, setChoice] = useState<AgentChoice | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [current, setCurrent] = useState<AgentConversationSummary | null>(null); // 보고 있는 대화의 요약(머리글 메뉴 — 열 때·허브 응답마다)
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [turn, setTurn] = useState<{ id: string; status: AgentTurnStatus } | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<AgentConversationSummary[] | null>(null);
  const [truncated, setTruncated] = useState(false); // 허브가 최근 500개만 실었다
  const [notice, setNotice] = useState<string | null>(null); // 오류가 아닌 안내(다른 창에서 지워짐 등)
  const [usage, setUsage] = useState<AgentUsage>(() => ({ weekly: savedWeekly() }));
  // 사건 속 사용량 — 대화 찬 정도는 마지막 값, 주간은 지금 받은 사건(live)만(복원한 옛 차례 값이 새 값을 덮지 않게)
  const noteUsage = (events: AgentEvent[], live: boolean) => {
    let context: AgentUsage["context"];
    let weekly: AgentWeeklyUsage | undefined;
    for (const ev of events) {
      if (ev.kind !== "usage") continue;
      if (ev.context) context = ev.context;
      if (ev.weekly && live) weekly = ev.weekly;
    }
    if (!context && !weekly) return;
    const account = getAccountNamespace();
    const at = Date.now();
    if (weekly) saveJSON(STORAGE_KEYS.agentUsage, { account, weekly, at });
    setUsage((u) => ({ context: context ?? u.context, weekly: weekly ? { ...weekly, at, account } : u.weekly }));
  };
  const currentId = useRef<string | null>(null); // 저장소 알림·끝남 처리에서 지금 대화를 읽는다(닫힌 값이 아니라)
  currentId.current = conversationId;
  const loadingId = useRef<string | null>(null); // 불러오는 중인 대화 — 그 사이 지워지면 늦은 복원 응답을 버린다
  const pendingRead = useRef<{ id: string; rev: number } | null>(null); // 숨은 창에서 받은 끝남 — 다시 보일 때 읽음
  const pendingOpen = useRef<OpenRequest | null>(null); // 바쁠 때 온 새 창 열기 요청(최신 하나)
  // 이 창에서 바꾼 줄 — 순번·지움 여부·마지막으로 받은 요약. 목록 조회를 보낸 뒤 바뀐 줄은 늦게 온 조회 응답이 덮지 않는다
  //  (독립 리뷰 재확인 P2 두 번: 목록에 아직 없을 때 받은 요약도 남겨 조회 응답과 합친다 — 지움과 구분)
  const changeSeq = useRef(0);
  const changedAt = useRef(new Map<string, { seq: number; deleted: boolean; summary?: AgentConversationSummary }>());
  const touch = (id: string, change: { deleted?: boolean; summary?: AgentConversationSummary }) => {
    changeSeq.current += 1;
    const before = changedAt.current.get(id)?.summary;
    const older = before && change.summary && typeof before.unread_rev === "number" && typeof change.summary.unread_rev === "number"
      && change.summary.unread_rev < before.unread_rev;
    changedAt.current.set(id, { seq: changeSeq.current, deleted: !!change.deleted,
      summary: change.deleted ? undefined : older ? before : change.summary ?? before });
  };

  const contextRef = useRef(context);
  contextRef.current = context;
  const epoch = useRef(0); // 새 대화·대화 바꿈·닫힘마다 올린다 — 그 전에 시작한 요청의 답은 버린다
  const poll = useRef<AbortController | null>(null);
  const busy = useRef(false); // 보내는 중·차례 진행 중 — 두 번 보내기 막음(상태보다 먼저 바뀐다)
  const executing = useRef(new Set<string>());
  const estimating = useRef(new Set<string>());
  // 화면 동작(docs/status/MVAgent_화면동작_2026-11-12.md 3-2) — 이 마운트의 실행 창 번호(옆 칸만, 마운트마다 새로), 이 마운트가 직접 보낸
  //  차례(대화를 열거나 다시 열면 비운다 — 복원은 실행하지 않음), 이미 처리한 동작
  const screenRef = useRef(options.screen);
  screenRef.current = options.screen;
  const screenTab = useRef<string | null>(null);
  if (screenTab.current === null && !options.popout && options.screen) screenTab.current = crypto.randomUUID();
  const sentTurns = useRef(new Set<string>());
  const handledActions = useRef(new Set<string>());
  const messagesRef = useRef<AgentMessage[]>([]);
  messagesRef.current = messages; // 되돌리기가 지금 카드 순서를 읽는다(상태 갱신 함수 안에서 화면을 바꾸지 않게)

  /** 허브가 발급한 화면 동작 — 이 마운트가 직접 보낸 차례면 claim → 명령 직전 다시 확인 → 실행 → 영수증 카드 → 결과 보고. */
  const runAction = useCallback(async (turnId: string, ev: Extract<AgentEvent, { kind: "ui_action" }>) => {
    const host = screenRef.current, tab = screenTab.current;
    if (!host || !tab || !sentTurns.current.has(turnId) || handledActions.current.has(ev.action_id)) return;
    handledActions.current.add(ev.action_id); // 이미 처리한 동작은 다시 청하지 않는다
    const account = getAccountNamespace();
    let token: string;
    try {
      token = (await agentChatApi.claimAction(turnId, ev.action_id, tab)).token;
    } catch {
      return; // 다른 마운트·기한 지남·차례 끝 — 실행하지 않는다
    }
    if (!mounted.current || !sentTurns.current.has(turnId) || getAccountNamespace() !== account) { // claim 뒤 자격 재확인
      void agentChatApi.reportAction(turnId, ev.action_id, { token, ok: false, summary: "화면이 바뀌어 실행하지 않았어요", data: {} }).catch(() => {});
      return;
    }
    const receipt = runScreenAction(ev.name, ev.args, host); // 씬·보기 모드는 실행기가 명령 직전에 다시 본다
    const card: AgentMessage = { kind: "action", id: `${turnId}:action:${ev.action_id}`, actionId: ev.action_id, ok: receipt.ok,
      summary: receipt.summary, status: receipt.ok ? "done" : "failed", undo: receipt.undo, account };
    // 영수증이 먼저다 — claim 답이 늦어 허브의 상태 카드(결과 불명 등)가 먼저 들어왔으면 그 자리를 대신한다(독립 리뷰 P1)
    setMessages((m) => (m.some((x) => x.kind === "action" && x.actionId === ev.action_id)
      ? m.map((x) => (x.kind === "action" && x.actionId === ev.action_id ? card : x)) : [...m, card]));
    try {
      await agentChatApi.reportAction(turnId, ev.action_id, { token, ok: receipt.ok, summary: receipt.summary, data: receipt.data });
    } catch {
      // 보고가 실패해도 이미 반영한 동작은 영수증 카드로 둔다(실패로 보이지 않게)
    }
    // mounted 는 아래에서 선언한 참조 — 부를 때 읽는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** '한 일' 카드의 되돌리기 — 그 동작이 바꾼 것만, 뒤에 손댄 것이 없을 때만. 계정이 바뀌었으면 거절. 한 번 되돌리면 단추가 사라진다. */
  const undoAction = useCallback((actionId: string) => {
    const list = messagesRef.current;
    const at = list.findIndex((m) => m.kind === "action" && m.actionId === actionId);
    const card = list[at];
    if (!card || card.kind !== "action" || !card.undo || card.undone) return;
    const mark = (patch: { undone?: boolean; note: string; undo?: ScreenUndo }) =>
      setMessages((m) => m.map((x) => (x.kind === "action" && x.actionId === actionId ? { ...x, ...patch } : x)));
    const host = screenRef.current;
    if (!host || card.account !== getAccountNamespace()) return mark({ note: "계정이나 화면이 바뀌어 되돌릴 수 없어요" });
    const later = list.slice(at + 1).flatMap((m) => (m.kind === "action" && !m.undone && m.undo?.kind === "canvas" ? [m.undo.fingerprint] : []));
    const result = undoScreenAction(card.undo, host, later);
    // 내 저장 실패면 실행기가 기준을 새로 잡아 준다 — 그 자료로 바꿔 다시 누를 수 있게
    mark(result.ok ? { undone: true, note: result.message } : { note: result.message, ...(result.undo ? { undo: result.undo } : {}) });
  }, []);

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
    sentTurns.current.clear(); // 대화를 바꾸거나 다시 열면 그 전 차례의 화면 동작은 실행하지 않는다
    setConversationId(null);
    setTitle(null);
    setCurrent(null);
    setMessages([]);
    setTurn(null);
    setSending(false);
    setUsage((u) => ({ weekly: u.weekly })); // 대화 찬 정도는 그 대화의 것
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

  /** 지워진 대화를 이 창에서 비운다 — 지금 보거나 불러오는 중이면 drop(늦은 복원 응답도 버린다), '마지막 대화'는 같은 id 일 때만 비움. */
  const forget = useCallback((id: string) => {
    if (currentId.current === id || loadingId.current === id) {
      drop();
      loadingId.current = null;
    }
    if (remembered() === id) remember(null);
    if (pendingRead.current?.id === id) pendingRead.current = null;
    touch(id, { deleted: true });
    setConversations((list) => (list ? list.filter((c) => c.id !== id) : list));
  }, [drop]);

  // 허브가 돌려준 요약으로 목록 한 줄 — 읽지 않음 번호가 더 작은(늦게 온 옛) 응답은 버린다(독립 리뷰 P2: 늦은 자동 읽음이 수동 표시를 덮지 않게)
  const putSummary = (summary: AgentConversationSummary) => {
    if (changedAt.current.get(summary.id)?.deleted) return; // 지운 대화(id 는 다시 안 쓰임)에 늦게 온 응답 — 지움 표시를 풀지 않는다(독립 리뷰 재확인 3)
    touch(summary.id, { summary });
    if (summary.id === currentId.current) setCurrent((c) => (
      c?.id === summary.id && typeof c.unread_rev === "number" && typeof summary.unread_rev === "number" && summary.unread_rev < c.unread_rev ? c : summary));
    setConversations((list) => (list ? list.map((c) => {
      if (c.id !== summary.id) return c;
      if (typeof c.unread_rev === "number" && typeof summary.unread_rev === "number" && summary.unread_rev < c.unread_rev) return c;
      return { ...c, ...summary };
    }) : list));
  };

  /** 자동 읽음 — 본 번호(seen_rev)가 지금과 같을 때만 허브가 끈다. 창이 숨어 있으면 들고 있다가 다시 보일 때 보낸다.
   *  답은 보낼 때의 계정·차례 번호가 그대로일 때만 목록에 넣는다. */
  const markRead = useCallback((id: string, rev: number) => {
    if (!visible()) {
      pendingRead.current = { id, rev };
      return;
    }
    pendingRead.current = null;
    const stale = ticket();
    agentChatApi.patchConversation(id, { unread: false, seen_rev: rev }).then((r) => { if (!stale()) putSummary(r.conversation); }, () => {});
    // ticket 은 매번 새로 만드는 표라 넣지 않는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        for (const ev of r.events) if (ev.kind === "ui_action") void runAction(turnId, ev); // 살아서 받은 사건만(복원은 실행 안 함)
        noteUsage(r.events, true);
        seq = Math.max(seq, r.last_seq);
        setTurn({ id: turnId, status: r.status });
        // 보고 있는 대화의 끝남 — 그 사건의 읽지 않음 번호로 조건부 읽음(서랍 메뉴 2-3)
        const ended = [...r.events].reverse().find((ev) => ev.kind === "state" && TERMINAL_TURN.has(ev.status));
        if (ended?.kind === "state" && typeof ended.unread_rev === "number" && currentId.current) markRead(currentId.current, ended.unread_rev);
        if (TERMINAL_TURN.has(r.status) && !r.more) break; // 끝났어도 남은 사건(계획 카드 등)은 마저 받는다
      } catch (e) {
        if (controller.signal.aborted || stale()) return;
        failures += 1;
        const clientError = e instanceof AccountChangedError || isHttpStatus(e, 400, 401, 403, 404, 409);
        if (clientError || failures >= 3) {
          if (isHttpStatus(e, 404) && currentId.current) { // 그 사이 지워진 대화
            forget(currentId.current);
            setNotice("이 대화는 지워졌어요");
            break;
          }
          fail(e);
          break;
        }
        await sleep(2000);
      }
    }
    if (poll.current === controller) poll.current = null;
    busy.current = false;
  }, [fail, forget, markRead, runAction]);

  const openConversation = useCallback(async (id: string) => {
    if (busy.current) return; // 보내는 중·진행 중엔 대화를 바꾸지 않는다 — 허브에서 시작한 차례를 놓치지 않게
    drop();
    setError(null);
    setNotice(null);
    // 불러오는 동안 보내기·전환을 막는다 — 늦게 온 지난 대화가 그사이 보낸 새 차례를 덮지 않게(리뷰 2차)
    busy.current = true;
    setSending(true);
    loadingId.current = id;
    const stale = ticket();
    try {
      const r = await agentChatApi.conversation(id);
      if (stale()) return;
      loadingId.current = null;
      let rebuilt: AgentMessage[] = [];
      for (const t of r.turns) {
        const attached = t.attachments?.items?.length ? { attachments: t.attachments.items } : {};
        rebuilt = [...rebuilt, { kind: "user", id: `${t.id}:user`, text: t.text, ...attached }];
        rebuilt = t.events.reduce((acc, ev) => applyAgentEvent(acc, ev, t.id), rebuilt);
      }
      setMessages(r.plans ? restorePlans(rebuilt, r.plans) : rebuilt);
      noteUsage(r.turns.flatMap((t) => t.events), false);
      setConversationId(id);
      currentId.current = id;
      setTitle(r.conversation.title);
      setCurrent(r.conversation);
      setChoice({ engine: r.conversation.engine, model: r.conversation.model, effort: r.conversation.effort });
      remember(id);
      // 열었다 = 봤다 — 그때의 번호로 조건부(늦게 닿아도 그 뒤의 차례 끝·수동 표시는 못 지운다), 이미 읽음이면 안 보냄
      if (r.conversation.unread) markRead(id, r.conversation.unread_rev ?? 0);
      const last = r.turns[r.turns.length - 1];
      if (last && !TERMINAL_TURN.has(last.status)) {
        setTurn({ id: last.id, status: last.status });
        void follow(last.id, last.events.length ? last.events[last.events.length - 1].seq : 0);
      }
    } catch (e) {
      if (stale()) return;
      if (loadingId.current === id) loadingId.current = null;
      if (isHttpStatus(e, 403, 404) && remembered() === id) remember(null); // 지워졌거나 다른 신원의 대화 — 새 대화로 둔다
      fail(e);
    } finally {
      if (!stale()) {
        setSending(false);
        if (!poll.current) busy.current = false; // 진행 중 차례를 이어 받았으면 follow 가 끝날 때 푼다
      }
    }
  }, [drop, fail, follow, markRead]);

  /** 새 창의 열기 요청 — 같은 계정·신원이고 아직 처리 안 한 번호만. 뜰 때(atMount)는 30초 안의 것만. 바쁘면 최신 하나 보류.
   *  처리 번호는 공유 '처리됨' 키에 적고 요청 키는 지우지 않는다(sessionStorage 는 window.open 이 복사해 줘 다시 연 창이 잊는다). */
  const takeOpenRequest = useCallback((req: OpenRequest | null, identity: string | undefined, atMount: boolean): boolean => {
    if (!options.popout || !req || !identity || req.account !== getAccountNamespace() || req.identity !== identity) return false;
    if (loadString(STORAGE_KEYS.agentPanelOpenDone) === req.nonce) return false;
    if (atMount && Date.now() - req.at > OPEN_REQUEST_TTL) return false;
    saveString(STORAGE_KEYS.agentPanelOpenDone, req.nonce);
    if (busy.current) pendingOpen.current = req;
    else void openConversation(req.id);
    return true;
  }, [openConversation, options.popout]);

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

  // 실행기가 Claude Code 를 설치하는 중이면 3초마다 다시 본다 — 끝나면(running 아님) 멈추고 화면이 그 단계로 넘어간다.
  //  로그인 창 기다림(2초·10분)과 따로다. 칸을 닫으면 정리로 멈춘다(설치 설계 2-v3-1b).
  const installing = claude?.install?.state === "running";
  useEffect(() => {
    if (!installing) return;
    const timer = window.setInterval(() => { if (!claudeInFlight.current) void recheck(); }, 3000);
    return () => window.clearInterval(timer);
  }, [installing, recheck]);

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
      // 처음 = 새 대화(마지막 대화를 열면 그 대화의 모델로 바뀐다) — 칸 설정의 새 대화 모델·깊이를 얹는다
      setChoice(withDefaults(s.engines, pickChoice(s.engines, loadJSON<AgentChoice>(STORAGE_KEYS.agentPanelModel)), readDefaults()));
      const claudeEngine = s.engines.find((e) => e.id === "claude");
      lastClaudeState.current = claudeEngine?.state ?? null;
      // Claude 를 못 쓰면 연결 안내에 필요한 지금 상태(스위치 포함)를 받는다 — 로그인 창이 열려 있으면 기다림부터
      if (connectSupported && claudeEngine && !claudeEngine.available) {
        void recheck().then((status) => { if (status?.state === "login_window") startWaiting(); });
      }
      // 새 창은 '새 창에서 열기' 요청이 마지막 대화 복원보다 먼저(서랍 메뉴 2-1)
      if (takeOpenRequest(readOpenRequest(), s.identity_key, true)) return;
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
    setNotice(null);
    if (session) setChoice((c) => withDefaults(session.engines, c, readDefaults())); // 칸 설정의 새 대화 모델·깊이
  }, [drop, session]);

  /** 모델·생각 깊이를 고른다. 엔진이 바뀌면 새 대화로 시작한다(보내는 중·진행 중엔 엔진을 바꾸지 않는다). */
  const choose = useCallback((next: AgentChoice) => {
    if (choice && next.engine !== choice.engine && busy.current) return;
    if (choice && next.engine !== choice.engine && (conversationId || messages.length)) newConversation();
    const fixed = { ...next, fast: next.engine === "claude" && next.model === "opus" ? !!next.fast : false };
    setChoice(fixed);
    // 빠른 모드는 기억하지 않는다(돈이 드니 칸을 열 때마다 꺼짐)
    saveJSON(STORAGE_KEYS.agentPanelModel, { engine: fixed.engine, model: fixed.model, effort: fixed.effort });
  }, [choice, conversationId, messages.length, newConversation]);

  /** 보낸다. 받아들였으면 true(입력칸을 비운다). 보내는 중·진행 중이면 아무것도 하지 않는다.
   *  attach = 이 말과 함께 붙인 자료(보내는 순간의 묶음 — 성공하면 부르는 쪽이 그 묶음만 비운다, 설계 2-1). */
  const send = useCallback(async (text: string, attach: AgentAttachments | null = null): Promise<boolean> => {
    const body = text.trim();
    if (!body || !choice || busy.current) return false;
    busy.current = true;
    setSending(true);
    setError(null);
    const stale = ticket();
    const account = getAccountNamespace();
    const fast = !!choice.fast && choice.engine === "claude" && choice.model === "opus";
    const attached = attach?.items.length ? attach : null;
    const genModel = readDefaults().gen_model; // 칸 설정 '먼저 쓸 생성 모델'
    // 캔버스 씬은 이 창에 그 보드가 실제로 붙어 있을 때만 싣는다 — 보내기 직전에 본다(손잡이가 바뀌어도 다시 그려지지 않으므로, 화면 동작 3-3b)
    const screen = contextRef.current;
    const host = screenRef.current;
    let ctx: AgentContext | Record<string, never> = screen;
    const full = screen as Partial<AgentContext>; // 빈 값('지금 화면' 칩을 뺌)이면 tab 이 없다
    if (host && typeof full.tab === "string" && full.scene && host.scene()?.sceneId !== full.scene.id) {
      const away: AgentContext = { ...(full as AgentContext), scene: undefined, scene_unavailable: "away" }; // undefined 는 보낼 때 빠진다
      ctx = away;
    }
    // 같은 요청인가 = 계정·대화·모델·깊이·빠른 모드·글·화면 정보·붙인 자료(와 그 공간)·먼저 쓸 생성 모델이 모두 같은가(허브는 같은 열쇠면 내용 비교 없이 그 차례를 돌려준다)
    const sig = JSON.stringify([conversationId, choice.engine, choice.model, choice.effort, fast, body, ctx,
      attached && { workspace: { scope: attached.workspace.scope, id: attached.workspace.id ?? null }, items: attached.items }, genModel ?? null]);
    const key = pendingSend?.account === account && pendingSend.sig === sig ? pendingSend.key : crypto.randomUUID();
    pendingSend = { account, sig, key }; // 받아들인 답을 화면에 붙이면 지운다
    const rememberedAtSend = remembered();
    try {
      const r = await agentChatApi.startTurn({
        idempotency_key: key,
        ...(conversationId ? { conversation_id: conversationId } : {}),
        engine: choice.engine, model: choice.model, effort: choice.effort, fast,
        text: body, context: ctx,
        ...(attached ? { attachments: attached.items, attach_workspace: attached.workspace } : {}),
        ...(genModel ? { gen_model: genModel } : {}),
        // 화면 정보를 뺀 차례('지금 화면' 칩을 끔)는 실행 창 번호도 싣지 않는다 — 화면 동작 불가(설계 3-1, 독립 리뷰 P2)
        ...(screenTab.current && typeof full.tab === "string" ? { screen_tab: screenTab.current } : {}),
      });
      if (stale()) {
        // 칸을 닫는 등 화면이 바뀐 뒤 온 접수 답 — 허브는 받아들였다. 같은 계정이고 그사이 사람이 다른 대화를 고르지 않았으면
        // 다음에 열 때 그 대화로 붙게 남긴다(더 최근 선택을 덮지 않게). 열쇠 기록은 남겨 둔다(같은 요청 재전송 = 같은 차례)
        if (getAccountNamespace() === account && remembered() === rememberedAtSend) remember(r.conversation_id);
        return false;
      }
      if (pendingSend?.key === key) pendingSend = null; // 받아들인 답을 화면에 붙였다
      setMessages((m) => [...m, { kind: "user", id: `${r.turn_id}:user`, text: body, ...(attached ? { attachments: attached.items } : {}) }]);
      setConversationId(r.conversation_id);
      currentId.current = r.conversation_id; // 다시 그리기 전에 끝남이 와도 읽음이 이 대화로 가게
      remember(r.conversation_id);
      setTurn({ id: r.turn_id, status: r.status });
      sentTurns.current.add(r.turn_id); // 이 마운트가 직접 보낸 차례 — 그 화면 동작만 실행한다
      void follow(r.turn_id, 0);
      return true;
    } catch (e) {
      if (stale()) return false;
      busy.current = false;
      if (isHttpStatus(e, 404) && conversationId) { // 다른 창에서 지워진 대화 — 비우고 새 대화로 보내게 안내
        forget(conversationId);
        setNotice("이 대화는 지워졌어요 — 새 대화로 다시 보내 주세요");
        return false;
      }
      if (isHttpStatus(e, 409) && conversationId && current?.fork_state) { // 시작 전 포크가 거절됨 — 안내·잠금을 새 상태로
        const id = conversationId;
        agentChatApi.conversation(id).then((r) => { if (!stale() && currentId.current === id) setCurrent(r.conversation); }, () => {});
      }
      fail(e);
      return false;
    } finally {
      if (!stale()) setSending(false);
    }
  }, [choice, conversationId, current, fail, follow, forget]);

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

  // 실행 응답은 계획(제목·프롬프트)을 바꾸지 않는다 — 진행은 스냅샷 규칙으로만(늦은 응답이 새 상태를 못 되돌림, 설계 A2-3)
  const setExec = (planId: string, exec: PlanMessage["exec"], response?: AgentPlan & { snapshot?: AgentPlanSnapshot }) =>
    setMessages((list) => list.map((m) => {
      if (m.kind !== "plan" || m.plan.plan_id !== planId) return m;
      const next = { ...m, exec };
      if (!response) return next;
      return response.snapshot ? applyPlanSnapshot(next, response.snapshot) : fillPlanProgress(next, response);
    }));

  // 계획 카드가 새로 보이면 견적을 한 번 묻는다(무료 조회). 실패해도 카드·실행은 그대로 — '확인하지 못했어요'로 보인다.
  useEffect(() => {
    for (const m of messages) {
      // 포크 전 계획(plan.forked)은 묻지 않는다 — 이 대화에서 실행·견적할 수 없다(포크 설계 2-4)
      if (m.kind !== "plan" || m.plan.forked || m.estimate || estimating.current.has(m.plan.plan_id)) continue;
      const planId = m.plan.plan_id;
      const conversation = currentId.current;
      if (!conversation) continue; // 대화 id 를 받은 뒤에 묻는다(허브가 계획을 만든 대화와 대조)
      estimating.current.add(planId);
      const stale = ticket();
      const put = (credits: number | null) => {
        if (stale()) return;
        setMessages((list) => list.map((x) => (x.kind === "plan" && x.plan.plan_id === planId ? { ...x, estimate: { credits } } : x)));
      };
      agentChatApi.estimatePlan(planId, conversation).then((r) => put(typeof r.total_credits === "number" ? r.total_credits : null), () => put(null));
    }
    // ticket 은 매번 새로 만드는 표라 넣지 않는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, conversationId]);

  /** [실행] — 사람만 누른다. 허브의 앱 입구가 계획을 다시 읽어 확인한 뒤 낸다(두 번 눌러도 한 번만 나간다 — 허브의 선점).
   *  지금 대화 id 는 누르는 순간의 참조로(닫힌 콜백의 옛 id 가 아니라 — 포크 설계 Codex 2차 P2). */
  const executePlan = useCallback(async (planId: string) => {
    const conversation = currentId.current;
    if (executing.current.has(planId) || !conversation) return;
    executing.current.add(planId);
    setExec(planId, { state: "running" });
    const stale = ticket();
    try {
      const plan = await agentChatApi.executePlan(planId, conversation);
      if (stale()) return;
      // 200 이어도 접수됐다는 뜻은 아니다 — submitted 만 '보냈어요', attention(거절·접수 불명확)은 따로 알린다
      if (plan.status === "submitted") setExec(planId, { state: "done" }, plan);
      else setExec(planId, { state: "failed", message: plan.status === "attention"
        ? "일부 항목을 접수하지 못했거나 접수 여부를 확인하지 못했어요 — 다시 누르지 말고 라이브러리에서 확인하세요"
        : `실행 상태를 확인하지 못했어요(${plan.status ?? "알 수 없음"}) — 라이브러리에서 확인하세요` }, plan);
    } catch (e) {
      if (stale()) return;
      executing.current.delete(planId);
      if (e instanceof AccountChangedError) fail(e);
      else setExec(planId, { state: "failed", message: errorDetail(e) });
    }
  }, [fail]);

  const loadConversations = useCallback(async () => {
    const stale = ticket();
    const sentAt = changeSeq.current;
    try {
      const r = await agentChatApi.conversations();
      if (!stale()) {
        // 지운 뒤에 보낸 조회에 그 대화가 있으면 허브에 있다는 뜻 — 지움 표시를 푼다(다시 나온 줄의 응답을 putSummary 가 버리지 않게)
        for (const c of r.conversations) {
          const change = changedAt.current.get(c.id);
          if (change?.deleted && change.seq <= sentAt) changedAt.current.set(c.id, { seq: change.seq, deleted: false });
        }
        // 보낸 뒤 이 창에서 바꾼 줄 — 지운 줄은 빼고, 고친 줄은 지금 화면 값(목록에 없었으면 받은 요약)을 지킨다(늦게 온 옛 조회가 덮지 않게)
        setConversations((prev) => {
          const kept = new Map((prev ?? []).map((c) => [c.id, c]));
          const listed = new Set(r.conversations.map((c) => c.id));
          // 보낸 뒤 이 창에서 받은 요약 중 지우지 않았고 응답에 없는 줄(방금 만든 포크 등)은 맨 앞에 붙인다(포크 설계 2-4)
          const fresh = [...changedAt.current].flatMap(([id, change]) => (
            change.seq > sentAt && !change.deleted && change.summary && !listed.has(id) ? [kept.get(id) ?? change.summary] : []));
          return [...fresh, ...r.conversations.flatMap((c) => {
            const change = changedAt.current.get(c.id);
            if (!change || change.seq <= sentAt) return [c];
            if (change.deleted) return [];
            return [kept.get(c.id) ?? { ...c, ...(change.summary ?? {}) }];
          })];
        });
        setTruncated(!!r.truncated);
      }
    } catch (e) {
      if (!stale()) fail(e);
    }
  }, [fail]);

  // ── 서랍 메뉴 동작(설계 2-1) — 허브가 돌려준 요약으로 목록 한 줄만 바꾼다 ──
  const patchConversation = useCallback(async (id: string, body: AgentConversationPatch): Promise<boolean> => {
    try {
      const r = await agentChatApi.patchConversation(id, body);
      putSummary(r.conversation);
      if (id === currentId.current && body.title !== undefined) setTitle(r.conversation.title);
      return true;
    } catch (e) {
      if (isHttpStatus(e, 404)) forget(id);
      else fail(e);
      return false;
    }
  }, [fail, forget]);

  /** 지우기 — 허브의 세션 파일 정리 결과를 돌려준다(실패면 null). 다른 창에도 알린다. */
  const removeConversation = useCallback(async (id: string): Promise<AgentSessionFileResult | null> => {
    try {
      const r = await agentChatApi.deleteConversation(id);
      forget(id);
      saveJSON(STORAGE_KEYS.agentPanelDeleted, { account: getAccountNamespace(), id, at: Date.now() });
      return r.session_file;
    } catch (e) {
      if (isHttpStatus(e, 404)) {
        forget(id);
        return "none";
      }
      fail(e);
      return null;
    }
  }, [fail, forget]);

  /** 포크(docs/status/MVAgent_포크_2026-11-12.md 2-4) — 원래 대화마다 요청 번호 하나(응답을 잃고 다시 눌러도 같은 포크), 누르는 중엔
   *  다시 못 누름. 받은 요약을 목록 맨 위에 넣고 '이 창에서 바꾼 줄'로 남긴다. 계정이 바뀌면 버리고, 그사이 화면이 바뀌었으면
   *  (다른 대화·새 대화) 목록에만 넣는다. 돌려주는 것 = 연 포크 id(못 열었으면 null). */
  const forkRequests = useRef(new Map<string, string>());
  const forkingNow = useRef(false); // 같은 렌더에서 두 번 불려도 하나만 — 상태(forking)는 다음 렌더에야 바뀐다(포크 독립 리뷰 P2)
  const [forking, setForking] = useState(false);
  const forkConversation = useCallback(async (sourceId: string): Promise<string | null> => {
    if (forkingNow.current || busy.current) return null;
    forkingNow.current = true;
    const requestId = forkRequests.current.get(sourceId) ?? crypto.randomUUID();
    forkRequests.current.set(sourceId, requestId);
    setForking(true);
    const account = getAccountNamespace();
    const stale = ticket();
    try {
      const r = await agentChatApi.forkConversation(sourceId, requestId);
      forkRequests.current.delete(sourceId);
      if (getAccountNamespace() !== account) return null;
      touch(r.conversation.id, { summary: r.conversation });
      setConversations((list) => (list ? [r.conversation, ...list.filter((c) => c.id !== r.conversation.id)] : [r.conversation]));
      if (stale()) return null; // 그사이 다른 대화를 열었거나 새 대화를 시작했다 — 자동으로 열지 않는다
      await openConversation(r.conversation.id);
      return r.conversation.id;
    } catch (e) {
      if (isHttpStatus(e, 400, 404, 409, 413, 422)) forkRequests.current.delete(sourceId); // 허브가 거절 — 다음엔 새 번호
      if (getAccountNamespace() === account) setError(errorDetail(e));
      return null;
    } finally {
      forkingNow.current = false;
      setForking(false);
    }
    // ticket·touch 는 매번 새로 만드는 표·함수라 넣지 않는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openConversation]);

  /** 옆 칸의 '새 창에서 열기' — 새 창이 받을 요청을 적는다(창을 여는 것은 부르는 쪽의 onPopOut). */
  const requestOpenInWindow = useCallback((id: string) => {
    if (!session?.identity_key) return false;
    saveJSON(STORAGE_KEYS.agentPanelOpenRequest,
      { account: getAccountNamespace(), identity: session.identity_key, id, nonce: crypto.randomUUID(), at: Date.now() });
    return true;
  }, [session]);

  // 다른 창 알림 — 지운 대화는 비우고, 새 창은 열기 요청을 받는다
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEYS.agentPanelDeleted) {
        const gone = loadJSON<{ account?: string; id?: string }>(STORAGE_KEYS.agentPanelDeleted);
        if (!gone || gone.account !== getAccountNamespace() || typeof gone.id !== "string") return;
        const watching = currentId.current === gone.id || loadingId.current === gone.id;
        forget(gone.id);
        if (watching) setNotice("이 대화는 다른 창에서 지워졌어요");
      } else if (event.key === STORAGE_KEYS.agentPanelOpenRequest) {
        takeOpenRequest(readOpenRequest(), session?.identity_key, false);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [forget, takeOpenRequest, session]);

  // 숨은 창에서 받은 끝남 — 다시 보이면 그 번호로 읽음(지금 보는 대화일 때만)
  useEffect(() => {
    const onVisible = () => {
      const pending = pendingRead.current;
      if (pending && visible() && pending.id === currentId.current) markRead(pending.id, pending.rev);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [markRead]);

  // 바쁠 때 온 새 창 열기 요청 — 풀리면 연다
  useEffect(() => {
    if (sending || (turn && !TERMINAL_TURN.has(turn.status)) || busy.current || !pendingOpen.current) return;
    const req = pendingOpen.current;
    pendingOpen.current = null;
    void openConversation(req.id);
  }, [sending, turn, openConversation]);

  const running = !!turn && !TERMINAL_TURN.has(turn.status);
  const claudeEngine = session?.engines.find((e) => e.id === "claude");
  const claudeState = claude?.state ?? claudeEngine?.state ?? null;
  return {
    session, choice, choose, conversationId, title, current, messages, turn, running, sending, error, usage,
    conversations, loadConversations, openConversation, newConversation, send, cancel, executePlan, forkConversation, forking, undoAction,
    truncated, notice, dismissNotice: () => setNotice(null), patchConversation, removeConversation, requestOpenInWindow,
    // Claude 연결 — 허브가 연결 경로를 알 때만 안내(옛 허브는 엔진 사유만)
    connect: {
      supported: connectSupported && !!claudeEngine,
      state: claudeState,
      version: claude?.version ?? claudeEngine?.version ?? null,
      allowed: !!claudeEngine?.available,
      loginWindowEnabled: !!claude?.login_window_enabled,
      install: claude?.install ?? null,
      waiting, note: loginNote, connected,
      recheck, connect, stopWaiting, dismissConnected: () => setConnected(null),
    },
  };
}
