// @vitest-environment jsdom
// 작업표 — 재조회가 실패해도 받은 표를 걷지 않는다(띠로 알림). 실제 TableView 를 붙여 치던 설명 글이 남는지까지 본다.
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkBoard } from "../src/components/manage/WorkBoard";
import { api } from "../src/api";
import { manageApi } from "../src/lib/manageApi";
import { HttpError } from "../src/lib/http";
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

it("설명 저장이 실패하고 복구 조회까지 실패해도 친 글과 '저장 안 됨'이 남는다 — 서버가 돌아오면 [다시 저장]으로 저장되고, 목록도 다시 받아 띠가 걷힌다", async () => {
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
  // 서버는 저장된 글을 돌려준다 — 저장 뒤의 재조회가 옛 글을 돌려주는 일은 없다(그러면 칸이 옛 글로 돌아간다: 아래 재조회 단언의 전제)
  vi.mocked(manageApi.listTasksBatch).mockImplementation(async (_ids, workspace) => ({ project: [{ ...task(workspace), description: "저장할 글" }] }));
  const loads = vi.mocked(manageApi.taskProjects).mock.calls.length;
  await act(async () => { host.querySelector<HTMLButtonElement>(".work-desc .work-desc-retry")!.click(); });
  await settle();
  expect(manageApi.updateTask).toHaveBeenCalledTimes(2);
  // 편집을 시작할 때의 설명(기준)을 같이 보낸다 — 그사이 남이 바꿨으면 서버가 거절한다(50회차)
  expect(manageApi.updateTask).toHaveBeenLastCalledWith("task-a", { description: "저장할 글", expected_description: "원래 설명" });
  expect(host.querySelector(".work-desc .work-desc-chip")).toBeNull();
  expect(input().value).toBe("저장할 글");
  // 저장이 통했으면 서버는 돌아온 것 — 목록을 다시 받아(띠만 지운 것이 아니다) "목록을 새로 받지 못했습니다" 띠를 걷는다(28회차).
  expect(manageApi.taskProjects).toHaveBeenCalledTimes(loads + 1);
  expect(banner()).toBeNull();
});

// 50회차(Codex 검토): 두 사람이 같은 설명을 고치면 나중에 확정한 옛 초안이 먼저 저장된 글을 덮었다.
it("설명을 고치는 사이 남이 먼저 저장했으면(409) 내 글은 '저장 안 됨'으로 남고 안내한다 — [다시 저장]은 최신 글을 기준으로 보낸다(일부러 덮기)", async () => {
  render(); await settle();
  const conflict = new HttpError(409, "conflict", JSON.stringify({ kind: "task_edit_conflict", field: "description", latest: "남이 쓴 글" }));
  vi.mocked(manageApi.updateTask).mockRejectedValueOnce(conflict);
  act(() => input().focus());
  type("내 초안");
  act(() => input().blur());
  await settle();
  expect(manageApi.updateTask).toHaveBeenLastCalledWith("task-a", { description: "내 초안", expected_description: "원래 설명" });
  expect(window.alert).toHaveBeenLastCalledWith(expect.stringContaining("그사이 다른 사람이 설명을 바꿨습니다"));
  expect(input().value).toBe("내 초안");
  expect(host.querySelector(".work-desc-chip")).not.toBeNull();
  vi.mocked(manageApi.updateTask).mockResolvedValueOnce({} as never);
  await act(async () => { host.querySelector<HTMLButtonElement>(".work-desc .work-desc-retry")!.click(); });
  await settle();
  expect(manageApi.updateTask).toHaveBeenLastCalledWith("task-a", { description: "내 초안", expected_description: "남이 쓴 글" });
});

it("앞 저장이 가는 중에 이어 쳐서 다시 저장하면, 앞 저장이 성공했을 때 그 글을 기준으로 보낸다 — 엉뚱한 충돌이 나지 않게(50회차)", async () => {
  render(); await settle();
  let release!: () => void;
  vi.mocked(manageApi.updateTask).mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({} as never); }));
  act(() => input().focus()); type("첫 글"); act(() => input().blur());
  await settle();
  act(() => input().focus()); type("첫 글 더"); act(() => input().blur()); // 앞 저장이 아직 가는 중
  await settle();
  release();
  await settle(); await settle();
  const calls = vi.mocked(manageApi.updateTask).mock.calls.map((call) => call[1]);
  expect(calls).toEqual([{ description: "첫 글", expected_description: "원래 설명" }, { description: "첫 글 더", expected_description: "첫 글" }]);
});

