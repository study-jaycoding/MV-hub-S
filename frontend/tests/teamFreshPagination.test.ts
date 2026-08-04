import { beforeEach, describe, expect, it, vi } from "vitest";

const jsonFetch = vi.fn();
vi.mock("../src/lib/http", () => ({
  jsonFetch: (...args: unknown[]) => jsonFetch(...args),
  jsonBody: (value: unknown) => JSON.stringify(value),
}));

import { fetchAllTeamFresh } from "../src/lib/projectApi";

describe("team-fresh 페이지 수집", () => {
  beforeEach(() => jsonFetch.mockReset());

  it("500건 이후 페이지도 커서로 이어 받아 합친다", async () => {
    jsonFetch
      .mockResolvedValueOnce({
        items: [{ id: "new", project_id: "p1", folder_path: null, shared_at: "2026-08-03 12:00:00" }],
        next_cursor: { shared_at: "2026-08-03 12:00:00", id: "new" },
      })
      .mockResolvedValueOnce({
        items: [{ id: "older", project_id: "p1", folder_path: "ep1", shared_at: "2026-08-03 11:00:00" }],
        next_cursor: null,
      });

    const items = await fetchAllTeamFresh("2026-08-01 00:00:00");
    expect(items.map((item) => item.id)).toEqual(["new", "older"]);
    expect(jsonFetch).toHaveBeenCalledTimes(2);
    expect(String(jsonFetch.mock.calls[1][0])).toContain("cursor_shared_at=2026-08-03+12%3A00%3A00");
    expect(String(jsonFetch.mock.calls[1][0])).toContain("cursor_id=new");
  });

  it("구서버처럼 next_cursor가 없으면 첫 페이지로 호환 종료한다", async () => {
    jsonFetch.mockResolvedValueOnce({
      items: [{ id: "legacy", project_id: null, folder_path: null, shared_at: null }],
    });
    const items = await fetchAllTeamFresh("2026-08-01 00:00:00");
    expect(items.map((item) => item.id)).toEqual(["legacy"]);
    expect(jsonFetch).toHaveBeenCalledTimes(1);
  });
});
