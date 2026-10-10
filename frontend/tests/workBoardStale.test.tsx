// @vitest-environment jsdom
// 작업표 — 재조회가 실패해도 받은 표를 걷지 않는다(띠로 알림). 실제 TableView 를 붙여 치던 설명 글이 남는지까지 본다.
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkBoard } from "../src/components/manage/WorkBoard";
import { api } from "../src/api";
import { manageApi } from "../src/lib/manageApi";
import type { Task } from "../src/components/manage/types";

vi.mock("../src/api", () => ({ api: { facets: vi.fn(), projects: vi.fn() } }));
vi.mock("../src/lib/manageApi", () => ({ manageApi: {
  taskProjects: vi.fn(), listTasksBatch: vi.fn(), localTaskPreviews: vi.fn(), updateTask: vi.fn(),
} }));

let host: HTMLDivElement;
let root: Root;
let props: ComponentProps<typeof WorkBoard>;
function render(patch: Partial<typeof props> = {}) {
  props = { ...props, ...patch };
  act(() => root.render(<WorkBoard {...props} />));
}
async function settle() { await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); }); }
function task(workspace = "a"): Task {
  return { id: `task-${workspace}`, project_id: "project", name: "ep", folder_path: "ep/seq", description: "원래 설명",
    workspace_scope: "team", workspace_id: workspace, status: "in_progress", created_at: "2026-09-17",
    gen_count: 0, credits: 0, cuts: [] };
}
const input = () => host.querySelector<HTMLInputElement>("input.work-cell-in[placeholder]")!;
const banner = () => host.querySelector(".work-stale-notice");
const type = (value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
  input().dispatchEvent(new Event("input", { bubbles: true }));
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks();
  vi.spyOn(window, "alert").mockImplementation(() => {});
  vi.mocked(api.facets).mockResolvedValue({ auto_tags: [] } as never);
  vi.mocked(manageApi.taskProjects).mockResolvedValue({ projects: [{ id: "project", name: "Project" }] });
  vi.mocked(manageApi.listTasksBatch).mockImplementation(async (_ids, workspace) => ({ project: [task(workspace)] }));
  vi.mocked(manageApi.localTaskPreviews).mockResolvedValue({ viewer_uid: "me", items: {} });
  props = { viewerUid: "me", workspaceId: "a", contextKey: "account-a", reloadSignal: 0 };
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it("재조회(프로젝트·작업 어느 쪽이든)가 실패해도 받은 표와 치던 설명 글이 남고 띠가 뜬다 — [다시 시도]가 성공하면 띠가 사라진다", async () => {
  render(); await settle();
  expect(input().value).toBe("원래 설명");
  act(() => input().focus());
  type("치던 글");
  // 작업 목록 재조회 실패(실시간 신호·30초 안전망의 길)
  vi.mocked(manageApi.listTasksBatch).mockRejectedValueOnce(new Error("Failed to fetch"));
  render({ reloadSignal: 1 }); await settle();
  expect(banner()).not.toBeNull();
  expect(host.textContent).not.toContain("불러오기 실패");
  expect(input().value).toBe("치던 글"); // 표가 언마운트되지 않았다
  // 프로젝트 목록 재조회 실패(저장 실패 뒤 복구 조회의 길)
  vi.mocked(manageApi.taskProjects).mockRejectedValueOnce(new Error("Failed to fetch"));
  render({ reloadSignal: 2 }); await settle();
  expect(banner()).not.toBeNull();
  expect(input().value).toBe("치던 글");
  // 다시 시도 → 성공
  await act(async () => { banner()!.querySelector("button")!.click(); });
  await settle();
  expect(banner()).toBeNull();
  expect(input().value).toBe("치던 글"); // 고친 글은 새 목록이 와도 지키고 있다
});

it("설명 저장이 실패하고 복구 조회까지 실패해도 친 글과 '저장 안 됨'이 남는다 — 서버가 돌아오면 [다시 저장]으로 저장된다", async () => {
  render(); await settle();
  vi.mocked(manageApi.updateTask).mockRejectedValueOnce(new Error("500: boom"));
  vi.mocked(manageApi.taskProjects).mockRejectedValueOnce(new Error("Failed to fetch")); // 복구 조회
  act(() => input().focus());
  type("저장할 글");
  act(() => input().blur());
  await settle();
  expect(window.alert).toHaveBeenCalled();
  expect(banner()).not.toBeNull();
  expect(input().value).toBe("저장할 글");
  expect(host.querySelector(".work-desc-chip")).not.toBeNull();
  vi.mocked(manageApi.updateTask).mockResolvedValueOnce({} as never);
  await act(async () => { host.querySelector<HTMLButtonElement>(".work-desc .work-desc-retry")!.click(); });
  await settle();
  expect(manageApi.updateTask).toHaveBeenCalledTimes(2);
  expect(manageApi.updateTask).toHaveBeenLastCalledWith("task-a", { description: "저장할 글" });
  expect(host.querySelector(".work-desc .work-desc-chip")).toBeNull();
  expect(input().value).toBe("저장할 글");
});

it("받은 적 없는 범위의 조회 실패는 전처럼 오류 화면이다 — 첫 조회 실패, 그리고 다른 범위에 다녀온 뒤의 실패(빈 표를 받은 내용이라 하지 않는다)", async () => {
  vi.mocked(manageApi.listTasksBatch).mockRejectedValueOnce(new Error("Failed to fetch"));
  render(); await settle();
  expect(host.textContent).toContain("불러오기 실패");
  expect(banner()).toBeNull();
  await act(async () => { host.querySelector("button")!.click(); }); // 다시 시도 → 성공
  await settle();
  expect(input().value).toBe("원래 설명");
  // A 성공 → B 로 갔다가(목록 비움) 바로 A 로 복귀 → A 의 작업 조회 실패
  render({ workspaceId: "b" });
  vi.mocked(manageApi.listTasksBatch).mockRejectedValue(new Error("Failed to fetch"));
  render({ workspaceId: "a" }); await settle();
  expect(host.textContent).toContain("불러오기 실패");
  expect(banner()).toBeNull();
});

it("'저장 안 됨'이 붙은 줄은 보기를 보드로 바꿨다 돌아와도 친 글과 표시가 남는다", async () => {
  render(); await settle();
  vi.mocked(manageApi.updateTask).mockRejectedValueOnce(new Error("500: boom"));
  act(() => input().focus());
  type("못 간 글");
  act(() => input().blur());
  await settle();
  expect(host.querySelector(".work-desc-chip")).not.toBeNull();
  const viewButton = (label: string) => [...host.querySelectorAll<HTMLButtonElement>(".manage-toggles button")].find((button) => button.textContent?.trim() === label)!;
  await act(async () => { viewButton("보드").click(); });
  expect(host.querySelector("input.work-cell-in[placeholder]")).toBeNull(); // 표가 내려갔다
  await act(async () => { viewButton("테이블").click(); });
  expect(input().value).toBe("못 간 글");
  expect(host.querySelector(".work-desc-chip")).not.toBeNull();
});

it("보관 기록에 다녀온 뒤의 실패도 오류 화면이다 — 비운 표를 '마지막으로 받은 내용'이라 하지 않는다", async () => {
  render(); await settle();
  expect(input().value).toBe("원래 설명");
  const toggle = () => act(() => { host.querySelector<HTMLButtonElement>(".work-history-toggle")!.click(); });
  toggle(); // 보관 기록으로(목록 비움)
  vi.mocked(manageApi.listTasksBatch).mockRejectedValue(new Error("Failed to fetch"));
  toggle(); // 바로 돌아옴 → 프로젝트는 받고 작업 조회는 실패
  await settle();
  expect(host.textContent).toContain("불러오기 실패");
  expect(banner()).toBeNull();
});
