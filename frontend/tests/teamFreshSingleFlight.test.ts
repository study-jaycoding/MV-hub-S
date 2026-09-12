import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAllTeamFresh } from "../src/lib/projectApi";

// 사이드바 "+N" 배지의 원천 — 기준선 이후 60일치 공유 **전체**를 500건씩 순차로 읽는다.
// ★왜 이 시험이 있나(2026-09-12 실측): 한 페이지가 413건·85.7KB 였고, 팀 탭의 15초 폴이
//  갱신을 계속 일으킨다. 종전 구현은 갱신마다 앞 실행을 무효로 만들어 **완독 전에 폐기**했다 —
//  전체 조회가 15초보다 길면 배지가 영영 갱신되지 않는다. 지금은 같은 기준선이면 합류한다.

function okResponse(result: unknown): Pick<Response, "ok" | "json"> {
  return { ok: true, json: vi.fn().mockResolvedValue(result) };
}

function page(ids: string[], next: { shared_at: string; id: string } | null) {
  return okResponse({
    items: ids.map((id) => ({ id, project_id: "p1", folder_path: "e/c", shared_at: "2026-09-09", ack_key: id })),
    next_cursor: next,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("team-fresh 전체 조회", () => {
  it("두 번 겹쳐 불러도 한 벌만 왕복하고 같은 결과를 준다", async () => {
    let resolvePage: ((value: unknown) => void) | null = null;
    const fetchMock = vi.fn().mockImplementation(
      () => new Promise((resolve) => { resolvePage = resolve; }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = fetchAllTeamFresh("2026-07-14T00:00:00Z");
    const second = fetchAllTeamFresh("2026-07-14T00:00:00Z"); // 응답 전에 또 부른다
    expect(fetchMock).toHaveBeenCalledTimes(1); // ★합류 — 새로 시작하지 않는다

    resolvePage!(page(["a", "b"], null));
    expect(await first).toEqual(await second);
    expect((await first).map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("페이지를 끝까지 읽는다 — 도중에 새 요청이 와도 중단하지 않는다", async () => {
    const resolvers: ((value: unknown) => void)[] = [];
    const fetchMock = vi.fn().mockImplementation(
      () => new Promise((resolve) => { resolvers.push(resolve); }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const run = fetchAllTeamFresh("2026-07-14T00:00:00Z");
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    resolvers[0](page(["a"], { shared_at: "2026-09-08", id: "a" }));

    fetchAllTeamFresh("2026-07-14T00:00:00Z"); // 1페이지를 읽는 사이 새 갱신 요청
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1](page(["b"], null));

    expect((await run).map((item) => item.id)).toEqual(["a", "b"]); // ★완독
    expect(fetchMock).toHaveBeenCalledTimes(2); // 페이지 수만큼만
  });

  it("기준선이 다르면 따로 조회한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(page(["a"], null));
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([
      fetchAllTeamFresh("2026-07-14T00:00:00Z"),
      fetchAllTeamFresh("2026-08-01T00:00:00Z"),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("끝난 뒤의 다음 갱신은 새로 조회한다 — 오래된 결과를 영구히 물고 있지 않는다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(page(["a"], null));
    vi.stubGlobal("fetch", fetchMock);

    await fetchAllTeamFresh("2026-07-14T00:00:00Z");
    await fetchAllTeamFresh("2026-07-14T00:00:00Z");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("실패해도 붙잡아 두지 않는다 — 다음 갱신이 다시 시도할 수 있어야 한다", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("네트워크 끊김"))
      .mockResolvedValue(page(["a"], null));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAllTeamFresh("2026-07-14T00:00:00Z")).rejects.toThrow();
    expect((await fetchAllTeamFresh("2026-07-14T00:00:00Z")).map((i) => i.id)).toEqual(["a"]);
  });

  it("같은 커서가 되돌아오면 무한 루프 대신 실패한다(기존 계약)", async () => {
    const repeat = { shared_at: "2026-09-08", id: "a" };
    const fetchMock = vi.fn().mockResolvedValue(page(["a"], repeat));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAllTeamFresh("2026-07-14T00:00:00Z")).rejects.toThrow(/커서가 반복/);
  });

  it("중복 항목은 한 번만 담는다(기존 계약)", async () => {
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      call += 1;
      return Promise.resolve(
        call === 1 ? page(["a", "b"], { shared_at: "2026-09-08", id: "b" }) : page(["b", "c"], null),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    expect((await fetchAllTeamFresh("2026-07-14T00:00:00Z")).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});
