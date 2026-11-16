// @vitest-environment jsdom
// 설정 옆 창의 MV·MCP 연결(Jay 2026-11-16 시안 v3) — [한 번에 연결]은 세 앱을 한 번에 등록하고, 앱마다 상태·[해제]/[다시 연결].
//  가짜는 바깥 경계(jsonFetch)에만 — 등록·목록·해제 API 는 MCP 창(McpRegistration)과 같다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const calls: { path: string; body?: unknown }[] = [];
let clients: { id: string; name: string; revoked_at: string | null }[] = [];
let configureResult: unknown[] = [];
vi.mock("../src/lib/http", () => ({
  getAuthToken: () => "token",
  jsonBody: (value: unknown) => JSON.stringify(value),
  jsonFetch: vi.fn(async (path: string, init?: { body?: string }) => {
    calls.push({ path, body: init?.body ? JSON.parse(init.body) : undefined });
    if (path.endsWith("/app/clients")) return { clients };
    if (path.endsWith("/app/configure")) {
      clients = [...clients, { id: "c2", name: "claude", revoked_at: null }];
      return { clients: configureResult };
    }
    if (path.includes("/revoke")) {
      clients = clients.map((client) => (path.includes(client.id) ? { ...client, revoked_at: "now" } : client));
      return { ok: true };
    }
    throw new Error("unexpected " + path);
  }),
}));

import { McpQuickConnect } from "../src/components/mcp/McpQuickConnect";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  calls.length = 0;
  clients = [{ id: "c1", name: "codex", revoked_at: null }, { id: "old", name: "claude", revoked_at: "earlier" }];
  configureResult = [
    { client: "codex", status: "configured", message: "" },
    { client: "claude", status: "configured", message: "" },
    { client: "claude_desktop", status: "skipped", message: "Claude 데스크톱 앱이 켜져 있어 건너뛰었습니다. Claude 앱을 끄고 다시 연결하세요." },
  ];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const flush = () => act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
const row = (app: string) => host.querySelector<HTMLElement>(`[data-app="${app}"]`)!;
const pill = (app: string) => row(app).querySelector(".settings-pill")!.textContent;
const button = (app: string) => row(app).querySelector<HTMLButtonElement>("button")!;

it("처음 — 목록을 읽어 앱마다 상태(해제된 연결은 안 셈)·제목 밑 줄", async () => {
  const onSummary = vi.fn();
  await act(async () => root.render(<McpQuickConnect onSummary={onSummary} onOpenWindow={() => {}} />));
  await flush();
  expect([pill("codex"), pill("claude"), pill("claude_desktop")]).toEqual(["연결됨", "연결 안 됨", "연결 안 됨"]);
  expect([button("codex").textContent, button("claude").textContent]).toEqual(["해제", "연결"]);
  expect(onSummary).toHaveBeenLastCalledWith("연결됨 · Codex");
  expect(host.textContent).toContain("MV Agent 칸은 이 연결 없이 씁니다.");
});

it("[한 번에 연결] — 세 앱을 계정 기준·생성 허용으로 한 번에 등록, 건너뛴 앱은 까닭과 [다시 연결]", async () => {
  await act(async () => root.render(<McpQuickConnect onOpenWindow={() => {}} />));
  await flush();
  await act(async () => host.querySelector<HTMLButtonElement>(".settings-action-main")!.click());
  await flush();
  expect(calls.find((call) => call.path.endsWith("/app/configure"))!.body)
    .toEqual({ clients: ["codex", "claude", "claude_desktop"], scope: "account", allow_execution: true });
  expect([pill("codex"), pill("claude"), pill("claude_desktop")]).toEqual(["연결됨", "연결됨", "건너뜀"]);
  expect(row("claude_desktop").textContent).toContain("Claude 앱을 끄고 다시 연결하세요");
  expect(button("claude_desktop").textContent).toBe("다시 연결");
  expect(host.querySelector('[role="status"]')!.textContent).toContain("다시 켜야 MV Hub 가 보입니다");
});

it("[해제] — 그 앱의 살아 있는 연결만 해제하고 목록을 다시 읽는다 · [다시 연결]은 그 앱만 등록", async () => {
  await act(async () => root.render(<McpQuickConnect onOpenWindow={() => {}} />));
  await flush();
  await act(async () => button("codex").click());
  await flush();
  expect(calls.filter((call) => call.path.includes("/revoke")).map((call) => call.path)).toEqual(["/api/mcp/v2/app/clients/c1/revoke"]);
  expect(pill("codex")).toBe("연결 안 됨");
  configureResult = [{ client: "claude", status: "configured", message: "" }];
  await act(async () => button("claude").click());
  await flush();
  expect(calls.filter((call) => call.path.endsWith("/app/configure")).map((call) => call.body))
    .toEqual([{ clients: ["claude"], scope: "account", allow_execution: true }]);
  expect(pill("claude")).toBe("연결됨");
});

it("고급 — [MV·MCP 연결 열기]는 연결 창을 연다(다른 MCP 프로그램·옛 연결·MCP 업데이트)", async () => {
  const onOpenWindow = vi.fn();
  await act(async () => root.render(<McpQuickConnect onOpenWindow={onOpenWindow} />));
  await flush();
  const open = [...host.querySelectorAll<HTMLButtonElement>("details.settings-adv button")].find((item) => item.textContent === "MV·MCP 연결 열기")!;
  act(() => open.click());
  expect(onOpenWindow).toHaveBeenCalledTimes(1);
});
