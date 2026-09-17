import { describe, expect, it } from "vitest";
import { applyTaskPreviews, cutHasPreview, cutLocalId, prepareTaskPreviews, taskPreviewCandidates } from "../src/components/manage/taskPreviews";
import { scopeTaskToCreator, taskModelUsage } from "../src/components/manage/personalWork";
import { creatorCalendarRows } from "../src/components/manage/CalendarView";
import type { Cut, Task, TaskPreviewResponse } from "../src/components/manage/types";

function cut(patch: Partial<Cut> = {}): Cut {
  return { id: "fact:one", metadata_only: true, local_gen_id: "local-one", job_id: "job-one",
    creator_uid: "me", creator_name: "제이", status: "done", created_at: "2026-09-17T01:00:00Z",
    credits: 2, elapsed: 30, model: "model-one", ...patch };
}
function task(patch: Partial<Task> = {}): Task {
  return { id: "task-one", project_id: "project", name: "ep01", sequence: "seq01",
    folder_path: "ep01/seq01", workspace_scope: "team", workspace_id: "workspace",
    status: "in_progress", created_at: "2026-09-17", gen_count: 1, credits: 2,
    cuts: [cut()], ...patch };
}
function response(patch: Partial<TaskPreviewResponse> = {}): TaskPreviewResponse {
  return { viewer_uid: "me", items: { "fact:one": { local_gen_id: "verified-local",
    thumb: "/local-thumb", file_path: "/local-file", media_type: "image" } }, ...patch };
}

describe("local task preview boundary", () => {
  it("only requests identified self metadata in an exact team folder", () => {
    const source = task({ cuts: [cut(), cut({ id: "shared", metadata_only: false }),
      cut({ id: "fact:other", creator_uid: "other" }),
      cut({ id: "fact:unknown", local_gen_id: undefined, job_id: undefined })] });
    expect(taskPreviewCandidates([source], "me").map((item) => item.id)).toEqual(["fact:one"]);
    expect(taskPreviewCandidates([source], null)).toEqual([]);
    for (const invalid of [{ workspace_scope: "personal" }, { workspace_id: null },
      { folder_path: null }, { project_id: "" }]) {
      expect(taskPreviewCandidates([task(invalid)], "me")).toEqual([]);
    }
  });

  it("does not guess a local match for conflicting locations of the same activity", () => {
    expect(taskPreviewCandidates([task(), task({ folder_path: "ep02/seq02" })], "me")).toEqual([]);
    expect(taskPreviewCandidates([task(), task()], "me")).toHaveLength(1);
  });

  it("strips media on metadata rows before checking locally", () => {
    const source = task({ cuts: [cut({ thumb: "unexpected-server-media", file_path: "server-original",
      preview_state: "ready" }), cut({ id: "fact:other", creator_uid: "other", thumb: "private" })] });
    const prepared = prepareTaskPreviews([source], "me")[0];
    expect(prepared.cuts?.map((item) => [item.thumb, item.file_path, item.preview_state])).toEqual([
      [null, null, "pending"], [null, null, "unavailable"],
    ]);
    expect(source.cuts?.[0].thumb).toBe("unexpected-server-media");
  });

  it("enriches only media without replacing the server activity identity or metrics", () => {
    const prepared = prepareTaskPreviews([task()], "me");
    const out = applyTaskPreviews(prepared, "me", taskPreviewCandidates(prepared, "me"), response());
    expect(out[0]).toMatchObject({ gen_count: 1, credits: 2, status: "in_progress" });
    expect(out[0].cuts?.[0]).toMatchObject({ id: "fact:one", local_gen_id: "verified-local",
      thumb: "/local-thumb", preview_state: "ready", credits: 2, elapsed: 30, creator_uid: "me" });
    expect(cutLocalId(out[0].cuts![0])).toBe("verified-local");
  });

  it("rejects a different viewer, out-of-request media, and mutated location", () => {
    const prepared = prepareTaskPreviews([task()], "me");
    const candidates = taskPreviewCandidates(prepared, "me");
    const wrong = applyTaskPreviews(prepared, "me", candidates, response({ viewer_uid: "other" }));
    expect(wrong[0].cuts?.[0]).toMatchObject({ thumb: null, preview_state: "unavailable" });
    expect(applyTaskPreviews(prepared, "me", [], response())[0].cuts?.[0].thumb).toBeNull();
    const moved = [{ ...prepared[0], folder_path: "other" }];
    expect(applyTaskPreviews(moved, "me", candidates, response())[0].cuts?.[0].thumb).toBeNull();
  });

  it("keeps activity when a local original is missing or the preview request fails", () => {
    const prepared = prepareTaskPreviews([task()], "me");
    const candidates = taskPreviewCandidates(prepared, "me");
    for (const [payload, state] of [[response({ items: {} }), "missing"], [null, "unavailable"]] as const) {
      const out = applyTaskPreviews(prepared, "me", candidates, payload);
      expect(out[0]).toMatchObject({ id: "task-one", gen_count: 1, credits: 2 });
      expect(out[0].cuts?.[0].preview_state).toBe(state);
      expect(cutHasPreview(out[0].cuts![0])).toBe(false);
    }
  });

  it("never uses a fact id or an unverified local hint for local mutations", () => {
    expect(cutLocalId(cut())).toBeUndefined();
    expect(cutLocalId(cut({ metadata_only: false }))).toBeUndefined();
    expect(cutLocalId(cut({ preview_state: "ready", local_gen_id: "fact:invalid" }))).toBeUndefined();
    expect(cutLocalId(cut({ id: "content", metadata_only: false }))).toBe("content");
  });

  it("counts private activity in mine-only, model summaries, and creator calendar without media", () => {
    const source = task({ cuts: [cut(), cut({ id: "fact:other", creator_uid: "other", credits: 7 })] });
    const mine = scopeTaskToCreator(source, "me")!;
    expect(mine).toMatchObject({ gen_count: 1, credits: 2, elapsed: 30, status: "in_progress" });
    expect(taskModelUsage(mine)[0]).toMatchObject({ model: "model-one", count: 1, credits: 2 });
    expect(creatorCalendarRows([mine], 2026, 8)[0]).toMatchObject({ key: "me", total: 1 });
  });
});
