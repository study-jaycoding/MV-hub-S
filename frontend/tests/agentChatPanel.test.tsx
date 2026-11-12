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
  { id: "claude", available: true, version: "2.1.296", reason: null, state: "ready", subscription: "Max", efforts: ["low", "medium", "high", "xhigh", "max"],
    models: [{ id: "opus", label: "Opus 5.5" }, { id: "sonnet", label: "Sonnet 5.5" }, { id: "haiku", label: "Haiku 5.5" }, { id: "fable", label: "Fable 5.1" }] },
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
/** 한 메뉴에서 그 회사 묶음의 첫 모델을 고른다 */
function pickCompany(name: string) {
  act(() => host.querySelector<HTMLButtonElement>(".agent-model-btn")!.click());
  act(() => host.querySelector<HTMLButtonElement>(`.agent-model-group[aria-label="${name}"] .agent-model-item`)!.click());
}
const menuRadios = (group: string) => [...host.querySelectorAll<HTMLButtonElement>(`.agent-model-menu [role="radiogroup"][aria-label="${group}"] [role="radio"]`)];

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

  it("모델 한 메뉴(Aside) — 못 쓰는 회사는 머리에 까닭·고를 수 없음 · 찾기 · 생각 깊이 Low~Max · 속도(빠름)는 Opus 에서만, 보낼 때 실리고 모델을 바꾸면 꺼진다", async () => {
    route = (c) => {
      if (c.path === "/session") {
        return json({ secret: "s1", account_email: "jay@example.com", identity_key: "id-1", engines: [ENGINES[0], { ...ENGINES[1], available: false, reason: "점검 필요" }] });
      }
      if (c.path === "/turns") return started();
      return json({ events: [], status: "done", last_seq: 0 });
    };
    await mount();
    const btn = () => host.querySelector<HTMLButtonElement>(".agent-model-btn")!;
    expect(btn().textContent).toBe("✳Opus 5.5Medium"); // 모델 이름 + 흐린 생각 깊이 한 단추
    act(() => btn().click());
    expect(texts('.agent-model-group[aria-label="Claude"] .agent-model-item')).toEqual(["✳Opus 5.5✓", "✳Sonnet 5.5", "✳Haiku 5.5", "✳Fable 5.1"]);
    expect(host.querySelector('.agent-model-group[aria-label="ChatGPT"] .agent-model-group-head')!.textContent).toBe("ChatGPT점검 필요");
    expect([...host.querySelectorAll<HTMLButtonElement>('.agent-model-group[aria-label="ChatGPT"] .agent-model-item')].map((b) => b.disabled)).toEqual([true, true]);
    act(() => {
      const search = host.querySelector<HTMLInputElement>(".agent-model-search")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "son");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(texts(".agent-model-menu .agent-model-group .agent-model-item")).toEqual(["✳Sonnet 5.5"]); // 찾기는 모델만 거른다
    expect(menuRadios("생각 깊이").map((b) => b.textContent)).toEqual(["Low", "Medium✓", "High", "Extra High", "Max"]);
    expect(menuRadios("속도").map((b) => b.textContent)).toEqual(["기본✓", "빠름"]);
    expect(panel().textContent).toContain("Claude 추가 사용 크레딧이 들어요");
    act(() => menuRadios("속도")[1].click()); // 고르면 닫힌다
    expect(host.querySelector(".agent-model-menu")).toBeNull();
    act(() => btn().click());
    act(() => menuRadios("생각 깊이")[4].click());
    expect(btn().textContent).toBe("✳Opus 5.5Max빠름");
    type("빨리");
    enter();
    await flush();
    expect(turnCalls()[0].body).toMatchObject({ model: "opus", effort: "max", fast: true });
    expect(JSON.parse(localStorage.getItem("mvhub.agentPanel.model")!)).toEqual({ engine: "claude", model: "opus", effort: "max" }); // 빠른 모드는 기억 안 함
    pickModel("Sonnet 5.5");
    act(() => btn().click());
    expect(menuRadios("속도")).toEqual([]); // Opus 가 아니면 속도가 없다
    expect(btn().textContent).not.toContain("빠름");
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
      if (c.path === "/claude/version") return json({ current: "2.1.296", latest: "2.1.322", newer: true });
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
    expect([texts(".agent-drawer-plan")[0], texts(".agent-drawer-ver.new")[0]]).toEqual(["✳Claude · Max", "v2.1.296"]);
    expect(host.querySelector(".agent-drawer-ver")!.getAttribute("title")).toBe("v2.1.322 이 나왔어요");
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

  it("⋯·우클릭으로 메뉴 — 항목·단축키(event.code, 수정키·반복·조합 무시)·Esc 는 한 겹씩", async () => {
    await render({ onPopOut: () => {} });
    await openDrawer();
    openMenu("고양이");
    expect(items()).toEqual(["새 창에서 열기", "고정P", "읽지 않음으로 표시U", "이름 바꾸기R", "프로젝트로 옮기기", "보관A", "삭제D"]);
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
    expect(items()).toEqual(["새 창에서 열기", "고정P", "이름 바꾸기R", "프로젝트로 옮기기", "보관A", "삭제D"]);
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

  it("받는 형식에만 덮개 · 어셋은 끌기 값만(저장값으로 넓히지 않음)·필드 검사 · 생성물 묶음·폴더 · 중복·8개 상한 · 입력칸 위 놓기는 기본 동작 막음", async () => {
    await render();
    const files = fire("dragenter", { Files: "" });
    expect([files.defaultPrevented, host.querySelector(".agent-drop")]).toEqual([false, null]); // OS 파일만 = 손대지 않음
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
