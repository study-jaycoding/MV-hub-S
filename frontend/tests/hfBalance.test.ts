import { beforeEach, expect, it, vi } from "vitest";
import { getBalanceLedger, getBalances } from "../src/lib/hfBalance";
import { HttpError } from "../src/lib/http";

const http = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/http", async (original) => ({ ...await original<typeof import('../src/lib/http')>(), jsonFetch: http }));
beforeEach(() => { http.mockReset(); });

it("passes workspace, period and an opaque cursor without modifying balances", async () => {
  const data = { balances: [{ workspace_id: "a/b", credits_c: null, basis: "unavailable" }] };
  http.mockResolvedValue(data);
  expect(await getBalances("a/b")).toBe(data);
  expect(http.mock.calls[0][0]).toBe("/api/manage/balances?workspace_id=a%2Fb");
  await getBalanceLedger("a/b", "2026-11-01", "2026-12-01", "opaque+/=");
  const url = new URL(http.mock.calls[1][0], "http://localhost");
  expect(Object.fromEntries(url.searchParams)).toEqual({ workspace_id: "a/b", start: "2026-11-01", end: "2026-12-01", limit: "500", cursor: "opaque+/=" });
});

it("marks an old server as unsupported without manufacturing a balance", async () => {
  const unsupported = new HttpError(404, "unsupported");
  http.mockRejectedValue(unsupported);
  await expect(getBalances()).rejects.toBe(unsupported);
  await expect(getBalanceLedger("ws", "2026-11-01", "2026-12-01")).rejects.toBe(unsupported);
});
