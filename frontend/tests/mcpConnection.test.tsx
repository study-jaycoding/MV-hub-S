// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Generation } from "../src/types";
import type { Scene } from "../src/lib/scenes";
import type { McpPlanBody, McpPlanRecord } from "../src/lib/mcpPlans";

const io = vi.hoisted(() => ({ http: vi.fn(), scenes: vi.fn(), confirm: vi.fn() }));
vi.mock("../src/lib/http", async (original) => ({ ...await original<typeof import("../src/lib/http")>(), jsonFetch: io.http }));
vi.mock("../src/lib/scenes", async (original) => ({
  ...await original<typeof import("../src/lib/scenes")>(),
  listScenes: io.scenes, listPersistedScenes: io.scenes, confirmSceneWrite: io.confirm,
}));
vi.mock("../src/api", () => ({ api: {
  projects: vi.fn(), models: vi.fn(), projectFolder: vi.fn(), modelParams: vi.fn(),
  estimateCost: vi.fn(), getGeneration: vi.fn(), prepareCreate: vi.fn(),
} }));

import { api } from "../src/api";
import { HttpError } from "../src/lib/http";
import { McpConnection, mcpSetupConfig, mcpInstallCommand, type McpConnectionProps, type McpSetup } from "../src/components/mcp/McpConnection";

type Command = { id: string; method: string; args: object };
type Reply = { id: string; error?: string; result?: Record<string, unknown> };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const realSetTimeout = globalThis.setTimeout;
let root: Root, host: HTMLDivElement, scene: Scene, props: McpConnectionProps;
let record: McpPlanRecord | undefined;
let pendingPoll: ((request: Command | null) => void) | undefined;
let replies: Map<string, Reply>, sequence: number, pollCount: number;
let events: string[];

async function until(done: () => boolean) {
  for (let index = 0; index < 300 && !done(); index++) {
    await act(async () => { await new Promise<void>((resolve) => realSetTimeout(resolve, 0)); });
  }
  expect(done(), "비동기 MCP 요청이 끝나지 않았습니다").toBe(true);
}

async function command(method: string, args: object = {}): Promise<Reply> {
  await until(() => !!pendingPoll);
  const id = String(++sequence);
  await act(async () => { pendingPoll!({ id, method, args }); });
  await until(() => replies.has(id));
  return replies.get(id)!;
}

async function pair() {
  await act(async () => { root.render(<McpConnection {...props} />); });
  await act(async () => {
    const input = host.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "123456");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "연결 허용")!.click(); });
  await until(() => !!pendingPoll);
  expect(io.http).toHaveBeenCalledWith("/api/mcp/app/pair", expect.objectContaining({ body: JSON.stringify({ pair_code: "123456", allow_execution: true }) }));
}

