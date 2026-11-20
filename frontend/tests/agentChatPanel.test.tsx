// @vitest-environment jsdom
// Ask Agent 옆 칸(docs/status/AskAgent_옆칸_설계_2026-11-09.md 3-1·3-5·10절) — 가짜는 바깥 경계(fetch)에만 둔다.
//  보내기 → 긴 기다림으로 사건 받기(text_delta 는 붙고 text 는 덩어리를 바꾼다) · 계획 [실행] · 두 번 보내기 막음 ·
//  패널 표 401 → 같은 계정일 때만 한 번 다시 보냄 · 계정이 바뀐 뒤의 늦은 답 버림 · 엔진을 바꾸면 새 대화 · 닫았다 열면 이어 붙기.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPanel } from "../src/components/agent-chat/AgentPanel";
import type { CanvasInputCommand } from "../src/features/canvas/api";
import { applyCanvasEdit, type CanvasEditCommand } from "../src/features/canvas/edits";
import type { AgentConversationSummary, AgentEvent, AgentTurnRecord } from "../src/lib/agentChatApi";
import type { ScreenHost } from "../src/lib/agentScreenActions";
import type { SceneCard, SceneEdge, SceneGroup } from "../src/lib/scenes";
import { getAccountNamespace } from "../src/lib/accountScope";
import { STORAGE_KEYS } from "../src/lib/storageKeys";
import { getAuthToken, setAuthToken } from "../src/lib/http";
import { applyAgentEvent, type AgentMessage } from "../src/lib/useAgentChat";
import { setHubFeatures } from "../src/lib/hubFeatures";
import { resetModelCatalogCache } from "../src/lib/modelCatalogCache";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Call = { path: string; method: string; headers: Record<string, string>; body?: Record<string, unknown>; signal?: AbortSignal };
let calls: Call[];
let route: (call: Call) => Response | Promise<Response>;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const ENGINES = [
  { id: "claude", available: true, version: "2.1.296", reason: null, state: "ready", subscription: "Max", efforts: ["low", "medium", "high", "xhigh", "max"],
    models: [{ id: "opus", label: "Opus 5.5" }, { id: "sonnet", label: "Sonnet 5.5" }, { id: "haiku", label: "Haiku 5.5" }, { id: "fable", label: "Fable 5.1" }] },
  { id: "codex", enabled: true, available: true, version: "0.162.0-alpha.17.2", reason: null, efforts: ["low", "medium", "high"],
    models: [{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol" }, { id: "gpt-6-astra", label: "GPT-6 Astra" }] },
];
const session = (email = "jay@example.com", secret = "s1", identity = "id-1") =>
  json({ secret, account_email: email, identity_key: identity, engines: ENGINES });
const started = (turnId = "t1", conversationId = "c1") => json({ turn_id: turnId, conversation_id: conversationId, status: "running" });
const PLAN = { plan_id: "p1", title: "고양이 컷 4장", status: "draft", items: [{ model: "Nano Banana 2", prompt: "고양이" }], workspace: { scope: "personal", name: null } };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  resetModelCatalogCache();
  localStorage.clear();
  sessionStorage.clear();
  sessionStorage.setItem("ch.accountScope", "jay@example.com");
  calls = [];
  route = (c) => (c.path === "/session" ? session() : json({ detail: "Not Found" }, 404));
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
    const call: Call = {
      path: String(url).replace("/api/agent-chat", ""), method: init.method ?? "GET", headers: { ...(init.headers as Record<string, string>) },
      body: init.body ? JSON.parse(String(init.body)) : undefined, signal: init.signal ?? undefined,
    };
    calls.push(call);
    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    Promise.resolve().then(() => route(call)).then(resolve, reject);
  })));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  setAuthToken(null);
});

