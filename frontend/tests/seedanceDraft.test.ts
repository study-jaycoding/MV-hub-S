import { describe, expect, it } from "vitest";
import { canFinishDraft, isDraftGeneration, normalizeSeedanceDraftParams, summarizeDraftChildren, isExpiredDraftChild } from "../src/lib/seedanceDraft";

describe("Seedance Draft", () => {
  const draft = { model: "seedance_2_5", status: "done", params: { draft: true }, job_id: "remote-job", is_mine: true };
  it("requires a completed recorded Draft, never resolution alone", () => {
    expect(isDraftGeneration(draft)).toBe(true);
    expect(isDraftGeneration({ ...draft, status: "running" })).toBe(false);
    expect(isDraftGeneration({ ...draft, params: { resolution: "480p" } })).toBe(false);
    expect(isDraftGeneration({ ...draft, params: { draft: true, draft_job_id: "parent-job" } })).toBe(false);
  });
  it("requires ownership and a remote job for finishing", () => {
    expect(canFinishDraft(draft)).toBe(true);
    expect(canFinishDraft({ ...draft, job_id: null })).toBe(false);
    expect(canFinishDraft({ ...draft, is_mine: false })).toBe(false);
    expect(canFinishDraft({ ...draft, deleted: true })).toBe(false);
  });
  it("derives fresh Draft mode and strips remote IDs from copied options", () => {
    const original = { resolution: "480p", draft_job_id: "remote-job", seed: 23 };
    expect(normalizeSeedanceDraftParams("seedance_2_5", original)).toEqual({ resolution: "480p", seed: 23, draft: true });
    expect(original.draft_job_id).toBe("remote-job");
    expect(normalizeSeedanceDraftParams("seedance_2_5", { resolution: "1080p", draft: true })).toEqual({ resolution: "1080p" });
    expect(normalizeSeedanceDraftParams("other", { draft: true, draft_job_id: "job" })).toEqual({});
  });
});


it("history 집계는 현재 원격 job·화질·삭제·중복·실행 단계를 구분한다", () => {
  const base = { id: "a", model: "seedance_2_5", status: "done", params: { draft_job_id: "today" } };
  const summary = summarizeDraftChildren("today", [base, base,
    { ...base, id: "4k", params: { draft_job_id: "today", resolution: "4k" } },
    { ...base, id: "pending", execution_phase: "recovery_required" },
    { ...base, id: "deleted", deleted: true },
    { ...base, id: "failed", status: "failed" },
    { ...base, id: "old", status: "failed", params: { draft_job_id: "old" }, error: "CLI 실패: Error: Seedance 2.5 draft has expired" },
  ]);
  expect(summary).toEqual({ done: { "1080p": 1, "4k": 1 }, pending: { "1080p": true, "4k": false }, expired: false });
  expect(summarizeDraftChildren("today", [{ ...base, status: "running", execution_phase: "recovery_required",
    error: "제출 확인 필요\n제출 진단: CLI 실패: Error: Seedance 2.5 draft has expired — cmd: generate create" }]).expired).toBe(true);
  expect(isExpiredDraftChild({ ...base, status: "failed", execution_phase: "tracking", error: "Seedance 2.5 draft has expired" })).toBe(false);
});