async function prepare(count = 1) {
  const context = await command("read_context", { kind: "scene" });
  expect(context.error).toBeUndefined();
  const plan = await command("prepare_generation_plan", {
    title: "우주 바나나", context_id: context.result!.context_id,
    items: Array.from({ length: count }, (_, index) => ({ label: `Cut ${index + 1}`, prompt: "우주 바나나", model: "model", params: {}, reference_ids: [], project_id: "project", folder_path: "e001/c0010" })),
  });
  expect(plan.error).toBeUndefined();
  return { plan_id: plan.result!.plan_id };
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", (await vi.importActual<{ webcrypto: Crypto }>("node:crypto")).webcrypto);
  scene = { id: "scene", name: "Scene", created_at: 1, cards: [], edges: [] };
  record = undefined; pendingPoll = undefined; replies = new Map(); sequence = 0; pollCount = 0; events = [];
  io.scenes.mockImplementation(() => [clone(scene)]);
  io.confirm.mockImplementation((write: () => unknown) => ({ value: write(), confirmed: Promise.resolve(true) }));
  props = {
    open: true, onClose: vi.fn(), authReady: true, authKey: "account-a",
    workspace: { scope: "personal", id: null, name: null }, activeSceneId: "scene", flushScenePending: vi.fn(),
    patchSceneById: vi.fn((_id, patch) => { events.push("cards"); scene = { ...scene, ...patch }; return true; }),
    prepareCanvasGenerationBatch: vi.fn(async (_sceneId, _ids, links = []) => { events.push("links"); return links; }),
    settleCanvasGeneration: vi.fn(), discardCanvasGeneration: vi.fn(),
  };
  vi.mocked(api.projects).mockResolvedValue({ projects: [{ id: "project", name: "Project", workspace_scope: "personal", workspace_id: null }], unassigned: 0 } as Awaited<ReturnType<typeof api.projects>>);
  vi.mocked(api.models).mockResolvedValue([{ job_set_type: "model", display_name: "Model", type: "image" }]);
  vi.mocked(api.projectFolder).mockResolvedValue({ project_id: "project", root_path: "", selected_path: "", render_path: "", truncated: false, tree: { path: "", name: "Render", count: 0, children: [{ path: "e001/c0010", name: "Cut", count: 0, children: [] }] }, error: null });
  vi.mocked(api.modelParams).mockResolvedValue({ job_set_type: "model", type: "image", params: [] });
  vi.mocked(api.estimateCost).mockResolvedValue({ credits: 3 });
  vi.mocked(api.getGeneration).mockResolvedValue({ status: "pending" } as Generation);
  vi.mocked(api.prepareCreate).mockImplementation(() => async () => { events.push("submit"); return { id: "generation", status: "pending" } as Generation; });
  io.http.mockImplementation(async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path.endsWith("/app/pair")) return { name: "Test MCP", client_id: "client", can_execute: true };
    if (path.endsWith("/app/next")) {
      pollCount++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(null), 25_000);
        const finish = (request: Command | null) => { clearTimeout(timer); pendingPoll = undefined; resolve({ request }); };
        pendingPoll = finish;
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); pendingPoll = undefined; reject(new DOMException("Aborted", "AbortError")); }, { once: true });
      });
    }
    if (path.endsWith("/app/reply")) { replies.set(body.id, body); return { ok: true }; }
    if (path.endsWith("/app/check") || path.endsWith("/app/close")) return { ok: true };
    if (path === "/api/mcp/plans") {
      record = { id: "plan", revision: 0, status: "proposed", plan: clone(body as McpPlanBody), items: body.items.map(() => ({ state: "pending", error: null })) };
    } else if (path.endsWith("/approve") || path.endsWith("/item")) {
      if (!record || body.revision !== record.revision) throw Object.assign(new Error("revision conflict"), { status: 409 });
      record = clone(record); record.revision++;
      if (path.endsWith("/approve")) { events.push(`approve:${body.source}`); record.status = "approved"; }
      else {
        events.push(body.state); record.items[body.index] = { state: body.state, error: body.error ?? null };
        if (record.items.every((item) => item.state === "submitted")) record.status = "submitted";
      }
    } else if (path !== "/api/mcp/plans/plan" && path !== "/api/mcp/plans/other") throw new Error(`Unmocked path: ${path}`);
    if (!record) throw new Error("missing plan");
    return { ...clone(record), ...(path.endsWith("/other") ? { id: "other" } : {}) };
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});

it("한 번 연결한 뒤 앱 승인 클릭 없이 카드·연결·제출·상태를 기존 순서로 저장한다", async () => {
  await pair();
  const plan = await prepare();
  expect(await command("execute_generation_plan", plan)).toMatchObject({ result: { status: "execution_started", submitted: false } });
  await until(() => record?.status === "submitted");
  expect(events).toEqual(["approve:mcp", "cards", "links", "submitting", "submit", "submitted"]);
  expect(scene.cards.filter((card) => card.kind === "generation")).toHaveLength(1);
  expect(props.settleCanvasGeneration).toHaveBeenCalledTimes(1);
  expect(await command("get_plan", plan)).toMatchObject({ result: { status: "submitted", execution: { running: false, error: null }, items: [{ state: "submitted", generation_status: "pending" }] } });
  expect((await command("execute_generation_plan", plan)).error).toContain("반복하지 말고");
  expect(api.prepareCreate).toHaveBeenCalledTimes(1);
});

