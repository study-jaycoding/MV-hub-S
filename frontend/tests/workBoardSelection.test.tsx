// @vitest-environment jsdom
// 작업표의 일괄 삭제는 보이는 것에만 걸린다(조작 규칙 42).
// 2026-10-12(조작 점검 15회차, Codex 전수 검토): 선택은 id 집합이고 보기·공간이 바뀔 때만 비웠다 — 고른 뒤 검색·필터로 가려진 작업이
//  선택에 남아, 보이는 것만 지우려던 [삭제]에 같이 지워졌다. 다시 읽어 없어진 작업이 남으면 삭제 자체가 "목록이 변경되었습니다"로 막혔다.
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkBoard } from "../src/components/manage/WorkBoard";
import { api } from "../src/api";
import { manageApi } from "../src/lib/manageApi";
import type { Task } from "../src/components/manage/types";

vi.mock("../src/api", () => ({ api: { facets: vi.fn(), projects: vi.fn() } }));
vi.mock("../src/lib/manageApi", () => ({ manageApi: {
  taskProjects: vi.fn(), listTasksBatch: vi.fn(), localTaskPreviews: vi.fn(), updateTask: vi.fn(), deleteTasksBatch: vi.fn(),
} }));

let host: HTMLDivElement;
let root: Root;
let props: ComponentProps<typeof WorkBoard>;
let rows: Task[];
function render(patch: Partial<typeof props> = {}) {
  props = { ...props, ...patch };
  act(() => root.render(<WorkBoard {...props} />));
}
async function settle() { await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); }); }
const task = (name: string): Task => ({ id: `task-${name}`, project_id: "project", name, folder_path: `${name}/seq`, description: "",
  workspace_scope: "team", workspace_id: "a", status: "in_progress", created_at: "2026-09-17", gen_count: 0, credits: 0, cuts: [] });
const rowChecks = () => [...host.querySelectorAll<HTMLInputElement>('tbody .work-sel-col input[type="checkbox"]')];
const check = (index: number) => act(() => { rowChecks()[index].click(); });
const search = (value: string) => act(() => {
  const input = host.querySelector<HTMLInputElement>(".work-search input")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const count = () => host.querySelector(".work-selbar-count")?.textContent ?? null;
const pressDelete = async () => { await act(async () => { host.querySelector<HTMLButtonElement>(".work-selbar-btn.danger")!.click(); }); await settle(); };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks();
  vi.spyOn(window, "alert").mockImplementation(() => {});
  vi.spyOn(window, "confirm").mockReturnValue(true);
  rows = [task("alpha"), task("beta"), task("gamma")];
  vi.mocked(api.facets).mockResolvedValue({ auto_tags: [] } as never);
  vi.mocked(manageApi.taskProjects).mockResolvedValue({ projects: [{ id: "project", name: "Project" }] });
  vi.mocked(manageApi.listTasksBatch).mockImplementation(async () => ({ project: rows }));
  vi.mocked(manageApi.localTaskPreviews).mockResolvedValue({ viewer_uid: "me", items: {} });
  vi.mocked(manageApi.deleteTasksBatch).mockResolvedValue({ ok: true } as never);
  props = { viewerUid: "me", workspaceId: "a", contextKey: "account-a", reloadSignal: 0 };
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it("고른 뒤 검색으로 가려진 작업은 선택에서 빠진다 — [삭제]는 보이는 것만 보낸다", async () => {
  render(); await settle();
  expect(rowChecks()).toHaveLength(3);
  check(0); check(1); // alpha·beta
  expect(count()).toBe("2개 선택");
  search("beta"); // alpha 가 가려진다
  expect(rowChecks()).toHaveLength(1);
  expect(count()).toBe("1개 선택"); // 전엔 '2개 선택' 그대로였다
  await pressDelete();
  expect(window.confirm).toHaveBeenCalledWith("선택한 작업 1개를 삭제할까요?");
  expect(manageApi.deleteTasksBatch).toHaveBeenCalledExactlyOnceWith(["task-beta"]); // 전엔 보이지 않는 alpha 도 지워졌다
});

it("다시 읽어 없어진 작업은 선택에서 빠진다 — 남은 것의 삭제가 '목록이 변경되었습니다'로 막히지 않는다", async () => {
  render(); await settle();
  check(0); check(2); // alpha·gamma
  rows = [task("beta"), task("gamma")]; // 다른 창에서 alpha 를 지웠다(또는 앞 묶음만 성공한 삭제 뒤의 복구 조회)
  render({ reloadSignal: 1 }); await settle();
  expect(count()).toBe("1개 선택");
  await pressDelete();
  expect(window.alert).not.toHaveBeenCalled(); // 전엔 없어진 alpha 가 남아 삭제 전체가 막혔다
  expect(manageApi.deleteTasksBatch).toHaveBeenCalledExactlyOnceWith(["task-gamma"]);
});
