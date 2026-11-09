// @vitest-environment jsdom
// MV Agent 칸의 Claude 연결 안내(첫 연결 설계 3·5·6·9절) — 가짜는 바깥 경계(fetch)에만 둔다.
//  상태별 장면(설치 안내 B·업데이트·확인 못 함·연결·구독 아님·구독 없음·로그인 창) · 입력칸 잠금 = 허브와 같은 허용 조건 ·
//  로그인 창 스위치 꺼짐/열 수 없음 = 터미널 안내 · [Claude 연결] → 2초마다 확인 → 연결 띠·엔진 목록 갱신 · 옛 허브(표식 없음).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPanel } from "../src/components/agent-chat/AgentPanel";
import { setHubFeatures } from "../src/lib/hubFeatures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Call = { path: string; method: string };
let calls: Call[];
let route: (call: Call) => Response | Promise<Response>;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const MODELS = [{ id: "opus", label: "Opus 5.5" }, { id: "sonnet", label: "Sonnet 5.5" }];
const claudeEngine = (state: string, available = false, subscription: string | null = null) => ({
  id: "claude", available, version: "2.1.296", state, subscription, reason: available ? null : "연결 필요",
  models: MODELS, efforts: ["low", "medium", "high", "xhigh", "max"],
});
const CODEX = { id: "codex", available: false, version: "", reason: "점검 필요", models: [{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol" }], efforts: ["low", "medium", "high"] };
const session = (state: string, available = false) =>
  json({ secret: "s1", account_email: "jay@example.com", identity_key: "id-1", engines: [claudeEngine(state, available), CODEX] });
const status = (state: string, opts: { enabled?: boolean; window?: boolean; subscription?: string | null } = {}) => {
  const ok = state === "ready" || state === "subscription_unknown";
  return json({
    state, version: "2.1.296", subscription: opts.subscription ?? null, login_window: !!opts.window,
    login_window_enabled: !!opts.enabled, engines: [claudeEngine(state, ok, opts.subscription ?? null), CODEX],
  });
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  sessionStorage.setItem("ch.accountScope", "jay@example.com");
  setHubFeatures(["agent_chat_v1", "agent_chat_connect_v1"]);
  calls = [];
  route = () => json({ detail: "Not Found" }, 404);
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit = {}) => {
    const call: Call = { path: String(url).replace("/api/agent-chat", ""), method: init.method ?? "GET" };
    calls.push(call);
    return Promise.resolve().then(() => route(call));
  }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setHubFeatures([]);
});

const flush = async (times = 10) => {
  for (let i = 0; i < times; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};
const panel = () => host.querySelector<HTMLElement>(".agent-panel")!;
const input = () => host.querySelector<HTMLTextAreaElement>(".agent-input")!;
const buttonText = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label) ?? null;
async function mount() {
  act(() => root.render(<AgentPanel context={{ tab: "my" }} contextLabel="워크스페이스" onClose={() => {}} />));
  await flush();
}

describe("MV Agent 칸 — Claude 연결 안내", () => {
  it("Claude Code 가 없으면 설치 안내(B) — 공식 명령·복사·다시 확인 → 연결되면 띠와 함께 입력칸이 풀린다", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    let installed = false;
    route = (c) => {
      if (c.path === "/session") return session("not_installed");
      if (c.path === "/claude") return installed ? status("ready", { subscription: "Max" }) : status("not_installed");
      return json({ detail: "Not Found" }, 404);
    };
    await mount();
    expect(panel().textContent).toContain("이 PC 에 Claude Code 가 없어요");
    expect(host.querySelector(".cn-code span")!.textContent).toBe("irm https://claude.ai/install.ps1 | iex");
    expect(input().disabled).toBe(true);
    expect(input().placeholder).toBe("Claude 를 연결하면 쓸 수 있어요");
    expect(host.querySelector<HTMLButtonElement>('.agent-send')!.disabled).toBe(true);
    act(() => host.querySelector<HTMLButtonElement>(".cn-copy")!.click());
    await flush();
    expect(writeText).toHaveBeenCalledWith("irm https://claude.ai/install.ps1 | iex");
    installed = true;
    act(() => buttonText("다시 확인")!.click());
    await flush();
    expect(panel().textContent).toContain("Claude 가 연결됐어요");
    expect(panel().textContent).toContain("Claude Max 구독");
    expect(input().disabled).toBe(false);
    expect(host.querySelector(".cn")).toBeNull();
  });

  it("로그인 창 스위치가 꺼져 있으면 [Claude 연결] 대신 터미널 안내", async () => {
    route = (c) => {
      if (c.path === "/session") return session("not_logged_in");
      if (c.path === "/claude") return status("not_logged_in", { enabled: false });
      return json({ detail: "Not Found" }, 404);
    };
    await mount();
    expect(panel().textContent).toContain("Claude 를 연결하세요");
    expect(buttonText("Claude 연결")).toBeNull();
    expect(host.querySelector(".cn-code span")!.textContent).toBe("claude auth login");
    expect(buttonText("다시 확인")).not.toBeNull();
  });

  it("[Claude 연결] → 로그인 창을 열고 2초마다 확인 → 연결되면 기다림을 멈추고 띠", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let phase: "need" | "window" | "done" = "need";
    route = (c) => {
      if (c.path === "/session") return session("not_logged_in");
      if (c.path === "/claude/login") { phase = "window"; return json({ opened: true }); }
      if (c.path === "/claude") {
        return phase === "need" ? status("not_logged_in", { enabled: true })
          : phase === "window" ? status("login_window", { enabled: true, window: true })
            : status("ready", { enabled: true, subscription: "Max" });
      }
      return json({ detail: "Not Found" }, 404);
    };
    await mount();
    act(() => buttonText("Claude 연결")!.click());
    await flush();
    expect(calls.filter((c) => c.path === "/claude/login").map((c) => c.method)).toEqual(["POST"]);
    expect(panel().textContent).toContain("열린 창에서 로그인을 마쳐 주세요");
    expect(buttonText("그만두기")).not.toBeNull();
    phase = "done";
    await act(async () => { vi.advanceTimersByTime(2000); });
    await flush();
    expect(panel().textContent).toContain("Claude 가 연결됐어요");
    expect(input().disabled).toBe(false);
    const polls = calls.filter((c) => c.path === "/claude").length;
    await act(async () => { vi.advanceTimersByTime(6000); });
    await flush();
    expect(calls.filter((c) => c.path === "/claude").length).toBe(polls); // 연결되면 기다림 끝
  });

  it("로그인 창을 열 수 없는 환경이면 터미널 안내 · 창이 닫혔는데 연결이 안 되면 다시 하라는 안내", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let deny = true;
    let phase: "need" | "window" = "need";
    route = (c) => {
      if (c.path === "/session") return session("not_logged_in");
      if (c.path === "/claude/login") {
        if (deny) return json({ detail: "로그인 창을 열 수 없는 환경이에요" }, 409, { "X-MVHub-Claude-Error": "breakaway_denied" });
        phase = "window";
        return json({ opened: true });
      }
      if (c.path === "/claude") return phase === "window" ? status("login_window", { enabled: true, window: true }) : status("not_logged_in", { enabled: true });
      return json({ detail: "Not Found" }, 404);
    };
    await mount();
    act(() => buttonText("Claude 연결")!.click());
    await flush();
    expect(host.querySelector(".cn-code span")!.textContent).toBe("claude auth login");
    expect(buttonText("Claude 연결")).toBeNull();
    // 다시 마운트해 창이 열렸다가 연결 없이 닫히는 경우
    act(() => root.unmount());
    root = createRoot(host);
    deny = false;
    phase = "need";
    await mount();
    act(() => buttonText("Claude 연결")!.click());
    await flush();
    phase = "need"; // 창이 닫혔고 여전히 로그인 안 됨
    await act(async () => { vi.advanceTimersByTime(2000); });
    await flush();
    expect(panel().textContent).toContain("로그인을 마치지 못했어요");
  });

  it("구독 아님·구독 없음·업데이트·확인 못 함 장면", async () => {
    for (const [state, text, action] of [
      ["not_subscription", "구독 로그인이 아니에요", "구독으로 다시 연결"],
      ["no_plan", "이 계정엔 Claude Code 를 쓸 수 있는 구독이 없어요", "다른 계정으로 연결"],
      ["outdated", "Claude Code 를 업데이트해야 해요", "다시 확인"],
      ["unknown", "Claude 상태를 확인하지 못했어요", "다시 확인"],
    ] as const) {
      route = (c) => {
        if (c.path === "/session") return session(state);
        if (c.path === "/claude") return status(state, { enabled: true });
        return json({ detail: "Not Found" }, 404);
      };
      act(() => root.unmount());
      root = createRoot(host);
      await mount();
      expect([state, panel().textContent?.includes(text), !!buttonText(action)]).toEqual([state, true, true]);
      expect(input().disabled).toBe(true);
    }
  });

  it("늦게 온 옛 상태 답은 더 나중 확인(연결됨)을 덮지 않는다", async () => {
    let release: (r: Response) => void = () => {};
    let first = true;
    route = (c) => {
      if (c.path === "/session") return session("not_logged_in");
      if (c.path === "/claude") {
        if (first) { first = false; return new Promise<Response>((done) => { release = done; }); } // 칸을 열 때의 확인 — 늦게 온다
        return status("ready", { enabled: true, subscription: "Max" });
      }
      return json({ detail: "Not Found" }, 404);
    };
    await mount();
    act(() => buttonText("다시 확인")!.click());
    await flush();
    expect(input().disabled).toBe(false);
    release(status("not_logged_in", { enabled: true }));
    await flush();
    expect(input().disabled).toBe(false);
    expect(host.querySelector(".cn")).toBeNull();
  });

  it("2초 확인은 앞 확인이 끝나기 전엔 겹쳐 보내지 않고, 칸을 닫으면 확인도 타이머도 멈춘다", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let opened = false;
    route = (c) => {
      if (c.path === "/session") return session("not_logged_in");
      if (c.path === "/claude/login") { opened = true; return json({ opened: true }); }
      if (c.path === "/claude") return opened ? new Promise<Response>(() => {}) : status("not_logged_in", { enabled: true }); // 창이 열린 뒤엔 답이 안 온다
      return json({ detail: "Not Found" }, 404);
    };
    await mount();
    act(() => buttonText("Claude 연결")!.click());
    await flush();
    const before = calls.filter((c) => c.path === "/claude").length;
    await act(async () => { vi.advanceTimersByTime(8000); });
    await flush();
    expect(calls.filter((c) => c.path === "/claude").length).toBe(before); // 연결 직후 확인이 아직 안 끝남 = 더 보내지 않음
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => { vi.advanceTimersByTime(8000); });
    expect(calls.filter((c) => c.path === "/claude").length).toBe(before);
  });

  it("로그인 창 장면에서 [그만두기] 뒤엔 [다시 확인]이 남는다", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    route = (c) => {
      if (c.path === "/session") return session("login_window");
      if (c.path === "/claude") return status("login_window", { enabled: true, window: true });
      return json({ detail: "Not Found" }, 404);
    };
    await mount();
    act(() => buttonText("그만두기")!.click());
    await flush();
    expect(buttonText("그만두기")).toBeNull();
    const polls = calls.filter((c) => c.path === "/claude").length;
    act(() => buttonText("다시 확인")!.click());
    await flush();
    expect(calls.filter((c) => c.path === "/claude").length).toBe(polls + 1);
  });

  it("구독 종류를 모르면 대화는 열려 있다(허브와 같은 허용 조건) · 옛 허브(연결 표식 없음)는 안내 없이 엔진 사유만", async () => {
    route = (c) => (c.path === "/session" ? session("subscription_unknown", true) : json({ detail: "Not Found" }, 404));
    await mount();
    expect(host.querySelector(".cn")).toBeNull();
    expect(input().disabled).toBe(false);
    act(() => root.unmount());
    root = createRoot(host);
    setHubFeatures(["agent_chat_v1"]);
    route = (c) => (c.path === "/session" ? session("not_logged_in") : json({ detail: "Not Found" }, 404));
    await mount();
    expect(host.querySelector(".cn")).toBeNull();
    expect(calls.some((c) => c.path === "/claude")).toBe(false);
  });
});
