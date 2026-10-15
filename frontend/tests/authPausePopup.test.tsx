// @vitest-environment jsdom
// Jay 결정 4B(Codex 3차): 다른 탭 로그아웃으로 멈춘 관리 분리 창은 다른 계정의 로그인이 워크스페이스 범위를 지워도 따라가지 않는다 —
//  따라가면 작업표가 다른 범위로 다시 그려져 쓰던 설명 초안이 사라진다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => [] as (string | undefined)[]);
vi.mock("../src/api", () => ({
  api: { authConfig: () => Promise.resolve({ manage_enabled: true }), workspaceOptions: () => Promise.resolve({ workspaces: [] }) },
}));
vi.mock("../src/lib/useManageCaps", () => ({ useManageCaps: () => ({ loaded: true, contextKey: "k" }) }));
vi.mock("../src/lib/useManageRealtime", () => ({ useManageRealtime: () => 0 }));
vi.mock("../src/components/manage/DashboardView", () => ({ DashboardView: () => null }));
vi.mock("../src/components/manage/ExportView", () => ({ ExportView: () => null }));
vi.mock("../src/components/manage/WorkBoard", () => ({
  WorkBoard: (props: { workspaceId?: string }) => {
    seen.push(props.workspaceId);
    return null;
  },
}));

import { ManageWindow } from "../src/components/ManageWindow";
import { setApiPause } from "../src/lib/http";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  seen.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setApiPause(null);
});

const changeWorkspace = (value: unknown) => {
  if (value === null) localStorage.removeItem("ch.workspaceContext");
  else localStorage.setItem("ch.workspaceContext", JSON.stringify(value));
  window.dispatchEvent(new StorageEvent("storage", { key: "ch.workspaceContext", newValue: value === null ? null : JSON.stringify(value) }));
};

it("멈춘 관리 창은 다른 탭이 지운 워크스페이스 범위를 따라가지 않는다 — 멈추지 않았으면 따라간다", async () => {
  localStorage.setItem("ch.manage.tab", "tasks");
  localStorage.setItem("ch.workspaceContext", JSON.stringify({ scope: "team", id: "ws1", name: "팀" }));
  await act(async () => root.render(<ManageWindow />));
  await act(async () => {});
  const before = seen.at(-1);
  expect(before).toBe("ws1");
  setApiPause("shared");
  await act(async () => changeWorkspace(null)); // 다른 계정의 로그인이 개인 설정을 지웠다
  expect(seen.at(-1)).toBe(before);
  setApiPause(null);
  await act(async () => changeWorkspace({ scope: "team", id: "ws2", name: "다른 팀" }));
  expect(seen.at(-1)).toBe("ws2");
});
