// @vitest-environment jsdom
// 작업 탭에는 줄 선택·[삭제]가 없다(2026-11-05 Jay B안). 폴더에서 생긴 줄은 지워도 다음 조회 때 다시 생기고 PM 이 적은 설명·마감일·
//  순서·담당만 잃었다. 전에 이 파일은 '보이는 것만 지운다'(조작 규칙 42)를 지켰다 — 삭제가 없어져 그 시험도 뺐다.
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkBoard } from "../src/components/manage/WorkBoard";
import { api } from "../src/api";
import { manageApi } from "../src/lib/manageApi";
import type { Task } from "../src/components/manage/types";

vi.mock("../src/api", () => ({ api: { autoTags: vi.fn(), projects: vi.fn() } }));
vi.mock("../src/lib/manageApi", () => ({ manageApi: {
  taskProjects: vi.fn(), listTasksBatch: vi.fn(), localTaskPreviews: vi.fn(), updateTask: vi.fn(),
  deleteTask: vi.fn(), deleteTasksBatch: vi.fn(),
} }));

let host: HTMLDivElement;
let root: Root;
async function settle() { await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); }); }
const task = (name: string): Task => ({ id: `task-${name}`, project_id: "project", name, folder_path: `${name}/seq`, description: "",
  workspace_scope: "team", workspace_id: "a", status: "in_progress", created_at: "2026-09-17", gen_count: 1, credits: 0, cuts: [] });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks();
  vi.mocked(api.autoTags).mockResolvedValue({ auto_tags: [] });
  vi.mocked(manageApi.taskProjects).mockResolvedValue({ projects: [{ id: "project", name: "Project" }] });
  vi.mocked(manageApi.listTasksBatch).mockResolvedValue({ project: [task("alpha"), task("beta")] });
  vi.mocked(manageApi.localTaskPreviews).mockResolvedValue({ viewer_uid: "me", items: {} });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it("작업 표에는 줄 선택 칸과 [삭제] 막대가 없고, 순서 손잡이는 남는다", async () => {
  const props: ComponentProps<typeof WorkBoard> = { viewerUid: "me", workspaceId: "a", contextKey: "account-a", reloadSignal: 0 };
  act(() => root.render(<WorkBoard {...props} />));
  await settle();
  expect(host.querySelectorAll("tbody tr .work-name-static")).toHaveLength(2); // 표는 그려졌다
  expect(host.querySelectorAll('.work-table input[type="checkbox"]')).toHaveLength(0);
  expect(host.querySelectorAll("tbody .work-row-handle")).toHaveLength(2);
  act(() => { host.querySelector<HTMLElement>("tbody tr td:nth-child(2)")!.click(); });
  expect(host.querySelector(".work-selbar")).toBeNull();
  expect(host.textContent).not.toContain("삭제");
  expect(manageApi.deleteTask).not.toHaveBeenCalled();
  expect(manageApi.deleteTasksBatch).not.toHaveBeenCalled();
});
