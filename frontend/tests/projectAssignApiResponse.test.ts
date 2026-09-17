// @vitest-environment jsdom
// Transport-shape contract only; no server or real fetch. Separate from hook feedback regressions.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => { vi.resetModules(); localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

function transport(body: string, status = 200) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe("/api/projects/assign?tab=team");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ generation_ids: ["g1"], project_id: "p", folder_path: "ep/shot", resume_work: true });
    return new Response(body, { status, headers: { "Content-Type": "application/json", "X-MVHub-Mutation-Domains": "" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

it.each([null, {}, [], { ok: true, updated: 1 }])("current API passes JSON shape %j without inventing a success count", async (value) => {
  const fetchMock = transport(JSON.stringify(value));
  const { projectApi } = await import("../src/lib/projectApi");
  await expect(projectApi.assignProject(["g1"], "p", "team", "ep/shot", true)).resolves.toEqual(value);
  expect(fetchMock).toHaveBeenCalledOnce();
});

it.each([400, 502])("HTTP %s is still rejected before the hook's unknown-result path", async (status) => {
  const fetchMock = transport(JSON.stringify({ detail: "SYNTHETIC_FAILURE" }), status);
  const { projectApi } = await import("../src/lib/projectApi");
  const { HttpError } = await import("../src/lib/http");
  const request = projectApi.assignProject(["g1"], "p", "team", "ep/shot", true);
  await expect(request).rejects.toBeInstanceOf(HttpError);
  await expect(request).rejects.toMatchObject({ status });
  expect(fetchMock).toHaveBeenCalledOnce();
});

it("non-JSON local HTTP success remains a parse rejection, not a resolved null ACK", async () => {
  const fetchMock = transport("not JSON");
  const { projectApi } = await import("../src/lib/projectApi");
  await expect(projectApi.assignProject(["g1"], "p", "team", "ep/shot", true)).rejects.toBeInstanceOf(SyntaxError);
  expect(fetchMock).toHaveBeenCalledOnce();
});