it("제출이 60초 걸려도 폴링과 상태 조회를 유지하고 중복 요청은 거절한다", async () => {
  vi.useFakeTimers();
  let finish!: (value: Generation) => void;
  vi.mocked(api.prepareCreate).mockImplementation(() => () => new Promise((resolve) => { finish = resolve; }));
  await pair(); const plan = await prepare();
  expect(await command("execute_generation_plan", plan)).toMatchObject({ result: { status: "execution_started", submitted: false } });
  await until(() => !!finish);
  const pollsBefore = pollCount;
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(pollCount).toBeGreaterThanOrEqual(pollsBefore + 2);
  expect(await command("get_plan", plan)).toMatchObject({ result: { execution: { running: true }, items: [{ state: "submitting" }] } });
  expect((await command("execute_generation_plan", plan)).error).toContain("반복하지 말고");
  expect(await command("get_plan", { plan_id: "other" })).toMatchObject({ result: { execution: null } });
  await act(async () => { finish({ id: "generation", status: "pending" } as Generation); });
  await until(() => record?.status === "submitted");
  expect(api.prepareCreate).toHaveBeenCalledTimes(1);
});

it("기존 request_execution은 승인 창만 열고 생성하지 않는다", async () => {
  await pair(); const plan = await prepare();
  expect(await command("request_execution", plan)).toMatchObject({ result: { status: "awaiting_user_approval", submitted: false } });
  expect(host.textContent).toContain("앱에서 직접 생성");
  expect(record?.status).toBe("proposed");
  expect(events).toEqual([]); expect(api.prepareCreate).not.toHaveBeenCalled();
});

it.each(["preflight", "cards"])("%s 실패는 get_plan에 안전하게 보이고 재제출하지 않는다", async (phase) => {
  await pair(); const plan = await prepare();
  if (phase === "preflight") scene = { ...scene, name: "Changed" };
  else vi.mocked(props.patchSceneById).mockImplementation(() => { throw new Error("token=fake-private-secret"); });
  await command("execute_generation_plan", plan);
  let status: Reply | undefined;
  for (let attempt = 0; attempt < 10; attempt++) {
    status = await command("get_plan", plan);
    if ((status.result?.execution as { running: boolean })?.running === false) break;
  }
  expect(status).toMatchObject({ result: { execution: { running: false, error: expect.any(String) } } });
  expect((status!.result!.execution as { error: string }).error).toContain("API 호출 전에 중단");
  expect(JSON.stringify(status)).not.toContain("fake-private-secret");
  expect((await command("execute_generation_plan", plan)).error).toContain("반복하지 말고");
  expect(api.prepareCreate).not.toHaveBeenCalled();
});

it("사전 확인을 기다리는 동안 씬 재조회가 실행 문맥을 바꾸지 않는다", async () => {
  await pair(); const plan = await prepare();
  let resume!: () => void;
  const pending = new Promise<void>((resolve) => { resume = resolve; });
  vi.mocked(props.flushScenePending).mockImplementationOnce(() => pending);
  io.confirm.mockImplementationOnce((write: () => unknown) => ({ value: write(), confirmed: pending.then(() => true) }));
  expect(await command("execute_generation_plan", plan)).toMatchObject({ result: { status: "execution_started" } });
  expect((await command("read_context", { kind: "scene" })).error).toContain("get_plan");
  expect(await command("get_plan", plan)).toMatchObject({ result: { execution: { running: true } } });
  await act(async () => { resume(); });
  await until(() => record?.status === "submitted");
  expect(api.prepareCreate).toHaveBeenCalledTimes(1);
});

it("실행 중 계정이 바뀌면 다음 항목을 제출하지 않는다", async () => {
  let finish!: (value: Generation) => void;
  vi.mocked(api.prepareCreate).mockImplementation(() => () => new Promise((resolve) => { finish = resolve; }));
  await pair(); const plan = await prepare(2);
  await command("execute_generation_plan", plan); await until(() => !!finish);
  await act(async () => { root.render(<McpConnection {...props} authKey="account-b" />); });
  await act(async () => { finish({ id: "generation", status: "pending" } as Generation); });
  await until(() => host.querySelector("input") !== null);
  expect(api.prepareCreate).toHaveBeenCalledTimes(1);
  expect(props.settleCanvasGeneration).not.toHaveBeenCalled();
  expect(record?.items[1].state).toBe("pending");
});

const setup: McpSetup = {
  url: "http://127.0.0.1:8016",
  adapter: "C:\\Jay's Hub\\tools\\mcp_adapter\\server.py", adapter_exists: true,
  python: "C:\\Users\\Jay's PC\\MVHub-MCP\\venv\\Scripts\\python.exe", python_exists: true,
};
const click = async (label: string) => {
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent === label);
  expect(button, `${label} 단추`).toBeDefined();
  await act(async () => { button!.click(); });
};
const showSetup = async (value: McpSetup = setup) => {
  io.http.mockResolvedValueOnce(value);
  await act(async () => { root.render(<McpConnection {...props} />); });
  await click("처음 연결 설정");
  const toggle = host.querySelector<HTMLButtonElement>('button[aria-controls]')!;
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBe(host.querySelector(".mcp-setup"));
};

