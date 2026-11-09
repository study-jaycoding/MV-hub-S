// @vitest-environment jsdom
// Ask Agent 옆 칸(docs/status/AskAgent_옆칸_설계_2026-11-09.md 3-1·3-5·10절) — 가짜는 바깥 경계(fetch)에만 둔다.
//  보내기 → 긴 기다림으로 사건 받기(text_delta 는 붙고 text 는 덩어리를 바꾼다) · 계획 [실행] · 두 번 보내기 막음 ·
//  패널 표 401 → 같은 계정일 때만 한 번 다시 보냄 · 계정이 바뀐 뒤의 늦은 답 버림 · 엔진을 바꾸면 새 대화 · 닫았다 열면 이어 붙기.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPanel } from "../src/components/agent-chat/AgentPanel";
import type { AgentEvent } from "../src/lib/agentChatApi";
import { getAuthToken, setAuthToken } from "../src/lib/http";
import { applyAgentEvent, type AgentMessage } from "../src/lib/useAgentChat";

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
  { id: "claude", available: true, version: "2.1.296", reason: null, efforts: ["low", "medium", "high"],
    models: [{ id: "opus", label: "Opus 5.5" }, { id: "sonnet", label: "Sonnet 5.5" }, { id: "haiku", label: "Haiku 5.5" }] },
  { id: "codex", available: true, version: "0.162.0-alpha.17.2", reason: null, efforts: ["low", "medium", "high"],
    models: [{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol" }, { id: "gpt-6-astra", label: "GPT-6 Astra" }] },
];
const session = (email = "jay@example.com", secret = "s1", identity = "id-1") =>
  json({ secret, account_email: email, identity_key: identity, engines: ENGINES });
const started = (turnId = "t1", conversationId = "c1") => json({ turn_id: turnId, conversation_id: conversationId, status: "running" });
const PLAN = { plan_id: "p1", title: "고양이 컷 4장", status: "draft", items: [{ model: "Nano Banana 2", prompt: "고양이" }], workspace: { scope: "personal", name: null } };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
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
function pickModel(label: string) {
  act(() => host.querySelector<HTMLButtonElement>(".agent-model-btn")!.click());
  const item = [...host.querySelectorAll<HTMLButtonElement>(".agent-model-item")].find((b) => b.textContent?.includes(label))!;
  act(() => item.click());
}

describe("Ask Agent 옆 칸", () => {
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
    expect(panel().textContent).toContain("워크스페이스 › e001");
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
    expect(host.querySelector(".agent-plan-title")!.textContent).toBe("계획 — 고양이 컷 4장");
    expect(panel().textContent).toContain("실행하면 크레딧이 나갑니다");
    expect(panel().textContent).toContain("저장 위치: 내 공간");
    expect(host.querySelector(".agent-plan-cost")!.textContent).toBe("예상 크레딧: 12"); // 카드가 보이면 견적(무료)을 한 번 묻는다
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
    expect(panel().textContent).toContain("실행을 보냈어요");
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
    expect(host.querySelector(".agent-plan-title")!.textContent).toBe("계획 — 고양이 컷 4장");
    expect(calls.filter((c) => c.path.startsWith("/turns/t1/events")).map((c) => c.path)).toEqual(
      ["/turns/t1/events?after=0", "/turns/t1/events?after=1"]);
    // 견적을 못 받았으면 0 이 아니라 '확인하지 못했어요' — 카드와 [실행]은 그대로
    expect(host.querySelector(".agent-plan-cost")!.textContent).toBe("예상 크레딧: 확인하지 못했어요");
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
    expect(panel().textContent).not.toContain("실행을 보냈어요");
    expect(panel().textContent).toContain("라이브러리에서 확인하세요");
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
    expect(button("지난 대화 보기")!.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>(".agent-model-btn")!.disabled).toBe(true);
    gate.resolve(started());
    await flush();
    expect(texts(".agent-user")).toEqual(["하나"]); // 접수 응답을 버리지 않고 그 차례를 따라간다
  });

  it("[고치기]는 입력칸을 채운다", async () => {
    route = (c) => {
      if (c.path === "/session") return session();
      if (c.path === "/turns") return started();
      return json({ events: [{ seq: 1, kind: "plan", plan: PLAN }], status: "done", last_seq: 1 });
    };
    await mount();
    type("계획 세워 줘");
    enter();
    await flush();
    act(() => host.querySelector<HTMLButtonElement>(".agent-plan-fix")!.click());
    expect(input().value).toBe("「고양이 컷 4장」 계획을 이렇게 고쳐 주세요: ");
    expect(document.activeElement).toBe(input());
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

    pickModel("GPT-6.1 Sol");
    expect(host.querySelector(".agent-user")).toBeNull();
    expect(host.querySelector(".agent-title")!.textContent).toBe("새 대화");
    expect(panel().textContent).toContain("지금 보는 화면을 같이 보면서 일해요");
    type("셋");
    enter();
    await flush();
    expect(turnCalls()[2].body).toMatchObject({ engine: "codex", model: "gpt-6.1-sol", effort: "medium" });
    expect("conversation_id" in turnCalls()[2].body!).toBe(false);
    expect(JSON.parse(localStorage.getItem("mvhub.agentPanel.model")!)).toEqual({ engine: "codex", model: "gpt-6.1-sol", effort: "medium" });
  });

  it("못 쓰는 엔진은 까닭을 보이고 고를 수 없다 · 생각 깊이는 낮음·보통·높음", async () => {
    route = (c) => (c.path === "/session"
      ? json({ secret: "s1", account_email: "jay@example.com", identity_key: "id-1", engines: [ENGINES[0], { ...ENGINES[1], available: false, reason: "점검 필요" }] })
      : json({ detail: "Not Found" }, 404));
    await mount();
    act(() => host.querySelector<HTMLButtonElement>(".agent-model-btn")!.click());
    expect(texts(".agent-model-group-head")).toEqual(["Claude", "GPT점검 필요", "생각 깊이"]);
    const gpt = [...host.querySelectorAll<HTMLButtonElement>(".agent-model-item")].filter((b) => b.textContent?.startsWith("GPT"));
    expect(gpt.map((b) => b.disabled)).toEqual([true, true]);
    expect(texts(".agent-effort-seg button")).toEqual(["낮음", "보통", "높음"]);
    expect(host.querySelector('.agent-model-item[aria-pressed="true"]')!.textContent).toContain("Opus 5.5");
    act(() => [...host.querySelectorAll<HTMLButtonElement>(".agent-effort-seg button")][2].click());
    expect(host.querySelector(".agent-model-btn")!.textContent).toContain("높음");
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
    expect(host.querySelector(".agent-title")!.textContent).toBe("고양이");
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
    act(() => host.querySelector<HTMLButtonElement>(".agent-title")!.click());
    await flush();
    look();
    type("안녕");
    enter();
    await flush();
    look();
    expect(seen.join("\n")).toContain("이어 가기 불가");
    expect(seen.join("\n")).toContain("MV Hub · 자료 조회 하는 중");
    expect(seen.join("\n")).not.toMatch(/\.\.\.|…/);

    for (const file of ["components/agent-chat/AgentPanel.tsx", "components/agent-chat/AgentPlanCard.tsx", "lib/useAgentChat.ts", "lib/agentChatApi.ts"]) {
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
