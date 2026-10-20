import { describe, expect, it } from "vitest";
import { canFinishDraft, isDraftGeneration, normalizeSeedanceDraftParams } from "../src/lib/seedanceDraft";

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
