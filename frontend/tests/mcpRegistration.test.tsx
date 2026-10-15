// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceContext } from "../src/types";
const io = vi.hoisted(() => ({ http: vi.fn(), token: "a" }));
vi.mock("../src/lib/http", async (original) => ({ ...await original<typeof import("../src/lib/http")>(), jsonFetch: io.http, jsonBody: JSON.stringify, getAuthToken: () => io.token }));
import { HttpError } from "../src/lib/http";
import { McpRegistration } from "../src/components/mcp/McpRegistration";
let root: Root, host: HTMLDivElement;
const workspace: WorkspaceContext = { scope: "team", id: "w1", name: "작업 공간" };
const client = { id: "c1", name: "Codex", workspace, can_execute: true, revoked_at: null, last_seen_at: null };
const render = async (authKey = "a", currentWorkspace = workspace) => { await act(async () => root.render(<McpRegistration authReady authKey={authKey} workspace={currentWorkspace} />)); };
const click = async (text: string) => { await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === text)!.click()); };
beforeEach(async () => {
  vi.resetAllMocks(); io.token = "a";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", (await vi.importActual<{ webcrypto: Crypto }>("node:crypto")).webcrypto);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("명시적인 최초 버튼만 두 클라이언트를 허용하고 등록과 연결 확인을 구분한다", async () => {
  io.http.mockResolvedValueOnce({ clients: [{ client: "codex", status: "configured", message: "등록됨" }, { client: "claude", status: "error", message: "설정 파일을 확인하세요" }] }).mockResolvedValueOnce({ clients: [client] });
  await render(); expect(io.http).not.toHaveBeenCalled();
  expect(host.textContent).toContain("크레딧 사용을 허용");
  await click("Codex·Claude Code 연결 허용");
  expect(io.http.mock.calls[0][0]).toBe("/api/mcp/v2/app/configure");
  expect(JSON.parse(io.http.mock.calls[0][1].body)).toEqual({ clients: ["codex", "claude"], scope: "account", allow_execution: true });
  expect(host.textContent).not.toContain("현재 공간");
  expect(host.textContent).toContain("공간 고정: 작업 공간");
  expect(io.http.mock.calls[0][1].headers["X-MVHub-Tab"]).toBeTruthy();
  expect(host.textContent).toContain("LLM 응답 미확인");
  expect(host.textContent).toContain("claude · 등록 실패");
  expect(host.querySelector(".mcp-reg-status strong")?.textContent).toBe("저장된 연결을 확인했습니다."); // 첫 문장만 굵게(모의 그림)
  io.http.mockResolvedValueOnce({}).mockResolvedValueOnce({ clients: [{ ...client, revoked_at: "2026-10-15" }] });
  await click("권한 해제");
  expect(io.http).toHaveBeenCalledWith("/api/mcp/v2/app/clients/c1/revoke", expect.objectContaining({ method: "POST" }));
  expect(host.textContent).toContain("권한 해제됨");
  expect(host.textContent).toContain("자료 조회와 생성 실행 권한을 해제했습니다.");
  expect(host.querySelector(".mcp-reg-status strong")?.textContent).toBe("자료 조회와 생성 실행 권한을 해제했습니다."); // 한 문장이면 통째로
});

it("계정 전환 뒤 늦게 도착한 등록 결과를 표시하거나 권한을 자동 해제하지 않는다", async () => {
  let finish!: (value: unknown) => void;
  io.http.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  await render(); await click("Codex·Claude Code 연결 허용");
  io.token = "b"; await render("b");
  await act(async () => finish({ clients: [{ client: "codex", status: "configured", message: "이전 계정 결과" }] }));
  expect(host.textContent).not.toContain("이전 계정 결과");
  expect(io.http).toHaveBeenCalledTimes(1);
});

it("공간 선택 없이 계정 기준 연결을 등록하고 저장된 범위를 표시한다", async () => {
  io.http.mockResolvedValueOnce({ clients: [{ client: "codex", status: "configured", message: "등록됨" }] })
    .mockResolvedValueOnce({ clients: [{ ...client, scope: "account", workspace: null }] });
  await render();
  await click("Codex·Claude Code 연결 허용");
  expect(host.textContent).toContain("계정 기준 연결");
  expect(host.textContent).not.toContain("공간 선택 필요");
  expect(host.textContent).not.toContain("공간 고정:");
  expect(host.textContent).toContain("현재 계정이 접근 가능한 모든 공간");
});