const flush = async (times = 10) => {
  for (let i = 0; i < times; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};
const panel = () => host.querySelector<HTMLElement>(".agent-panel")!;
const texts = (selector: string) => [...host.querySelectorAll(selector)].map((el) => el.textContent);
const input = () => host.querySelector<HTMLTextAreaElement>(".agent-input")!;
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const turnCalls = () => calls.filter((c) => c.path === "/turns" && c.method === "POST");
async function mount() {
  act(() => root.render(<AgentPanel context={{ tab: "my", folder: "e001" }} contextLabel="워크스페이스 › e001" onClose={() => {}} />));
  await flush();
}
function type(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const enter = () => act(() => { input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
function searchModel(value: string) {
  act(() => {
    const search = host.querySelector<HTMLInputElement>(".agent-model-search")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, value);
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
/** 모델 칩 메뉴의 찾기로 그 모델을 고른다 */
function pickModel(label: string) {
  act(() => host.querySelector<HTMLButtonElement>(".agent-model-btn")!.click());
  searchModel(label);
  const item = [...host.querySelectorAll<HTMLButtonElement>(".agent-model-menu .agent-model-item[aria-pressed]")].find((b) => b.textContent?.includes(label))!;
  act(() => item.click());
}
/** 모델 칩 메뉴에서 회사 줄을 눌러 그 회사의 첫 모델을 고른다 */
function pickCompany(name: string) {
  act(() => host.querySelector<HTMLButtonElement>(".agent-model-btn")!.click());
  act(() => [...host.querySelectorAll<HTMLButtonElement>(".agent-model-row")].find((b) => b.textContent?.includes(name))!.click());
  act(() => host.querySelector<HTMLButtonElement>(`.agent-model-sub[aria-label="${name}"] .agent-model-item`)!.click());
}
const effortBtn = () => host.querySelector<HTMLButtonElement>(".agent-effort-btn")!;
const menuRadios = (group: string) => [...host.querySelectorAll<HTMLButtonElement>(`.agent-effort-menu [role="radiogroup"][aria-label="${group}"] [role="radio"]`)];
function pickSelect(label: string, value: string) {
  act(() => {
    const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("Ask Agent 옆 칸", () => {
  it("StrictMode에서도 엔진당 한 번 바깥 연결하고 칸 비밀값을 보내지 않는다", async () => {
    route = (c) => c.path === "/session" ? session("jay@example.com", "s-external", "external-strict")
      : c.path === "/api/mcp/v2/app/agent-link" ? json({ clients: [{ client: (c.body?.engines as string[])[0], status: "configured", access: "allowed" }] })
      : json({}, 404);
    act(() => root.render(<StrictMode><AgentPanel context={{ tab: "my" }} contextLabel="" onClose={() => {}} /></StrictMode>));
    await flush();
    const links = calls.filter((c) => c.path === "/api/mcp/v2/app/agent-link");
    expect(links).toHaveLength(2);
    expect(links.map((c) => c.body?.engines)).toEqual([["claude"], ["codex"]]);
    for (const call of links) {
      expect(call.body?.identity_key).toBe("external-strict");
      expect(call.headers["X-MVHub-Expect-Account"]).toBe("acct:jay@example.com");
      expect(call.headers["X-MVHub-Tab"]).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
      expect(call.headers["X-MVHub-Panel"]).toBeUndefined();
    }
    expect(input()).toBeTruthy();
  });

  it("바깥 연결 실패는 칸을 막지 않고 다시 확인으로만 재시도하며 off는 유지한다", async () => {
    let attempts = 0;
    route = (c) => {
      if (c.path === "/session") return session("jay@example.com", "s-external", "external-retry");
      if (c.path === "/api/mcp/v2/app/agent-link") {
        const engine = (c.body?.engines as string[])[0];
        if (engine === "codex") return json({ clients: [{ client: engine, status: "off" }] });
        attempts += 1;
        return attempts === 1 ? json({}, 503) : json({ clients: [{ client: engine, status: "configured", access: "allowed" }] });
      }
      return json({}, 404);
    };
    await mount();
    expect(input()).toBeTruthy();
    expect(attempts).toBe(1);
    act(() => host.querySelector<HTMLButtonElement>(".agent-model-btn")!.click());
    act(() => [...host.querySelectorAll<HTMLButtonElement>(".agent-model-item")].find((b) => b.textContent === "설정")!.click());
    expect(host.textContent).toContain("허용 설정 확인 실패");
    const external = [...host.querySelectorAll<HTMLElement>('[role="status"]')].find((el) => el.textContent?.includes("바깥 앱 연결"))!;
    act(() => [...external.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "연결 다시 확인")!.click());
    await flush();
    expect(attempts).toBe(2);
    expect(host.textContent).toContain("등록·허용 설정 완료");
    expect(calls.filter((c) => c.path === "/api/mcp/v2/app/agent-link" && (c.body?.engines as string[])[0] === "codex")).toHaveLength(1);
  });

  it("계정이 바뀐 뒤 바깥 연결의 늦은 성공을 표시하지 않는다", async () => {
    const pending = deferred<Response>();
    route = (c) => c.path === "/session" ? session("jay@example.com", "s-external", "external-stale")
      : c.path === "/api/mcp/v2/app/agent-link" ? pending.promise : json({}, 404);
    await mount();
    act(() => host.querySelector<HTMLButtonElement>(".agent-model-btn")!.click());
    act(() => [...host.querySelectorAll<HTMLButtonElement>(".agent-model-item")].find((b) => b.textContent === "설정")!.click());
    sessionStorage.setItem("ch.accountScope", "other@example.com");
    pending.resolve(json({ clients: [{ client: "claude", status: "configured", access: "allowed" }, { client: "codex", status: "configured", access: "allowed" }] }));
    await flush();
    expect(host.textContent).not.toContain("등록·허용 설정 완료");
  });
  it("Codex 선택 중에도 설정의 Claude 안내·연결 요청 오류가 보인다", async () => {
    setHubFeatures(["agent_chat_v1", "agent_chat_connect_v1"]);
    const engines = ENGINES.map((e) => e.id === "claude" ? { ...e, state: "not_logged_in", available: false, subscription: null, reason: "Claude 로그인이 필요해요 — 설정에서 연결" } : e);
    route = (c) => {
      if (c.path === "/session") return json({ secret: "s1", account_email: "jay@example.com", identity_key: "id-1", engines });
      if (c.path === "/claude") return json({ state: "not_logged_in", version: "2.1.296", subscription: null, login_window: false, login_window_enabled: true, engines });
      if (c.path === "/claude/login") return json({ detail: "권한을 확인하지 못해 버튼 연결을 쓸 수 없어요" }, 409, { "X-MVHub-Claude-Error": "login_window_unsupported" });
      return json({ detail: "Not Found" }, 404);
    };
    try {
      await mount();
      pickModel("GPT-6.1 Sol");
      expect(host.querySelector(".cn")).toBeNull();
      act(() => host.querySelector<HTMLButtonElement>(".agent-model-btn")!.click());
      expect(texts(".agent-model-row")).toEqual(["✳Claude미연결", "ChatGPT"]); // ChatGPT 처럼 긴 까닭 대신 한 단어(Jay 11-19)
      act(() => [...host.querySelectorAll<HTMLButtonElement>(".agent-model-item")].find((b) => b.textContent === "설정")!.click());
      const settings = () => host.querySelector<HTMLElement>(".agent-settings")!;
      expect(settings().textContent).toContain("로그인 안 됨");
      expect(settings().querySelector("summary")!.textContent).toBe("직접 하려면(PowerShell)");
      act(() => [...settings().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "연결")!.click());
      await flush();
      expect(settings().querySelector('[role="alert"]')!.textContent).toBe("권한을 확인하지 못해 버튼 연결을 쓸 수 없어요");
      expect(settings().textContent).toContain("PowerShell 로 연결");
      expect(settings().querySelector(".cn-code span")!.textContent).toBe("claude auth login");
      expect(host.querySelector(".agent-model-btn")!.textContent).toContain("GPT-6.1 Sol");
    } finally {
      setHubFeatures([]);
    }
  });

  it("설정 Codex 연결 — 확인 중·실패 사유·다시 연결·끄기와 엔진 목록 갱신", async () => {
    let enabled = false;
    const engines = () => ENGINES.map((e) => e.id === "codex"
      ? { ...e, enabled, available: enabled, reason: enabled ? null : "설정에서 [연결]을 눌러 켜요" } : e);
    const checking = deferred<Response>();
    let attempts = 0;
    route = (c) => {
      if (c.path === "/session") return json({ secret: "s1", account_email: "jay@example.com", identity_key: "id-1", engines: engines() });
      if (c.path === "/codex/enable") {
        attempts += 1;
        if (attempts === 1) return checking.promise;
        enabled = true;
        return json({ engines: engines() });
      }
      if (c.path === "/codex/disable") {
        enabled = false;
        return json({ engines: engines() });
      }
      return json({ detail: "Not Found" }, 404);
    };
    await mount();
    act(() => host.querySelector<HTMLButtonElement>(".agent-model-btn")!.click());
    act(() => [...host.querySelectorAll<HTMLButtonElement>(".agent-model-item")].find((b) => b.textContent === "설정")!.click());
    expect(host.textContent).toContain("꺼짐 · 설정에서 [연결]을 눌러 켜요");
    act(() => button("Codex 연결")!.click());
    await flush();
    expect(button("Codex 연결")!.disabled).toBe(true);
    expect(host.textContent).toContain("확인하는 중");
    checking.resolve(json({ detail: "연결 점검을 통과하지 못했어요" }, 409));
    await flush();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("연결 점검을 통과하지 못했어요");
    expect(button("Codex 연결")!.disabled).toBe(false);
    act(() => button("Codex 연결")!.click());
    await flush();
    expect(host.textContent).toContain("이 PC 에서 켬");
    expect(button("Codex 끄기")).not.toBeNull();
    expect(host.querySelector(".agent-codex-error")).toBeNull();
    act(() => button("Codex 끄기")!.click());
    await flush();
    expect(host.textContent).toContain("꺼짐 · 설정에서 [연결]을 눌러 켜요");
    expect(button("Codex 연결")).not.toBeNull();
    expect(calls.filter((c) => c.path.startsWith("/codex/")).map((c) => [c.path, c.method])).toEqual([
      ["/codex/enable", "POST"], ["/codex/enable", "POST"], ["/codex/disable", "POST"],
    ]);
  });

  const restoredHistory = () => ({
    conversation: { id: "restored-1", title: "복원한 작업", engine: "claude", model: "opus", effort: "medium", updated_at: "", resumable: false, restored_from: "backup-1" },
    turns: [{ id: "old-turn", status: "running", text: "옛 요청", created_at: "", attachments: { items: [{ kind: "generation", id: "old-attachment" }] }, events: [
      { seq: 1, kind: "plan", plan: PLAN },
      { seq: 2, kind: "plan_progress", plan_id: "p1", observed_at: "9", plan_status: "submitted", items: [{ index: 0, state: "submitted", generation_id: "g-old", generation_status: "done" }] },
    ] }],
    plans: [], references: [{ plan_id: "p1", status: "missing", generations: [{ id: "g-old", status: "unchecked" }] }],
    restore_reference: { source_conversation_id: "restored-1", turns: [{ you: "옛 요청", answer: "옛 답" }], included_turns: 1, earlier_turns: 3, truncated: true, note: "참고 자료" },
  });
  const openRestored = async () => {
    localStorage.setItem(STORAGE_KEYS.agentPanelConversation, JSON.stringify({ account: getAccountNamespace(), id: "restored-1" }));
    await mount();
  };
  const useRestored = () => act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "이 기록으로 새 대화")!.click());

  it("복원 기록은 옛 실행·견적·폴링을 멈추고, 새 대화 버튼 뒤 별도 전송에서만 참고 ID를 보낸다", async () => {
    route = (c) => c.path === "/session" ? session()
      : c.path === "/conversations/restored-1" ? json(restoredHistory())
      : c.path === "/turns" ? started("new-turn", "new-chat")
      : c.path.startsWith("/turns/new-turn/events") ? json({ events: [], status: "done", last_seq: 0 })
      : json({ detail: "Not Found" }, 404);
    await openRestored();
    expect(input().disabled).toBe(true);
    expect(button("고쳐 보내기")).toBeNull();
    expect(host.textContent).toContain("자료 없음");
    expect(host.textContent).toContain("확인 전");
    expect(host.querySelector(".agent-plan-sent, .agent-plan-run")).toBeNull();
    expect(calls.some((c) => c.path.startsWith("/plans/") || c.path.startsWith("/turns/old-turn"))).toBe(false);
    act(() => button("정보")!.click());
    expect(host.querySelector(".agent-info-grid")).toBeNull();
    expect(host.textContent).toContain("복원 기록의 자료 상태는 계획 카드에서 확인하세요");
    expect(calls.some((c) => c.path.includes("/generations/"))).toBe(false);
    expect(host.querySelector(".agent-sent img")).toBeNull();
    useRestored();
    await flush();
    expect(input().disabled).toBe(false);
    expect(turnCalls()).toHaveLength(0);
    expect(host.textContent).toContain("1턴 포함 · 3턴 제외 · 긴 글 일부 생략");
    expect(host.textContent).toContain("도구·계획·첨부 제외");
    pickModel("GPT-6.1 Sol");
    expect(host.textContent).toContain("보낼 모델: codex · GPT-6.1 Sol");
    type("지금 할 일"); enter(); await flush();
    expect(turnCalls()).toHaveLength(1);
    expect(turnCalls()[0].body).toMatchObject({ text: "지금 할 일", source_conversation_id: "restored-1", engine: "codex" });
    expect(turnCalls()[0].body).not.toHaveProperty("conversation_id");
    expect(button("참고 기록 빼기")).toBeNull();
  });

  it("참고 전송 실패는 작성 내용을 보존하고 재시도에 같은 열쇠를 쓰며, 404면 참고만 제거한다", async () => {
    let sendStatus = 500;
    route = (c) => c.path === "/session" ? session()
      : c.path === "/conversations/restored-1" ? json(restoredHistory())
      : c.path === "/turns" ? json({ detail: "시험 실패" }, sendStatus) : json({}, 404);
    await openRestored(); useRestored(); await flush();
    type("이 내용은 남겨 주세요"); enter(); await flush();
    expect(input().value).toBe("이 내용은 남겨 주세요");
    expect(button("참고 기록 빼기")).toBeTruthy();
    enter(); await flush();
    expect(turnCalls()[1].body?.idempotency_key).toBe(turnCalls()[0].body?.idempotency_key);
    sendStatus = 404; enter(); await flush();
    expect(button("참고 기록 빼기")).toBeNull();
    expect(input().value).toBe("이 내용은 남겨 주세요");
    expect(host.textContent).toContain("참고 기록을 찾을 수 없어요");
  });

  it.each([500, 503, "network"])("복원 초안의 접수 불명(%s) 뒤 편집 재전송은 같은 key로 저장된 대화를 채택한다", async (failure) => {
    let attempt = 0;
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/conversations/restored-1") return json(restoredHistory());
      if (c.path === "/turns") {
        attempt += 1;
        if (attempt === 1) return failure === "network" ? Promise.reject(new TypeError("Failed to fetch")) : json({ detail: "접수 답 실패" }, failure);
        return json({ turn_id: attempt === 2 ? "accepted-turn" : "next-turn", conversation_id: "accepted-chat", status: "failed" });
      }
      if (c.path === "/conversations/accepted-chat") return json({
        conversation: { id: "accepted-chat", title: "접수된 대화", engine: "claude", model: "opus", effort: "medium", resumable: true },
        turns: [{ id: "accepted-turn", status: "failed", text: "먼저 보낸 글", events: [] }],
      });
      return json({ events: [], status: "failed", last_seq: 0 });
    };
    await openRestored(); useRestored(); await flush();
    type("먼저 보낸 글"); enter(); await flush();
    type("수정한 초안"); enter(); await flush();
    expect(turnCalls()).toHaveLength(2);
    expect(turnCalls()[1].body!.idempotency_key).toBe(turnCalls()[0].body!.idempotency_key);
    expect(input().value).toBe("수정한 초안");
    expect(texts(".agent-user-wrap").join(" ")).toContain("먼저 보낸 글");
    expect(texts(".agent-user-wrap").join(" ")).not.toContain("수정한 초안");
    expect(host.textContent).toContain("접수된 대화를 불러왔습니다. 작성 내용은 남겨 두었습니다.");
    enter(); await flush();
    expect(turnCalls()[2].body).toMatchObject({ conversation_id: "accepted-chat", text: "수정한 초안" });
    expect(turnCalls()[2].body).not.toHaveProperty("source_conversation_id");
    expect(turnCalls()[2].body!.idempotency_key).not.toBe(turnCalls()[0].body!.idempotency_key);
  });

  it("복원 초안이 다른 글로 한 번이라도 재전송되면 원래 글로 돌아와도 실제 저장된 글을 채택한다", async () => {
    let attempt = 0;
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/conversations/restored-1") return json(restoredHistory());
      if (c.path === "/turns") return ++attempt < 3 ? Promise.reject(new TypeError("Failed to fetch"))
        : json({ turn_id: "accepted-turn", conversation_id: "accepted-chat", status: "failed" });
      if (c.path === "/conversations/accepted-chat") return json({
        conversation: { id: "accepted-chat", title: "접수된 편집본", engine: "claude", model: "opus", effort: "medium", resumable: true },
        turns: [{ id: "accepted-turn", status: "failed", text: "편집본이 먼저 저장됨", events: [] }],
      });
      return json({}, 404);
    };
    await openRestored(); useRestored(); await flush();
    type("원래 글"); enter(); await flush();
    type("편집본이 먼저 저장됨"); enter(); await flush();
    type("원래 글"); enter(); await flush();
    expect(new Set(turnCalls().map((c) => c.body!.idempotency_key)).size).toBe(1);
    expect(texts(".agent-user-wrap").join(" ")).toContain("편집본이 먼저 저장됨");
    expect(texts(".agent-user-wrap").join(" ")).not.toContain("원래 글");
    expect(input().value).toBe("원래 글");
  });

  it("복원 재시도의 대화 조회 실패는 참고와 key를 보존하고, 새 초안을 명시하면 옛 key를 재사용하지 않는다", async () => {
    let attempt = 0;
    let reads = 0;
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/conversations/restored-1") return json(restoredHistory());
      if (c.path === "/turns") return ++attempt === 1 ? json({ detail: "접수 답 실패" }, 500)
        : json({ turn_id: "accepted-turn", conversation_id: "accepted-chat", status: "failed" });
      if (c.path === "/conversations/accepted-chat") return ++reads === 1 ? json({ detail: "대화 조회 실패" }, 500) : json({
        conversation: { id: "accepted-chat", title: "접수된 대화", engine: "claude", model: "opus", effort: "medium", resumable: true },
        turns: [{ id: "accepted-turn", status: "failed", text: "원래 글", events: [] }],
      });
      return json({}, 404);
    };
    await openRestored(); useRestored(); await flush();
    type("원래 글"); enter(); await flush();
    type("남길 편집본"); enter(); await flush();
    expect(button("참고 기록 빼기")).not.toBeNull();
    expect(input().value).toBe("남길 편집본");
    enter(); await flush();
    expect(new Set(turnCalls().map((c) => c.body!.idempotency_key)).size).toBe(1);
    expect(host.textContent).toContain("접수된 대화를 불러왔습니다");
    const oldKey = turnCalls()[0].body!.idempotency_key;
    act(() => root.unmount()); root = createRoot(host);
    await openRestored(); useRestored(); await flush();
    type("명시한 새 초안"); enter(); await flush();
    expect(turnCalls().at(-1)!.body!.idempotency_key).not.toBe(oldKey);
  });

  it("복원 초안은 화면 문맥만 바뀌어도 같은 key이고, 허브 신원이 바뀌면 재발급 뒤 전송하지 않는다", async () => {
    let attempt = 0;
    let changed = false;
    route = (c) => {
      if (c.path === "/session") return session("jay@example.com", changed ? "s2" : "s1", changed ? "id-2" : "id-1");
      if (c.path === "/conversations/restored-1") return json(restoredHistory());
      if (c.path === "/turns") {
        if (++attempt === 1) return Promise.reject(new TypeError("Failed to fetch"));
        changed = true;
        return json({ detail: "패널 만료" }, 401, { "X-MVHub-Panel-Error": "session" });
      }
      return json({}, 404);
    };
    await openRestored(); useRestored(); await flush();
    type("유지할 글"); enter(); await flush();
    act(() => root.render(<AgentPanel context={{ tab: "my", folder: "e002" }} contextLabel="다른 폴더" onClose={() => {}} />));
    await flush(); enter(); await flush();
    expect(turnCalls()).toHaveLength(2);
    expect(turnCalls()[1].body!.idempotency_key).toBe(turnCalls()[0].body!.idempotency_key);
    expect(turnCalls().every((c) => c.headers["X-MVHub-Panel"] !== "s2")).toBe(true);
    expect(input().value).toBe("유지할 글");
    expect(button("참고 기록 빼기")).toBeNull();
  });

  it("복원 참조 조회에서 빠진 계획도 확인 전이며 공간 전환은 보내기 전 참고를 제거한다", async () => {
    route = (c) => c.path === "/session" ? session()
      : c.path === "/conversations/restored-1" ? json({ ...restoredHistory(), references: [] }) : json({}, 404);
    await openRestored();
    expect(host.textContent).toContain("계획 자료: 확인 전");
    useRestored(); await flush(); type("남길 초안");
    act(() => root.render(<AgentPanel context={{ tab: "my", workspace: { scope: "team", id: "other-team" } }} contextLabel="다른 팀" onClose={() => {}} />));
    await flush();
    expect(button("참고 기록 빼기")).toBeNull();
    expect(input().value).toBe("남길 초안");
    expect(turnCalls()).toHaveLength(0);
  });

  it("보내면 차례를 열고 사건을 받는다 — text_delta 는 붙고 text 는 그 덩어리를 바꾸며, 계획 카드의 [실행]은 실행 입구를 한 번만 부른다", async () => {
    const rest = deferred<Response>();
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/turns") return started();
      if (c.path === "/turns/t1/events?after=0") {
        return json({ events: [{ seq: 1, kind: "text_delta", text: "안녕" }, { seq: 2, kind: "text_delta", text: "하세" }], status: "running", last_seq: 2 });
      }
      if (c.path === "/turns/t1/events?after=2") return rest.promise;
      if (c.path === "/plans/p1/execute") return json({ ...PLAN, status: "submitted" });
      if (c.path === "/plans/p1/estimate") return json({ plan_id: "p1", total_credits: 12 });
      return json({ detail: "Not Found" }, 404);
    };
    await mount();
    expect(panel().textContent).toContain("지금 보는 화면을 같이 보면서 일해요");
    act(() => button("정보")!.click()); // 지금 화면은 머리글 정보 칸에
    expect(panel().textContent).toContain("워크스페이스 › e001");
    act(() => button("정보")!.click());
    type("고양이 컷 4장");
    enter();
    await flush();
    expect(texts(".agent-user")).toEqual(["고양이 컷 4장"]);
    expect(texts(".agent-assistant")).toEqual(["안녕하세"]);
    expect(input().value).toBe("");
    expect(button("멈추기")).toBeTruthy(); // 진행 중엔 보내기 대신 멈추기

    rest.resolve(json({ events: [
      { seq: 3, kind: "text", text: "안녕하세요." },
      { seq: 4, kind: "tool", name: "prepare_generation_plan", status: "started" },
      { seq: 5, kind: "tool", name: "prepare_generation_plan", status: "done" },
      { seq: 6, kind: "plan", plan: PLAN },
      { seq: 7, kind: "text_delta", text: "계획을 저장했어요" },
    ], status: "done", last_seq: 7 }));
    await flush();
    expect(texts(".agent-assistant")).toEqual(["안녕하세요.", "계획을 저장했어요"]);
    expect(texts(".agent-tool")).toEqual(["MV Hub · 계획 저장 끝"]);
    expect(host.querySelector(".agent-plan-title")!.textContent).toBe("계획고양이 컷 4장"); // [계획] 표 + 제목
    expect(panel().textContent).toContain("실행하면 크레딧이 나갑니다");
    expect(host.querySelector(".agent-plan-where")!.textContent).toBe("저장 위치 내 공간");
    expect(host.querySelector(".agent-plan-cost")!.textContent).toBe("예상 크레딧 12"); // 카드가 보이면 견적(무료)을 한 번 묻는다
    expect(calls.filter((c) => c.path === "/plans/p1/estimate").map((c) => c.method)).toEqual(["POST"]);
    expect(button("보내기")).toBeTruthy();

    // 허브 계약: 모든 요청에 기대 계정, /session 밖에는 패널 비밀값
    const open = calls.find((c) => c.path === "/session")!;
    expect([open.method, open.headers["X-MVHub-Expect-Account"], open.headers["X-MVHub-Panel"]]).toEqual(["POST", "acct:jay@example.com", undefined]);
    const turn = turnCalls()[0];
    expect([turn.headers["X-MVHub-Expect-Account"], turn.headers["X-MVHub-Panel"]]).toEqual(["acct:jay@example.com", "s1"]);
    expect(turn.body).toMatchObject({ engine: "claude", model: "opus", effort: "medium", text: "고양이 컷 4장", context: { tab: "my", folder: "e001" } });
    expect(String(turn.body!.idempotency_key).length).toBeGreaterThan(8);
    expect("conversation_id" in turn.body!).toBe(false);
    for (const c of calls.filter((item) => item.path.startsWith("/turns/t1/events"))) expect(c.headers["X-MVHub-Panel"]).toBe("s1");

    const run = host.querySelector<HTMLButtonElement>(".agent-plan-run")!;
    expect(run.textContent).toBe("실행");
    act(() => { run.click(); run.click(); });
    await flush();
    expect(calls.filter((c) => c.path === "/plans/p1/execute").map((c) => c.method)).toEqual(["POST"]);
    // 실행·견적은 지금 대화 id 를 싣는다(포크 카드로 원래 계획을 실행하지 않게 — docs/status/MVAgent_포크_2026-11-12.md 2-1)
    expect([calls.find((c) => c.path === "/plans/p1/execute")!.body, calls.find((c) => c.path === "/plans/p1/estimate")!.body])
      .toEqual([{ conversation_id: "c1" }, { conversation_id: "c1" }]);
    expect(host.querySelector(".agent-plan-sent")!.textContent).toBe("생성을 보냈어요"); // 접수일 뿐 완료가 아니다
    expect(texts(".agent-plan-tile")).toEqual(["접수됨"]); // 항목 상태가 없는 응답 — 완료·미제출이라 단정하지 않는다
    expect(host.querySelector(".agent-plan-run")).toBeNull();
  });

  it("끝난 차례라도 허브가 more 를 주면 남은 사건(계획 카드)을 마저 받는다", async () => {
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/turns") return started();
      if (c.path === "/turns/t1/events?after=0") return json({ events: [{ seq: 1, kind: "text", text: "앞부분" }], status: "done", last_seq: 1, more: true });
      if (c.path === "/turns/t1/events?after=1") return json({ events: [{ seq: 2, kind: "plan", plan: PLAN }], status: "done", last_seq: 2, more: false });
      return json({ detail: "Not Found" }, 404);
    };
    await mount();
    type("계획 세워 줘");
    enter();
    await flush();
    expect(host.querySelector(".agent-plan-title")!.textContent).toBe("계획고양이 컷 4장");
    expect(calls.filter((c) => c.path.startsWith("/turns/t1/events")).map((c) => c.path)).toEqual(
      ["/turns/t1/events?after=0", "/turns/t1/events?after=1"]);
    // 견적을 못 받았으면 0 이 아니라 '확인하지 못했어요' — 카드와 [실행]은 그대로
    expect(host.querySelector(".agent-plan-cost")!.textContent).toBe("예상 크레딧 확인하지 못했어요");
    expect(host.querySelector(".agent-plan-run")).toBeTruthy();
  });

  it("접수 답을 잃고(연결 끊김) 같은 글을 다시 보내면 같은 열쇠 — 허브가 그 차례를 돌려준다. 글을 바꾸면 새 열쇠", async () => {
    let attempt = 0;
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/turns") {
        attempt += 1;
        if (attempt <= 2) return Promise.reject(new TypeError("Failed to fetch"));
        return started();
      }
      return json({ events: [], status: "done", last_seq: 0 });
    };
    await mount();
    type("고양이");
    enter();
    await flush();
    expect(input().value).toBe("고양이"); // 받아들이지 않았으면 글이 남는다
    enter();
    await flush();
    type("강아지");
    enter();
    await flush();
    const keys = turnCalls().map((c) => c.body!.idempotency_key);
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("같은 글이라도 화면 정보가 다르면 새 열쇠 · 칸을 닫았다 열어도 같은 요청이면 같은 열쇠", async () => {
    let attempt = 0;
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/turns") {
        attempt += 1;
        return attempt <= 3 ? Promise.reject(new TypeError("Failed to fetch")) : started();
      }
      return json({ events: [], status: "done", last_seq: 0 });
    };
    await mount();
    type("여우");
    enter();
    await flush();
    act(() => root.unmount()); // 닫았다 다시 연다 — 같은 화면
    root = createRoot(host);
    await mount();
    type("여우");
    enter();
    await flush();
    act(() => root.render(<AgentPanel context={{ tab: "my", folder: "e002" }} contextLabel="워크스페이스 › e002" onClose={() => {}} />));
    await flush();
    enter(); // 같은 글, 다른 폴더
    await flush();
    const keys = turnCalls().map((c) => c.body!.idempotency_key);
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it("[실행] 응답이 attention(거절·접수 불명확)이면 '보냈어요' 대신 라이브러리 확인 안내", async () => {
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/turns") return started();
      if (c.path === "/plans/p1/execute") return json({ ...PLAN, status: "attention" });
      return json({ events: [{ seq: 1, kind: "plan", plan: PLAN }], status: "done", last_seq: 1 });
    };
    await mount();
    type("계획 세워 줘");
    enter();
    await flush();
    act(() => host.querySelector<HTMLButtonElement>(".agent-plan-run")!.click());
    await flush();
    expect(panel().textContent).not.toContain("끝났어요");
    expect(panel().textContent).toContain("라이브러리에서 확인하세요");
  });

  it("AI 가 실행하면 진행 사건(plan_progress)으로 칸이 바뀐다 — 늦게 온 옛 스냅샷은 무시, 생성 상태가 빠진 항목은 앞 값 보존, 다 끝나면 끝났어요 줄", async () => {
    const two = { ...PLAN, items: [{ model: "Nano Banana 2", prompt: "고양이 1" }, { model: "Nano Banana 2", prompt: "고양이 2" }] };
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/turns") return started();
      if (c.path === "/plans/p1/estimate") return json({ plan_id: "p1", total_credits: 6 });
      if (c.path.startsWith("/api/generations/")) return json({ detail: "Not Found" }, 404); // 썸네일 읽기 실패 → 글
      // 차례가 도는 동안 다음 기다림은 허브처럼 새 사건이 올 때까지 붙잡는다(바로 같은 답을 주면 끝없이 다시 묻는다)
      if (!c.path.endsWith("after=0")) return new Promise<Response>(() => {});
      return json({ events: [
        { seq: 1, kind: "plan", plan: two },
        { seq: 2, kind: "tool", name: "execute_generation_plan", status: "done" },
        { seq: 3, kind: "plan_progress", plan_id: "p1", plan_status: "submitted", observed_at: "1000",
          items: [{ index: 0, state: "submitted", generation_id: "g1", generation_status: "running" },
                  { index: 1, state: "submitted", generation_id: "g2", generation_status: "running" }] },
        { seq: 4, kind: "plan_progress", plan_id: "p1", plan_status: "submitted", observed_at: "1002",
          items: [{ index: 0, state: "submitted", generation_id: "g1", generation_status: "done" },
                  { index: 1, state: "submitted", generation_id: "g2" }] }, // g2 는 허브가 잠깐 못 읽음 — running 보존
        { seq: 5, kind: "plan_progress", plan_id: "p1", plan_status: "submitted", observed_at: "1001", // 늦게 도착한 옛 스냅샷
          items: [{ index: 0, state: "submitted", generation_id: "g1", generation_status: "running" },
                  { index: 1, state: "submitted", generation_id: "g2", generation_status: "running" }] },
      ], status: "running", last_seq: 5 });
    };
    await mount();
    type("고양이 두 장 생성해");
    enter();
    await flush();
    expect(texts(".agent-tool")).toEqual(["MV Hub · 생성 실행 끝"]);
    expect(host.querySelector(".agent-plan-sent")!.textContent).toBe("생성을 보냈어요");
    expect(texts(".agent-plan-tile")).toEqual(["완료 — 라이브러리에서 확인", "만드는 중"]); // 썸네일 줄 곳이 없으면 글
    expect(host.querySelector(".agent-plan-title")!.textContent).toBe("계획고양이 컷 4장"); // 진행은 제목·프롬프트를 안 덮는다
    expect(texts(".agent-plan-items li")).toEqual(["1Nano Banana 2고양이 1", "2Nano Banana 2고양이 2"]);
    act(() => button("정보")!.click()); // 정보 칸 '이 대화에서 만든 것' = 끝난 g1 만
    expect([host.querySelectorAll(".agent-info-grid .agent-sent-tile").length, host.querySelector(".agent-info-count")!.textContent]).toEqual([1, "1"]);
  });

  it("정보 칸 — 정보 단추로만 열고 닫음(바깥 누름·Esc 에 안 닫힘·다시 올려도 열린 채) · 지금 화면 스위치로 빈 문맥·회색 점·안내문 · 새 대화는 다시 켜짐 · 입력칸엔 지금 화면 칩 없음", async () => {
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/turns") return started(`t${turnCalls().length}`, "c1");
      return json({ events: [{ seq: 1, kind: "text", text: "네" }], status: "done", last_seq: 1 });
    };
    await mount();
    expect([host.querySelector(".agent-context"), host.querySelector(".agent-chips"), host.querySelector(".agent-info")]).toEqual([null, null, null]);
    const info = () => button("정보")!;
    act(() => info().click());
    expect([info().getAttribute("aria-pressed"), host.querySelector(".agent-info dd")!.textContent]).toEqual(["true", "워크스페이스 › e001"]);
    act(() => { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(host.querySelector(".agent-info")).not.toBeNull(); // 정보 단추를 다시 누를 때까지 떠 있다
    expect(localStorage.getItem("mvhub.agentPanel.infoOpen")).toBe("true");
    const sw = () => host.querySelector<HTMLButtonElement>('.agent-info [role="switch"]')!;
    act(() => sw().click());
    expect([sw().getAttribute("aria-checked"), !!host.querySelector(".agent-info-dot"), input().placeholder])
      .toEqual(["false", true, "지금 화면 없이 물어보세요 — 어디인지는 직접 알려 주세요"]);
    type("여기에 생성해");
    enter();
    await flush();
    expect(turnCalls()[0].body!.context).toEqual({});
    act(() => sw().click());
    type("e001 에 생성해");
    enter();
    await flush();
    expect(turnCalls()[1].body!.context).toEqual({ tab: "my", folder: "e001" });
    act(() => sw().click());
    act(() => button("새 대화")!.click());
    expect([sw().getAttribute("aria-checked"), host.querySelector(".agent-info-dot")]).toEqual(["true", null]);
    act(() => root.unmount()); // 칸을 다시 올려도 열린 채(기억)
    root = createRoot(host);
    await mount();
    expect(host.querySelector(".agent-info")).not.toBeNull();
    act(() => info().click());
    expect([host.querySelector(".agent-info"), localStorage.getItem("mvhub.agentPanel.infoOpen")]).toEqual([null, "false"]);
  });

  it("정보 칸 분리 — 자리가 있으면 대화 옆 칸(붙은 칸 = 대화 폭 + 정보 칸), 좁으면 겹쳐 뜸 · 카드 머리로 접고 기억", async () => {
    const before = window.innerWidth;
    const setWindow = (w: number) => act(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
      window.dispatchEvent(new Event("resize"));
    });
    const agentW = () => document.documentElement.style.getPropertyValue("--agent-w");
    try {
      setWindow(1600);
      await mount();
      expect(agentW()).toBe("520px");
      act(() => button("정보")!.click());
      // 대화(.agent-main) 옆에 서고, 붙은 칸은 정보 칸 폭만큼 넓어진다(대화 520 그대로)
      expect([host.querySelector(".agent-body > .agent-main + .agent-info.side") !== null, agentW()]).toEqual([true, "806px"]);
      setWindow(1000); // 앱 본문을 320 남기고는 못 넓힘 → 대화 폭 그대로, 정보 칸은 겹쳐 뜬다
      expect([host.querySelector(".agent-info")!.className, agentW()]).toEqual(["agent-info over", "500px"]);
      setWindow(1600);
      const fold = (title: string) => [...host.querySelectorAll<HTMLButtonElement>(".agent-info-fold")].find((b) => b.textContent?.startsWith(title))!;
      act(() => fold("이 대화에서 만든 것").click());
      expect([fold("이 대화에서 만든 것").getAttribute("aria-expanded"), texts(".agent-info-empty")]).toEqual(["false", ["아직 없어요"]]);
      expect(localStorage.getItem("mvhub.agentPanel.infoFold")).toBe('["made"]');
      act(() => fold("지금 화면").click()); // 접어도 보내기 스위치는 머리에 남는다
      expect([host.querySelector(".agent-info dl"), host.querySelector('.agent-info [role="switch"]') !== null]).toEqual([null, true]);
      act(() => root.unmount()); // 다시 올려도 접은 채(기억)
      root = createRoot(host);
      await mount();
      expect([fold("지금 화면").getAttribute("aria-expanded"), fold("이 대화에서 만든 것").getAttribute("aria-expanded"),
        fold("붙였던 자료").getAttribute("aria-expanded")]).toEqual(["false", "false", "true"]);
      act(() => button("정보")!.click());
      expect([host.querySelector(".agent-info"), agentW()]).toEqual([null, "520px"]); // 닫으면 원래 폭
    } finally {
      setWindow(before);
    }
  });

  it("보내는 중에는 새 대화·지난 대화·모델 단추가 잠겨 허브에서 시작한 차례를 놓치지 않는다", async () => {
    const gate = deferred<Response>();
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/turns") return gate.promise;
      return new Promise<Response>(() => {});
    };
    await mount();
    type("하나");
    enter();
    await flush(3);
    expect(button("새 대화")!.disabled).toBe(true);
    act(() => button("대화 목록")!.click()); // 서랍은 열리지만 새 대화·지난 대화 고르기는 잠긴다
    expect(host.querySelector<HTMLButtonElement>(".agent-drawer-new")!.disabled).toBe(true);
    act(() => button("대화 목록")!.click());
    expect(host.querySelector<HTMLButtonElement>(".agent-model-btn")!.disabled).toBe(true);
    gate.resolve(started());
    await flush();
    expect(texts(".agent-user")).toEqual(["하나"]); // 접수 응답을 버리지 않고 그 차례를 따라간다
  });

  it("[고치기]는 입력칸 위에 '고칠 계획' 칩을 붙이고, 고칠 내용을 써야 보내며 보낼 때 제목을 붙인다", async () => {
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/turns") return started(`t${turnCalls().length}`, "c1");
      return json({ events: [{ seq: 1, kind: "plan", plan: PLAN }], status: "done", last_seq: 1 });
    };
    await mount();
    type("계획 세워 줘");
    enter();
    await flush();
    act(() => host.querySelector<HTMLButtonElement>(".agent-plan-fix")!.click());
    expect(host.querySelector(".agent-revise")!.textContent).toContain("고양이 컷 4장");
    expect(input().value).toBe(""); // 빈 문장이 그대로 보내지지 않게 글은 넣지 않는다
    expect(document.activeElement).toBe(input());
    expect(button("보내기")!.disabled).toBe(true);
    type("두 장만");
    enter();
    await flush();
    expect(turnCalls()[1].body!.text).toBe("「고양이 컷 4장」 계획을 이렇게 고쳐 주세요: 두 장만");
    expect(host.querySelector(".agent-revise")).toBeNull();
  });

  it("이어진 도구 알약은 한 줄로 묶이고(이름별 횟수 · 도는 중이면 '하는 중'), 누르면 하나씩 펼친다", async () => {
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/turns") return started();
      if (!c.path.endsWith("after=0")) return new Promise<Response>(() => {});
      return json({ events: [
        { seq: 1, kind: "tool", name: "read_context", status: "started" },
        { seq: 2, kind: "tool", name: "read_context", status: "done" },
        { seq: 3, kind: "tool", name: "read_context", status: "started" },
        { seq: 4, kind: "tool", name: "read_context", status: "done" },
        { seq: 5, kind: "tool", name: "prepare_generation_plan", status: "started" },
        { seq: 6, kind: "tool", name: "prepare_generation_plan", status: "done" },
        { seq: 7, kind: "text", text: "계획을 저장했어요" },
        { seq: 8, kind: "tool", name: "execute_generation_plan", status: "started" },
      ], status: "running", last_seq: 8 });
    };
    await mount();
    type("만들어 줘");
    enter();
    await flush();
    expect(texts(".agent-tool")).toEqual(["MV Hub · 자료 조회 2번, 계획 저장 끝", "MV Hub · 생성 실행 하는 중"]);
    expect(host.querySelector(".agent-tool-list")).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>(".agent-tool")!.click());
    expect(texts(".agent-tool-list li")).toEqual(["✓자료 조회 끝", "✓자료 조회 끝", "✓계획 저장 끝"]);
    expect(panel().textContent).toContain("일하는 중"); // 떠 있는 알약
  });

  it("보내는 중·진행 중에는 다시 보내지 않는다", async () => {
    const gate = deferred<Response>();
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/turns") return gate.promise;
      return new Promise<Response>(() => {}); // 사건은 아직 없음(진행 중)
    };
    await mount();
    type("하나");
    enter();
    enter();
    await flush(3);
    expect(turnCalls()).toHaveLength(1);
    gate.resolve(started());
    await flush();
    type("둘");
    enter();
    await flush();
    expect(turnCalls()).toHaveLength(1);
    expect(button("보내기")).toBeNull();
    expect(input().value).toBe("둘");
  });

  it("접수 응답을 기다리는 동안 고친 글은 응답이 와도 남는다(배포 전 리뷰 L4-01)", async () => {
    const gates = [deferred<Response>(), deferred<Response>()];
    let turn = 0;
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/turns") return gates[turn++].promise;
      return new Promise<Response>(() => {});
    };
    await mount();
    type("하나");
    enter();
    await flush(3);
    type("고친 다음 글");
    gates[0].resolve(started());
    await flush();
    expect(turnCalls()).toHaveLength(1);
    expect(turnCalls()[0].body!.text).toBe("하나");
    expect(input().value).toBe("고친 다음 글"); // 전엔 접수 응답이 이 글까지 지웠다
  });

  it("패널 표 401(허브 재시작) → 새 표가 같은 신원(계정·허브·DB)이면 같은 요청(같은 중복 방지 키)을 한 번 다시 보낸다 — 로그인은 그대로", async () => {
    setAuthToken("tok");
    let issued = 0;
    route = (c) => {
      if (c.path === "/session") { issued += 1; return session(issued === 1 ? "jay@example.com" : "JAY@example.com", `s${issued}`); }
      if (c.path === "/turns") return c.headers["X-MVHub-Panel"] === "s1" ? json({ detail: "panel" }, 401, { "X-MVHub-Panel-Error": "session" }) : started();
      return json({ events: [{ seq: 1, kind: "text", text: "다시 붙었어요" }], status: "done", last_seq: 1 });
    };
    await mount();
    type("안녕");
    enter();
    await flush();
    expect(turnCalls().map((c) => c.headers["X-MVHub-Panel"])).toEqual(["s1", "s2"]);
    expect(turnCalls()[1].body!.idempotency_key).toBe(turnCalls()[0].body!.idempotency_key);
    expect(texts(".agent-assistant")).toEqual(["다시 붙었어요"]);
    expect(getAuthToken()).toBe("tok");
  });

  it("패널 표 401 뒤 새 표의 계정이 다르면 다시 보내지 않고 '계정이 바뀌었어요'", async () => {
    setAuthToken("tok");
    let issued = 0;
    route = (c) => {
      if (c.path === "/session") {
        issued += 1;
        return session(issued === 1 ? "jay@example.com" : "other@example.com", `s${issued}`, `id-${issued}`);
      }
      if (c.path === "/turns") return json({ detail: "panel" }, 401, { "X-MVHub-Panel-Error": "session" });
      return json({ detail: "Not Found" }, 404);
    };
    await mount();
    type("안녕");
    enter();
    await flush();
    expect(turnCalls()).toHaveLength(1);
    expect(host.querySelector(".agent-error")!.textContent).toBe("계정이 바뀌었어요");
    expect(getAuthToken()).toBe("tok");
  });

  it("패널 표 401 뒤 계정은 같아도 신원 표식이 다르면(같은 계정·다른 DB) 다시 보내지 않는다", async () => {
    setAuthToken("tok");
    let issued = 0;
    route = (c) => {
      if (c.path === "/session") { issued += 1; return session("jay@example.com", `s${issued}`, `id-${issued}`); }
      if (c.path === "/turns") return json({ detail: "panel" }, 401, { "X-MVHub-Panel-Error": "session" });
      return json({ detail: "Not Found" }, 404);
    };
    await mount();
    type("안녕");
    enter();
    await flush();
    expect(turnCalls()).toHaveLength(1);
    expect(host.querySelector(".agent-error")!.textContent).toBe("계정이 바뀌었어요");
  });

  it("계정이 바뀐 뒤 도착한 늦은 사건은 버린다 · 허브가 계정 표식(account)으로 거절하면 다시 묻지 않고 비운다", async () => {
    const late = deferred<Response>();
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/turns") return started();
      return late.promise;
    };
    await mount();
    type("안녕");
    enter();
    await flush();
    sessionStorage.setItem("ch.accountScope", "other@example.com"); // 이 탭의 계정이 바뀜
    late.resolve(json({ events: [{ seq: 1, kind: "text", text: "늦은 답" }], status: "done", last_seq: 1 }));
    await flush();
    expect(panel().textContent).not.toContain("늦은 답");
    expect(calls.filter((c) => c.path.startsWith("/turns/t1/events"))).toHaveLength(1);

    // 새 칸 — 허브가 다른 계정이라고 거절(409 + X-MVHub-Panel-Error: account)
    act(() => root.unmount());
    root = createRoot(host);
    sessionStorage.setItem("ch.accountScope", "jay@example.com");
    localStorage.clear();
    calls = [];
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/turns") return started("t2", "c2");
      return json({ detail: "다른 계정" }, 409, { "X-MVHub-Panel-Error": "account" });
    };
    await mount();
    type("둘");
    enter();
    await flush();
    expect(calls.filter((c) => c.path.startsWith("/turns/t2/events"))).toHaveLength(1);
    expect(host.querySelector(".agent-error")!.textContent).toBe("계정이 바뀌었어요");
    expect(host.querySelector(".agent-user")).toBeNull();
  });

  it("엔진을 바꾸면 새 대화 — 같은 엔진의 다른 모델은 대화를 잇는다", async () => {
    let n = 0;
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/turns") { n += 1; return started(`t${n}`, n < 3 ? "c1" : "c2"); }
      return json({ events: [{ seq: 1, kind: "text", text: "네" }], status: "done", last_seq: 1 });
    };
    await mount();
    type("하나");
    enter();
    await flush();
    pickModel("Sonnet 5.5");
    expect(texts(".agent-user")).toEqual(["하나"]);
    type("둘");
    enter();
    await flush();
    expect(turnCalls()[1].body).toMatchObject({ conversation_id: "c1", engine: "claude", model: "sonnet" });

    pickCompany("ChatGPT"); // 회사를 바꾸면 그 회사 첫 모델 + 새 대화
    expect(host.querySelector(".agent-user")).toBeNull();
    expect(host.querySelector(".agent-head-left")!.textContent).toBe("새 대화");
    expect(panel().textContent).toContain("지금 보는 화면을 같이 보면서 일해요");
    type("셋");
    enter();
    await flush();
    expect(turnCalls()[2].body).toMatchObject({ engine: "codex", model: "gpt-6.1-sol", effort: "medium" });
    expect("conversation_id" in turnCalls()[2].body!).toBe(false);
    expect(JSON.parse(localStorage.getItem("mvhub.agentPanel.model")!)).toEqual({ engine: "codex", model: "gpt-6.1-sol", effort: "medium" });
  });

  it("모델 칩·깊이 칩(Claude 앱) — 회사 줄에 올리면·→ 옆에 모델(못 쓰는 회사는 까닭·고를 수 없음) · 찾기는 모델 바로 · 깊이 Low~Max · 빠른 모드 스위치는 Opus 에서만, 보낼 때 실리고 모델을 바꾸면 꺼진다", async () => {
    route = (c) => {
      if (c.path === "/session") {
        return json({ secret: "s1", account_email: "jay@example.com", identity_key: "id-1", engines: [ENGINES[0], { ...ENGINES[1], available: false, reason: "점검 필요" }] });
      }
      if (c.path === "/turns") return started();
      return json({ events: [], status: "done", last_seq: 0 });
    };
    await mount();
    const btn = () => host.querySelector<HTMLButtonElement>(".agent-model-btn")!;
    expect([btn().textContent, effortBtn().textContent]).toEqual(["✳Opus 5.5", "Medium"]); // 두 칩
    act(() => btn().click());
    expect(texts(".agent-model-row")).toEqual(["✳ClaudeMax 구독", "ChatGPT미연결"]); // 긴 까닭 대신 한 단어
    expect(host.querySelectorAll(".agent-model-row")[1].querySelector(".agent-model-ic svg")).not.toBeNull(); // GPT 아이콘
    const rows = host.querySelectorAll<HTMLButtonElement>(".agent-model-row");
    act(() => { rows[0].dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); }); // 올리면 옆에
    expect(texts('.agent-model-sub[aria-label="Claude"] .agent-model-item')).toEqual(["✳Opus 5.5✓", "✳Sonnet 5.5", "✳Haiku 5.5", "✳Fable 5.1"]);
    act(() => { rows[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    expect([host.querySelector('.agent-model-sub[aria-label="Claude"]'),
      [...host.querySelectorAll<HTMLButtonElement>('.agent-model-sub[aria-label="ChatGPT"] .agent-model-item')].map((b) => b.disabled)]).toEqual([null, [true, true]]);
    searchModel("son");
    expect([texts(".agent-model-menu .agent-model-item[aria-pressed]"), host.querySelector(".agent-model-row")]).toEqual([["✳Sonnet 5.5"], null]); // 찾기는 모델 바로
    act(() => btn().click());
    act(() => effortBtn().click());
    expect(menuRadios("생각 깊이").map((b) => b.textContent)).toEqual(["Low", "Medium✓", "High", "Extra High", "Max"]);
    expect(panel().textContent).toContain("Claude 추가 사용 크레딧이 들어요");
    const fast = () => host.querySelector<HTMLButtonElement>('.agent-effort-menu [role="switch"]');
    act(() => fast()!.click()); // 스위치는 메뉴를 닫지 않는다
    expect([fast()!.getAttribute("aria-checked"), effortBtn().textContent]).toEqual(["true", "Medium빠름"]);
    act(() => menuRadios("생각 깊이")[4].click()); // 깊이를 고르면 닫힌다
    expect([host.querySelector(".agent-effort-menu"), effortBtn().textContent]).toEqual([null, "Max빠름"]);
    type("빨리");
    enter();
    await flush();
    expect(turnCalls()[0].body).toMatchObject({ model: "opus", effort: "max", fast: true });
    expect(turnCalls()[0].body).not.toHaveProperty("gen_model");
    expect(JSON.parse(localStorage.getItem("mvhub.agentPanel.model")!)).toEqual({ engine: "claude", model: "opus", effort: "max" }); // 빠른 모드는 기억 안 함
    pickModel("Sonnet 5.5");
    act(() => effortBtn().click());
    expect(fast()).toBeNull(); // Opus 가 아니면 빠른 모드가 없다
    expect(effortBtn().textContent).not.toContain("빠름");
  });

  it("사용량 원 — Claude 사건(주간·문맥)으로 채움 · 누르면 대화 찬 정도·주간 남은 양 · 주간은 계정별로 남고, 대화 찬 정도는 새 대화에서 비움", async () => {
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/turns") return started();
      return json({ events: [{ seq: 1, kind: "usage", weekly: { utilization: 0.45, resets_at: 1794319200 } }, { seq: 2, kind: "text", text: "네" },
        { seq: 3, kind: "usage", context: { used: 120000, window: 1000000 } }], status: "done", last_seq: 3 });
    };
    await mount();
    const ring = () => button("사용량")!;
    act(() => ring().click());
    expect([texts(".agent-usage-row b"), texts(".agent-usage-pop .agent-usage-note")]).toEqual([["—", "—"], ["답을 한 번 받으면 보여요", "Claude 답을 한 번 받으면 보여요"]]);
    act(() => ring().click());
    type("안녕");
    enter();
    await flush();
    act(() => ring().click());
    expect(texts(".agent-usage-row b")).toEqual(["12%", "55%"]);
    expect(texts(".agent-usage-pop .agent-usage-note")[0]).toBe("120K / 1M 토큰 · 차면 앞 대화를 줄여요");
    const saved = JSON.parse(localStorage.getItem("mvhub.agentPanel.usage")!);
    expect([typeof saved.account, saved.weekly]).toEqual(["string", { utilization: 0.45, resets_at: 1794319200 }]); // 계정 표식과 함께
    act(() => button("새 대화")!.click());
    expect(texts(".agent-usage-row b")).toEqual(["—", "55%"]);
    act(() => root.unmount()); // 다시 올려도 같은 계정이면 주간은 남는다
    root = createRoot(host);
    await mount();
    act(() => ring().click());
    expect(texts(".agent-usage-row b")).toEqual(["—", "55%"]);
    act(() => root.unmount()); // 다른 계정이면 보이지 않는다
    sessionStorage.setItem("ch.accountScope", "other@example.com");
    route = (c) => (c.path === "/session" ? session("other@example.com") : json({ detail: "Not Found" }, 404));
    root = createRoot(host);
    await mount();
    act(() => ring().click());
    expect(texts(".agent-usage-row b")).toEqual(["—", "—"]);
  });

  it("설정 쪽 — 모델 메뉴 '설정' · 연결 줄 · 새 대화 기본 모델·깊이 · 먼저 쓸 생성 모델(차례에 gen_model) · ← 와 Esc", async () => {
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/api/models") {
        return json([{ display_name: "Nano Banana 2", job_set_type: "nano_banana_flash", type: "image" },
          { display_name: "Kling 3.0", job_set_type: "kling3", type: "video" }, { display_name: "말하기", job_set_type: "tts", type: "audio" }]);
      }
      if (c.path === "/turns") return started();
      return json({ events: [], status: "done", last_seq: 0 });
    };
    await mount();
    const openSettings = () => {
      act(() => host.querySelector<HTMLButtonElement>(".agent-model-btn")!.click());
      act(() => [...host.querySelectorAll<HTMLButtonElement>(".agent-model-menu .agent-model-item")].find((b) => b.textContent === "설정")!.click());
    };
    openSettings();
    await flush();
    expect([host.querySelector(".agent-model-menu"), host.querySelector(".agent-settings") !== null]).toEqual([null, true]);
    expect(texts(".agent-settings-line .agent-settings-t small").slice(0, 2)).toEqual(["구독 Max · Claude Code 2.1.296 · 연결됨", "Codex 0.162.0-alpha.17.2 · 이 PC 에서 켬 · 연결됨"]);
    expect(texts('select[aria-label="먼저 쓸 생성 모델"] option')).toEqual(["정하지 않음", "Nano Banana 2", "Kling 3.0"]); // 그림·영상만
    pickSelect("새 대화 모델", "claude:sonnet");
    pickSelect("새 대화 생각 깊이", "high");
    pickSelect("먼저 쓸 생성 모델", "nano_banana_flash");
    expect(JSON.parse(localStorage.getItem("mvhub.agentPanel.defaults")!))
      .toEqual({ model: { engine: "claude", model: "sonnet" }, effort: "high", gen_model: "nano_banana_flash" });
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(host.querySelector(".agent-settings")).toBeNull();
    expect(host.querySelector(".agent-model-btn")!.textContent).toBe("✳Opus 5.5"); // 지금 대화는 그대로
    act(() => button("새 대화")!.click()); // 새 대화부터 기본값
    expect([host.querySelector(".agent-model-btn")!.textContent, effortBtn().textContent]).toEqual(["✳Sonnet 5.5", "High"]);
    type("사과 그려");
    enter();
    await flush();
    expect(turnCalls()[0].body).toMatchObject({ model: "sonnet", effort: "high", gen_model: "nano_banana_flash" });
    openSettings();
    act(() => button("돌아가기")!.click());
    expect(host.querySelector(".agent-settings")).toBeNull();
  });
  it("보낸 직후 칸을 닫아 접수 답이 늦게 와도, 다시 열면 그 대화에 붙는다 — 같은 일을 또 시작하지 않는다", async () => {
    const accepted = deferred<Response>();
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/turns") return accepted.promise;
      if (c.path === "/conversations/c1") {
        return json({
          conversation: { id: "c1", title: "늦은 접수", engine: "claude", model: "opus", effort: "medium", updated_at: "", resumable: true },
          turns: [{ id: "t1", status: "done", text: "늦은 접수", created_at: "", events: [{ seq: 1, kind: "text", text: "끝났어요" }] }],
        });
      }
      return json({ detail: "Not Found" }, 404);
    };
    await mount();
    type("늦은 접수");
    enter();
    await flush();
    act(() => root.unmount()); // 접수 답을 받기 전에 닫는다
    accepted.resolve(started());
    await flush();
    root = createRoot(host);
    await mount();
    expect(texts(".agent-user")).toEqual(["늦은 접수"]);
    expect(texts(".agent-assistant")).toEqual(["끝났어요"]);
    expect(turnCalls()).toHaveLength(1);
  });

  it("칸을 다시 열어 지난 대화를 불러오는 동안에는 보내지 않는다 — 늦게 온 지난 대화가 새 차례를 덮지 않게", async () => {
    const restore = deferred<Response>();
    let restoring = false;
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/turns") return started();
      if (c.path.startsWith("/turns/t1/events")) return json({ events: [{ seq: 1, kind: "text", text: "첫 답" }], status: "done", last_seq: 1 });
      if (c.path === "/conversations/c1" && restoring) return restore.promise;
      return json({ detail: "Not Found" }, 404);
    };
    await mount();
    type("첫 질문");
    enter();
    await flush();
    act(() => root.unmount());
    restoring = true;
    root = createRoot(host);
    await mount(); // 지난 대화 c1 을 불러오는 중(답을 붙잡아 둔다)
    type("둘째 질문");
    enter();
    await flush();
    expect(turnCalls()).toHaveLength(1);
    expect(button("보내기")!.disabled).toBe(true);
    restore.resolve(json({
      conversation: { id: "c1", title: "첫 질문", engine: "claude", model: "opus", effort: "medium", updated_at: "", resumable: true },
      turns: [{ id: "t1", status: "done", text: "첫 질문", created_at: "", events: [{ seq: 1, kind: "text", text: "첫 답" }] }],
    }));
    await flush();
    expect(texts(".agent-user")).toEqual(["첫 질문"]);
    expect(button("보내기")!.disabled).toBe(false);
    enter();
    await flush();
    expect(turnCalls()).toHaveLength(2);
    expect(turnCalls()[1].body).toMatchObject({ conversation_id: "c1", text: "둘째 질문" });
  });

  it("칸을 닫으면 기다림만 끊고(취소 안 함), 다시 열면 마지막 대화를 읽어 마지막 순번 뒤부터 이어 붙는다", async () => {
    const hold = deferred<Response>();
    let afterTwo = 0;
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/turns") return started();
      if (c.path === "/turns/t1/events?after=0") {
        return json({ events: [{ seq: 1, kind: "text_delta", text: "반" }, { seq: 2, kind: "text_delta", text: "쯤" }], status: "running", last_seq: 2 });
      }
      if (c.path === "/turns/t1/events?after=2") {
        afterTwo += 1;
        return afterTwo === 1 ? hold.promise : json({ events: [{ seq: 3, kind: "text", text: "반쯤 왔어요" }], status: "done", last_seq: 3 });
      }
      if (c.path === "/conversations/c1") {
        return json({
          conversation: { id: "c1", title: "고양이", engine: "claude", model: "opus", effort: "medium", updated_at: "", resumable: true },
          turns: [{ id: "t1", status: "running", text: "안녕", created_at: "", events: [{ seq: 1, kind: "text_delta", text: "반" }, { seq: 2, kind: "text_delta", text: "쯤" }] }],
        });
      }
      return json({ detail: "Not Found" }, 404);
    };
    await mount();
    type("안녕");
    enter();
    await flush();
    const waiting = calls.find((c) => c.path === "/turns/t1/events?after=2")!;
    act(() => root.unmount()); // 옆 칸 닫기
    expect(waiting.signal!.aborted).toBe(true);
    expect(calls.some((c) => c.path.endsWith("/cancel"))).toBe(false);

    root = createRoot(host);
    await mount(); // 다시 열기
    expect(calls.filter((c) => c.path === "/turns/t1/events?after=2")).toHaveLength(2);
    expect(texts(".agent-user")).toEqual(["안녕"]);
    expect(texts(".agent-assistant")).toEqual(["반쯤 왔어요"]);
    expect(host.querySelector(".agent-head-left")!.textContent).toBe("고양이");
  });

  it("[멈추기]는 취소를 보내고, 허브가 끝을 알릴 때까지 기다린다", async () => {
    const end = deferred<Response>();
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/turns") return started();
      if (c.path === "/turns/t1/cancel") return json({ status: "cancelling" });
      if (c.path === "/turns/t1/events?after=0") return end.promise;
      return json({ detail: "Not Found" }, 404);
    };
    await mount();
    type("안녕");
    enter();
    await flush();
    act(() => button("멈추기")!.click());
    await flush();
    expect(calls.filter((c) => c.path === "/turns/t1/cancel").map((c) => c.method)).toEqual(["POST"]);
    expect(panel().textContent).toContain("멈추는 중");
    end.resolve(json({ events: [], status: "cancelled", last_seq: 0 }));
    await flush();
    expect(button("보내기")).toBeTruthy();
  });

  it("칸의 글자에는 '...'·'…' 이 없다(그려진 글·placeholder·aria-label·title, 소스의 글자 상수)", async () => {
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/turns") return started();
      if (c.path === "/conversations") return json({ conversations: [{ id: "c1", title: "고양이", engine: "claude", model: "opus", effort: "medium", updated_at: "", resumable: false }] });
      if (c.path === "/turns/t1/events?after=0") {
        return json({ events: [{ seq: 1, kind: "tool", name: "read_context", status: "started" }, { seq: 2, kind: "plan", plan: PLAN }], status: "running", last_seq: 2 });
      }
      return new Promise<Response>(() => {});
    };
    const seen: string[] = [];
    const look = () => {
      seen.push(panel().textContent ?? "");
      for (const el of panel().querySelectorAll("[placeholder],[aria-label],[title]")) {
        seen.push(el.getAttribute("placeholder") ?? "", el.getAttribute("aria-label") ?? "", el.getAttribute("title") ?? "");
      }
    };
    await mount();
    look();
    act(() => host.querySelector<HTMLButtonElement>(".agent-model-btn")!.click());
    look();
    act(() => button("대화 목록")!.click());
    await flush();
    look();
    act(() => button("대화 목록")!.click());
    type("안녕");
    enter();
    await flush();
    look();
    expect(seen.join("\n")).toContain("이어 가기 불가");
    expect(seen.join("\n")).toContain("MV Hub · 자료 조회 하는 중");
    expect(seen.join("\n")).not.toMatch(/\.\.\.|…/);

    for (const file of ["components/agent-chat/AgentPanel.tsx", "components/agent-chat/AgentPlanCard.tsx", "components/agent-chat/AgentConnect.tsx",
      "components/agent-chat/AgentMarkdown.tsx", "lib/useAgentChat.ts", "lib/agentChatApi.ts"]) {
      const src = readFileSync(new NodeURL(`../src/${file}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      const literals = [...src.matchAll(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|>([^<>{}\n]*\S[^<>{}\n]*)</g)].map((m) => m[0]);
      expect([file, literals.filter((s) => /\.\.\.|…/.test(s))]).toEqual([file, []]);
    }
  });
});

describe("applyAgentEvent", () => {
  const ev = (seq: number, e: Record<string, unknown>) => ({ seq, ...e }) as AgentEvent;
  it("조각 없이 통째로 오는 글(Codex)은 한 덩어리씩 · 도구는 시작 줄을 끝으로 바꾼다 · 상태의 까닭은 오류 줄", () => {
    let m: AgentMessage[] = [];
    for (const e of [
      ev(1, { kind: "text", text: "첫째" }),
      ev(2, { kind: "text", text: "둘째" }),
      ev(3, { kind: "tool", name: "read_context", status: "started" }),
      ev(4, { kind: "tool", name: "read_context", status: "failed" }),
      ev(5, { kind: "state", status: "interrupted", reason: "허브가 다시 켜져 멈췄어요" }),
      ev(6, { kind: "who_knows" }),
    ]) m = applyAgentEvent(m, e, "t1");
    expect(m.map((x) => [x.kind, "text" in x ? x.text : "status" in x ? x.status : "message" in x ? x.message : ""])).toEqual([
      ["assistant", "첫째"], ["assistant", "둘째"], ["tool", "failed"], ["error", "허브가 다시 켜져 멈췄어요"],
    ]);
  });
});

// 칸 폭(docs/status/MVAgent_칸폭_떠있는창_2026-11-10.md) · 서랍·새 창(docs/status/MVAgent_서랍_새창_2026-11-10.md)
describe("MV Agent 칸 폭·서랍·새 창", () => {
  const agentW = () => document.documentElement.style.getPropertyValue("--agent-w");
  const width0 = window.innerWidth;
  const setWindowWidth = (value: number) => Object.defineProperty(window, "innerWidth", { configurable: true, value });
  beforeEach(() => { setWindowWidth(1600); document.documentElement.style.removeProperty("--agent-w"); });
  afterEach(() => setWindowWidth(width0));

  it("끝선 손잡이 — 방향키·더블클릭으로 폭을 바꿔 남기고 창 폭의 절반을 넘지 않는다 · 새 창 안에서는 손잡이 대신 [옆 칸으로 붙이기]", async () => {
    let popped = 0;
    let docked = 0;
    const render = (popout: boolean) => act(() => root.render(
      <AgentPanel context={{ tab: "my" }} contextLabel="워크스페이스" onClose={() => {}} popout={popout}
        onPopOut={() => { popped += 1; }} onDock={() => { docked += 1; }} />));
    render(false);
    await flush();
    const handle = host.querySelector<HTMLElement>(".agent-resize")!;
    expect(agentW()).toBe("520px");
    act(() => { handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); }); // 오른쪽 칸 — 왼쪽으로 = 넓게
    expect([agentW(), localStorage.getItem("mvhub.agentPanel.width")]).toEqual(["528px", "528"]);
    act(() => { handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(agentW()).toBe("520px");
    setWindowWidth(900);
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect([agentW(), localStorage.getItem("mvhub.agentPanel.width")]).toEqual(["450px", "520"]); // 보이는 폭만 줄고 고른 폭은 그대로

    // 옆 칸 머리 = 왼쪽 [대화 목록][옆 칸 닫기] · 오른쪽 [새 대화][새 창으로 띄우기](시안 A안)
    const heads = () => [...panel().querySelectorAll(".agent-head button")].map((b) => b.getAttribute("aria-label"));
    expect(heads()).toEqual(["대화 목록", "옆 칸 닫기", "새 대화", "정보", "새 창으로 띄우기"]);
    act(() => button("새 창으로 띄우기")!.click());
    expect(popped).toBe(1);
    render(true);
    await flush();
    expect([panel().classList.contains("popout"), host.querySelector(".agent-resize")]).toEqual([true, null]);
    expect(heads()).toEqual(["대화 목록", "옆 칸으로 붙이기", "새 대화", "정보"]);
    act(() => button("옆 칸으로 붙이기")!.click());
    expect(docked).toBe(1);
  });

  it("≡ 서랍 — 대화를 프로젝트별로 묶고(이름 모르는 프로젝트는 한 묶음, '프로젝트 없음'은 맨 아래) 고르면 열고 닫힌다 · 설정 칸은 없다", async () => {
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/conversations") {
        return json({ conversations: [
          { id: "c1", title: "고양이", engine: "claude", model: "opus", effort: "medium", updated_at: "", resumable: true, project: null },
          { id: "c2", title: "딸기와 바나나", engine: "claude", model: "opus", effort: "medium", updated_at: "", resumable: true, project: "p1" },
          { id: "c3", title: "강아지", engine: "claude", model: "opus", effort: "medium", updated_at: "", resumable: false, project: "p-other" },
          { id: "c4", title: "사과", engine: "claude", model: "opus", effort: "medium", updated_at: "", resumable: true, project: "p1" },
        ] });
      }
      if (c.path === "/claude/version") return json({ current: "2.1.296", latest: "2.1.322", newer: true, method: "official" });
      if (c.path === "/conversations/c2") {
        return json({ conversation: { id: "c2", title: "딸기와 바나나", engine: "claude", model: "opus", effort: "medium", updated_at: "", resumable: true }, turns: [] });
      }
      return json({ detail: "Not Found" }, 404);
    };
    act(() => root.render(<AgentPanel context={{ tab: "my" }} contextLabel="워크스페이스" onClose={() => {}}
      projectName={(id) => (id === "p1" ? "뻘뻘뻘" : undefined)} onPopOut={() => {}} />));
    await flush();
    act(() => button("대화 목록")!.click());
    await flush();
    const groups = () => [...host.querySelectorAll(".agent-drawer-group")].map((g) => [
      g.querySelector(".agent-drawer-ghead")!.textContent, [...g.querySelectorAll(".agent-drawer-item")].map((i) => i.textContent)]);
    expect(groups()).toEqual([
      ["뻘뻘뻘", ["딸기와 바나나", "사과"]], ["다른 공간 프로젝트", ["강아지이어 가기 불가"]], ["프로젝트 없음", ["고양이"]],
    ]);
    expect(host.querySelector(".agent-drawer")!.textContent).not.toMatch(/설정|구독|새 대화 모델|칸 위치/); // 설정 칸은 뺐다(Jay 11-10)
    // 맨 아래 한 줄 — Claude · 요금제(허브가 싣는 표시 이름) / 지금 쓰는 판(v + 번호), 새 판이 있으면 라임 + 알림 글
    expect([texts(".agent-drawer-plan")[0], texts(".agent-drawer-ver.new")[0]]).toEqual(["✳Claude · Max", "v2.1.296공식 설치"]);
    expect(host.querySelector(".agent-drawer-ver")!.getAttribute("title")).toBe("v2.1.322 이 나왔어요");
    expect(host.querySelector(".agent-drawer")!.textContent).not.toMatch(/자동 업데이트|업데이트$/); // 설치 방식만 — 보장 문구 없음
    act(() => [...host.querySelectorAll<HTMLButtonElement>(".agent-drawer-item")][0].click());
    await flush();
    expect([host.querySelector(".agent-drawer"), host.querySelector(".agent-head-left")!.textContent]).toEqual([null, "딸기와 바나나"]);
    act(() => button("대화 목록")!.click());
    await flush();
    act(() => host.querySelector<HTMLElement>(".agent-drawer-dim")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(host.querySelector(".agent-drawer")).toBeNull();
  });
});

// 서랍 행 메뉴·넓이(docs/status/MVAgent_서랍메뉴_2026-11-12.md 2-1~2-6)
describe("MV Agent 서랍 메뉴", () => {
  type Conv = { id: string; title: string; engine?: string; project?: string | null; pinned?: boolean; archived?: boolean; unread?: boolean; unread_rev?: number };
  let list: Conv[];
  const full = (c: Conv) => ({ engine: "claude", model: "opus", effort: "medium", updated_at: "", resumable: true, project: null,
    pinned: false, archived: false, unread: false, unread_rev: 0, ...c });
  const width0 = window.innerWidth;
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1600 });
    list = [{ id: "c1", title: "고양이", project: "p1" }, { id: "c2", title: "강아지", unread: true, unread_rev: 3 }, { id: "c3", title: "새", engine: "codex" }];
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/conversations" && c.method === "GET") return json({ conversations: list.map(full) });
      if (c.path === "/claude/version") return json({ current: null, latest: null, newer: false });
      const m = c.path.match(/^\/conversations\/(c\d)$/);
      if (m && c.method === "PATCH") {
        const at = list.findIndex((x) => x.id === m[1]);
        const body = { ...(c.body as Record<string, unknown>) };
        if (typeof body.title === "string") body.title = body.title.trim();
        if ("unread" in body) body.unread_rev = (list[at].unread_rev ?? 0) + 1;
        delete body.seen_rev;
        list[at] = { ...list[at], ...(body as Partial<Conv>) };
        return json({ conversation: full(list[at]) });
      }
      if (m && c.method === "DELETE") { list = list.filter((x) => x.id !== m[1]); return json({ deleted: true, session_file: "not_found" }); }
      if (m) return json({ conversation: full(list.find((x) => x.id === m[1])!), turns: [] });
      return json({ detail: "Not Found" }, 404);
    };
  });
  afterEach(() => Object.defineProperty(window, "innerWidth", { configurable: true, value: width0 }));
  const render = async (props: Partial<Parameters<typeof AgentPanel>[0]> = {}) => {
    act(() => root.render(<AgentPanel context={{ tab: "my", project: "p2" }} contextLabel="워크스페이스" onClose={() => {}}
      projectName={(id) => ({ p1: "뻘뻘뻘", p2: "프롤로그" } as Record<string, string>)[id]} {...props} />));
    await flush();
  };
  const openDrawer = async () => { act(() => button("대화 목록")!.click()); await flush(); };
  const row = (title: string) => [...host.querySelectorAll<HTMLElement>(".agent-drawer-row")].find((r) => r.textContent?.includes(title))!;
  const openMenu = (title: string) => act(() => row(title).querySelector<HTMLButtonElement>(".agent-drawer-more")!.click());
  const items = () => [...host.querySelectorAll(".agent-row-menu > .agent-row-mi, .agent-row-menu .agent-row-sub-wrap > .agent-row-mi")].map((b) => b.textContent);
  const mi = (label: string) => [...host.querySelectorAll<HTMLButtonElement>(".agent-row-mi")].find((b) => b.textContent?.includes(label))!;
  const key = (init: KeyboardEventInit) => act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
  const patches = () => calls.filter((c) => c.method === "PATCH").map((c) => [c.path, c.body]);
  const groupTitles = () => [...host.querySelectorAll(".agent-drawer-ghead")].map((g) => g.textContent);

  it("포크 — 허브가 막은 대화는 흐리고 까닭 · F·누르면 요청 번호 하나로 한 번 · 목록 맨 위·그 대화를 엶 · 시작 전 안내 · 포크 전 계획은 보기만(견적 안 함)", async () => {
    const forkPlan = { plan_id: "p9", title: "고양이 계획", status: "draft", items: [{ model: "m", prompt: "고양이" }], forked: true };
    list = [{ id: "c1", title: "고양이", ...({ can_fork: true } as object) }, { id: "c3", title: "새", engine: "codex", ...({ can_fork: false, fork_block: "codex" } as object) }];
    let forkState = "ready";
    const base = route;
    route = (c) => {
      if (c.path === "/conversations/c1/fork" && c.method === "POST") {
        const made = { id: "f1", title: "고양이 (포크)", ...({ can_fork: false, fork_block: "forked_unstarted", fork_state: "ready" } as object) };
        list = [made, ...list]; // 허브 목록에도 맨 앞(새로 만든 대화)
        return json({ conversation: full(made) });
      }
      if (c.path === "/conversations/f1" && c.method === "GET") {
        return json({ conversation: full({ id: "f1", title: "고양이 (포크)", ...({ fork_state: forkState } as object) }),
          turns: [{ id: "t1", status: "done", text: "고양이 계획해", events: [{ seq: 1, kind: "plan", plan: forkPlan }] }] });
      }
      if (c.path === "/conversations/f1" && c.method === "PATCH") return json({ conversation: full({ id: "f1", title: "고양이 (포크)" }) });
      return base(c);
    };
    await render();
    await openDrawer();
    openMenu("새");
    expect([mi("포크").disabled, mi("포크").title]).toEqual([true, "Codex 대화는 포크할 수 없어요"]);
    key({ code: "KeyF", key: "f" }); // 메뉴는 닫히고 아무것도 하지 않는다
    expect([calls.filter((c) => c.path.endsWith("/fork")), host.querySelector(".agent-row-menu")]).toEqual([[], null]);
    openMenu("고양이");
    expect(mi("포크").title).toBe("지금까지를 복사한 새 대화 — 이후는 원래와 따로");
    key({ code: "KeyF", key: "f" });
    await flush();
    const forks = calls.filter((c) => c.path === "/conversations/c1/fork");
    expect(forks.length).toBe(1);
    expect(typeof (forks[0].body as { request_id: string }).request_id).toBe("string");
    expect(host.querySelector(".agent-title-btn")!.textContent).toContain("고양이 (포크)"); // 그 대화를 열었다
    expect(host.querySelector(".agent-fork-note")!.textContent).toBe("포크한 대화예요 · 첫 말을 보내면 이 시점에서 갈라져요");
    expect([texts(".agent-plan-tag"), host.querySelector(".agent-plan-run"), host.querySelector(".agent-plan-cost")]).toEqual([["계획", "포크 전"], null, null]);
    expect(calls.filter((c) => c.path.includes("/estimate"))).toEqual([]); // 포크 전 계획은 견적을 묻지 않는다
    act(() => button("대화 목록")!.click());
    await flush();
    expect(texts(".agent-drawer-item span")[0]).toBe("고양이 (포크)");
    act(() => button("대화 목록")!.click());
    forkState = "source_changed"; // 다시 열면 시작할 수 없음 — 안내·보내기 잠금
    act(() => button("새 대화")!.click());
    await openDrawer();
    act(() => row("고양이 (포크)").querySelector<HTMLButtonElement>(".agent-drawer-item")!.click());
    await flush();
    expect(host.querySelector(".agent-fork-note.agent-error")!.textContent).toContain("이 포크는 시작할 수 없어요");
    type("이어서");
    expect(host.querySelector<HTMLButtonElement>('.agent-send[aria-label="보내기"]')!.disabled).toBe(true);
  });

  it("포크 — 응답을 잃으면 같은 요청 번호로 다시 · 한 렌더에서 두 번 눌러도 요청 하나 · 받는 중엔 포크 항목 잠금 · 그사이 새 대화면 열지 않고 늦은 목록에도 맨 위", async () => {
    list = [{ id: "c1", title: "고양이", ...({ can_fork: true } as object) }];
    const made = { id: "f1", title: "고양이 (포크)", ...({ can_fork: false, fork_block: "forked_unstarted", fork_state: "ready" } as object) };
    const answer = deferred<Response>();
    let lose = true;
    let hold: Promise<Response> | null = null;
    const base = route;
    route = (c) => {
      if (c.path === "/conversations/c1/fork" && c.method === "POST") {
        if (lose) { lose = false; throw new TypeError("Failed to fetch"); } // 응답을 잃음 — 허브가 만들었는지 모른다
        return answer.promise;
      }
      if (c.path === "/conversations/f1" && c.method === "GET") return json({ conversation: full(made), turns: [] });
      if (c.path === "/conversations" && c.method === "GET" && hold) return hold;
      return base(c);
    };
    const lists = () => calls.filter((c) => c.path === "/conversations" && c.method === "GET").length;
    await render();
    await openDrawer();
    openMenu("고양이");
    act(() => mi("포크").click());
    await flush();
    await openDrawer();
    openMenu("고양이");
    const press = mi("포크");
    act(() => { press.click(); press.click(); }); // 같은 렌더에서 두 번
    await flush();
    const forks = calls.filter((c) => c.path === "/conversations/c1/fork");
    expect(forks.length).toBe(2); // 잃은 하나 + 이번 하나
    expect((forks[1].body as { request_id: string }).request_id).toBe((forks[0].body as { request_id: string }).request_id);
    const late = deferred<Response>();
    hold = late.promise;
    const before = lists();
    await openDrawer(); // 포크 답보다 먼저 보낸 목록 조회 — 늦게 온다
    expect(lists()).toBe(before + 1);
    openMenu("고양이");
    expect(mi("포크").disabled).toBe(true); // 받는 중엔 포크 항목 잠금
    key({ code: "Escape", key: "Escape" });
    hold = new Promise<Response>(() => {}); // 이 뒤의 조회는 답하지 않는다 — 화면이 지금 가진 목록을 본다
    act(() => button("새 대화")!.click()); // 기다리는 사이 다른 화면으로
    await flush();
    answer.resolve(json({ conversation: full(made) }));
    await flush();
    expect(calls.filter((c) => c.path === "/conversations/f1" && c.method === "GET")).toEqual([]); // 자동으로 열지 않았다
    expect(host.querySelector(".agent-title-btn")?.textContent ?? "").not.toContain("고양이 (포크)");
    late.resolve(json({ conversations: list.map(full) })); // f1 없는 늦은 목록
    await flush();
    await openDrawer();
    expect(texts(".agent-drawer-item span")[0]).toBe("고양이 (포크)");
  });

  it("⋯·우클릭으로 메뉴 — 항목·단축키(event.code, 수정키·반복·조합 무시)·Esc 는 한 겹씩", async () => {
    await render({ onPopOut: () => {} });
    await openDrawer();
    openMenu("고양이");
    expect(items()).toEqual(["새 창에서 열기", "고정P", "읽지 않음으로 표시U", "이름 바꾸기R", "포크F", "프로젝트로 옮기기", "보관A", "삭제D"]);
    key({ code: "KeyP", key: "p", ctrlKey: true });
    key({ code: "KeyP", key: "p", repeat: true });
    key({ code: "KeyP", key: "ㅔ", isComposing: true });
    expect(patches()).toEqual([]);
    key({ code: "KeyP", key: "ㅔ" }); // 한글 자판에서도 자리로
    await flush();
    expect(patches()).toEqual([["/conversations/c1", { pinned: true }]]);
    expect(groupTitles()[0]).toBe("고정됨");
    act(() => { row("강아지").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 80 })); });
    expect(host.querySelector(".agent-row-menu")).not.toBeNull();
    act(() => mi("프로젝트로 옮기기").click());
    expect(host.querySelector(".agent-row-sub")).not.toBeNull();
    key({ key: "Escape" });
    expect([host.querySelector(".agent-row-sub"), !!host.querySelector(".agent-row-menu")]).toEqual([null, true]); // 하위 메뉴만
    key({ key: "Escape" });
    await flush();
    expect([host.querySelector(".agent-row-menu"), !!host.querySelector(".agent-drawer")]).toEqual([null, true]); // 행 메뉴만
    key({ key: "Escape" });
    expect(host.querySelector(".agent-drawer")).toBeNull();
  });

  it("읽지 않음 점 · 열면 그 번호로 조건부 읽음 · 수동 표시 · 보관함 · 이름 바꾸기 Enter/Esc · 프로젝트 후보는 이름 아는 id 만", async () => {
    list.push({ id: "c4", title: "모름", project: "p-unknown" });
    await render();
    await openDrawer();
    expect(row("강아지").querySelector(".agent-drawer-unread")).not.toBeNull();
    expect(row("고양이").querySelector(".agent-drawer-unread")).toBeNull();
    openMenu("고양이");
    act(() => mi("프로젝트로 옮기기").click());
    expect([...host.querySelectorAll(".agent-row-sub .agent-row-mi")].map((b) => b.textContent)).toEqual(["프롤로그 · 지금 화면", "뻘뻘뻘✓", "프로젝트 없음"]);
    act(() => mi("프롤로그").click());
    await flush();
    openMenu("고양이");
    act(() => mi("프로젝트로 옮기기").click());
    act(() => [...host.querySelectorAll<HTMLButtonElement>(".agent-row-sub .agent-row-mi")].find((b) => b.textContent === "프로젝트 없음")!.click());
    await flush();
    openMenu("새");
    act(() => mi("보관").click());
    await flush();
    expect(groupTitles().at(-1)).toBe("보관함 1");
    expect(row("새")).toBeUndefined(); // 보관함은 처음엔 접힘
    act(() => [...host.querySelectorAll<HTMLButtonElement>(".agent-drawer-ghead")].at(-1)!.click());
    expect(row("새")).toBeDefined();
    openMenu("고양이");
    act(() => mi("이름 바꾸기").click());
    const field = host.querySelector<HTMLInputElement>(".agent-drawer-rename")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "  검은 고양이  ");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    await flush();
    openMenu("검은 고양이");
    act(() => mi("이름 바꾸기").click());
    key({ key: "Escape" });
    expect(host.querySelector(".agent-drawer-rename")).toBeNull();
    expect(patches()).toEqual([
      ["/conversations/c1", { project: "p2" }], ["/conversations/c1", { project: null }], ["/conversations/c3", { archived: true }],
      ["/conversations/c1", { title: "검은 고양이" }],
    ]);
    act(() => row("강아지").querySelector<HTMLButtonElement>(".agent-drawer-item")!.click());
    await flush();
    expect(patches().at(-1)).toEqual(["/conversations/c2", { unread: false, seen_rev: 3 }]); // 열 때 본 번호로
    await openDrawer();
    act(() => row("검은 고양이").querySelector<HTMLButtonElement>(".agent-drawer-item")!.click()); // 이미 읽음 — 안 보냄
    await flush();
    expect(patches()).toHaveLength(5);
  });

  it("삭제 — 확인 창 · 결과 안내 · 지금 대화면 비우고 마지막 대화 기억도 같을 때만 · 다른 창에 알림", async () => {
    await render();
    await openDrawer();
    act(() => row("고양이").querySelector<HTMLButtonElement>(".agent-drawer-item")!.click());
    await flush();
    expect(host.querySelector(".agent-head-left")!.textContent).toBe("고양이");
    await openDrawer();
    openMenu("고양이");
    act(() => mi("삭제").click());
    expect(host.querySelector(".agent-drawer-confirm")!.textContent).toContain("되돌릴 수 없어요");
    act(() => [...host.querySelectorAll<HTMLButtonElement>(".agent-confirm-btn")].find((b) => b.textContent === "삭제")!.click());
    await flush();
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/conversations/c1"]);
    expect(host.querySelector(".agent-drawer-note")!.textContent).toBe("지웠어요 · Claude 세션 파일은 확인하지 못해 남겨 뒀어요");
    expect([row("고양이"), host.querySelector(".agent-head-left")!.textContent]).toEqual([undefined, "새 대화"]);
    expect(JSON.parse(localStorage.getItem("mvhub.agentPanel.conversation") ?? "null")).toBeNull(); // 지운 id 와 같아서 비움
    expect(JSON.parse(localStorage.getItem("mvhub.agentPanel.deleted")!)).toMatchObject({ account: "acct:jay@example.com", id: "c1" });
    openMenu("새");
    act(() => mi("삭제").click());
    expect(host.querySelector(".agent-drawer-confirm")!.textContent).toContain("Codex 기록이 Codex 폴더에 남아요");
  });

  it("다른 창에서 지운 대화 — 보던 대화면 비우고 안내 · 끝남 사건의 번호로 조건부 읽음", async () => {
    route = ((base) => (c: Call) => {
      if (c.path === "/turns") return started("t9", "c2");
      if (c.path === "/turns/t9/events?after=0") return json({ events: [{ seq: 1, kind: "state", status: "done", unread_rev: 7 }], status: "done", last_seq: 1 });
      return base(c);
    })(route);
    await render();
    type("안녕");
    enter();
    await flush();
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([{ unread: false, seen_rev: 7 }]);
    localStorage.setItem("mvhub.agentPanel.deleted", JSON.stringify({ account: "acct:jay@example.com", id: "c2", at: Date.now() }));
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key: "mvhub.agentPanel.deleted" })); });
    await flush();
    expect([host.querySelector(".agent-head-left")!.textContent, host.querySelector(".agent-notice")!.textContent]).toEqual(["새 대화", "이 대화는 다른 창에서 지워졌어요"]);
  });

  it("새 창에서 열기 — 옆 칸은 요청을 적고 띄움 · 새 창만 받고(복원보다 먼저) · 처리 번호는 공유 키 · 30초 지난 요청·다른 신원은 무시", async () => {
    let popped = 0;
    await render({ onPopOut: () => { popped += 1; } });
    await openDrawer();
    openMenu("강아지");
    act(() => mi("새 창에서 열기").click());
    const req = JSON.parse(localStorage.getItem("mvhub.agentPanel.openRequest")!);
    expect([popped, req.id, req.identity, req.account]).toEqual([1, "c2", "id-1", "acct:jay@example.com"]);
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key: "mvhub.agentPanel.openRequest" })); }); // 옆 칸은 무시
    await flush();
    expect(calls.some((c) => c.path === "/conversations/c2" && c.method === "GET")).toBe(false);
    localStorage.setItem("mvhub.agentPanel.conversation", JSON.stringify({ account: "acct:jay@example.com", id: "c1" }));
    act(() => root.unmount());
    root = createRoot(host);
    await render({ popout: true });
    expect([host.querySelector(".agent-head-left")!.textContent, localStorage.getItem("mvhub.agentPanel.openDone")]).toEqual(["강아지", req.nonce]);
    act(() => root.unmount()); // 닫았다 다시 연 새 창 — 처리한 요청은 다시 안 연다(마지막 대화 복원)
    root = createRoot(host);
    await render({ popout: true });
    expect(host.querySelector(".agent-head-left")!.textContent).toBe("강아지"); // 열었던 대화가 '마지막 대화'가 됐다
    localStorage.setItem("mvhub.agentPanel.openRequest", JSON.stringify({ ...req, id: "c1", nonce: "n-old", at: Date.now() - 31_000 }));
    act(() => root.unmount());
    root = createRoot(host);
    await render({ popout: true });
    expect(host.querySelector(".agent-head-left")!.textContent).toBe("강아지"); // 30초 지난 요청은 뜰 때 무시
    localStorage.setItem("mvhub.agentPanel.openRequest", JSON.stringify({ ...req, id: "c1", nonce: "n-other", identity: "id-2", at: Date.now() }));
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key: "mvhub.agentPanel.openRequest" })); });
    await flush();
    expect(host.querySelector(".agent-head-left")!.textContent).toBe("강아지"); // 다른 신원
    localStorage.setItem("mvhub.agentPanel.openRequest", JSON.stringify({ ...req, id: "c1", nonce: "n-new", at: Date.now() }));
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key: "mvhub.agentPanel.openRequest" })); }); // 열린 새 창은 알림으로
    await flush();
    expect(host.querySelector(".agent-head-left")!.textContent).toBe("고양이");
    expect(localStorage.getItem("mvhub.agentPanel.openRequest")).toContain("n-new"); // 받는 창은 요청 키를 안 지운다
    await openDrawer();
    openMenu("고양이");
    expect(mi("새 창에서 열기")).toBeUndefined(); // 새 창 안에서는 없음
  });

  it("불러오는 중에 다른 창에서 지우면 늦은 복원 응답을 버린다 · 숨은 창에서 받은 끝남은 다시 보일 때 읽음 · 늦은 옛 읽음 응답은 새 표시를 못 덮는다", async () => {
    const slow = deferred<Response>();
    const base = route;
    route = (c) => (c.path === "/conversations/c2" && c.method === "GET" ? slow.promise : base(c));
    await render();
    await openDrawer();
    act(() => row("강아지").querySelector<HTMLButtonElement>(".agent-drawer-item")!.click());
    await flush();
    localStorage.setItem("mvhub.agentPanel.deleted", JSON.stringify({ account: "acct:jay@example.com", id: "c2", at: Date.now() }));
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key: "mvhub.agentPanel.deleted" })); });
    slow.resolve(json({ conversation: full(list[1]), turns: [] }));
    await flush();
    expect([host.querySelector(".agent-head-left")!.textContent, host.querySelector(".agent-notice")!.textContent]).toEqual(["새 대화", "이 대화는 다른 창에서 지워졌어요"]);

    const hidden = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      route = (c) => {
        if (c.path === "/turns") return started("t7", "c1");
        if (c.path === "/turns/t7/events?after=0") return json({ events: [{ seq: 1, kind: "state", status: "done", unread_rev: 5 }], status: "done", last_seq: 1 });
        return base(c);
      };
      type("숨은 창");
      enter();
      await flush();
      expect(patches()).toEqual([]); // 숨어 있으면 들고 있는다
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      act(() => { document.dispatchEvent(new Event("visibilitychange")); });
      await flush();
      expect(patches()).toEqual([["/conversations/c1", { unread: false, seen_rev: 5 }]]);
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
      if (hidden) Object.defineProperty(Document.prototype, "visibilityState", hidden);
    }

    // 늦은 자동 읽음(옛 번호) 응답이 그 뒤 수동 '읽지 않음'(새 번호)을 덮지 않는다
    const late = deferred<Response>();
    route = (c) => (c.method === "PATCH" && c.body && "seen_rev" in c.body ? late.promise : base(c));
    list[1] = { ...list[1], unread: true, unread_rev: 3 };
    await openDrawer();
    act(() => row("강아지").querySelector<HTMLButtonElement>(".agent-drawer-item")!.click()); // 열기 → 자동 읽음(늦게 옴)
    await flush();
    await openDrawer();
    openMenu("강아지");
    act(() => mi("읽음으로 표시").click()); // 화면이 아직 '읽지 않음'으로 알고 있다 → 수동 읽음(번호 4)
    await flush();
    openMenu("강아지");
    act(() => mi("읽지 않음으로 표시").click()); // 수동 읽지 않음(번호 5)
    await flush();
    late.resolve(json({ conversation: full({ ...list[1], unread: false, unread_rev: 4 }) })); // 옛 응답
    await flush();
    expect(row("강아지").querySelector(".agent-drawer-unread")).not.toBeNull();
  });

  it("새 창 — 바쁠 때 온 열기 요청은 최신 하나를 들고 있다가 차례가 끝나면 연다", async () => {
    const stay = deferred<Response>();
    const base = route;
    route = (c) => (c.path === "/turns" ? started("t3", "c3") : c.path === "/turns/t3/events?after=0" ? stay.promise : base(c));
    await render({ popout: true });
    type("일해");
    enter();
    await flush();
    for (const [id, nonce] of [["c1", "n1"], ["c2", "n2"]]) {
      localStorage.setItem("mvhub.agentPanel.openRequest", JSON.stringify({ account: "acct:jay@example.com", identity: "id-1", id, nonce, at: Date.now() }));
      act(() => { window.dispatchEvent(new StorageEvent("storage", { key: "mvhub.agentPanel.openRequest" })); });
    }
    await flush();
    expect(calls.some((c) => c.method === "GET" && /^\/conversations\/c[12]$/.test(c.path))).toBe(false); // 바쁠 때는 안 바꾼다
    stay.resolve(json({ events: [{ seq: 1, kind: "state", status: "done" }], status: "done", last_seq: 1 }));
    await flush();
    expect(host.querySelector(".agent-head-left")!.textContent).toBe("강아지"); // 최신(c2)만
    expect(calls.some((c) => c.method === "GET" && c.path === "/conversations/c1")).toBe(false);
  });

  it("서랍 넓이 — 끝선을 끌어 바꿔 남기고, 칸 폭이 바뀌면 상한을 다시 맞춘다 · 좁은 칸은 하위 메뉴를 아래로", async () => {
    const proto = Element.prototype as unknown as Record<string, unknown>;
    proto.setPointerCapture ??= () => {};
    proto.releasePointerCapture ??= () => {};
    proto.hasPointerCapture ??= () => false;
    class FakePointer extends MouseEvent {
      pointerId: number; isPrimary: boolean;
      constructor(type: string, init: MouseEventInit & { pointerId?: number }) { super(type, init); this.pointerId = init.pointerId ?? 1; this.isPrimary = true; }
    }
    let observed: (() => void) | null = null;
    vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { observed = cb; } observe() {} disconnect() {} });
    await render();
    await openDrawer();
    const nav = () => host.querySelector<HTMLElement>(".agent-drawer")!;
    const handle = host.querySelector<HTMLElement>(".agent-drawer-resize")!;
    act(() => { handle.dispatchEvent(new FakePointer("pointerdown", { bubbles: true, button: 0, clientX: 100, pointerId: 7 })); });
    act(() => { handle.dispatchEvent(new FakePointer("pointermove", { bubbles: true, clientX: 160, pointerId: 7 })); });
    act(() => { handle.dispatchEvent(new FakePointer("pointerup", { bubbles: true, clientX: 160, pointerId: 7 })); });
    expect([nav().style.width, localStorage.getItem("mvhub.agentPanel.drawerWidth")]).toEqual(["370px", "370"]);
    const panelEl = host.querySelector<HTMLElement>(".agent-panel")!;
    Object.defineProperty(panelEl, "clientWidth", { configurable: true, value: 300 });
    act(() => observed!());
    expect(nav().style.width).toBe("260px"); // 칸 폭 − 40
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 300 });
    openMenu("고양이");
    act(() => mi("프로젝트로 옮기기").click());
    expect(host.querySelector(".agent-row-sub")!.classList.contains("below")).toBe(true);
  });

  it("늦게 온 목록 조회는 보낸 뒤 바꾼 줄(표시·지움)을 덮지 않는다 · 좁은 칸·후보 많음 — 아래로 펼친 메뉴는 높이 상한·스크롤", async () => {
    const base = route;
    let gets = 0;
    const slowList = deferred<Response>();
    route = (c) => {
      if (c.path === "/conversations" && c.method === "GET") {
        gets += 1;
        if (gets === 2) { const old = list.map(full); return slowList.promise.then(() => json({ conversations: old })); } // 보낸 때의 옛 목록
      }
      return base(c);
    };
    await render();
    await openDrawer();
    act(() => button("대화 목록")!.click());
    await openDrawer(); // 두 번째 조회 — 늦게 온다
    openMenu("고양이");
    act(() => mi("읽지 않음으로 표시").click());
    await flush();
    openMenu("새");
    act(() => mi("삭제").click());
    act(() => [...host.querySelectorAll<HTMLButtonElement>(".agent-confirm-btn")].find((b) => b.textContent === "삭제")!.click());
    await flush();
    slowList.resolve(json({}));
    await flush();
    expect(row("고양이").querySelector(".agent-drawer-unread")).not.toBeNull(); // 수동 표시가 옛 조회에 덮이지 않음
    expect(row("새")).toBeUndefined(); // 지운 줄이 옛 조회로 되살아나지 않음

    // 고정 PATCH 가 늦는 사이 그 대화를 지움 → 늦은 PATCH 응답 → 지우기 전에 보낸 목록 응답: 지운 줄이 되살아나지 않는다(재확인 3)
    const slowPatch = deferred<Response>();
    const slowList2 = deferred<Response>();
    route = (c) => {
      if (c.path === "/conversations/c2" && c.method === "PATCH") return slowPatch.promise;
      if (c.path === "/conversations" && c.method === "GET") { const old = list.map(full); return slowList2.promise.then(() => json({ conversations: old })); }
      return base(c);
    };
    act(() => button("대화 목록")!.click());
    await openDrawer(); // 조회를 보냄 — 늦게 온다(옛 목록에 강아지가 있다)
    openMenu("강아지");
    act(() => mi("고정").click());
    await flush();
    openMenu("강아지");
    act(() => mi("삭제").click());
    act(() => [...host.querySelectorAll<HTMLButtonElement>(".agent-confirm-btn")].find((b) => b.textContent === "삭제")!.click());
    await flush();
    expect(row("강아지")).toBeUndefined();
    slowPatch.resolve(json({ conversation: full({ id: "c2", title: "강아지", pinned: true, unread: true, unread_rev: 3 }) }));
    await flush();
    slowList2.resolve(json({}));
    await flush();
    expect(row("강아지")).toBeUndefined();
    route = base;
    act(() => button("대화 목록")!.click());

    // 목록이 아직 없을 때(첫 조회 중) 받은 요약 — 늦게 온 조회에서 그 대화가 빠지지 않고 요약이 합쳐진다(재확인 2)
    act(() => root.unmount());
    root = createRoot(host);
    list = [{ id: "c1", title: "고양이", unread: true, unread_rev: 4 }];
    const firstList = deferred<Response>();
    route = (c) => {
      if (c.path === "/conversations" && c.method === "GET") { const old = list.map(full); return firstList.promise.then(() => json({ conversations: old })); }
      if (c.path === "/turns") return started("t8", "c1");
      if (c.path === "/turns/t8/events?after=0") return json({ events: [{ seq: 1, kind: "state", status: "done", unread_rev: 4 }], status: "done", last_seq: 1 });
      return base(c);
    };
    await render();
    await openDrawer(); // 첫 조회 — 아직 목록 없음
    type("마저");
    enter();
    await flush(); // 끝남 → 자동 읽음 응답(목록 밖에서 도착)
    firstList.resolve(json({}));
    await flush();
    expect(row("고양이")).toBeDefined();
    expect(row("고양이").querySelector(".agent-drawer-unread")).toBeNull(); // 받은 요약(읽음)이 합쳐짐

    act(() => button("대화 목록")!.click());
    route = base;
    list = Array.from({ length: 14 }, (_, i) => ({ id: `c${i + 1}`, title: `대화${i + 1}`, project: `p${i + 1}` }));
    act(() => root.render(<AgentPanel context={{ tab: "my" }} contextLabel="워크스페이스" onClose={() => {}}
      projectName={(id) => `프로젝트 ${id}`} />));
    await flush();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 300 });
    await openDrawer();
    openMenu("대화1");
    act(() => mi("프로젝트로 옮기기").click());
    expect(host.querySelectorAll(".agent-row-sub.below .agent-row-mi")).toHaveLength(15); // 후보 14 + 없음
    expect(host.querySelector(".agent-row-sub.below")!.textContent).toContain("프로젝트 p1");
    expect(host.querySelector(".agent-row-menu")!.classList.contains("stacked")).toBe(true);
    const css = readFileSync(new NodeURL("../src/styles/agent-chat.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.agent-row-sub\.below \{[^}]*max-height: 200px;[^}]*overflow-y: auto/);
    expect(css).toMatch(/\.agent-row-menu\.stacked \{ max-height: calc\(100% - 16px\); overflow-y: auto; \}/);
  });

  it("도는 대화는 바꾸는 항목 잠금 · 목록이 잘렸으면 '최근 500개만' · 서랍 넓이 끌기·더블클릭·저장", async () => {
    const base = route;
    route = (c) => (c.path === "/conversations" && c.method === "GET" ? json({ conversations: list.map(full), truncated: true }) : base(c));
    await render();
    await openDrawer();
    expect(host.querySelector(".agent-drawer-list")!.textContent).toContain("최근 500개만 보여요");
    const nav = () => host.querySelector<HTMLElement>(".agent-drawer")!;
    const handle = host.querySelector<HTMLElement>(".agent-drawer-resize")!;
    expect(nav().style.width).toBe("310px");
    act(() => { handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    expect([nav().style.width, localStorage.getItem("mvhub.agentPanel.drawerWidth")]).toEqual(["318px", "318"]);
    act(() => { handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(nav().style.width).toBe("310px");
    localStorage.setItem("mvhub.agentPanel.drawerWidth", "5000");
    act(() => button("대화 목록")!.click());
    await openDrawer();
    expect(nav().style.width).toBe("1560px"); // 칸 폭(jsdom 은 창 폭) − 40 이 최대
    act(() => button("대화 목록")!.click());
    // 도는 대화 — 그 대화의 바꾸는 항목은 잠그고, 다른 대화는 된다
    const stay = deferred<Response>();
    const before = route;
    route = (c) => (c.path === "/turns" ? started("t5", "c1") : c.path === "/turns/t5/events?after=0" ? stay.promise : before(c));
    type("계속 일해");
    enter();
    await flush();
    await openDrawer();
    openMenu("고양이");
    expect(["고정", "이름 바꾸기", "보관", "삭제"].map((label) => mi(label).disabled)).toEqual([true, true, true, true]);
    act(() => mi("고정").click());
    openMenu("강아지");
    expect(mi("고정").disabled).toBe(false);
    expect(patches()).toEqual([]);
  });

  it("머리글 제목 메뉴 — 새 대화엔 단추 없음 · [제목 ⌄] 은 읽지 않음 뺀 같은 메뉴 · 단축키 · 제목 자리 이름 바꾸기 · 보관하면 새 대화 · 삭제 확인·안내 · 새 창에서 열기", async () => {
    const popped = vi.fn();
    await render({ onPopOut: popped });
    const titleBtn = () => host.querySelector<HTMLButtonElement>(".agent-title-btn");
    expect([titleBtn(), host.querySelector(".agent-head-left")!.textContent]).toEqual([null, "새 대화"]);
    const open = async (title: string) => {
      await openDrawer();
      act(() => row(title).querySelector<HTMLButtonElement>(".agent-drawer-item")!.click());
      await flush();
    };
    await open("고양이");
    expect(titleBtn()!.textContent).toBe("고양이");
    act(() => titleBtn()!.click());
    expect(items()).toEqual(["새 창에서 열기", "고정P", "이름 바꾸기R", "포크F", "프로젝트로 옮기기", "보관A", "삭제D"]);
    act(() => titleBtn()!.click()); // 다시 누르면 닫힘
    expect(host.querySelector(".agent-row-menu")).toBeNull();
    act(() => titleBtn()!.click());
    key({ code: "KeyP" });
    await flush();
    expect(patches()).toEqual([["/conversations/c1", { pinned: true }]]);
    act(() => titleBtn()!.click());
    expect(mi("고정 풀기")).toBeDefined(); // 허브 응답으로 머리글 요약도 바뀜
    act(() => mi("이름 바꾸기").click());
    const field = host.querySelector<HTMLInputElement>(".agent-title-rename")!;
    expect(field.value).toBe("고양이");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "검은 고양이");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    await flush();
    expect([titleBtn()!.textContent, patches().at(-1)]).toEqual(["검은 고양이", ["/conversations/c1", { title: "검은 고양이" }]]);
    act(() => titleBtn()!.click());
    key({ key: "Escape" }); // Esc 는 메뉴만 닫고 제목 단추로 초점
    expect([host.querySelector(".agent-row-menu"), document.activeElement]).toEqual([null, titleBtn()]);
    act(() => titleBtn()!.click());
    act(() => mi("보관").click());
    await flush();
    expect([patches().at(-1), titleBtn(), host.querySelector(".agent-head-left")!.textContent])
      .toEqual([["/conversations/c1", { archived: true }], null, "새 대화"]);

    await open("강아지");
    act(() => titleBtn()!.click());
    act(() => mi("삭제").click());
    expect(host.querySelector(".agent-drawer-confirm")!.textContent).toContain("되돌릴 수 없어요");
    act(() => [...host.querySelectorAll<HTMLButtonElement>(".agent-confirm-btn")].find((b) => b.textContent === "삭제")!.click());
    await flush();
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/conversations/c2"]);
    expect([titleBtn(), host.querySelector(".agent-notice")!.textContent]).toEqual([null, "지웠어요 · Claude 세션 파일은 확인하지 못해 남겨 뒀어요"]);

    await open("새");
    expect(host.querySelector(".agent-notice")).toBeNull(); // 다른 대화를 열면 지운 안내는 끝
    act(() => titleBtn()!.click());
    act(() => mi("새 창에서 열기").click());
    expect(popped).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem("mvhub.agentPanel.openRequest")!)).toMatchObject({ id: "c3" });
    expect(host.querySelector(".agent-row-menu")).toBeNull();
  });
});

// 끌어다 넣기(docs/status/MVAgent_끌어다넣기_2026-11-12.md 2-1·2-5)
describe("MV Agent 끌어다 넣기", () => {
  const PERSONAL = { scope: "personal", id: null, name: "개인" };
  const ASSET = "application/x-ch-asset", GEN = "application/x-ch-gen", GENLIST = "application/x-ch-genlist", FOLDER = "application/x-ch-project-folder";
  const gen = (id: string, extra: Record<string, unknown> = {}) => ({
    id, prompt: `프롬프트 ${id}`, model: "m", status: "done", created_at: "2026-11-12T00:00:00", workspace_scope: "personal", workspace_id: null,
    assets: [{ id: `${id}-a`, type: "image", file_path: `/media/${id}.png` }], ...extra,
  });
  let gens: Record<string, unknown>;
  beforeEach(() => {
    gens = { g1: gen("g1"), g2: gen("g2") };
    route = (c) => {
      if (c.path === "/session") return session();
      const one = c.path.match(/^\/api\/generations\/([^/?]+)$/);
      if (one && one[1] !== "batch") return gens[one[1]] ? json(gens[one[1]]) : json({ detail: "generation 없음" }, 404);
      if (c.path === "/api/generations/batch") {
        const ids = (c.body?.gen_ids as string[]) ?? [];
        return json({ items: Object.fromEntries(ids.filter((id) => gens[id]).map((id) => [id, gens[id]])), materials: {}, missing: [] });
      }
      if (c.path === "/turns" && c.method === "POST") return started("t9", "c9");
      if (c.path === "/turns/t9/events?after=0") return json({ events: [{ seq: 1, kind: "state", status: "done" }], status: "done", last_seq: 1 });
      return json({ detail: "Not Found" }, 404);
    };
  });
  const render = async (workspace: unknown = PERSONAL) => {
    act(() => root.render(<AgentPanel context={{ tab: "my", workspace } as never} contextLabel="개인" onClose={() => {}} />));
    await flush();
  };
  const fire = (type: string, data: Record<string, string>, target: Element = panel()) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types: Object.keys(data), getData: (k: string) => data[k] ?? "", dropEffect: "none" } });
    act(() => { target.dispatchEvent(event); });
    return event as Event & { dataTransfer: { dropEffect: string } };
  };
  const drop = async (data: Record<string, string>, target?: Element) => {
    fire("dragenter", data, target);
    const event = fire("drop", data, target);
    await flush();
    return event;
  };
  const chipNames = () => texts(".agent-attach .agent-context-text b");
  const notice = () => host.querySelector(".agent-notice")?.textContent ?? null;

  it("붙인 자료 번호 — 칩·내 말 위는 붙인 순서 1·2(보낸 순서와 같음), 정보 칸 '이 대화에서 만든 것'은 번호 없음", async () => {
    await render();
    await drop({ [GEN]: "g1" });
    await drop({ [FOLDER]: JSON.stringify({ projectId: "p1", path: "e001/c0010" }) });
    expect(texts(".agent-chips .agent-attach-num")).toEqual(["1", "2"]);
    type("1번을 2번 폴더에");
    enter();
    await flush();
    expect(turnCalls()[0].body!.attachments).toMatchObject([{ kind: "generation", id: "g1" }, { kind: "folder", project_id: "p1" }]);
    expect(texts(".agent-sent .agent-attach-num")).toEqual(["1", "2"]);
    act(() => button("정보")!.click());
    expect(host.querySelectorAll(".agent-info .agent-attach-num").length).toBe(0);
  });

  it("받는 형식에만 덮개 · 어셋은 끌기 값만(저장값으로 넓히지 않음)·필드 검사 · 생성물 묶음·폴더 · 중복·8개 상한 · 입력칸 위 놓기는 기본 동작 막음", async () => {
    await render();
    const text = fire("dragenter", { "text/plain": "글자" });
    expect([text.defaultPrevented, host.querySelector(".agent-drop")]).toEqual([false, null]); // 받지 않는 형식(글자) = 손대지 않음 — OS 파일은 그림 넣기(agentChatImages.test.tsx)
    fire("dragenter", { [ASSET]: "[]" });
    expect(host.querySelector(".agent-drop")!.textContent).toContain("놓으면 대화에 붙어요");
    const over = fire("dragover", { [ASSET]: "[]" });
    expect([over.defaultPrevented, over.dataTransfer.dropEffect]).toEqual([true, "copy"]);
    fire("dragleave", { [ASSET]: "[]" });
    expect(host.querySelector(".agent-drop")).toBeNull();

    localStorage.setItem("mvhub.assetsDrag", JSON.stringify([{ project: "p", path: "stale.png", name: "stale.png", type: "image" }]));
    await drop({ [ASSET]: JSON.stringify([
      { project: "my-assets", path: "e001/apple.png", name: "apple\npng", type: "image" },
      { project: "my-assets", path: "bad\npath.png", name: "x", type: "image" },
      { project: "my-assets", path: "doc.txt", name: "doc", type: "text" },
    ]) });
    expect(chipNames()).toEqual(["apple png"]);
    expect(notice()).toBe("2개는 붙일 수 없어 뺐어요");
    await drop({ [GENLIST]: "g1,g2,bad id", [GEN]: "g1" });
    expect(chipNames()).toEqual(["apple png", "프롬프트 g1", "프롬프트 g2"]);
    const projectId = "x".repeat(201);
    await drop({ [FOLDER]: JSON.stringify({ projectId, path: "e001" }) });
    expect(notice()).toBe("1개는 붙일 수 없어 뺐어요");
    await drop({ [FOLDER]: JSON.stringify({ projectId: "p1", projectName: "뻘뻘뻘", path: "e001/c0010" }) });
    expect(host.querySelector(".agent-attach:last-child small")!.textContent).toBe("폴더 · 뻘뻘뻘");
    await drop({ [GEN]: "g1" });
    expect(chipNames()).toHaveLength(4); // 같은 것은 하나로
    gens = { ...gens, ...Object.fromEntries(["g3", "g4", "g5", "g6", "g7"].map((id) => [id, gen(id)])) };
    await drop({ [GENLIST]: "g3,g4,g5,g6,g7" });
    expect([chipNames().length, notice()]).toEqual([8, "8개까지 붙일 수 있어요"]);
    const onInput = await drop({ [GEN]: "g9" }, input());
    expect(onInput.defaultPrevented).toBe(true);
  });

  it("공간 미확정이면 받지 않고 안내(기본 동작은 막음) · 공간(scope·id)이 바뀌면 비움(팀 이름만 채워지면 그대로) · 다른 공간 생성물 거절 · 늦은 조회 응답은 비운 칩을 못 살림", async () => {
    await render({ scope: "unknown", id: null, name: null });
    fire("dragenter", { [GEN]: "g1" });
    expect(host.querySelector(".agent-drop.blocked")!.textContent).toContain("공간을 확인한 뒤 다시 끌어 주세요");
    expect(fire("dragover", { [GEN]: "g1" }).dataTransfer.dropEffect).toBe("none");
    const refused = await drop({ [GEN]: "g1" });
    expect([refused.defaultPrevented, chipNames(), notice()]).toEqual([true, [], "공간을 확인한 뒤 다시 끌어 주세요"]);

    await render({ scope: "team", id: "team-a", name: null });
    gens.g1 = gen("g1", { workspace_scope: "team", workspace_id: "team-a" });
    gens.g2 = gen("g2"); // 개인 공간 생성물
    await drop({ [GENLIST]: "g1,g2" });
    expect([chipNames(), notice()]).toEqual([["프롬프트 g1"], "다른 공간의 생성물이에요"]);
    await render({ scope: "team", id: "team-a", name: "팀 A" });
    expect(chipNames()).toEqual(["프롬프트 g1"]);
    await render({ scope: "personal", id: null, name: "개인" });
    expect([chipNames(), notice()]).toEqual([[], "공간이 바뀌어 붙인 자료를 비웠어요"]);

    const late = deferred<Response>();
    const base = route;
    route = (c) => (c.path === "/api/generations/g3" ? late.promise : base(c));
    await drop({ [GEN]: "g3" });
    expect(host.querySelector(".agent-attach.pending")).not.toBeNull();
    await render({ scope: "team", id: "team-b", name: null }); // 기다리는 사이 공간이 바뀌어 비움
    late.resolve(json(gen("g3", { workspace_scope: "team", workspace_id: "team-b" })));
    await flush();
    expect(chipNames()).toEqual([]);
    const lateFail = deferred<Response>();
    route = (c) => (c.path === "/api/generations/g4" ? lateFail.promise : base(c));
    await drop({ [GEN]: "g4" });
    await render({ scope: "personal", id: null, name: "개인" }); // 실패 답(회색 칩)도 비운 뒤에는 못 들어온다
    lateFail.resolve(json({ detail: "boom" }, 500));
    await flush();
    expect(texts(".agent-attach")).toEqual([]);
    // 같은 개인 공간끼리 계정만 바뀌어도 비운다(독립 리뷰 P1)
    route = base;
    await drop({ [GEN]: "g2" }); // 개인 공간 생성물(g1 은 위에서 팀 공간으로 바꿈)
    expect(chipNames()).toHaveLength(1);
    sessionStorage.setItem("ch.accountScope", "other@example.com");
    try {
      await render({ scope: "personal", id: null, name: "개인" });
      expect([chipNames(), notice()]).toEqual([[], "공간이 바뀌어 붙인 자료를 비웠어요"]);
    } finally {
      sessionStorage.setItem("ch.accountScope", "jay@example.com");
    }
  });

  it("보낸 묶음만 칩 번호로 지움(보내는 사이 ×로 뺐다 다시 붙인 같은 자료는 남음) · 같은 미조회 생성물을 가진 다른 대화로 옮기면 그 대화의 조회를 새로 하고 늦은 앞 답은 버림", async () => {
    await render();
    await drop({ [GEN]: "g1" });
    const slow = deferred<Response>();
    const base = route;
    route = (c) => (c.path === "/turns" && c.method === "POST" ? slow.promise : base(c));
    type("이걸로");
    enter();
    await flush();
    act(() => host.querySelector<HTMLButtonElement>(".agent-attach .agent-context-x")!.click());
    await drop({ [GEN]: "g1" }); // 보내는 사이 같은 자료를 다시 붙임 — 새 칩
    slow.resolve(started("t9", "c9"));
    await flush();
    expect(chipNames()).toEqual(["프롬프트 g1"]);

    const convo = (id: string) => ({ conversation: { id, title: `대화 ${id}`, engine: "claude", model: "opus", effort: "medium", updated_at: "",
      resumable: true, pinned: false, archived: false, unread: false, unread_rev: 0 },
      turns: [{ id: `t-${id}`, status: "done", text: "봐 줘", created_at: "", events: [],
        attachments: { workspace: { scope: "personal", id: null }, items: [{ kind: "generation", id: "g8" }] } }] });
    gens.g8 = gen("g8");
    const firstBatch = deferred<Response>();
    let batches = 0;
    route = (c) => {
      if (c.path === "/conversations" && c.method === "GET") {
        return json({ conversations: ["cA", "cB"].map((id) => ({ ...convo(id).conversation, project: null })) });
      }
      if (c.path === "/conversations/cA" || c.path === "/conversations/cB") return json(convo(c.path.split("/").pop()!));
      if (c.path === "/api/generations/batch") {
        batches += 1;
        if (batches === 1) return firstBatch.promise;
      }
      return base(c);
    };
    act(() => root.unmount());
    root = createRoot(host);
    localStorage.setItem("mvhub.agentPanel.conversation", JSON.stringify({ account: "acct:jay@example.com", id: "cA" }));
    await render();
    expect(batches).toBe(1); // cA 의 조회가 아직 안 끝남
    act(() => button("대화 목록")!.click());
    await flush();
    act(() => [...host.querySelectorAll<HTMLElement>(".agent-drawer-row")].find((r) => r.textContent?.includes("대화 cB"))!
      .querySelector<HTMLButtonElement>(".agent-drawer-item")!.click());
    await flush();
    expect(batches).toBe(2); // 같은 g8 이라도 cB 의 조회를 새로 한다
    expect(host.querySelector(".agent-user-wrap .agent-sent .agent-sent-tile img")).not.toBeNull();
    firstBatch.resolve(json({ items: {}, materials: {}, missing: ["g8"] })); // 늦은 cA 답(못 찾음) — 버린다
    await flush();
    expect(host.querySelector(".agent-user-wrap .agent-sent .agent-sent-tile img")).not.toBeNull();
  });

  it("보낼 때 묶음을 고정해 싣고 성공하면 그 묶음만 비움(보내는 사이 붙인 칩은 남음) · 서명에 붙인 자료 · 내 말 위 썸네일 · 복원 썸네일은 묶음 조회 한 번", async () => {
    await render();
    await drop({ [GEN]: "g1" });
    await drop({ [FOLDER]: JSON.stringify({ projectId: "p1", projectName: "뻘뻘뻘", path: "e001/c0010" }) });
    const slow = deferred<Response>();
    const base = route;
    let fail = true;
    route = (c) => (c.path === "/turns" && c.method === "POST" ? (fail ? json({ detail: "boom" }, 500) : slow.promise) : base(c));
    type("이걸로 만들어");
    enter();
    await flush();
    const firstKey = turnCalls()[0].body!.idempotency_key;
    expect(turnCalls()[0].body).toMatchObject({
      attachments: [{ kind: "generation", id: "g1", name: "프롬프트 g1" }, { kind: "folder", project_id: "p1", path: "e001/c0010", name: "c0010" }],
      attach_workspace: { scope: "personal", id: null },
    });
    expect(chipNames()).toHaveLength(2); // 실패 = 그대로
    act(() => host.querySelectorAll<HTMLButtonElement>(".agent-attach .agent-context-x")[1].click()); // 폴더 빼기
    fail = false;
    enter(); // 같은 글·다른 붙인 자료 = 새 열쇠
    await flush();
    expect(turnCalls()[1].body!.idempotency_key).not.toBe(firstKey);
    await drop({ [GEN]: "g2" }); // 보내는 사이 붙임
    slow.resolve(started("t9", "c9"));
    await flush();
    expect(chipNames()).toEqual(["프롬프트 g2"]);
    const sent = host.querySelector(".agent-user-wrap .agent-sent")!;
    expect(sent.querySelectorAll(".agent-sent-tile img")).toHaveLength(1);
    act(() => button("정보")!.click()); // 정보 칸의 '붙였던 자료'
    expect(texts(".agent-info-list li")).toEqual(["프롬프트 g1생성물"]);
    expect(texts(".agent-info-empty")).toEqual(["아직 없어요"]); // 이 대화에서 만든 것 없음
    act(() => button("정보")!.click());

    // 복원 — 앱 카드에 없는 생성물만 묶음 조회 한 번
    route = (c) => {
      if (c.path === "/conversations/c5") {
        return json({ conversation: { id: "c5", title: "붙인 대화", engine: "claude", model: "opus", effort: "medium", updated_at: "", resumable: true,
          pinned: false, archived: false, unread: false, unread_rev: 0 },
          turns: [{ id: "t5", status: "done", text: "봐 줘", created_at: "", events: [],
            attachments: { workspace: { scope: "personal", id: null }, items: [{ kind: "generation", id: "g7" }, { kind: "asset", project: "a", path: "x.png" }] } }] });
      }
      return base(c);
    };
    gens.g7 = gen("g7");
    act(() => root.unmount());
    root = createRoot(host);
    localStorage.setItem("mvhub.agentPanel.conversation", JSON.stringify({ account: "acct:jay@example.com", id: "c5" }));
    await render();
    const batches = calls.filter((c) => c.path === "/api/generations/batch");
    expect(batches.map((c) => c.body!.gen_ids)).toEqual([["g7"]]);
    expect(host.querySelectorAll(".agent-user-wrap .agent-sent .agent-sent-tile")).toHaveLength(2);

    // 늦은 복원 묶음 조회 — 그 사이 새 대화로 바뀌어도 오류 없이 버린다(한 번만 물음)
    const slowBatch = deferred<Response>();
    const restoring = route;
    route = (c) => (c.path === "/api/generations/batch" && (c.body?.gen_ids as string[])?.includes("g8") ? slowBatch.promise : restoring(c));
    gens.g8 = gen("g8");
    route = ((prev) => (c: Call) => (c.path === "/conversations/c5" ? json({ conversation: { id: "c5", title: "붙인 대화", engine: "claude", model: "opus",
      effort: "medium", updated_at: "", resumable: true, pinned: false, archived: false, unread: false, unread_rev: 0 },
      turns: [{ id: "t5", status: "done", text: "봐 줘", created_at: "", events: [],
        attachments: { workspace: { scope: "personal", id: null }, items: [{ kind: "generation", id: "g8" }] } }] }) : prev(c)))(route);
    act(() => root.unmount());
    root = createRoot(host);
    await render();
    act(() => button("새 대화")!.click());
    await flush();
    slowBatch.resolve(json({ items: { g8: gens.g8 }, materials: {}, missing: [] }));
    await flush();
    const before = calls.filter((c) => c.path === "/api/generations/batch" && (c.body?.gen_ids as string[]).includes("g8")).length;
    expect(before).toBe(1);
  });
});

// 화면 동작(docs/status/MVAgent_화면동작_2026-11-12.md) — 이 마운트가 보낸 차례의 사건만 claim·실행, 영수증 카드·되돌리기, 복원·새 창은 실행 안 함
describe("MV Agent 화면 동작", () => {
  const SCENE_CONTEXT = { tab: "compose", workspace: { scope: "personal", id: null, name: "내 공간" }, scene: { id: "s1", name: "씬" } };
  function board(sceneId: string | null = "s1") {
    let doc: { cards: SceneCard[]; edges: SceneEdge[]; groups: SceneGroup[] } = { cards: [], edges: [], groups: [] };
    const handle = sceneId ? {
      sceneId,
      commit: (command: CanvasInputCommand) => {
        const next = applyCanvasEdit(doc, command as CanvasEditCommand, {});
        if (!next) return false;
        doc = next.snapshot;
        return true;
      },
      snapshot: () => doc, viewCenter: () => ({ x: 300, y: 200 }), canEdit: () => true,
      selectCards: () => {}, selectedCardIds: () => [] as string[],
    } : null;
    return { host: { scene: () => handle } as ScreenHost, doc: () => doc };
  }
  const action = (seq: number, id: string, nodes = [{ kind: "text", text: "제목" }]) =>
    ({ seq, kind: "ui_action", action_id: id, name: "canvas.create_nodes", args: { scene_id: "s1", nodes } });
  async function render(host: ScreenHost, props: Partial<Parameters<typeof AgentPanel>[0]> = {}) {
    act(() => root.render(<AgentPanel context={SCENE_CONTEXT} contextLabel="캔버스 › 씬" onClose={() => {}} screen={host} {...props} />));
    await flush();
  }

  it("보낸 차례의 동작 — 실행 창 번호로 claim → 실행 → 영수증 카드(되돌리기) → 결과 보고 · 허브 결과 사건은 카드를 겹치지 않음 · 되돌리기 한 번", async () => {
    const fake = board();
    let tab = "";
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/turns" && c.method === "POST") { tab = c.body?.screen_tab as string; return started(); }
      if (c.path === "/turns/t1/events?after=0") return json({ events: [action(1, "a".repeat(32))], status: "running", last_seq: 1 });
      if (c.path === `/turns/t1/actions/${"a".repeat(32)}/claim`) return json({ token: "tok-123456789012345" });
      if (c.path === `/turns/t1/actions/${"a".repeat(32)}/result`) return json({ accepted: true });
      if (c.path === "/turns/t1/events?after=1") {
        return json({ events: [{ seq: 2, kind: "ui_action_result", action_id: "a".repeat(32), status: "done", ok: true, summary: "새 노드 1개 만듦" },
          { seq: 3, kind: "state", status: "done" }], status: "done", last_seq: 3 });
      }
      return json({ detail: "Not Found" }, 404);
    };
    await render(fake.host);
    type("제목 노드 하나 만들어");
    enter();
    await flush(20);
    expect(tab).toMatch(/^[0-9a-f-]{36}$/); // 이 마운트의 실행 창 번호
    const claim = calls.find((c) => c.path.endsWith("/claim"))!;
    expect(claim.body).toEqual({ screen_tab: tab });
    expect(fake.doc().cards.map((card) => [card.kind, card.text])).toEqual([["text", "제목"]]);
    expect(calls.find((c) => c.path.endsWith("/result"))!.body).toMatchObject({ token: "tok-123456789012345", ok: true, summary: "새 노드 1개 만듦" });
    expect(texts(".agent-action-text")).toEqual(["새 노드 1개 만듦"]); // 허브 사건은 같은 동작이면 카드를 더 만들지 않는다
    act(() => host.querySelector<HTMLButtonElement>(".agent-action-undo")!.click());
    expect(fake.doc().cards).toEqual([]);
    expect([host.querySelector(".agent-action-undo"), texts(".agent-action-text")[0]]).toEqual([null, "새 노드 1개 만듦 · 되돌림"]);
  });

  it("캔버스가 이 창에 없으면 씬을 빼고 'away' 를 싣는다 · claim 이 거절되면 실행하지 않는다 · 실행 안 됨은 허브 사건으로 카드", async () => {
    const fake = board(null);
    let context: Record<string, unknown> = {};
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/turns" && c.method === "POST") { context = c.body?.context as Record<string, unknown>; return started(); }
      if (c.path === "/turns/t1/events?after=0") {
        return json({ events: [action(1, "b".repeat(32)), { seq: 2, kind: "ui_action_result", action_id: "b".repeat(32), status: "expired_unclaimed", ok: false,
          summary: "화면에서 실행되지 않았어요 — 옆 칸이 받지 못했어요" }, { seq: 3, kind: "state", status: "done" }], status: "done", last_seq: 3 });
      }
      if (c.path.endsWith("/claim")) return json({ detail: "기한이 지났어요" }, 409);
      return json({ detail: "Not Found" }, 404);
    };
    await render(fake.host);
    type("노드 만들어");
    enter();
    await flush(20);
    expect([context.scene, context.scene_unavailable, context.tab]).toEqual([undefined, "away", "compose"]);
    expect(calls.some((c) => c.path.endsWith("/result"))).toBe(false); // claim 거절 = 실행 안 함
    expect(texts(".agent-action-text")).toEqual(["화면에서 실행되지 않았어요 — 옆 칸이 받지 못했어요"]);
    expect(host.querySelector(".agent-action.is-unknown .agent-action-undo")).toBeNull();
  });

  it("claim 답이 늦어 허브의 상태 카드가 먼저 와도 칸 영수증이 그 자리를 대신한다(카드 하나) · '지금 화면'을 빼면 실행 창 번호도 안 싣는다", async () => {
    const fake = board();
    const claim = deferred<Response>();
    const aid = "e".repeat(32);
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/turns" && c.method === "POST") return started();
      if (c.path === "/turns/t1/events?after=0") {
        return json({ events: [action(1, aid), { seq: 2, kind: "ui_action_result", action_id: aid, status: "unknown", ok: false,
          summary: "결과를 확인하지 못했어요 — 화면에서 확인해 주세요" }, { seq: 3, kind: "state", status: "done" }], status: "done", last_seq: 3 });
      }
      if (c.path === `/turns/t1/actions/${aid}/claim`) return claim.promise;
      if (c.path === `/turns/t1/actions/${aid}/result`) return json({ accepted: false });
      return json({ detail: "Not Found" }, 404);
    };
    await render(fake.host);
    type("노드 만들어");
    enter();
    await flush(10);
    expect(texts(".agent-action-text")).toEqual(["결과를 확인하지 못했어요 — 화면에서 확인해 주세요"]);
    claim.resolve(json({ token: "tok-123456789012345" }));
    await flush(10);
    expect(texts(".agent-action-text")).toEqual(["새 노드 1개 만듦"]); // 같은 자리, 하나
    expect(host.querySelector(".agent-action-undo")).not.toBeNull();
    // '지금 화면' 칩을 빼고 보내면 실행 창 번호가 없다
    act(() => root.unmount());
    root = createRoot(host);
    route = (c) => (c.path === "/session" ? session() : c.path === "/turns" && c.method === "POST" ? started("t2", "c2")
      : c.path.startsWith("/turns/t2/events") ? json({ events: [], status: "done", last_seq: 0 }) : json({ detail: "Not Found" }, 404));
    await render(fake.host);
    act(() => button("정보")!.click());
    act(() => button("지금 화면 AI 에게 보내기")!.click()); // 정보 칸의 'AI 에게 보내기' 끔
    expect(button("지금 화면 AI 에게 보내기")!.getAttribute("aria-checked")).toBe("false");
    act(() => button("정보")!.click());
    type("그냥 물어볼게");
    enter();
    await flush(10);
    const sent = calls.filter((c) => c.path === "/turns" && c.method === "POST").pop()!;
    expect([sent.body?.context, sent.body?.screen_tab]).toEqual([{}, undefined]);
  });

  it("claim 답을 기다리는 사이 새 대화로 바꾸면 실행하지 않고 그렇다고 보고 · 보드가 떨어지면 실행기가 실패 카드", async () => {
    let attached = true;
    const fake = board();
    const host: ScreenHost = { scene: () => (attached ? fake.host.scene() : null) };
    const claims = [deferred<Response>(), deferred<Response>()];
    let turnNo = 0;
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/turns" && c.method === "POST") { turnNo += 1; return started(`t${turnNo}`, `c${turnNo}`); }
      const m = c.path.match(/^\/turns\/(t\d)\/events\?after=0$/);
      if (m) return json({ events: [action(1, (m[1] === "t1" ? "f" : "a").repeat(32)), { seq: 2, kind: "state", status: "done" }], status: "done", last_seq: 2 });
      if (c.path.endsWith("/claim")) return claims[c.path.includes("/t1/") ? 0 : 1].promise;
      if (c.path.endsWith("/result")) return json({ accepted: true });
      return json({ detail: "Not Found" }, 404);
    };
    await render(host);
    type("노드 만들어");
    enter();
    await flush(10);
    act(() => button("새 대화")!.click()); // 차례는 끝났고 claim 답은 아직
    await flush();
    claims[0].resolve(json({ token: "tok-aaaaaaaaaaaaaaaa" }));
    await flush(10);
    expect(fake.doc().cards).toEqual([]); // 실행하지 않았다
    expect(calls.find((c) => c.path === `/turns/t1/actions/${"f".repeat(32)}/result`)!.body).toMatchObject({ ok: false, summary: "화면이 바뀌어 실행하지 않았어요" });
    // 다음 차례 — claim 을 기다리는 사이 보드가 떨어짐(캔버스를 별도 창으로)
    type("다시 만들어");
    enter();
    await flush(10);
    attached = false;
    claims[1].resolve(json({ token: "tok-bbbbbbbbbbbbbbbb" }));
    await flush(10);
    expect(fake.doc().cards).toEqual([]);
    expect(texts(".agent-action-text")).toEqual(["그 씬을 이 창의 캔버스에서 열어 주세요"]);
    expect(calls.find((c) => c.path === `/turns/t2/actions/${"a".repeat(32)}/result`)!.body).toMatchObject({ ok: false });
  });

  it("복원한 대화의 동작·새 창은 실행하지 않는다", async () => {
    const fake = board();
    localStorage.setItem(STORAGE_KEYS.agentPanelConversation, JSON.stringify({ account: getAccountNamespace(), id: "c1" }));
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/conversations/c1") {
        return json({ conversation: { id: "c1", title: "옛 대화", engine: "claude", model: "opus", effort: "medium", updated_at: "", resumable: true },
          turns: [{ id: "t0", status: "running", text: "만들어", events: [action(1, "c".repeat(32))] }] });
      }
      if (c.path === "/turns/t0/events?after=1") return new Promise<Response>(() => {}); // 진짜처럼 다음 사건을 기다린다
      if (c.path.startsWith("/turns/t0/events")) return json({ events: [action(1, "c".repeat(32))], status: "running", last_seq: 1 });
      if (c.path === "/conversations" && c.method === "GET") return json({ conversations: [] });
      return json({ detail: "Not Found" }, 404);
    };
    await render(fake.host);
    await flush(10);
    expect(calls.some((c) => c.path === "/conversations/c1")).toBe(true); // 마지막 대화를 복원했고, 진행 중 차례를 이어 받았다
    expect(calls.some((c) => c.path.startsWith("/turns/t0/events"))).toBe(true);
    expect(calls.some((c) => c.path.endsWith("/claim"))).toBe(false); // 같은 마운트라도 직접 보낸 차례가 아니면 실행하지 않는다
    // 새 창(popout) — 실행 창 번호를 싣지 않는다
    act(() => root.unmount());
    root = createRoot(host);
    route = (c) => (c.path === "/session" ? session() : c.path === "/turns" && c.method === "POST" ? started("t9", "c9")
      : c.path.startsWith("/turns/t9/events") ? json({ events: [action(1, "d".repeat(32))], status: "done", last_seq: 1 }) : json({ detail: "Not Found" }, 404));
    localStorage.clear();
    sessionStorage.setItem("ch.accountScope", "jay@example.com");
    await render(fake.host, { popout: true });
    type("만들어");
    enter();
    await flush(20);
    const sent = calls.filter((c) => c.path === "/turns" && c.method === "POST").pop()!;
    expect(sent.body?.screen_tab).toBeUndefined();
    expect(calls.some((c) => c.path.endsWith("/claim"))).toBe(false);
  });
});

describe("Claude 앱 원본 열기와 가져오기", () => {
  let conversation: AgentConversationSummary;
  let turns: AgentTurnRecord[];
  const menuItem = (label: string) => [...host.querySelectorAll<HTMLButtonElement>(".agent-row-mi")].find((b) => b.textContent?.includes(label));
  const clickText = (label: string, selector = "button") => act(() => {
    const found = [...host.querySelectorAll<HTMLButtonElement>(selector)].find((b) => b.textContent === label);
    expect(found, label).toBeTruthy(); found!.click();
  });
  const titleMenu = () => act(() => host.querySelector<HTMLButtonElement>(".agent-title-btn")!.click());
  const appCalls = () => calls.filter((c) => c.path.includes("/claude-app/"));
  const reads = () => calls.filter((c) => c.path === "/conversations/c1" && c.method === "GET");
  const hand = (state: "opening" | "handed" | "uncertain" = "handed") => {
    conversation = { ...conversation, app_revision: (conversation.app_revision ?? 0) + 1,
      app_handoff: { id: "h1", at: "2026-11-19 06:20:00", state }, app_opened_at: "2026-11-19 06:20:00",
      can_open_app: false, open_app_block: "in_claude_app", can_fork: false, fork_block: "in_claude_app" };
  };
  const result = () => ({ app_handoff: conversation.app_handoff, app_revision: conversation.app_revision,
    app_opened_at: conversation.app_opened_at, resumable: true });
  const render = async (popout = false) => {
    localStorage.setItem(STORAGE_KEYS.agentPanelConversation, JSON.stringify({ account: getAccountNamespace(), id: "c1" }));
    act(() => root.render(<AgentPanel context={{ tab: "my", workspace: { scope: "personal", id: null, name: null } }} contextLabel="내 공간" onClose={() => {}} popout={popout} />));
    await flush();
  };
  beforeEach(() => {
    setHubFeatures(["agent_chat_v1"]);
    conversation = { id: "c1", title: "앱 왕복", engine: "claude", model: "opus", effort: "medium", updated_at: "",
      resumable: true, unread: false, unread_rev: 0, can_fork: true, can_open_app: true, open_app_block: null,
      app_revision: 0, app_handoff: null, app_opened_at: null };
    turns = [{ id: "t1", text: "원래 사람 글", status: "done", created_at: "2026-11-19 06:00:00",
      events: [{ seq: 1, kind: "text", text: "원래 답" }, { seq: 2, kind: "plan", plan: PLAN }] }];
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/conversations") return json({ conversations: [conversation] });
      if (c.path === "/conversations/c1") return json({ conversation, turns });
      if (c.path === "/claude/version") return json({ current: null, latest: null, newer: false });
      if (c.path === "/plans/p1/estimate") return json({ plan_id: "p1", total_credits: 0 });
      if (c.path === "/plans/p1/execute") return json({ plan: { ...PLAN, status: "submitted" } });
      if (c.path.endsWith("/claude-app/open")) { hand(); return json(result()); }
      if (c.path.endsWith("/claude-app/bring-back")) {
        if (!c.body?.unlock_only) turns = [...turns, { id: "t2", text: "앱에서 쓴 사람 글", status: "done", created_at: "2026-11-19 06:20:00",
          origin: "claude_app", handoff_id: "h1", imported_at: "2026-11-19 06:20:00", omitted: { images: 1 },
          events: [{ seq: 1, kind: "tool", name: "Read", status: "unknown" }, { seq: 2, kind: "text", text: "앱에서 쓴 답" }] }];
        conversation = { ...conversation, app_revision: conversation.app_revision! + 1, app_handoff: null,
          can_open_app: true, open_app_block: null, can_fork: true, fork_block: null };
        return json({ ...result(), imported: c.body?.unlock_only ? 0 : 1 });
      }
      return json({ detail: "Not Found" }, 404);
    };
  });

  it("공용 메뉴 O → 원본 확인·창 단위 기억 → 잠금 → 서버 스냅샷으로 출처·생략·결과 미확인 표시", async () => {
    await render(); titleMenu();
    const labels = texts(".agent-row-mi");
    expect(labels.indexOf("Claude 앱에서 열기O")).toBe(labels.indexOf("포크F") + 1);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyO", key: "o", bubbles: true })));
    expect(host.querySelector('[role="dialog"]')!.textContent).toContain("같은 원본 대화를 이어 씁니다");
    expect(host.querySelector('[role="dialog"]')!.textContent).toContain("Claude 앱 자체의 도구와 권한");
    act(() => host.querySelector<HTMLInputElement>('.agent-app-skip input')!.click());
    clickText("열기"); await flush();
    expect(sessionStorage.getItem(STORAGE_KEYS.agentClaudeAppConfirmed)).toBe("1");
    expect(appCalls()[0].body).toEqual({ request_id: expect.any(String), expected_revision: 0 });
    expect(input().disabled).toBe(true);
    expect(texts(".agent-app-badge")).toEqual(["Claude 앱에서 쓰는 중"]);
    const before = reads().length;
    clickText("여기로 가져오기"); await flush();
    expect(appCalls()[1].body).toEqual({ request_id: expect.any(String), expected_revision: 1, handoff_id: "h1", unlock_only: false });
    expect(reads().length).toBe(before + 1);
    expect(input().disabled).toBe(false);
    expect(panel().textContent).toContain("Claude 앱에서 쓴 말 1개를 가져왔어요");
    expect(host.querySelectorAll(".agent-app-divider")).toHaveLength(1);
    expect(host.querySelector(".agent-app-divider time")!.getAttribute("datetime")).toBe("2026-11-19T06:20:00.000Z");
    expect(panel().textContent).toContain("결과 미확인");
    expect(panel().textContent).toContain("생략된 내용: 그림 1");
    expect(host.querySelectorAll('button[aria-label="고쳐 보내기"]')).toHaveLength(1); // 원래 사람 글만
    expect(panel().textContent).toContain("앱에서 쓴 답");
    titleMenu(); act(() => menuItem("Claude 앱에서 열기")!.click()); await flush();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(appCalls()).toHaveLength(3);
  });

  it.each([
    ["opening", "Claude 앱을 여는 중이에요"], ["handed", "Claude 앱에서 이 대화를 쓰는 중이에요"],
    ["uncertain", "Claude 앱에 열렸는지 확인하지 못했어요"],
  ] as const)("%s 잠금은 입력·키보드 보내기·드롭·붙여넣기·고쳐 보내기·포크·삭제를 막고 계획 실행·이동은 허용", async (state, message) => {
    hand(state); await render();
    expect(host.querySelector(".agent-app-band")!.textContent).toContain(message);
    expect(input().disabled).toBe(true);
    type("금지된 보내기"); enter();
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { types: ["application/x-ch-asset"],
      getData: () => JSON.stringify({ project: "p1", path: "x.png" }), files: [] } });
    act(() => panel().dispatchEvent(drop));
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { items: [{ kind: "file", type: "image/png", getAsFile: () => new File(["png"], "x.png", { type: "image/png" }) }] } });
    act(() => input().dispatchEvent(paste)); await flush();
    expect(turnCalls()).toEqual([]);
    expect(calls.some((c) => c.path.includes("upload"))).toBe(false);
    expect(host.querySelectorAll(".agent-attach")).toHaveLength(0);
    expect(button("고쳐 보내기")).toBeNull();
    expect(host.querySelector<HTMLButtonElement>(".agent-plan-fix")!.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>(".agent-plan-run")!.disabled).toBe(false);
    titleMenu(); expect(menuItem("포크")!.disabled).toBe(true); expect(menuItem("삭제")!.disabled).toBe(true);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    act(() => button("대화 목록")!.click()); await flush();
    expect(host.querySelectorAll(".agent-app-monitor")).toHaveLength(1);
    act(() => host.querySelector<HTMLButtonElement>(".agent-drawer-more")!.click());
    expect(menuItem("Claude 앱에서 열기")!.disabled).toBe(true);
    act(() => host.querySelector<HTMLElement>(".agent-drawer-dim")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(button("새 대화")!.disabled).toBe(false);
    act(() => button("새 대화")!.click());
    expect(input().disabled).toBe(false);
  });

  it.each([
    ["custom_config_dir", "Claude 설정 폴더를 바꾼 PC 라 열 수 없어요"],
    ["codex", "Codex 대화는 Claude 앱에서 열 수 없어요"], ["forked_unstarted", "포크한 대화에 먼저 한 번 말해 주세요"],
    ["old_cli", "Claude Code를 업데이트해 주세요"], ["platform", "이 PC에서는 Claude 앱 열기를 지원하지 않아요"],
    ["no_session", "먼저 한 번 대화해 주세요"], ["restored", "복원한 기록은 Claude 앱에서 열 수 없어요"],
    ["not_resumable", "이어 갈 수 없는 대화예요"],
  ])("열기 불가 %s는 메뉴 설명과 단축키에도 적용", async (code, message) => {
    conversation = { ...conversation, can_open_app: false, open_app_block: code };
    await render(); titleMenu();
    expect([menuItem("Claude 앱에서 열기")!.disabled, menuItem("Claude 앱에서 열기")!.title]).toEqual([true, message]);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyO", key: "o", bubbles: true })));
    expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(appCalls()).toEqual([]);
  });

  it("옛 서버는 메뉴 줄을 숨기고 O도 무시", async () => {
    delete conversation.can_open_app; delete conversation.app_revision;
    await render(); titleMenu(); expect(menuItem("Claude 앱에서 열기")).toBeUndefined();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyO", key: "o", bubbles: true })));
    expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(appCalls()).toEqual([]);
  });

  it.each([
    [409, "branched", "기록이 갈라져 가져오지 않았어요"], [413, "too_large", "기록이 너무 커서 가져오지 않았어요"],
  ])("가져오기 %s %s → 까닭·잠금 유지 → 잠금만 풀기 확인", async (status, code, message) => {
    hand(); const base = route;
    route = (c) => c.path.endsWith("/bring-back") && !c.body?.unlock_only
      ? json({ detail: code }, status) : base(c);
    await render(); clickText("여기로 가져오기"); await flush();
    expect(panel().textContent).toContain(message); expect(input().disabled).toBe(true);
    clickText("잠금만 풀기");
    expect(host.querySelector('[role="dialog"]')!.textContent).toContain("가져오지 않은 내용은 화면에 반영되지 않아요. 이어질 문맥은 Claude 세션 상태에 따릅니다");
    clickText("잠금만 풀기", '[role="dialog"] button'); await flush();
    expect(appCalls().at(-1)!.body?.unlock_only).toBe(true);
    expect(input().disabled).toBe(false);
    expect(panel().textContent).not.toContain("앱에서 쓴 사람 글");
  });

  it("실행기 정리가 불확실하면 잠금 해제 없이 상태 읽기만 제공", async () => {
    hand(); const base = route;
    route = (c) => c.path.endsWith("/bring-back") ? json({ detail: "launcher_uncertain" }, 409) : base(c);
    await render(); clickText("여기로 가져오기"); await flush();
    expect(panel().textContent).toContain("열기 작업이 끝났는지 확인하지 못했어요. 잠금을 유지합니다");
    expect(input().disabled).toBe(true);
    expect(texts(".agent-app-acts button")).toEqual(["상태 다시 확인"]);
    const before = reads().length;
    clickText("상태 다시 확인"); await flush();
    expect(reads()).toHaveLength(before + 1); expect(appCalls()).toHaveLength(1);
    expect(input().disabled).toBe(true); expect(texts(".agent-app-acts button")).not.toContain("잠금만 풀기");
  });

  it.each(["unlock_only", "supplement"] as const)("%s 기록은 사람 말풍선·가져온 묶음 대신 안내 줄", async (kind) => {
    turns.push({ id: "t-note", text: kind === "unlock_only" ? "[앱 기록을 가져오지 않고 잠금을 풂]" : "[Claude 앱에서 이어진 응답]",
      status: "done", created_at: "2026-11-19 06:20:00", origin: "claude_app", handoff_id: "h1", [kind]: true,
      events: kind === "supplement" ? [{ seq: 1, kind: "text", text: "보충 답변" }] : [] });
    await render();
    expect(texts(".agent-user")).toEqual(["원래 사람 글"]);
    expect(texts(".agent-notice")).toContain(turns[1].text);
    expect(host.querySelectorAll(".agent-app-divider")).toHaveLength(0);
    if (kind === "supplement") expect(texts(".agent-assistant")).toContain("보충 답변");
  });

  it("0개 성공은 새 말 없음 안내와 서버 스냅샷·입력 복구", async () => {
    hand(); const base = route;
    route = (c) => {
      if (c.path.endsWith("/bring-back")) {
        conversation = { ...conversation, app_revision: 2, app_handoff: null, can_open_app: true };
        return json({ ...result(), imported: 0 });
      }
      return base(c);
    };
    await render(); clickText("여기로 가져오기"); await flush();
    expect(panel().textContent).toContain("새로 쓴 말이 없어요"); expect(input().disabled).toBe(false);
    expect(reads()).toHaveLength(2);
  });

  it.each(["open", "bring-back"] as const)("%s 응답 전에 새 대화로 옮기면 늦은 결과·안내를 버림", async (action) => {
    if (action === "bring-back") hand();
    sessionStorage.setItem(STORAGE_KEYS.agentClaudeAppConfirmed, "1");
    const pending = deferred<Response>(), base = route;
    route = (c) => c.path.endsWith(`/claude-app/${action}`) ? pending.promise : base(c);
    await render();
    if (action === "open") { titleMenu(); act(() => menuItem("Claude 앱에서 열기")!.click()); }
    else clickText("여기로 가져오기");
    await flush(); expect(input().disabled).toBe(true);
    act(() => button("새 대화")!.click());
    hand(); pending.resolve(json({ ...result(), imported: 4 })); await flush();
    expect(input().disabled).toBe(false); expect(host.querySelector(".agent-app-band")).toBeNull();
    expect(panel().textContent).not.toContain("4개를 가져왔어요"); expect(reads()).toHaveLength(1);
  });

  it("계정이 바뀐 뒤의 열기 응답은 버림", async () => {
    sessionStorage.setItem(STORAGE_KEYS.agentClaudeAppConfirmed, "1");
    const pending = deferred<Response>(), base = route;
    route = (c) => c.path.endsWith("/claude-app/open") ? pending.promise : base(c);
    await render(); titleMenu(); act(() => menuItem("Claude 앱에서 열기")!.click()); await flush();
    sessionStorage.setItem("ch.accountScope", "other@example.com");
    hand(); pending.resolve(json(result())); await flush();
    expect(host.querySelector(".agent-app-band")).toBeNull(); expect(reads()).toHaveLength(1);
  });

  it("늦은 목록은 최신 잠금을 덮지 않고 창 복귀는 다시 조회", async () => {
    sessionStorage.setItem(STORAGE_KEYS.agentClaudeAppConfirmed, "1");
    const pending = deferred<Response>(), old = { ...conversation }, base = route;
    route = (c) => c.path === "/conversations" ? pending.promise : base(c);
    await render(); act(() => button("대화 목록")!.click()); await flush();
    act(() => host.querySelector<HTMLElement>(".agent-drawer-dim")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    titleMenu(); act(() => menuItem("Claude 앱에서 열기")!.click()); await flush();
    pending.resolve(json({ conversations: [old] })); await flush();
    expect(input().disabled).toBe(true);
    conversation = { ...conversation, app_revision: 2, app_handoff: null, can_open_app: true, can_fork: true };
    act(() => window.dispatchEvent(new Event("focus"))); await flush();
    expect(input().disabled).toBe(false); expect(reads()).toHaveLength(3);
  });

  it("응답을 잃은 재시도는 같은 요청 번호·내용을 재사용", async () => {
    sessionStorage.setItem(STORAGE_KEYS.agentClaudeAppConfirmed, "1");
    let tries = 0; const base = route;
    route = (c) => { if (c.path.endsWith("/claude-app/open") && tries++ === 0) throw new TypeError("network"); return base(c); };
    await render(); titleMenu(); act(() => menuItem("Claude 앱에서 열기")!.click()); await flush();
    titleMenu(); act(() => menuItem("Claude 앱에서 열기")!.click()); await flush();
    expect(appCalls()).toHaveLength(2); expect(appCalls()[1].body).toEqual(appCalls()[0].body);
  });

  it("열기는 처리됐지만 응답을 잃으면 최신 상태로 다시 열기 요청을 새로 만듦", async () => {
    sessionStorage.setItem(STORAGE_KEYS.agentClaudeAppConfirmed, "1");
    let lost = false; const base = route;
    route = (c) => {
      if (c.path.endsWith("/claude-app/open") && !lost) { lost = true; hand(); throw new TypeError("network"); }
      return base(c);
    };
    await render(); titleMenu(); act(() => menuItem("Claude 앱에서 열기")!.click()); await flush();
    expect(input().disabled).toBe(true);
    clickText("Claude 앱 다시 열기"); await flush();
    expect(appCalls()).toHaveLength(2);
    expect(appCalls()[1].body).toMatchObject({ expected_revision: 1, handoff_id: "h1" });
    expect(appCalls()[1].body?.request_id).not.toBe(appCalls()[0].body?.request_id);
  });

  it("가져오기는 처리됐지만 응답을 잃은 뒤 새 넘김은 새 요청 번호로 가져옴", async () => {
    hand(); let lost = false; const base = route;
    route = (c) => {
      if (c.path.endsWith("/bring-back") && !lost) { lost = true; base(c); throw new TypeError("network"); }
      return base(c);
    };
    await render(); clickText("여기로 가져오기"); await flush();
    expect(input().disabled).toBe(false);
    hand(); conversation.app_handoff = { ...conversation.app_handoff!, id: "h2" };
    act(() => window.dispatchEvent(new Event("focus"))); await flush();
    clickText("여기로 가져오기"); await flush();
    expect(appCalls()).toHaveLength(2);
    expect(appCalls()[1].body).toMatchObject({ expected_revision: 3, handoff_id: "h2", unlock_only: false });
    expect(appCalls()[1].body?.request_id).not.toBe(appCalls()[0].body?.request_id);
  });

  it.each([false, true, "launch"])("서랍의 다른 대화 열기(실패=%s)는 서랍을 유지하고 실패 까닭을 한 번 안내", async (fails) => {
    sessionStorage.setItem(STORAGE_KEYS.agentClaudeAppConfirmed, "1");
    let other = { ...conversation, id: "c2", title: "다른 대화" }; const base = route;
    route = (c) => {
      if (c.path === "/conversations") return json({ conversations: [conversation, other] });
      if (c.path === "/conversations/c2/claude-app/open") {
        if (fails === "launch") return json({ app_revision: 1, app_handoff: null, open_failed: "launch", resumable: true });
        if (fails) return json({ detail: "custom_config_dir" }, 409);
        other = { ...other, app_revision: 1, app_handoff: { id: "h2", state: "handed", at: "2026-11-19 06:20:00" }, can_open_app: false };
        return json({ app_revision: other.app_revision, app_handoff: other.app_handoff, resumable: true });
      }
      return base(c);
    };
    await render(); act(() => button("대화 목록")!.click()); await flush();
    const row = () => [...host.querySelectorAll<HTMLElement>(".agent-drawer-row")].find((r) => r.textContent?.includes("다른 대화"))!;
    act(() => row().querySelector<HTMLButtonElement>(".agent-drawer-more")!.click());
    act(() => menuItem("Claude 앱에서 열기")!.click()); await flush();
    expect(appCalls()[0].path).toBe("/conversations/c2/claude-app/open");
    expect(row().querySelectorAll(".agent-app-monitor")).toHaveLength(fails ? 0 : 1);
    expect(reads()).toHaveLength(1);
    expect(calls.some((c) => c.path === "/conversations/c2")).toBe(false);
    expect(input().disabled).toBe(false); expect(texts(".agent-user")).toEqual(["원래 사람 글"]);
    const message = fails === "launch" ? "Claude 앱 열기 작업을 시작하지 못했어요" : "Claude 설정 폴더를 바꾼 PC 라 열 수 없어요";
    expect(texts(".agent-notice").filter((text) => text === message)).toHaveLength(fails ? 1 : 0);
    expect(texts(".agent-error")).not.toContain(message);
    act(() => host.querySelector<HTMLElement>(".agent-drawer-dim")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    act(() => button("새 대화")!.click());
    expect(panel().textContent).not.toContain(message);
  });

  it.each(["새 대화", "다른 대화"])("현재 대화의 앱 오류는 %s로 이동하면 사라짐", async (destination) => {
    hand(); const other = { ...conversation, id: "c2", title: "다른 대화", app_handoff: null, app_revision: 0 };
    const base = route;
    route = (c) => {
      if (c.path.endsWith("/bring-back")) return json({ detail: "branched" }, 409);
      if (c.path === "/conversations") return json({ conversations: [other, conversation] });
      if (c.path === "/conversations/c2") return json({ conversation: other, turns: [] });
      return base(c);
    };
    await render(); clickText("여기로 가져오기"); await flush();
    expect(panel().textContent).toContain("기록이 갈라져 가져오지 않았어요");
    if (destination === "새 대화") act(() => button("새 대화")!.click());
    else {
      act(() => button("대화 목록")!.click()); await flush();
      const row = [...host.querySelectorAll<HTMLElement>(".agent-drawer-row")].find((r) => r.textContent?.includes("다른 대화"))!;
      act(() => row.querySelector<HTMLButtonElement>(".agent-drawer-item")!.click()); await flush();
    }
    expect(panel().textContent).not.toContain("기록이 갈라져 가져오지 않았어요");
  });

  it("복원으로 상태 번호가 낮아져도 대화를 다시 열면 서버 기록과 잠금을 표시", async () => {
    hand(); conversation.app_revision = 8; await render();
    act(() => button("새 대화")!.click());
    conversation = { ...conversation, app_revision: 0, app_handoff: null, restored_from: "backup-1", resumable: false, can_open_app: false, can_fork: false };
    turns = [{ ...turns[0], text: "복원한 대화 글" }];
    act(() => button("대화 목록")!.click()); await flush();
    act(() => host.querySelector<HTMLButtonElement>(".agent-drawer-item")!.click()); await flush();
    expect(texts(".agent-user")).toEqual(["복원한 대화 글"]);
    expect(input().disabled).toBe(true); expect(host.querySelector(".agent-app-band")).toBeNull();
    expect(panel().textContent).toContain("복원한 기록이에요");
    titleMenu(); expect(menuItem("Claude 앱에서 열기")!.disabled).toBe(true);
  });

  it.each([false, true])("앱 열기 중 같은 대화를 명시적으로 다시 읽어도 낮은 번호의 늦은 조회(복원=%s)는 잠금을 풀지 않음", async (restored) => {
    hand(); conversation.app_revision = 8; await render(true);
    const opened = deferred<Response>(), snapshot = deferred<Response>(), base = route;
    const old = { ...conversation, app_revision: 0, app_handoff: null, ...(restored ? { restored_from: "backup-1" } : {}) };
    let delayed = true;
    route = (c) => {
      if (c.path.endsWith("/claude-app/open")) return opened.promise;
      if (c.path === "/conversations/c1" && delayed) return snapshot.promise;
      return base(c);
    };
    clickText("Claude 앱 다시 열기"); await flush();
    localStorage.setItem(STORAGE_KEYS.agentPanelOpenRequest, JSON.stringify({ account: getAccountNamespace(), identity: "id-1", id: "c1", nonce: "reopen-during-app", at: Date.now() }));
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEYS.agentPanelOpenRequest })));
    await flush(); expect(reads()).toHaveLength(2);
    snapshot.resolve(json({ conversation: old, turns: [{ ...turns[0], text: "늦게 온 옛 글" }] })); await flush();
    expect(input().disabled).toBe(true); expect(texts(".agent-user")).toEqual(["원래 사람 글"]);
    expect(host.querySelector(".agent-app-band")).not.toBeNull();
    delayed = false; hand(); opened.resolve(json(result())); await flush();
    expect(input().disabled).toBe(true); expect(texts(".agent-app-badge")).toEqual(["Claude 앱에서 쓰는 중"]);
    expect(texts(".agent-user")).toEqual(["원래 사람 글"]);
  });

  it("앱에서 쓴 이력이 있는 대화 삭제에는 원본 파일 경고", async () => {
    conversation.app_opened_at = "2026-11-19 06:20:00";
    await render(); titleMenu(); act(() => menuItem("삭제")!.click());
    expect(panel().textContent).toContain("Claude 앱에서도 쓰는 원본 세션 파일을 함께 지울 수 있어요. 앱에서 이 대화를 닫아 주세요");
  });

  it("잠금만 풀어도 원본을 확인 못 하면 새 대화로 안내하고 보내기는 막음", async () => {
    hand(); const base = route;
    route = (c) => {
      if (c.path.endsWith("/bring-back")) {
        if (!c.body?.unlock_only) return json({ detail: "read_failed" }, 409);
        conversation = { ...conversation, app_handoff: null, app_revision: 2, resumable: false, open_app_block: "not_resumable" };
        return json({ ...result(), imported: 0, resumable: false });
      }
      return base(c);
    };
    await render(); clickText("여기로 가져오기"); await flush(); clickText("잠금만 풀기");
    clickText("잠금만 풀기", '[role="dialog"] button'); await flush();
    expect(host.querySelector(".agent-app-band")).toBeNull(); expect(input().disabled).toBe(true);
    expect(panel().textContent).toContain("새 대화를 시작해 주세요");
    type("못 보내는 글"); enter(); await flush(); expect(turnCalls()).toEqual([]);
  });

  it("창 복귀 조회보다 뒤에 보낸 차례를 늦은 스냅샷이 지우지 않음", async () => {
    await render(); const pending = deferred<Response>(), base = route;
    route = (c) => {
      if (c.path === "/conversations/c1") return pending.promise;
      if (c.path === "/turns") return started("t-new", "c1");
      if (c.path.startsWith("/turns/t-new/events")) return json({ events: [{ seq: 1, kind: "text", text: "새 차례 답" }], status: "done", last_seq: 1 });
      return base(c);
    };
    act(() => window.dispatchEvent(new Event("focus"))); await flush();
    type("새 차례 글"); enter(); await flush();
    pending.resolve(json({ conversation, turns })); await flush();
    expect(panel().textContent).toContain("새 차례 글"); expect(panel().textContent).toContain("새 차례 답");
  });

  it("같은 상태 번호의 늦은 opening 목록은 전달 완료를 되돌리지 않음", async () => {
    hand("opening"); await render(); const pending = deferred<Response>(), old = { ...conversation }, base = route;
    route = (c) => c.path === "/conversations" ? pending.promise : base(c);
    act(() => button("대화 목록")!.click()); await flush();
    act(() => host.querySelector<HTMLElement>(".agent-drawer-dim")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    conversation = { ...conversation, app_handoff: { ...conversation.app_handoff!, state: "handed" } };
    act(() => window.dispatchEvent(new Event("focus"))); await flush();
    pending.resolve(json({ conversations: [old] })); await flush();
    expect(host.querySelector(".agent-app-band")!.textContent).toContain("Claude 앱에서 이 대화를 쓰는 중이에요");
  });

  it("가져오기는 성공했지만 스냅샷을 못 읽으면 입력 잠금 유지·상태 재조회로만 복구", async () => {
    hand(); await render(); let failRead = true; const base = route;
    route = (c) => c.path === "/conversations/c1" && failRead ? json({ detail: "unavailable" }, 503) : base(c);
    clickText("여기로 가져오기"); await flush();
    expect(input().disabled).toBe(true); expect(panel().textContent).not.toContain("앱에서 쓴 사람 글");
    expect(panel().textContent).toContain("작업 결과를 화면에 다시 읽지 못했어요");
    failRead = false; clickText("상태 다시 확인"); await flush();
    expect(input().disabled).toBe(false); expect(panel().textContent).toContain("앱에서 쓴 사람 글");
    expect(appCalls()).toHaveLength(1); // 가져오기 자체를 다시 호출하거나 화면에서 합성하지 않는다.
  });

  it.each([
    ["job", "Windows 실행 격리를 확인하지 못해 앱을 열지 않았어요"],
    ["launch", "Claude 앱 열기 작업을 시작하지 못했어요"],
    ["identify", "열기 작업을 확인하지 못해 앱을 열지 않았어요"],
  ])("재개 전 실패 %s를 공개 분류로 안내", async (openFailed, message) => {
    sessionStorage.setItem(STORAGE_KEYS.agentClaudeAppConfirmed, "1"); const base = route;
    route = (c) => {
      if (c.path.endsWith("/claude-app/open")) {
        conversation = { ...conversation, app_revision: 1 };
        return json({ ...result(), open_failed: openFailed });
      }
      return base(c);
    };
    await render(); titleMenu(); act(() => menuItem("Claude 앱에서 열기")!.click()); await flush();
    expect(panel().textContent).toContain(message); expect(input().disabled).toBe(false);
  });
});
