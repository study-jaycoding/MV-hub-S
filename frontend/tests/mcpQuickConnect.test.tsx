// @vitest-environment jsdom
// 설정 옆 창의 MV·MCP 연결(Jay 2026-11-16 시안 v3) — [한 번에 연결]은 세 앱을 한 번에 등록하고, 앱마다 상태·[해제]/[다시 연결].
//  가짜는 바깥 경계(jsonFetch)에만 — 등록·목록·해제 API 는 MCP 창(McpRegistration)과 같다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const calls: { path: string; body?: unknown }[] = [];
let clients: { id: string; name: string; revoked_at: string | null }[] = [];
let configureResult: unknown[] = [];
let onConfigure: () => void = () => { clients = [...clients, { id: "c2", name: "claude", revoked_at: null }]; };
let failListOnce = false;
let afterRevoke: () => void = () => {};
vi.mock("../src/lib/http", () => ({
  getAuthToken: () => "token",
  jsonBody: (value: unknown) => JSON.stringify(value),
  jsonFetch: vi.fn(async (path: string, init?: { body?: string }) => {
    calls.push({ path, body: init?.body ? JSON.parse(init.body) : undefined });
    if (path.endsWith("/app/clients")) {
      if (failListOnce) { failListOnce = false; throw new Error("list failed"); }
      return { clients };
    }
    if (path.endsWith("/app/configure")) {
      onConfigure();
      return { clients: configureResult };
    }
    if (path.includes("/revoke")) {
      clients = clients.map((client) => (path.includes(client.id) ? { ...client, revoked_at: "now" } : client));
      afterRevoke();
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
  failListOnce = false;
  afterRevoke = () => {};
  onConfigure = () => { clients = [...clients, { id: "c2", name: "claude", revoked_at: null }]; };
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

it("[해제] — 다시 등록으로 연결이 바뀐 뒤 목록 읽기가 실패했어도, 지금 목록의 새 연결을 해제한다(Codex 리뷰 #1)", async () => {
  await act(async () => root.render(<McpQuickConnect onOpenWindow={() => {}} />));
  await flush();
  // 다시 등록 — 서버가 c1 을 거두고 c3 을 낸다. 그 뒤 목록 읽기가 한 번 실패해 화면엔 c1 이 남는다
  onConfigure = () => { clients = [{ id: "c1", name: "codex", revoked_at: "replaced" }, { id: "c3", name: "codex", revoked_at: null }]; };
  configureResult = [{ client: "codex", status: "configured", message: "" }];
  failListOnce = true;
  await act(async () => host.querySelector<HTMLButtonElement>(".settings-action-main")!.click());
  await flush();
  calls.length = 0;
  await act(async () => button("codex").click());
  await flush();
  expect(calls.filter((call) => call.path.includes("/revoke")).map((call) => call.path)).toEqual(["/api/mcp/v2/app/clients/c3/revoke"]);
  expect(pill("codex")).toBe("연결 안 됨");
  expect(host.querySelector('[role="status"]')!.textContent).toBe("자료 조회와 생성 권한을 해제했습니다.");
});

it("[해제] — 해제 뒤에도 살아 있는 연결이 남으면 '해제했습니다'라 하지 않는다", async () => {
  await act(async () => root.render(<McpQuickConnect onOpenWindow={() => {}} />));
  await flush();
  // 해제하는 사이 다른 등록이 새 연결을 낸 것처럼 — 해제 뒤 목록에 codex 가 또 살아 있다
  afterRevoke = () => { if (!clients.some((client) => client.id === "c10")) clients = [...clients, { id: "c10", name: "codex", revoked_at: null }]; };
  await act(async () => button("codex").click());
  await flush();
  expect(host.querySelector('[role="status"]')!.textContent).toContain("해제하지 못한 연결이 남아 있습니다");
  expect(pill("codex")).toBe("연결됨");
});

it("수동 등록 필요 — 연결 기록이 있어도 '연결됨'이 아니라 '수동 등록 필요'와 까닭·[설정 복사](Codex 리뷰 #2)", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  configureResult = [{ client: "codex", status: "manual", message: "설정이 다른 프로그램에서 바뀌었습니다. 다시 연결하세요.", config: { mcpServers: { mvhub: { command: "py" } } } }];
  onConfigure = () => {};
  await act(async () => root.render(<McpQuickConnect onOpenWindow={() => {}} />));
  await flush();
  await act(async () => button("claude").click()); // 아무 앱이나 등록 요청 — 결과는 codex manual
  await flush();
  expect(pill("codex")).toBe("수동 등록 필요");
  expect(row("codex").textContent).toContain("설정이 다른 프로그램에서 바뀌었습니다");
  expect(button("codex").textContent).toBe("설정 복사");
  await act(async () => button("codex").click());
  await flush();
  expect(writeText).toHaveBeenCalledWith(JSON.stringify({ mcpServers: { mvhub: { command: "py" } } }, null, 2));
  expect(host.querySelector('[role="status"]')!.textContent).toContain("설정을 복사했습니다");
});

it("고급 — [MV·MCP 연결 열기]는 연결 창을 연다(다른 MCP 프로그램·옛 연결·MCP 업데이트)", async () => {
  const onOpenWindow = vi.fn();
  await act(async () => root.render(<McpQuickConnect onOpenWindow={onOpenWindow} />));
  await flush();
  const open = [...host.querySelectorAll<HTMLButtonElement>("details.settings-adv button")].find((item) => item.textContent === "MV·MCP 연결 열기")!;
  act(() => open.click());
  expect(onOpenWindow).toHaveBeenCalledTimes(1);
});
