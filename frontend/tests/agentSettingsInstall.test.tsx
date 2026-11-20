// @vitest-environment jsdom
// 설치·로그인 API 경계만 가짜. 화면 요청 id·한 번 이어가기·취소·실패 문구를 확인한다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentPanel } from "../src/components/agent-chat/AgentPanel";
import { setHubFeatures } from "../src/lib/hubFeatures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ID = "a".repeat(32);
let host: HTMLDivElement, root: Root;
let calls: string[];
let loginBodies: unknown[];
let phase: "missing" | "installed" | "connected";
let install: { id?: string; state: string; reason: string | null; at: number } | null;
let login: { id: string; state: string; reason: string | null; ports_busy?: boolean };
let blocked: string | null;
let loginError: { status: number; detail: unknown } | null;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const engines = () => [
  { id: "claude", installed: phase !== "missing", available: false, state: phase === "missing" ? "not_installed" : "not_logged_in", version: "", subscription: null,
    install_blocked: blocked, install, models: [{ id: "opus", label: "Opus" }], efforts: ["low", "medium", "high"] },
  { id: "codex", installed: phase !== "missing", available: phase === "connected", enabled: phase === "connected", install_version: "0.162.0-alpha.17.2", version: phase === "missing" ? "" : "0.162.0-alpha.17.2",
    install_blocked: blocked, install, reason: "연결 필요", models: [{ id: "gpt-6.1-sol", label: "GPT" }], efforts: ["low", "medium", "high"] },
];
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem("ch.accountScope", "jay@example.test");
  setHubFeatures(["agent_chat_v1", "agent_chat_connect_v1"]);
  calls = []; loginBodies = []; phase = "missing"; install = null; blocked = null;
  loginError = null;
  login = { id: ID, state: "running", reason: null };
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = String(url).replace("/api/agent-chat", "");
    const method = init.method ?? "GET";
    calls.push(`${method} ${path}`);
    if (path === "/api/models") return json([]);
    if (path === "/session") return json({ secret: "secret", identity_key: "id", account_email: "jay@example.test", engines: engines() });
    if (path === "/claude") return json({ state: phase === "missing" ? "not_installed" : "not_logged_in", install, version: null,
      subscription: null, login_window: false, login_window_enabled: true, engines: engines() });
    if (/^\/(claude|codex)\/install$/.test(path)) {
      if (method === "POST") {
        install = { id: ID, state: "running", at: 1, reason: null };
        return json(install);
      }
      return json({ install, blocked });
    }
    if (path.startsWith("/codex/login")) {
      if (method === "POST") loginBodies.push(JSON.parse(String(init.body)));
      if (loginError) return json({ detail: loginError.detail }, loginError.status);
      return json(login);
    }
    if (path.startsWith("/codex/enable")) { phase = "connected"; return json({ engines: engines() }); }
    if (path === "/codex/disable") return json({ engines: engines() });
    if (path === "/claude/login") return json({ opened: true });
    return json({ conversations: [] });
  }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); setHubFeatures([]); });
