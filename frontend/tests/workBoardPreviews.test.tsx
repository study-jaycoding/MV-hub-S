// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkBoard } from "../src/components/manage/WorkBoard";
import { api } from "../src/api";
import { manageApi } from "../src/lib/manageApi";
import type { Task, TaskPreviewResponse, WorkViewProps } from "../src/components/manage/types";

vi.mock("../src/api", () => ({ api: { facets: vi.fn(), projects: vi.fn() } }));
vi.mock("../src/lib/manageApi", () => ({ manageApi: {
  taskProjects: vi.fn(), listTasksBatch: vi.fn(), localTaskPreviews: vi.fn(),
  linkGenerations: vi.fn(), unlinkGeneration: vi.fn(),
} }));
vi.mock("../src/components/manage/TableView", () => ({ TableView: ({ tasks, onLinkGen }: WorkViewProps) =>
  <div>{tasks.map((task) => <article key={task.id}>
    <span>{task.id}:{task.gen_count}:{task.credits}:{task.status}</span>
    {task.cuts?.map((cut) => <div key={cut.id}><span>{cut.preview_state}</span>
      {cut.thumb && <img src={cut.thumb} />}</div>)}
    <button onClick={() => onLinkGen(task.id, "fact:not-content")}>invalid-link</button>
  </article>)}</div>,
}));
let host: HTMLDivElement;
let root: Root;
let props: ComponentProps<typeof WorkBoard>;
function render(patch: Partial<typeof props> = {}) {
  props = { ...props, ...patch };
  act(() => root.render(<WorkBoard {...props} />));
}
async function settle() { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); }
function deferred<T>() { let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function task(workspace = "a", owner = "me"): Task {
  return { id: `task-${workspace}`, project_id: "project", name: "ep", folder_path: "ep/seq",
    workspace_scope: "team", workspace_id: workspace, status: "in_progress", created_at: "2026-09-17",
    gen_count: 1, credits: 3, cuts: [{ id: `fact:${workspace}`, status: "done", creator_uid: owner,
      metadata_only: true, local_gen_id: `local-${workspace}`, credits: 3 }] };
}
function preview(workspace = "a", viewer = "me"): TaskPreviewResponse {
  return { viewer_uid: viewer, items: { [`fact:${workspace}`]: { local_gen_id: `local-${workspace}`,
    thumb: `/preview-${workspace}`, file_path: `/file-${workspace}`, media_type: "image" } } };
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks();
  vi.mocked(api.facets).mockResolvedValue({ auto_tags: [] } as never);
  vi.mocked(manageApi.taskProjects).mockResolvedValue({ projects: [{ id: "project", name: "Project" }] });
  vi.mocked(manageApi.listTasksBatch).mockImplementation(async (_ids, workspace) => ({ project: [task(workspace)] }));
  vi.mocked(manageApi.localTaskPreviews).mockImplementation(async () => preview());
  props = { viewerUid: "me", workspaceId: "a", contextKey: "account-a", reloadSignal: 0 };
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it("renders activity before a delayed local preview and preserves its metrics", async () => {
  const pending = deferred<TaskPreviewResponse>();
  vi.mocked(manageApi.localTaskPreviews).mockReturnValue(pending.promise);
  render(); await settle();
  expect(host.textContent).toContain("task-a:1:3:in_progress");
  expect(host.textContent).toContain("pending");
  expect(host.querySelector("img")).toBeNull();
  pending.resolve(preview()); await settle();
  expect(host.querySelector("img")?.getAttribute("src")).toBe("/preview-a");
  expect(host.textContent).toContain("task-a:1:3:in_progress");
});

it("changing workspace loads immediately and discards a late old preview", async () => {
  const old = deferred<TaskPreviewResponse>();
  vi.mocked(manageApi.localTaskPreviews).mockImplementation(async (_viewer, items) =>
    items[0].workspace_id === "a" ? old.promise : preview("b"));
  render(); await settle(); render({ workspaceId: "b" });
  expect(host.textContent).not.toContain("task-a:");
  await settle();
  expect(host.textContent).toContain("task-b:");
  expect(host.querySelector("img")?.getAttribute("src")).toBe("/preview-b");
  old.resolve(preview("a")); await settle();
  expect(host.querySelector("img")?.getAttribute("src")).toBe("/preview-b");
});

it("account change removes existing previews before the next result arrives", async () => {
  render(); await settle(); expect(host.querySelector("img")).not.toBeNull();
  const next = deferred<Record<string, Task[]>>();
  vi.mocked(manageApi.listTasksBatch).mockReturnValue(next.promise);
  render({ viewerUid: "other", contextKey: "account-b" });
  expect(host.querySelector("img")).toBeNull(); expect(host.querySelector("article")).toBeNull();
  next.resolve({ project: [task("a", "me")] }); await settle();
  expect(host.textContent).toContain("unavailable");
  expect(manageApi.localTaskPreviews).toHaveBeenCalledTimes(1);
});

it("newer activity results win even when an older preview finishes last", async () => {
  const first = deferred<TaskPreviewResponse>();
  vi.mocked(manageApi.localTaskPreviews).mockReturnValueOnce(first.promise).mockResolvedValueOnce({ viewer_uid: "me", items: {} });
  render(); await settle(); render({ reloadSignal: 1 }); await settle();
  expect(host.textContent).toContain("missing");
  first.resolve(preview()); await settle();
  expect(host.querySelector("img")).toBeNull(); expect(host.textContent).toContain("missing");
});

it("preview failure and an unidentified viewer never remove the task", async () => {
  vi.mocked(manageApi.localTaskPreviews).mockRejectedValueOnce(new Error("local preview unavailable"));
  render(); await settle(); expect(host.textContent).toContain("task-a:1:3:in_progress");
  expect(host.textContent).toContain("unavailable");
  render({ viewerUid: null, contextKey: "unknown" }); await settle();
  expect(host.textContent).toContain("task-a:1:3:in_progress");
  expect(manageApi.localTaskPreviews).toHaveBeenCalledTimes(1);
});

it("does not send a fact identifier to content link APIs", async () => {
  render(); await settle();
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent === "invalid-link");
  act(() => button?.click()); await settle();
  expect(manageApi.linkGenerations).not.toHaveBeenCalled();
});