it.each([undefined, [], ["-I", "-S"]])("Codex·Claude 등록 설정은 Python 옵션 %j와 Windows 경로를 보존한다", (pythonArgs) => {
  const runtime = pythonArgs === undefined ? setup : { ...setup, python_args: pythonArgs };
  const args = [...(pythonArgs ?? []), setup.adapter, "--url", setup.url];
  expect(JSON.parse(mcpSetupConfig(runtime, "claude"))).toEqual({ mcpServers: { mvhub: { command: setup.python, args } } });
  const lines = mcpSetupConfig(runtime, "codex").split("\n");
  expect(lines[0]).toBe("[mcp_servers.mvhub]");
  expect(JSON.parse(lines[1].slice("command = ".length))).toBe(setup.python);
  expect(JSON.parse(lines[2].slice("args = ".length))).toEqual(args);
  expect(lines[3]).toBe("tool_timeout_sec = 150");
  for (const unavailable of [{ ...setup, adapter_exists: false }, { ...setup, python_exists: false }, { ...setup, python: null }]) {
    expect(mcpSetupConfig(unavailable, "codex")).toBe("");
    expect(mcpSetupConfig(unavailable, "claude")).toBe("");
  }
});

it("Python 미설치 안내는 작은따옴표가 든 경로를 PowerShell 리터럴로 보존한다", async () => {
  await showSetup({ ...setup, python_exists: false });
  expect(host.textContent).toContain("Python 3.11 이상");
  const script = host.querySelector("pre")!.textContent!;
  expect(script).toBe(mcpInstallCommand(setup));
  expect(script).toContain("py -3 -m venv 'C:\\Users\\Jay''s PC\\MVHub-MCP\\venv'");
  expect(script).toContain("& 'C:\\Users\\Jay''s PC\\MVHub-MCP\\venv\\Scripts\\python.exe' -m pip install -r 'C:\\Jay''s Hub\\tools\\mcp_adapter\\requirements.txt'");
  expect(script.split("\n")[0]).toBe('py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)"');
  expect(script.split("\n")[1]).toContain("$LASTEXITCODE -ne 0");
  expect(script.split("\n").filter((line) => line.includes("$LASTEXITCODE -ne 0"))).toHaveLength(3);
  expect(script).toContain("Test-Path -LiteralPath");
  expect([...host.querySelectorAll("button")].some((button) => button.textContent === "등록 설정 복사")).toBe(false);
});

it("어댑터가 없으면 실행 설정과 설치 명령을 보여주지 않는다", async () => {
  await showSetup({ ...setup, adapter_exists: false });
  expect(host.textContent).toContain("MCP 어댑터가 없습니다");
  expect(host.querySelector("pre")).toBeNull();
  expect(mcpInstallCommand({ ...setup, adapter_exists: false })).toBe("");
  expect(mcpInstallCommand({ ...setup, python: null })).toBe("");
});

it("미연결 상태 확인은 허브 응답만 알리고 LLM 연결 성공으로 표시하지 않는다", async () => {
  io.http.mockResolvedValueOnce(setup);
  await act(async () => { root.render(<McpConnection {...props} />); });
  await click("연결 상태 확인");
  expect(io.http).toHaveBeenCalledExactlyOnceWith("/api/mcp/app/setup", expect.objectContaining({ headers: { "X-MVHub-Tab": expect.any(String) } }));
  expect(host.textContent).toContain("아직 LLM과 연결되지 않았습니다");
  expect(host.textContent).not.toContain("LLM 연결됨");
  expect(host.querySelector("pre")).toBeNull();
});

it("SDK 번들 누락의 허용된 503 안내만 표시하고 등록 설정을 숨긴다", async () => {
  const detail = "MCP 번들이 불완전합니다. 앱을 다시 설치하세요.";
  await showSetup();
  io.http.mockRejectedValueOnce(new HttpError(503, `503: ${detail}`, detail));
  await click("연결 상태 확인");
  expect(host.textContent).toContain(detail);
  expect(host.querySelector("pre")).toBeNull();
  expect([...host.querySelectorAll("button")].some((button) => button.textContent === "등록 설정 복사")).toBe(false);
});