async function flush() { for (let i = 0; i < 12; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
async function mount() {
  act(() => root.render(<AgentPanel context={{ tab: "my" }} contextLabel="작업" onClose={() => {}} />)); await flush();
  act(() => host.querySelector<HTMLButtonElement>(".agent-model-btn")!.click());
  act(() => [...host.querySelectorAll<HTMLButtonElement>(".agent-model-item")].find((b) => b.textContent === "설정")!.click()); await flush();
}
function group(engine: "claude" | "codex") {
  const groups = host.querySelectorAll<HTMLElement>(".agent-install-controls");
  return groups[engine === "claude" ? 0 : groups.length - 1];
}
function clickInstall(engine: "claude" | "codex") { act(() => group(engine).querySelector<HTMLButtonElement>("button")!.click()); }
async function tick() { await act(async () => { vi.advanceTimersByTime(2000); }); await flush(); }

it("모델 메뉴의 상태가 이름 뒤·화살표 앞이며 미연결 줄은 설정 연결로 이동", async () => {
  await mount();
  act(() => host.querySelector<HTMLButtonElement>('.agent-settings button[aria-label="돌아가기"]')!.click());
  act(() => host.querySelector<HTMLButtonElement>(".agent-model-btn")!.click());
  const row = host.querySelector<HTMLButtonElement>(".agent-model-row")!;
  expect([...row.children].map((child) => child.getAttribute("class"))).toEqual(["agent-model-ic", "agent-model-name", "agent-model-reason", "agent-chevron"]);
  expect(row.textContent).toContain("미연결");
  expect(row.textContent).not.toContain("설정에서 연결");
  act(() => row.click()); await flush();
  expect(host.querySelector(".agent-settings")!.textContent).toContain("연결");
});

it("미설치 두 줄의 라임 설치 단추와 누르기 전 PATH 안내", async () => {
  await mount();
  expect(host.querySelector(".agent-settings")!.textContent).toContain("생성마다 묻지 않음");
  expect(host.querySelector(".agent-settings")!.textContent).toContain("바깥 앱 연결");
  expect([...host.querySelectorAll(".agent-settings button")].filter((b) => b.textContent === "연결 다시 확인")).toHaveLength(1);
  expect(host.querySelectorAll(".agent-install-controls .cn-go")).toHaveLength(2);
  expect(group("codex").textContent).toContain("설치하면 사용자 PATH 에 공식 Codex 가 더해져 터미널의 codex 가 바뀔 수 있어요");
  expect(calls.some((c) => c.includes("POST /codex/install"))).toBe(false);
  clickInstall("codex"); await flush();
  expect(group("codex").textContent).toContain("설치하는 중 · 몇 분 걸려요");
});

it("Claude 설치 성공의 같은 요청 id 에만 로그인 한 번", async () => {
  await mount(); clickInstall("claude"); await flush();
  install = { id: "b".repeat(32), state: "ok", reason: null, at: 2 };
  await tick(); expect(calls.filter((c) => c === "POST /claude/login")).toHaveLength(0);
  phase = "installed"; install = { id: ID, state: "ok", reason: null, at: 3 };
  await tick(); await tick();
  expect(calls.filter((c) => c === "POST /claude/login")).toHaveLength(1);
});

it("Codex 설치 → 로그인 창 → 확인 → 켜기 점검 한 번 → 연결됨", async () => {
  await mount(); clickInstall("codex"); await flush();
  phase = "installed"; install = { id: ID, state: "ok", reason: null, at: 2 };
  await tick();
  expect(host.querySelector(".agent-settings")!.textContent).toContain("로그인 창 기다리는 중 — 브라우저에서 로그인");
  expect(calls.filter((c) => c.startsWith("POST /codex/login"))).toHaveLength(1);
  login = { id: ID, state: "ok", reason: null };
  await tick(); await tick();
  expect(calls.filter((c) => c.startsWith("POST /codex/enable"))).toEqual([`POST /codex/enable?chain_id=${ID}`]);
  expect(host.querySelector(".agent-settings")!.textContent).toContain("연결됨");
});

it("이 화면에서 누르지 않은 오래된 성공은 자동 로그인하지 않음", async () => {
  install = { id: ID, state: "ok", reason: null, at: 1 };
  await mount(); await tick();
  expect(calls.some((c) => /^POST \/(claude|codex)\/login/.test(c))).toBe(false);
});

it.each(["timeout", "interrupted"])("설치 실패 %s 는 까닭·다시 시도·접힌 직접 설치", async (reason) => {
  install = { id: ID, state: "failed", reason, at: 1 };
  await mount();
  expect(group("codex").textContent).toContain("설치하지 못했어요");
  expect(group("codex").textContent).toContain("다시 시도");
  expect(group("codex").querySelector<HTMLDetailsElement>("details")!.open).toBe(false);
  expect(group("codex").querySelector(".cn-code")!.textContent).toContain("$env:CODEX_RELEASE='0.162.0-alpha.17.2'");
});

it("설치할 수 없는 환경은 까닭만 표시", async () => {
  blocked = "elevated"; await mount();
  expect(group("codex").textContent).toContain("관리자 권한으로 켜서 설치할 수 없어요");
  expect(group("codex").querySelector("button,details")).toBeNull();
});

it.each(["version_check", "interrupted"])("실패 %s 뒤 직접 설치되면 두 엔진 모두 평소 연결", async (reason) => {
  install = { id: ID, state: "failed", reason, at: 1 };
  await mount();
  phase = "installed";
  install = { id: ID, state: "failed", reason, at: 2 };
  act(() => group("claude").querySelector<HTMLButtonElement>(".cn-ghost")!.click()); await flush();
  const settings = host.querySelector(".agent-settings")!;
  expect(settings.querySelectorAll(".agent-install-controls")).toHaveLength(0);
  expect(settings.querySelector(".agent-connect-go")!.textContent).toBe("연결");
  expect(settings.querySelector('button[aria-label="Codex 연결"]')!.textContent).toBe("연결");
  expect(settings.textContent).not.toContain("설치하지 못했어요");
  expect(calls.some((c) => /^POST \/(claude|codex)\/install/.test(c))).toBe(false);
});

it("API 키 로그인은 공유 로그인 변경 안내 뒤 다시 연결에서만 창 요청", async () => {
  phase = "installed"; login = { id: ID, state: "not_subscription", reason: null };
  await mount();
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Codex 연결"]')!.click()); await flush();
  expect(loginBodies).toEqual([{ reconnect: false }]);
  expect(host.textContent).toContain("구독 로그인이 아니에요");
  expect(host.textContent).toContain("이 PC 에서 Codex 를 쓰는 다른 곳(터미널 등)의 로그인도 함께 바뀌어요");
  expect(calls.some((c) => c.startsWith("POST /codex/enable"))).toBe(false);
  const retry = host.querySelector<HTMLButtonElement>('button[aria-label="Codex 연결"]')!;
  expect(retry.textContent).toBe("다시 연결");
  login = { id: ID, state: "running", reason: null };
  act(() => retry.click()); await flush();
  expect(loginBodies).toEqual([{ reconnect: false }, { reconnect: true }]);
});

it("로그인 창 스위치가 꺼지면 수동 명령과 다시 확인으로 켜기", async () => {
  phase = "installed"; login = { id: ID, state: "manual", reason: null };
  await mount();
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Codex 연결"]')!.click()); await flush();
  expect(host.textContent).toContain("codex login");
  expect(host.textContent).not.toContain("로그인 창 기다리는 중");
  login = { id: ID, state: "ok", reason: null };
  const manual = [...host.querySelectorAll<HTMLElement>(".agent-settings-connect")].find((e) => e.textContent?.includes("codex login"))!;
  act(() => [...manual.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "다시 확인")!.click()); await flush();
  expect(calls.filter((c) => c.startsWith("POST /codex/enable"))).toHaveLength(1);
});

it.each([
  [409, "점검 필요 — 확인하지 않은 판입니다(0.1.0)", "점검 필요 — 확인하지 않은 판입니다(0.1.0)"],
  [422, [{ type: "string_pattern_mismatch", msg: "String should match pattern" }], "연결 요청을 확인하지 못했어요. 화면을 다시 열고 시도해 주세요"],
] as const)("연결 오류 %s 는 사람이 읽는 문구", async (status, detail, message) => {
  phase = "installed"; loginError = { status, detail };
  await mount();
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Codex 연결"]')!.click()); await flush();
  expect(host.textContent).toContain(message);
  expect(host.textContent).not.toContain("string_pattern_mismatch");
  expect(calls.some((c) => c.startsWith("POST /codex/enable"))).toBe(false);
});

it("로그인 실패는 다시 시도만, 포트 점유는 원인으로 말하지 않음", async () => {
  await mount(); clickInstall("codex"); await flush();
  phase = "installed"; install = { id: ID, state: "ok", reason: null, at: 2 }; await tick();
  login = { id: ID, state: "failed", reason: "login_unfinished", ports_busy: true }; await tick();
  const settings = host.querySelector(".agent-settings")!;
  expect(settings.textContent).toContain("로그인을 마치지 못했어요");
  expect(settings.textContent).toContain("확인한 현재 상태: 로그인 포트");
  expect([...settings.querySelectorAll("button")].some((b) => b.textContent === "다시 시도")).toBe(true);
  expect([...settings.querySelectorAll("summary")].some((b) => b.textContent === "직접 설치하려면")).toBe(false);
});

it("설치 중 끄면 늦은 설치 성공이 로그인·켜기로 이어지지 않음", async () => {
  await mount(); clickInstall("codex"); await flush();
  act(() => [...host.querySelectorAll<HTMLButtonElement>(".agent-settings button")].find((b) => b.textContent === "끄기")!.click()); await flush();
  phase = "installed"; install = { id: ID, state: "ok", reason: null, at: 2 }; await tick();
  expect(calls).toContain("POST /codex/disable");
  expect(calls.some((c) => c.startsWith("POST /codex/login") || c.startsWith("POST /codex/enable"))).toBe(false);
});

it("로그인 기다리기를 그만두면 늦은 성공이 켜지지 않음", async () => {
  await mount(); clickInstall("codex"); await flush(); phase = "installed";
  install = { id: ID, state: "ok", reason: null, at: 2 }; await tick();
  act(() => [...host.querySelectorAll<HTMLButtonElement>(".agent-settings button")].find((b) => b.textContent === "그만두기")!.click());
  login = { id: ID, state: "ok", reason: null }; await tick();
  expect(calls.some((c) => c.startsWith("POST /codex/enable"))).toBe(false);
});
