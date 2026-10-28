// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ http: vi.fn(), token: "a" }));
vi.mock("../../lib/http", async (original) => ({ ...await original<typeof import("../../lib/http")>(), jsonFetch: io.http, jsonBody: JSON.stringify, getAuthToken: () => io.token }));
import { McpUpdate } from "./McpUpdate";
import { HttpError } from "../../lib/http";

let root: Root, host: HTMLDivElement;
const digest = "b".repeat(64);
const available = { selected_version: "2026.10.27.1", bundle_version: "2026.10.27.1", source: "bundle", selection_reason: "",
  published: { version: "2026.10.27.2", commit: "a".repeat(40), manifest_sha256: digest }, compatible: true,
  checked: true, available: true, note: "새 MCP 버전을 준비할 수 있습니다." };
const render = async (authKey = "a", authReady = true) => {
  await act(async () => root.render(<McpUpdate authKey={authKey} authReady={authReady} />));
};
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;
const click = async (text: string) => { await act(async () => button(text).click()); };
beforeEach(async () => {
  io.http.mockReset(); io.token = "a";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", (await vi.importActual<{ webcrypto: Crypto }>("node:crypto")).webcrypto);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("checks only on request and freezes the displayed manifest before installing", async () => {
  io.http.mockResolvedValueOnce(available).mockResolvedValueOnce({ ...available, available: false, selected_version: "2026.10.27.2",
    source: "downloaded", reload_required: true, settings_preserved: true, note: "MCP 업데이트를 준비했습니다." });
  await render();
  expect(io.http).not.toHaveBeenCalled();
  await click("새 MCP 버전 확인");
  await click("MCP 업데이트");
  expect(io.http).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("2026.10.27.2 버전으로 준비");
  await click("이 버전으로 업데이트");
  expect(io.http.mock.calls[1][0]).toBe("/api/mcp/app/adapter/update");
  expect(JSON.parse(io.http.mock.calls[1][1].body)).toEqual({ expected_manifest_sha256: digest });
  expect(host.textContent).toContain("MCP를 다시 불러오거나 재시작");
  expect(host.textContent).toContain("기존 MCP 연결 설정을 보존");
});

it("never offers incompatible installs or asserts an unknown mutation failed safely", async () => {
  io.http.mockResolvedValueOnce({ ...available, available: false, compatible: false, note: "본체 업데이트 필요" });
  await render(); await click("새 MCP 버전 확인");
  expect(button("MCP 업데이트")).toBeUndefined();
  expect(host.textContent).toContain("본체 업데이트 필요");
  io.http.mockResolvedValueOnce(available).mockRejectedValueOnce(new Error("network lost"));
  await click("새 MCP 버전 확인"); await click("MCP 업데이트"); await click("이 버전으로 업데이트");
  expect(host.textContent).toContain("업데이트 결과를 확인하지 못했습니다");
  expect(host.textContent).not.toContain("기존 버전을 그대로");
  expect(button("MCP 업데이트")).toBeUndefined();
});

it("discards late results across account changes including returning to the original account", async () => {
  let finish!: (value: unknown) => void;
  io.http.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  await render(); await click("새 MCP 버전 확인");
  io.token = "b"; await render("b");
  io.token = "a"; await render("a");
  await act(async () => finish(available));
  expect(host.textContent).not.toContain("2026.10.27.2");
  expect(button("MCP 업데이트")).toBeUndefined();
});

it("requires explicit rollback confirmation and sends the current digest", async () => {
  io.http.mockResolvedValueOnce({ ...available, source: "downloaded", rollback_available: true, manifest_sha256: digest });
  io.http.mockResolvedValueOnce({ ...available, available: false, note: "이전 MCP 버전을 준비했습니다.", reload_required: true });
  await render(); await click("새 MCP 버전 확인"); await click("이전 MCP 버전으로");
  expect(io.http).toHaveBeenCalledTimes(1);
  await click("이전 버전 준비");
  expect(io.http.mock.calls[1][0]).toBe("/api/mcp/app/adapter/rollback");
  expect(JSON.parse(io.http.mock.calls[1][1].body)).toEqual({ expected_manifest_sha256: digest });
});

it("disables all requests when authentication is not ready", async () => {
  await render("", false);
  expect(button("새 MCP 버전 확인").disabled).toBe(true);
  await click("새 MCP 버전 확인");
  expect(io.http).not.toHaveBeenCalled();
});

it("shows a rejected frozen version and requires checking again", async () => {
  io.http.mockResolvedValueOnce(available).mockRejectedValueOnce(new HttpError(409, "게시 버전이 변경되었습니다."));
  await render(); await click("새 MCP 버전 확인"); await click("MCP 업데이트"); await click("이 버전으로 업데이트");
  expect(host.textContent).toContain("게시 버전이 변경되었습니다.");
  expect(button("MCP 업데이트")).toBeUndefined();
});

it("translates the new version, confirmation and reload states", async () => {
  const { setLang } = await import("../../lib/i18n");
  act(() => setLang("en"));
  try {
    io.http.mockResolvedValueOnce(available).mockResolvedValueOnce({ ...available, source: "downloaded", available: false,
      reload_required: true, settings_preserved: true, note: "MCP 업데이트를 준비했습니다." });
    await render(); await click("Check for an MCP update"); await click("MCP update");
    expect(host.textContent).not.toMatch(/[가-힣]/);
    await click("Update to this version");
    expect(host.textContent).not.toMatch(/[가-힣]/);
    expect(host.textContent).toContain("Reload MCP or restart");
  } finally { act(() => setLang("ko")); }
});