it.each([
  [503, "token=fake-private-secret C:\\private\\user"],
  [503, "MCP 번들이 불완전합니다. 앱을 다시 설치하세요. token=fake-private-secret"],
  [500, "token=fake-private-secret"],
] as const)("허용하지 않은 HTTP %s 오류 본문을 화면에 복제하지 않는다", async (status, detail) => {
  io.http.mockRejectedValueOnce(new HttpError(status, `${status}: ${detail}`, detail));
  await act(async () => { root.render(<McpConnection {...props} />); });
  await click("처음 연결 설정");
  expect(host.textContent).toContain("연결을 확인하지 못했습니다");
  expect(host.textContent).not.toContain("fake-private-secret");
  expect(host.textContent).not.toContain("C:\\private");
  expect(host.textContent).not.toContain("MCP 번들이 불완전합니다");
  expect(host.querySelector("pre")).toBeNull();
});

it("연결된 상태 확인은 등록 정보 대신 현재 앱 탭을 확인한다", async () => {
  await pair();
  io.http.mockClear();
  await click("연결 상태 확인");
  expect(io.http).toHaveBeenCalledExactlyOnceWith("/api/mcp/app/check", expect.objectContaining({ headers: { "X-MVHub-Tab": expect.any(String) } }));
  expect(host.textContent).toContain("연결된 앱 탭의 응답을 확인했습니다");
});

it("클립보드 실패 시 직접 복사할 설정을 남기고 프로그램 전환을 반영한다", async () => {
  const writeText = vi.fn().mockRejectedValue(new Error("clipboard denied"));
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  await showSetup();
  await click("등록 설정 복사");
  expect(writeText).toHaveBeenCalledExactlyOnceWith(mcpSetupConfig(setup, "codex"));
  expect(host.textContent).toContain("자동 복사를 사용할 수 없습니다");
  expect(host.querySelector("pre")!.textContent).toBe(mcpSetupConfig(setup, "codex"));
  await act(async () => {
    const select = host.querySelector("select")!;
    select.value = "claude"; select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(host.textContent).not.toContain("자동 복사를 사용할 수 없습니다");
  expect(JSON.parse(host.querySelector("pre")!.textContent!)).toHaveProperty("mcpServers.mvhub.command", setup.python);
  await click("등록 안내 접기");
  expect(host.querySelector('button[aria-controls]')!.getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector(".mcp-setup")).toBeNull();
});

it.each(["scope", "unmount"])("%s 변경 뒤 늦게 도착한 등록 응답을 버린다", async (change) => {
  let finish!: (value: McpSetup) => void;
  io.http.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => { root.render(<McpConnection {...props} />); });
  await click("처음 연결 설정");
  await act(async () => {
    if (change === "scope") root.render(<McpConnection {...props} workspace={{ scope: "team", id: "other", name: "Other" }} />);
    else { root.unmount(); root = createRoot(host); }
  });
  await act(async () => { finish(setup); });
  expect(host.querySelector("pre")).toBeNull();
  expect(host.textContent).not.toContain(setup.url);
  expect(host.textContent).not.toContain("허브 응답 확인");
});

// Jay 2026-10-16 "번역 버전 있게" — 창에 보이는 글은 모두 영어 표가 있어야 한다. 데이터(계획 제목·프롬프트·설정 본문)는 그대로.
it("영어 화면: 기본·처음 연결 설정·연결·계획까지 창의 글에 한글이 남지 않는다", async () => {
  const { setLang } = await import("../src/lib/i18n");
  const hangulLeft = () => {
    const copy = host.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("pre, .mcp-legacy > section:not(.mcp-setup) > h3").forEach((data) => data.remove());
    return copy.textContent!.match(/[가-힣][^.!?]*/g) ?? [];
  };
  try {
    await showSetup();
    await pair();
    await prepare();
    await until(() => !!host.querySelector(".mcp-items"));
    act(() => setLang("en"));
    expect(hangulLeft().join(" | ")).toBe("");
    expect(host.textContent).toContain("1 generations · about 3 credits");
  } finally {
    act(() => setLang("ko"));
  }
});
