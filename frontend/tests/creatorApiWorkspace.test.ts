import { beforeEach, expect, it, vi } from "vitest";
import type { Creator } from "../src/types";

const { jsonFetch } = vi.hoisted(() => ({ jsonFetch: vi.fn() }));
vi.mock("../src/lib/http", async (original) => ({
  ...await original<typeof import("../src/lib/http")>(), jsonFetch,
}));
import { HttpError } from "../src/lib/http";
import { projectApi } from "../src/lib/projectApi";

const items: Creator[] = [{ uid: "creator-a", name: "Alpha", count: 7, is_mine: false }];
function query() { return new URL(String(jsonFetch.mock.calls.at(-1)?.[0]), "http://test.invalid").searchParams; }
beforeEach(() => { jsonFetch.mockReset(); });

it("팀 공간 복수 조건을 정렬·중복제거하여 반복 query로 보내고 확인된 집계만 반환", async () => {
  jsonFetch.mockResolvedValue({ items, workspace_filter_applied: true });
  const ids = ["workspace-b", "workspace-a", "workspace-b"];
  expect(await projectApi.creators("team", "project/one", { workspace_ids: ids })).toEqual(items);
  expect(query().getAll("workspace_ids")).toEqual(["workspace-a", "workspace-b"]);
  expect(query().get("workspace_id")).toBeNull();
  expect(query().get("workspace_scope")).toBeNull();
  expect(query().get("project_id")).toBe("project/one");
  expect(query().get("tab")).toBe("team");
  expect(ids).toEqual(["workspace-b", "workspace-a", "workspace-b"]);
});

it("개인 집계는 개인 범위만 보내고 생성자 자신으로 좁히지 않는다", async () => {
  jsonFetch.mockResolvedValue({ items, workspace_filter_applied: true });
  expect(await projectApi.creators("team", undefined, { workspace_scope: "personal" })).toEqual(items);
  expect(query().get("workspace_scope")).toBe("personal");
  expect(query().getAll("workspace_ids")).toEqual([]);
  expect(query().get("creator_uid")).toBeNull();
});

it.each([
  { label: "구서버 배열", result: items },
  { label: "확인값 없음", result: { items } },
  { label: "확인값 false", result: { items, workspace_filter_applied: false } },
  { label: "문자열 확인값", result: { items, workspace_filter_applied: "true" } },
  { label: "목록 형태 불일치", result: { items: {}, workspace_filter_applied: true } },
  { label: "빈 응답", result: null },
])("공간 집계의 $label 은 전체 건수로 표시하지 않고 409로 거절", async ({ result }) => {
  jsonFetch.mockResolvedValue(result);
  await expect(projectApi.creators("team", undefined, { workspace_ids: ["a"] }))
    .rejects.toMatchObject({ status: 409 });
});

it("빈 scoped 집계도 정상 결과로 반환", async () => {
  jsonFetch.mockResolvedValue({ items: [], workspace_filter_applied: true });
  expect(await projectApi.creators("team", undefined, { workspace_scope: "personal" })).toEqual([]);
});

it.each([undefined, {}, { workspace_ids: [] }])("전체 보기는 기존 배열 응답 호환", async (filter) => {
  jsonFetch.mockResolvedValue(items);
  expect(await projectApi.creators("team", undefined, filter)).toEqual(items);
  expect(query().getAll("workspace_ids")).toEqual([]);
  expect(query().get("workspace_scope")).toBeNull();
});

it("내 작업은 본인 라이브러리 범위를 요청하고 공간·폴더를 함께 보낸다", async () => {
  jsonFetch.mockResolvedValue({ items, creator_scope_applied: true });
  expect(await projectApi.creators("my", "project-one", { workspace_ids: ["a"], workspace_scope: "personal" }, "ep/seq"))
    .toEqual(items);
  expect(query().get("tab")).toBe("my");
  expect(query().get("project_id")).toBe("project-one");
  expect(query().getAll("workspace_ids")).toEqual(["a"]);
  expect(query().get("workspace_scope")).toBe("personal");
  expect(query().get("folder_path")).toBe("ep/seq");
  expect(query().get("facet_scope")).toBe("library");
});

it("인자 없는 기존 호출과 서버 오류는 그대로 유지", async () => {
  jsonFetch.mockResolvedValueOnce({ items, creator_scope_applied: true });
  expect(await projectApi.creators()).toEqual(items);
  expect(query().get("tab")).toBe("my");
  const error = new HttpError(403, "denied");
  jsonFetch.mockRejectedValueOnce(error);
  await expect(projectApi.creators("team", undefined, { workspace_ids: ["a"] })).rejects.toBe(error);
  expect(jsonFetch).toHaveBeenCalledTimes(2);
});

it.each([items, { items }, { items, creator_scope_applied: false },
  { items, creator_scope_applied: "true" }, { items: {}, creator_scope_applied: true }, null])(
  "내 작업은 구서버 또는 범위 확인 없는 응답을 숫자로 표시하지 않는다", async (result) => {
    jsonFetch.mockResolvedValue(result);
    await expect(projectApi.creators("my", "none", {}, "e001")).rejects.toMatchObject({ status: 409 });
  },
);

it("미분류·루트와 공유 탭의 기존 범위를 구분한다", async () => {
  jsonFetch.mockResolvedValueOnce({ items: [], creator_scope_applied: true });
  await projectApi.creators("my", "none", {}, "");
  expect(query().get("project_id")).toBe("none");
  expect(query().get("folder_path")).toBeNull();
  jsonFetch.mockResolvedValueOnce(items);
  await projectApi.creators("team", "p", {}, "ignored-folder");
  expect(query().get("facet_scope")).toBeNull();
  expect(query().get("folder_path")).toBeNull();
});

it("프로젝트 귀속은 명시적 재개 요청에서만 resume_work를 보낸다", async () => {
  jsonFetch.mockResolvedValue({ ok: true, updated: 1 });
  await projectApi.assignProject(["g"], "p", "my", "ep/seq");
  expect(JSON.parse(jsonFetch.mock.calls.at(-1)![1].body)).not.toHaveProperty("resume_work");
  await projectApi.assignProject(["g"], "p", "my", "ep/seq", true);
  expect(JSON.parse(jsonFetch.mock.calls.at(-1)![1].body).resume_work).toBe(true);
});
