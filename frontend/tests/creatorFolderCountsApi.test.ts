import { afterEach, expect, it, vi } from "vitest";
import { fetchAllTeamFresh, projectApi } from "../src/lib/projectApi";

afterEach(() => vi.unstubAllGlobals());
const ok = (value: unknown) => ({ ok: true, json: async () => value });
const scoped = { creator_filter_uid: "alice", counts: { p: { shot: 2 } },
  project_counts: { p: 3 }, unassigned_count: 1,
  review_counts: { p: { shot: { final: 1, held: 0, shared: 1 } } } };

it("폴더 일괄 조회에 선택 생성자를 보내고 적용 응답을 확인한다", async () => {
  const fetch = vi.fn().mockResolvedValue(ok(scoped)); vi.stubGlobal("fetch", fetch);
  expect(await projectApi.projectFolderCountsBatch(["p"], "team", "alice")).toEqual(scoped);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ project_ids: ["p"], tab: "team", creator_uid: "alice" });
});

it.each([undefined, "bob"])("필터 적용 확인값 %s는 전체 수량으로 대체하지 않는다", async (uid) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ ...scoped, creator_filter_uid: uid })));
  await expect(projectApi.projectFolderCountsBatch(["p"], "team", "alice")).rejects.toMatchObject({ status: 409 });
});

it("선택하지 않으면 기존 요청과 구서버 응답 그대로 사용한다", async () => {
  const result = { counts: { p: { shot: 20 } } };
  const fetch = vi.fn().mockResolvedValue(ok(result)); vi.stubGlobal("fetch", fetch);
  expect(await projectApi.projectFolderCountsBatch(["p"], "team")).toEqual(result);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ project_ids: ["p"], tab: "team" });
});

it.each([
  { project_counts: undefined }, { unassigned_count: undefined }, { unassigned_count: -1 },
  { counts: {} }, { counts: { p: null } }, { counts: { p: { shot: -1 } } },
  { project_counts: { p: 1 } },
])("적용 확인값이 있어도 누락/잘못된 숫자 %j는 0으로 추정하지 않는다", async (patch) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ ...scoped, ...patch })));
  await expect(projectApi.projectFolderCountsBatch(["p"], "team", "alice")).rejects.toMatchObject({ status: 502 });
});

it("단건 조회도 생성자를 URL 인코딩하고 적용 확인값을 요구한다", async () => {
  const uid = "user:+a & b";
  const fetch = vi.fn().mockResolvedValue(ok({ counts: { shot: 2 }, creator_filter_uid: uid }));
  vi.stubGlobal("fetch", fetch);
  await projectApi.projectFolderCounts("p", "my", uid);
  expect(new URL(fetch.mock.calls[0][0], "http://localhost").searchParams.get("creator_uid")).toBe(uid);
  fetch.mockResolvedValue(ok({ counts: { shot: 999 } }));
  await expect(projectApi.projectFolderCounts("p", "my", uid)).rejects.toMatchObject({ status: 409 });
});

it("같은 신규 기준선이라도 계정/공간 문맥이 바뀌면 이전 요청에 합류하지 않는다", async () => {
  const resolvers: ((value: unknown) => void)[] = [];
  const fetch = vi.fn().mockImplementation(() => new Promise(resolve => resolvers.push(resolve)));
  vi.stubGlobal("fetch", fetch);
  const a = fetchAllTeamFresh("since", "account-a");
  const b = fetchAllTeamFresh("since", "account-b");
  const bAgain = fetchAllTeamFresh("since", "account-b");
  expect(fetch).toHaveBeenCalledTimes(2);
  resolvers[1](ok({ items: [{ id: "b", creator_uid: "bob" }], next_cursor: null }));
  resolvers[0](ok({ items: [{ id: "a", creator_uid: "alice" }], next_cursor: null }));
  expect(await bAgain).toEqual(await b);
  expect((await a)[0].id).toBe("a"); expect((await b)[0].id).toBe("b");
});