it("캔버스 대기 요청은 버튼으로 현재 공간만 조회하고 명시적으로 취소한다", async () => {
  const task = { id: "task/1", scene_id: "scene1", generation_ids: ["g1"], workspace, status: "pending" };
  io.http.mockResolvedValueOnce({ tasks: [task] });
  await render();
  expect(io.http).not.toHaveBeenCalled();
  expect(host.querySelector("details")!.open).toBe(false);
  await click("대기 작업 확인");
  expect(io.http.mock.calls[0][0]).toBe("/api/mcp/v2/app/canvas-tasks?workspace_scope=team&workspace_id=w1");
  expect(host.textContent).toContain("장면 scene1");
  io.http.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ tasks: [] });
  await click("추가 요청 취소");
  expect(io.http.mock.calls[1][0]).toBe("/api/mcp/v2/app/canvas-tasks/task%2F1/cancel");
  expect(JSON.parse(io.http.mock.calls[1][1].body)).toEqual({ workspace });
  expect(host.textContent).toContain("대기 요청을 취소했습니다");
  expect(host.textContent).not.toContain("장면 scene1");
});

it.each(["workspace", "account"])("%s 변경 뒤 돌아와도 이전 대기 목록 응답을 표시하지 않는다", async (change) => {
  let finish!: (value: unknown) => void;
  io.http.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  await render(); await click("대기 작업 확인");
  if (change === "workspace") await render("a", { ...workspace, id: "w2" });
  else { io.token = "b"; await render("b"); }
  io.token = "a"; await render();
  await act(async () => finish({ tasks: [{ id: "old", scene_id: "old-scene", generation_ids: ["g1"], workspace, status: "pending" }] }));
  expect(host.textContent).not.toContain("old-scene");
  expect(io.http).toHaveBeenCalledTimes(1);
});

it("취소 실패는 원문을 숨기고 재확인을 안내하며 목록을 보존한다", async () => {
  io.http.mockResolvedValueOnce({ tasks: [{ id: "task1", scene_id: "scene1", generation_ids: ["g1"], workspace, status: "pending" }] });
  await render(); await click("대기 작업 확인");
  io.http.mockRejectedValueOnce(new Error("secret-account-token"));
  await click("추가 요청 취소");
  expect(host.textContent).toContain("취소 결과를 확인하지 못했습니다");
  expect(host.textContent).not.toContain("secret-account-token");
  expect(host.textContent).toContain("장면 scene1");
});

it("이미 완료된 요청의 취소 404는 목록을 새로 받아 정리한다", async () => {
  io.http.mockResolvedValueOnce({ tasks: [{ id: "task1", scene_id: "scene1", generation_ids: ["g1"], workspace, status: "pending" }] });
  await render(); await click("대기 작업 확인");
  io.http.mockRejectedValueOnce(new HttpError(404, "private detail")).mockResolvedValueOnce({ tasks: [] });
  await click("추가 요청 취소");
  expect(host.textContent).toContain("더 이상 대기 중이 아닙니다");
  expect(host.textContent).not.toContain("장면 scene1");
  expect(host.textContent).not.toContain("private detail");
});

it("오류 원문을 숨기며 수동 설정은 복사 실패 후에도 남긴다", async () => {
  io.http.mockRejectedValueOnce(new Error("secret-account-token"));
  await render(); await click("Codex·Claude Code 연결 허용");
  expect(host.textContent).toContain("일부만 반영"); expect(host.textContent).not.toContain("secret-account-token");
  io.http.mockResolvedValueOnce({ clients: [{ client: "other", status: "manual", message: "직접 등록", config: { command: "python", args: ["-I", "-S"] } }] }).mockResolvedValueOnce({ clients: [] });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("unavailable")) } });
  await click("다른 MCP 프로그램 설정"); await click("MCP 설정 복사");
  expect(host.textContent).toContain("자동 복사를 사용할 수 없습니다");
  expect(host.querySelector("pre")!.textContent).toContain('"-I"');
});
