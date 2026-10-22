// @vitest-environment jsdom
// 내 계정 창의 'MCP 버전'(Jay 10-22) — CLI 버전 바로 아래에 이 앱 폴더의 MCP 어댑터 버전을 보인다.
//  값은 /api/mcp/app/setup 의 adapter_version 이고, 모르면(원격 접속·어댑터 없음) 앱 버전처럼 줄을 숨긴다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ jsonFetch: vi.fn() }));
vi.mock("../src/api", () => ({ api: {} }));
vi.mock("../src/lib/releaseUpdate", () => ({ getReleaseUpdateStatus: () => Promise.resolve({}) }));
vi.mock("../src/lib/http", async (original) => ({ ...(await original<typeof import("../src/lib/http")>()), jsonFetch: mocks.jsonFetch }));

import { ManageAccount } from "../src/components/ManageAccount";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.jsonFetch.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const labels = () => [...host.querySelectorAll(".manage-row-label")].map((el) => el.textContent);
const valueOf = (label: string) =>
  [...host.querySelectorAll(".manage-row")].find((row) => row.querySelector(".manage-row-label")?.textContent === label)
    ?.querySelector(".manage-row-value")?.textContent;
const open = async () => {
  await act(async () => {
    root.render(<ManageAccount provider={null} account={{ name: "나", email: "me@example.com" } as never} cliVersion="1.2.2" onClose={() => {}} onProviderUpdated={() => {}} />);
  });
};

it("CLI 버전 바로 아래에 MCP 어댑터 버전을 보인다", async () => {
  mocks.jsonFetch.mockResolvedValue({ adapter: "C:\\hub\\tools\\mcp_adapter\\server.py", adapter_exists: true, adapter_version: "2026.10.16.5" });
  await open();
  const order = labels();
  expect(order[order.indexOf("CLI 버전") + 1]).toBe("MCP 버전");
  expect(valueOf("MCP 버전")).toBe("2026.10.16.5");
  expect(mocks.jsonFetch).toHaveBeenCalledWith("/api/mcp/app/setup", expect.objectContaining({ headers: { "X-MVHub-Tab": expect.any(String) } }));
});

it("원격 HTTP(보안 문맥 아님 — randomUUID 없음)에서도 창이 열리고 MCP 조회는 하지 않는다", async () => {
  // 서버 주소(http://<IP>:8010)로 연 브라우저에는 crypto.randomUUID 가 없다 — 조회 인자를 만들다 던져 창이 깨졌다(Codex 10-22 R1).
  vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
  mocks.jsonFetch.mockResolvedValue({ adapter_version: "2026.10.16.5" });
  await open();
  expect(labels()).toContain("CLI 버전");
  expect(labels()).not.toContain("MCP 버전");
  expect(mocks.jsonFetch).not.toHaveBeenCalled();
});

it("버전을 모르거나 조회가 실패하면 줄을 숨긴다", async () => {
  mocks.jsonFetch.mockResolvedValue({ adapter_exists: false, adapter_version: null });
  await open();
  expect(labels()).toContain("CLI 버전");
  expect(labels()).not.toContain("MCP 버전");
  act(() => root.unmount());
  root = createRoot(host);
  mocks.jsonFetch.mockRejectedValue(new Error("403"));
  await open();
  expect(labels()).not.toContain("MCP 버전");
});
