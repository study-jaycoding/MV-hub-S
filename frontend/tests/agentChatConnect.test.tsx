// @vitest-environment jsdom
import { SCREEN_CONSENT } from "../src/lib/useMcpScreenActions";
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
const status = (state: string, opts: { enabled?: boolean; window?: boolean; subscription?: string | null; install?: unknown } = {}) => {
  const ok = state === "ready" || state === "subscription_unknown";
  return json({
    state, version: "2.1.296", subscription: opts.subscription ?? null, login_window: !!opts.window,
    login_window_enabled: !!opts.enabled, install: opts.install ?? null, engines: [claudeEngine(state, ok, opts.subscription ?? null), CODEX],
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
    return Promise.resolve().then(() => call.path === "/api/models" ? json([]) : route(call));
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

function openSettings() {
  act(() => host.querySelector<HTMLButtonElement>(".agent-model-btn")!.click());
  act(() => [...host.querySelectorAll<HTMLButtonElement>(".agent-model-item")].find((b) => b.textContent === "설정")!.click());
}
const settings = () => host.querySelector<HTMLElement>(".agent-settings")!;
const settingsButton = (text: string) => [...settings().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;
const back = () => act(() => settings().querySelector<HTMLButtonElement>('button[aria-label="돌아가기"]')!.click());

describe("계약 A — 설정 안 Claude 연결", () => {
  it("스위치 켬의 대화 칸 버튼 아래 안내·접힌 PowerShell", async () => {
    route = (c) => c.path === "/session" ? session("not_logged_in") : status("not_logged_in", { enabled: true });
    await mount();
    expect(buttonText("Claude 연결")).not.toBeNull();
    expect(panel().textContent).toContain(SCREEN_CONSENT);
    expect(panel().textContent).toContain("Claude Code·Codex 에서도 MV Hub 를 바로 쓰고 생성해요");
    expect(panel().textContent).toContain("생성마다 묻지 않음");
    expect(host.querySelector<HTMLDetailsElement>(".cn-more")!.open).toBe(false);
    expect(host.querySelector(".cn-more summary")!.textContent).toBe("직접 하려면(PowerShell)");
    expect(panel().textContent).toContain("로그인을 마치고 그 창이 닫히면 여기가 바뀌어요.");
  });

  it("설정은 닫히지 않고 요청 중 클릭·대화 칸과 설정의 요청도 하나", async () => {
    let finish!: (r: Response) => void;
    let opened = false;
    route = (c) => {
      if (c.path === "/session") return session("not_logged_in");
      if (c.path === "/claude/login") return new Promise<Response>((done) => { finish = done; });
      return opened ? status("login_window", { enabled: true, window: true }) : status("not_logged_in", { enabled: true });
    };
    await mount();
    openSettings();
    const connect = settingsButton("연결");
    act(() => { connect.click(); connect.click(); buttonText("Claude 연결")?.click(); });
    await flush();
    expect(settings()).not.toBeNull();
    expect(settingsButton("연결 요청 중").disabled).toBe(true);
    back();
    expect(buttonText("연결 요청 중")!.disabled).toBe(true);
    act(() => buttonText("연결 요청 중")!.click());
    openSettings();
    expect(calls.filter((c) => c.path === "/claude/login")).toHaveLength(1);
    opened = true;
    finish(json({ opened: true }));
    await flush();
    expect(settings().textContent).toContain("로그인 창 기다리는 중");
    expect(settings().querySelector(".agent-connect-spin")).not.toBeNull();
    expect(settings().textContent).toContain("자동 확인만 멈춰요 · 로그인 창은 직접 닫아 주세요");
    back();
    openSettings();
    expect(settingsButton("그만두기")).toBeDefined();
    act(() => settingsButton("그만두기").click());
    expect(settings().querySelector(".agent-connect-spin")).toBeNull();
    expect(settingsButton("다시 확인")).toBeDefined();
  });

  it("not_needed 는 최신 상태로 확인하고 연결 알림은 한 곳에 한 번", async () => {
    let done = false;
    route = (c) => {
      if (c.path === "/session") return session("not_logged_in");
      if (c.path === "/claude/login") { done = true; return json({ detail: "이미 연결됨" }, 409, { "X-MVHub-Claude-Error": "not_needed" }); }
      return done ? status("ready", { enabled: true, subscription: "Max" }) : status("not_logged_in", { enabled: true });
    };
    await mount();
    openSettings();
    act(() => settingsButton("연결").click());
    await flush();
    expect(settings().textContent).toContain("구독 Max");
    expect(settings().textContent).toContain("연결됨");
    expect(settings().querySelector(".agent-settings-connect")).toBeNull();
    expect(host.querySelectorAll(".cn-done")).toHaveLength(1);
    back();
    openSettings();
    expect(host.querySelectorAll(".cn-done")).toHaveLength(1);
    expect(host.querySelector(".agent-error")).toBeNull();
  });

  it("not_needed 뒤 상태 조회 실패도 설정 안 연결 오류로 보인다", async () => {
    let connectedElsewhere = false;
    route = (c) => {
      if (c.path === "/session") return session("not_logged_in");
      if (c.path === "/claude/login") {
        connectedElsewhere = true;
        return json({ detail: "이미 연결됨" }, 409, { "X-MVHub-Claude-Error": "not_needed" });
      }
      return connectedElsewhere ? json({ detail: "상태 조회 오류" }, 503) : status("not_logged_in", { enabled: true });
    };
    await mount();
    openSettings();
    act(() => settingsButton("연결").click());
    await flush();
    expect(settings().querySelector('[role="alert"]')?.textContent).toBe("Claude 상태를 다시 확인하지 못했어요");
    expect(host.querySelector(".agent-error")!.textContent).toBe("상태 조회 오류");
    expect(settingsButton("연결").disabled).toBe(false);
  });

  it.each(["not_logged_in", "not_subscription", "no_plan"])("스위치 0이면 설정 %s 연결 버튼 없이 PowerShell 안내만 보인다", async (state) => {
    route = (c) => c.path === "/session" ? session(state) : status(state, { enabled: false });
    await mount();
    openSettings();
    await flush();
    expect(settings().querySelector(".agent-connect-go")).toBeNull();
    expect(settings().textContent).toContain("PowerShell 로 연결");
    expect(settingsButton("다시 확인")).toBeDefined();
    expect(calls.filter((c) => c.path === "/claude/login")).toHaveLength(0);
  });

  it("대화 칸에서 먼저 요청한 동안 설정의 연결도 잠긴다", async () => {
    route = (c) => {
      if (c.path === "/session") return session("not_logged_in");
      if (c.path === "/claude/login") return new Promise<Response>(() => {});
      return status("not_logged_in", { enabled: true });
    };
    await mount();
    act(() => buttonText("Claude 연결")!.click());
    openSettings();
    const connect = settingsButton("연결 요청 중");
    expect(connect.disabled).toBe(true);
    act(() => connect.click());
    await flush();
    expect(calls.filter((c) => c.path === "/claude/login")).toHaveLength(1);
  });

  it.each([
    ["login_window_disabled", "이 PC 에서는 터미널에서 로그인해 주세요."],
    ["login_window_unsupported", "관리자 권한으로 켠 MV Hub 라 버튼 연결을 쓸 수 없어요"],
    ["login_window_unsupported", "이 Windows 로그인에서는 버튼 연결을 쓸 수 없어요"],
    ["login_window_unsupported", "다른 Windows 사용자로 켠 MV Hub 라 버튼 연결을 쓸 수 없어요"],
    ["login_window_unsupported", "권한을 확인하지 못해 버튼 연결을 쓸 수 없어요"],
  ])("%s 는 설정·대화 칸의 펼친 터미널 안내와 본문 까닭", async (code, detail) => {
    route = (c) => {
      if (c.path === "/session") return session("not_logged_in");
      if (c.path === "/claude/login") return json({ detail }, 409, { "X-MVHub-Claude-Error": code });
      return status("not_logged_in", { enabled: true });
    };
    await mount();
    openSettings();
    act(() => settingsButton("연결").click());
    await flush();
    expect(settings().textContent).toContain("PowerShell 로 연결");
    expect(settings().querySelector("details")).toBeNull();
    expect(settings().querySelector(".agent-connect-go")).toBeNull();
    expect(settings().querySelector(".cn-code span")!.textContent).toBe("claude auth login");
    if (code === "login_window_unsupported") expect(settings().querySelector('[role="alert"]')!.textContent).toBe(detail);
    back();
    expect(buttonText("Claude 연결")).toBeNull();
    if (code === "login_window_unsupported") expect(host.querySelector('.cn [role="alert"]')!.textContent).toBe(detail);
    expect(host.querySelector(".cn-code span")!.textContent).toBe("claude auth login");
  });

  it("연결 오류는 설정 안에 보이고 일반 대화 오류와 분리", async () => {
    let checks = 0;
    route = (c) => {
      if (c.path === "/session") return session("not_logged_in");
      if (c.path === "/claude/login") return json({ detail: "다른 MV Hub 에서 Claude 가 일하는 중이에요" }, 409, { "X-MVHub-Claude-Error": "claude_busy" });
      return ++checks === 1 ? status("not_logged_in", { enabled: true }) : json({ detail: "상태 조회 오류" }, 503);
    };
    await mount();
    openSettings();
    act(() => settingsButton("다시 확인").click());
    await flush();
    act(() => settingsButton("연결").click());
    await flush();
    expect(settings().querySelector('[role="alert"]')!.textContent).toBe("다른 MV Hub 에서 Claude 가 일하는 중이에요");
    expect(host.querySelector(".agent-error")!.textContent).toBe("상태 조회 오류");
    back();
    expect(host.querySelector('.cn [role="alert"]')).not.toBeNull();
  });

  it.each([
    ["not_installed", "이 PC 에 Claude Code 가 없어요", "irm https://claude.ai/install.ps1 | iex"],
    ["outdated", "Claude Code 를 업데이트해야 해요", "claude update"],
    ["unknown", "Claude 상태를 확인하지 못했어요", null],
    ["window_record", "열린 Claude 로그인 창을 닫고 [다시 확인]을 눌러 주세요", null],
    ["not_subscription", "구독 로그인이 아니에요", "claude auth login"],
    ["no_plan", "이 계정엔 Claude Code 를 쓸 수 있는 구독이 없어요", "claude auth login"],
  ])("설정 %s 안내가 안에서 펼쳐진다", async (state, line, command) => {
    route = (c) => c.path === "/session" ? session(state) : status(state, { enabled: true });
    await mount();
    openSettings();
    expect(settings().textContent).toContain(line);
    if (command) expect(settings().querySelector(".cn-code span")!.textContent).toBe(command);
    if (state === "not_subscription" || state === "no_plan") {
      expect(settingsButton("다시 연결")).toBeDefined();
      expect(settings().textContent).toContain("이 PC 에서 Claude 를 쓰는 다른 곳(터미널 등)의 로그인도 함께 바뀌어요");
      expect(settings().querySelector<HTMLDetailsElement>("details")!.open).toBe(false);
    } else expect(settingsButton("다시 확인")).toBeDefined();
  });

  it("10분 만료와 로그인 미완료를 설정 안에서 표시", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    let state = "login_window";
    route = (c) => c.path === "/session" ? session(state) : status(state, { enabled: true, window: state === "login_window" });
    await mount();
    openSettings();
    await act(async () => { await vi.advanceTimersByTimeAsync(602_000); });
    await flush();
    expect(settings().textContent).toContain("아직 로그인 창이 열려 있어요 — 마치면 [다시 확인]");
    // 창을 끄지 못해 기록이 남은 드문 경우의 복구 순서(Codex 후보 리뷰 낮음 2, Jay 11-18 "지금 고침")
    expect(settings().textContent).toContain("로그인 창이 보이지 않으면 MV Hub 를 다시 켜 주세요. 그래도 그대로면 PC 를 다시 시작하면 풀려요");
    expect(settings().querySelector(".agent-connect-spin")).toBeNull();
    const before = calls.length;
    await act(async () => { vi.advanceTimersByTime(4000); });
    expect(calls).toHaveLength(before);
    // 새로 연 칸에서 로그인 창이 닫혔으나 로그인은 마치지 못한 경우
    act(() => root.unmount());
    root = createRoot(host);
    await mount();
    openSettings();
    state = "not_logged_in";
    await act(async () => { vi.advanceTimersByTime(2000); });
    await flush();
    expect(settings().textContent).toContain("로그인을 마치지 못했어요 — 다시 해 주세요");
    expect(settingsButton("연결")).toBeDefined();
  });

  it.each(["connect", "status", "poll"])("칸을 닫은 뒤 늦은 %s 응답은 타이머를 만들지 않는다", async (late) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let finish!: (r: Response) => void;
    let opened = false;
    route = (c) => {
      if (c.path === "/session") return session("not_logged_in");
      if (c.path === "/claude/login") {
        opened = true;
        return late === "connect" ? new Promise<Response>((done) => { finish = done; }) : json({ opened: true });
      }
      if (late === "status" || opened) return new Promise<Response>((done) => { finish = done; });
      return status("not_logged_in", { enabled: true });
    };
    await mount();
    if (late !== "status") { act(() => buttonText("Claude 연결")!.click()); await flush(); }
    act(() => root.unmount());
    root = createRoot(host);
    finish(late === "connect" ? json({ opened: true }) : status("login_window", { enabled: true, window: true }));
    await flush();
    const before = calls.length;
    await act(async () => { vi.advanceTimersByTime(12_000); });
    expect(calls).toHaveLength(before);
    expect(vi.getTimerCount()).toBe(0);
  });
});

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
    // 복구 안내는 기다리는 중엔 없고(막 연 창이 보이는 때) 그만둔 뒤 대화 칸에 보인다(Codex 낮음 대응 리뷰 01a1ed70 낮음)
    const hint = "로그인 창이 보이지 않으면 MV Hub 를 다시 켜 주세요. 그래도 그대로면 PC 를 다시 시작하면 풀려요";
    expect(panel().textContent).not.toContain(hint);
    act(() => buttonText("그만두기")!.click());
    await flush();
    expect(buttonText("그만두기")).toBeNull();
    expect(host.querySelector(".cn")!.textContent).toContain(hint);
    const polls = calls.filter((c) => c.path === "/claude").length;
    act(() => buttonText("다시 확인")!.click());
    await flush();
    expect(calls.filter((c) => c.path === "/claude").length).toBe(polls + 1);
  });

  it("MV Hub 가 설치하는 중이면 기다림(손 설치는 접음) · 3초마다 다시 보고 끝나면 다음 단계로 · 그 뒤엔 멈춤", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let phase: "installing" | "done" = "installing";
    route = (c) => {
      if (c.path === "/session") return session("not_installed");
      if (c.path === "/claude") {
        return phase === "installing" ? status("not_installed", { install: { state: "running", at: 1, reason: null } })
          : status("not_logged_in", { enabled: true });
      }
      return json({ detail: "Not Found" }, 404);
    };
    await mount();
    expect(panel().textContent).toContain("MV Hub 가 Claude Code 를 설치하는 중이에요");
    const more = host.querySelector<HTMLDetailsElement>(".cn-more")!;
    expect([more.open, more.querySelector("summary")!.textContent]).toEqual([false, "직접 설치하려면"]); // 겹쳐 설치하지 않게 접어 둔다
    expect(input().disabled).toBe(true);
    const polls = () => calls.filter((c) => c.path === "/claude").length;
    const before = polls();
    await act(async () => { vi.advanceTimersByTime(3000); });
    await flush();
    expect(polls()).toBe(before + 1);
    phase = "done";
    await act(async () => { vi.advanceTimersByTime(3000); });
    await flush();
    expect(panel().textContent).toContain("Claude 를 연결하세요"); // 설치가 끝나 저절로 로그인 단계로
    const after = polls();
    await act(async () => { vi.advanceTimersByTime(9000); });
    await flush();
    expect(polls()).toBe(after); // 설치 중이 아니면 3초 확인을 멈춘다
  });

  it("설치 중 확인은 칸을 닫으면 멈춘다", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    route = (c) => {
      if (c.path === "/session") return session("not_installed");
      if (c.path === "/claude") return status("not_installed", { install: { state: "running", at: 1, reason: null } });
      return json({ detail: "Not Found" }, 404);
    };
    await mount();
    act(() => root.unmount());
    root = createRoot(host);
    const before = calls.filter((c) => c.path === "/claude").length;
    await act(async () => { vi.advanceTimersByTime(9000); });
    expect(calls.filter((c) => c.path === "/claude").length).toBe(before);
  });

  it("자동 설치 실패·건너뜀은 까닭 한 줄 + 손 설치 안내 · 확인 못 함 화면에도 그 줄", async () => {
    for (const [state, install, line] of [
      ["not_installed", { state: "failed", at: 1, reason: "timeout" }, "자동 설치가 안 됐어요 — 아래처럼 직접 설치해 주세요"],
      ["not_installed", { state: "skipped", at: 1, reason: "elevated" }, "관리자 권한으로 켠 MV Hub 라 자동 설치를 건너뛰었어요 — 아래처럼 직접 설치해 주세요"],
      ["unknown", { state: "failed", at: 1, reason: "version_check" }, "자동 설치가 안 됐어요 — 아래처럼 직접 설치해 주세요"],
    ] as const) {
      route = (c) => {
        if (c.path === "/session") return session(state);
        if (c.path === "/claude") return status(state, { install });
        return json({ detail: "Not Found" }, 404);
      };
      act(() => root.unmount());
      root = createRoot(host);
      await mount();
      expect([state, host.querySelector(".cn [role=status].cn-note")?.textContent]).toEqual([state, line]);
      // 그 줄이 말한 손 설치 안내가 같은 화면에 있다(확인 못 함 화면 포함) · [다시 확인]은 하나
      expect(host.querySelector(".cn-code span")!.textContent).toBe("irm https://claude.ai/install.ps1 | iex");
      expect([...host.querySelectorAll("button")].filter((b) => b.textContent === "다시 확인")).toHaveLength(1);
    }
  });

  it("설치 중이다가 실패로 끝나면 3초 확인을 멈추고 실패 줄 + 손 설치 안내", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let failed = false;
    route = (c) => {
      if (c.path === "/session") return session("not_installed");
      if (c.path === "/claude") {
        return status("not_installed", { install: failed ? { state: "failed", at: 2, reason: "exit" } : { state: "running", at: 1, reason: null } });
      }
      return json({ detail: "Not Found" }, 404);
    };
    await mount();
    failed = true;
    await act(async () => { vi.advanceTimersByTime(3000); });
    await flush();
    expect(panel().textContent).toContain("자동 설치가 안 됐어요");
    expect(host.querySelector(".cn-more")).toBeNull();
    const after = calls.filter((c) => c.path === "/claude").length;
    await act(async () => { vi.advanceTimersByTime(9000); });
    await flush();
    expect(calls.filter((c) => c.path === "/claude").length).toBe(after);
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