// Codex 검토(P1): 앞 저장이 남의 변경과 충돌했는데 뒤 저장이 기준 없이 나가 안내 전에 남의 글을 덮었다.
it("앞 저장이 충돌(409)로 막히면 그 뒤에 줄 선 저장도 원래 기준으로 나가 막힌다 — 안내 전에 남의 글을 덮지 않는다(50회차)", async () => {
  render(); await settle();
  let reject!: (error: unknown) => void;
  vi.mocked(manageApi.updateTask).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  act(() => input().focus()); type("첫 글"); act(() => input().blur());
  await settle();
  act(() => input().focus()); type("첫 글 더"); act(() => input().blur()); // 앞 저장이 아직 가는 중
  await settle();
  const conflict = new HttpError(409, "conflict", JSON.stringify({ kind: "task_edit_conflict", field: "description", latest: "남이 쓴 글" }));
  vi.mocked(manageApi.updateTask).mockRejectedValueOnce(conflict); // 서버는 뒤 저장도 거절한다(기준이 맞지 않으니)
  reject(conflict);
  await settle(); await settle(); await settle();
  const calls = vi.mocked(manageApi.updateTask).mock.calls.map((call) => call[1]);
  expect(calls[1]).toEqual({ description: "첫 글 더", expected_description: "원래 설명" }); // 앞 저장이 실패했다 — 기준을 그 글로 잇지 않는다
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

// 7회차(R29): 저장 결과는 줄(queue)의 끝에서 알렸는데, 줄의 끝은 실패 뒤의 복구 조회까지 기다린다 — '저장 안 됨'이 조회가 끝나야 붙었다.
it("'저장 안 됨'은 복구 조회가 끝나기를 기다리지 않고 붙는다 — 조회가 매달려도 바로 뜨고, 그사이 누른 [다시 저장]은 복구가 끝난 뒤에 나간다", async () => {
  render(); await settle();
  let release: () => void = () => {};
  vi.mocked(manageApi.updateTask).mockRejectedValueOnce(new Error("500: boom"));
  vi.mocked(manageApi.taskProjects).mockImplementationOnce(() => new Promise((resolve) => {
    release = () => resolve({ projects: [{ id: "project", name: "Project" }] }); // 복구 조회가 응답 없이 매달린다
  }));
  act(() => input().focus());
  type("못 간 글");
  act(() => input().blur());
  await settle();
  expect(window.alert).toHaveBeenCalled(); // 복구는 시작됐다(조회는 아직 안 끝났다)
  expect(manageApi.taskProjects).toHaveBeenCalledTimes(2);
  expect(host.querySelector(".work-desc-chip")).not.toBeNull();
  expect(input().value).toBe("못 간 글");
  // 같은 작업의 저장 줄은 그대로다 — 복구 조회가 끝나기 전에 누른 [다시 저장]은 줄에서 기다린다
  vi.mocked(manageApi.updateTask).mockResolvedValueOnce({} as never);
  await act(async () => { host.querySelector<HTMLButtonElement>(".work-desc .work-desc-retry")!.click(); });
  await settle();
  expect(manageApi.updateTask).toHaveBeenCalledTimes(1);
  expect(host.querySelector(".work-desc-chip")).not.toBeNull(); // 기다리는 동안에도 표시는 남는다
  await act(async () => { release(); });
  await settle();
  expect(manageApi.updateTask).toHaveBeenCalledTimes(2);
  expect(manageApi.updateTask).toHaveBeenLastCalledWith("task-a", { description: "못 간 글", expected_description: "원래 설명" }); // 앞 저장은 실패했다 — 원래 기준 그대로
  expect(host.querySelector(".work-desc-chip")).toBeNull();
  expect(input().value).toBe("못 간 글");
});

// 7회차 Codex 코드 리뷰(P2): 실패를 일찍 알리면서 '가는 중'(flying)까지 일찍 풀면, 복구 도중 도착한 옛 목록(저장 전에 떠난 조회)이
// 목록 값에 대한 믿음(DescCell ④)을 되살린다 — 그 값으로 되돌린 글을 안 보내, 저장이 실은 서버에 반영됐으면 마지막에 친 글이 사라진다.
const cells = () => [...host.querySelectorAll<HTMLInputElement>("input.work-cell-in[placeholder]")];
const typeIn = (cell: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(cell, value);
  cell.dispatchEvent(new Event("input", { bubbles: true }));
});
const leave = (cell: HTMLInputElement, value: string) => { act(() => cell.focus()); typeIn(cell, value); act(() => cell.blur()); };
const sentTexts = () => vi.mocked(manageApi.updateTask).mock.calls.map(([, patch]) => patch.description);
// 다음 목록 조회를 붙잡아 둔다 — 돌려받은 함수로 원하는 내용을 도착시킨다
function holdList() {
  let arrive: (rows: Task[]) => void = () => {};
  vi.mocked(manageApi.listTasksBatch).mockImplementationOnce(() => new Promise((resolve) => { arrive = (rows) => resolve({ project: rows }); }));
  return (rows: Task[]) => act(async () => { arrive(rows); });
}

it.each<[string, () => void]>([
  ["본 줄에서 되돌린다", () => leave(cells()[0], "원래 설명")],
  ["상세 줄(같은 작업의 다른 칸)에서 되돌린다", () => leave(cells()[1], "원래 설명")],
  ["Esc 로 버린 뒤 고쳤다가 되돌린다", () => {
    act(() => cells()[0].focus());
    act(() => { cells()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    act(() => cells()[0].focus());
    typeIn(cells()[0], "잠깐");
    typeIn(cells()[0], "원래 설명");
    act(() => cells()[0].blur());
  }],
])("실패한 저장의 복구 도중 옛 목록이 같은 설명·다른 객체로 와도, 원래 값으로 되돌린 글을 보낸다 — %s", async (_name, revert) => {
  render(); await settle();
  act(() => { host.querySelector<HTMLElement>("[aria-controls]")!.click(); }); // 상세 줄을 편다 — 설명 칸이 둘
  const oldList = holdList(); // 저장 전에 떠난 조회 — 늦게 온다
  const followUp = holdList(); // 그 뒤의 후속 조회
  render({ reloadSignal: 1 }); await settle();
  vi.mocked(manageApi.updateTask).mockRejectedValueOnce(new Error("500: boom")); // 서버에는 반영됐는데 응답은 실패로 왔다
  leave(cells()[0], "A");
  await settle();
  await oldList([{ ...task(), comment_count: 3 }]); // 복구 도중 도착: 설명은 저장 전 값 그대로, 줄 객체는 바뀐다
  await settle();
  revert(); // 후속 조회가 끝나기 전에 원래 값으로
  await settle();
  await followUp([{ ...task(), description: "A", comment_count: 3 }]); // 후속 조회는 서버에 반영된 A 를 가져온다
  await settle();
  expect(sentTexts()).toEqual(["A", "원래 설명"]); // 안 보내면 화면·서버가 A 로 남는다(마지막에 친 글이 사라진다)
  expect(cells().map((cell) => cell.value)).toEqual(["원래 설명", "원래 설명"]);
  expect(host.querySelector(".work-desc-chip")).toBeNull();
});

it("복구 조회가 끝나기 전에 원래 값으로 되돌려 벗어나면 그 글을 보낸다 — 복구 목록이 같은 설명을 새 객체로 가져와도", async () => {
  render(); await settle();
  const recoveryList = holdList();
  vi.mocked(manageApi.updateTask).mockRejectedValueOnce(new Error("500: boom"));
  leave(input(), "A");
  await settle();
  leave(input(), "원래 설명"); // 복구 조회가 아직 안 끝났다 — 줄에서 기다린다
  await settle();
  expect(sentTexts()).toEqual(["A"]);
  await recoveryList([{ ...task(), comment_count: 3 }]);
  await settle();
  expect(sentTexts()).toEqual(["A", "원래 설명"]);
  expect(input().value).toBe("원래 설명");
  expect(host.querySelector(".work-desc-chip")).toBeNull();
});

it("복구가 끝나 목록이 새로 온 뒤에는 다시 목록 값을 믿는다 — 원래 값으로 되돌린 글은 보내지 않고 표시만 걷는다(보호는 줄의 끝에서 풀린다)", async () => {
  render(); await settle();
  vi.mocked(manageApi.updateTask).mockRejectedValueOnce(new Error("500: boom"));
  vi.mocked(manageApi.listTasksBatch).mockImplementationOnce(async () => ({ project: [{ ...task(), comment_count: 3 }] })); // 복구 목록: 같은 설명, 다른 객체
  leave(input(), "A");
  await settle();
  expect(host.querySelector(".work-desc-chip")).not.toBeNull();
  leave(input(), "원래 설명");
  await settle();
  expect(sentTexts()).toEqual(["A"]); // 고쳤다가 서버 값으로 되돌린 글은 보내지 않는다(남의 변경을 되돌리지 않게 — 전과 같다)
  expect(host.querySelector(".work-desc-chip")).toBeNull();
  expect(input().value).toBe("원래 설명");
});

it("설명이 아닌 칸(마감일)의 실패한 저장은 설명의 '가는 중'으로 세지 않는다 — 그 복구 도중에 새로 온 목록의 설명 값은 전처럼 믿는다", async () => {
  render(); await settle();
  // 설명 저장이 실패하고 복구 목록은 그대로 온다(줄 객체가 안 바뀐다) — 목록 값을 못 믿는 채로 남는다
  vi.mocked(manageApi.updateTask).mockRejectedValueOnce(new Error("500: boom"));
  leave(input(), "A");
  await settle();
  expect(host.querySelector(".work-desc-chip")).not.toBeNull();
  // 같은 작업의 마감일 저장이 실패하고, 그 복구 조회가 매달린다
  let release: () => void = () => {};
  vi.mocked(manageApi.updateTask).mockRejectedValueOnce(new Error("500: boom"));
  vi.mocked(manageApi.taskProjects).mockImplementationOnce(() => new Promise((resolve) => {
    release = () => resolve({ projects: [{ id: "project", name: "Project" }] });
  }));
  typeIn(host.querySelector<HTMLInputElement>('input.work-cell-in[type="date"]')!, "2026-10-20");
  await settle();
  // 그사이 다른 신호로 목록이 새로 온다(같은 설명, 다른 객체) — 설명 저장은 가는 중이 아니니 다시 믿는다
  vi.mocked(manageApi.listTasksBatch).mockImplementationOnce(async () => ({ project: [{ ...task(), comment_count: 3 }] }));
  render({ reloadSignal: 1 }); await settle();
  leave(input(), "원래 설명");
  await settle();
  expect(host.querySelector(".work-desc-chip")).toBeNull(); // 목록 값과 같은 글 — 보내지 않고 표시를 걷는다
  await act(async () => { release(); });
  await settle();
  expect(sentTexts()).toEqual(["A", undefined]); // 설명 A, 마감일 — 되돌린 설명은 나가지 않았다
  expect(input().value).toBe("원래 설명");
});

it("복구 도중 범위를 바꿔도 '가는 중'은 센 보관함에서 뺀다 — 새 범위에서 보낸 같은 작업의 저장이 보호를 잃지 않는다", async () => {
  render(); await settle();
  // 공간 a: 설명 저장이 실패하고 복구 조회가 매달린다
  let release: () => void = () => {};
  vi.mocked(manageApi.updateTask).mockRejectedValueOnce(new Error("500: boom"));
  vi.mocked(manageApi.taskProjects).mockImplementationOnce(() => new Promise((resolve) => {
    release = () => resolve({ projects: [{ id: "project", name: "Project" }] });
  }));
  leave(input(), "A");
  await settle();
  // 다른 범위로 간다 — 같은 작업이 그 범위에도 있다(개인 범위가 공간의 작업을 품는 경우)
  vi.mocked(manageApi.listTasksBatch).mockImplementation(async () => ({ project: [task()] }));
  render({ workspaceId: "b" }); await settle();
  expect(input().value).toBe("원래 설명");
  let answer: () => void = () => {};
  vi.mocked(manageApi.updateTask).mockImplementationOnce(() => new Promise((resolve) => { answer = () => resolve({} as never); }));
  leave(input(), "새 글"); // 새 범위에서 보낸 저장 — 앞 범위의 복구 뒤에 줄 서 있다
  await settle();
  await act(async () => { release(); }); // 앞 범위의 복구가 끝난다 → '새 글' 이 나가 응답을 기다린다
  await settle();
  expect(sentTexts()).toEqual(["A", "새 글"]);
  // 목록이 새 객체로 온다 — '새 글' 이 가는 중이니 그 값을 믿으면 안 된다
  vi.mocked(manageApi.listTasksBatch).mockImplementationOnce(async () => ({ project: [{ ...task(), comment_count: 3 }] }));
  render({ reloadSignal: 1 }); await settle();
  leave(input(), "원래 설명"); // 마음을 바꿔 원래 값으로
  await settle();
  await act(async () => { answer(); });
  await settle();
  expect(sentTexts()).toEqual(["A", "새 글", "원래 설명"]); // 안 보내면 서버·화면이 '새 글' 로 남는다
  expect(input().value).toBe("원래 설명");
});
