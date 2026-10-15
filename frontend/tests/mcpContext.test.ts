import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { captureMcpContext, prepareMcpPlan, sendMcpReply, versionMcpReferences } from "../src/lib/mcpContext";
import type { Scene } from "../src/lib/scenes";

vi.mock("../src/api", () => ({ api: {
  projects: vi.fn(), models: vi.fn(), projectFolder: vi.fn(), modelParams: vi.fn(), estimateCost: vi.fn(), assetTree: vi.fn(), getGeneration: vi.fn(),
} }));
vi.mock("../src/lib/modelPolicy", () => ({ modelBlockMessage: () => null }));
vi.mock("../src/lib/aspectAuto", () => ({ resolveAutoAspectRatio: async (params: object) => params }));

const workspace = { scope: "personal" as const, id: null, name: null };
const scene: Scene = { id: "scene", name: "Scene", created_at: 1, cards: [], edges: [] };
const args = (contextId: string) => ({ title: "Scene plan", context_id: contextId, items: [{ label: "Cut", prompt: "A bird", model: "model", params: {}, reference_ids: [], project_id: "project", folder_path: "cut1" }] });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.projects).mockResolvedValue({ projects: [{ id: "project", name: "Project", workspace_scope: "personal", workspace_id: null }], unassigned: 0 } as Awaited<ReturnType<typeof api.projects>>);
  vi.mocked(api.models).mockResolvedValue([{ job_set_type: "model", display_name: "Model", type: "image" }]);
  vi.mocked(api.projectFolder).mockResolvedValue({ tree: { path: "", name: "Render", count: 0, children: [{ path: "cut1", name: "Cut1", count: 0, children: [] }] }, error: null } as Awaited<ReturnType<typeof api.projectFolder>>);
  vi.mocked(api.modelParams).mockResolvedValue({ job_set_type: "model", type: "image", params: [] });
  vi.mocked(api.estimateCost).mockResolvedValue({ credits: 3 });
});

describe("MCP context checks", () => {
  it("현재 문맥과 기존 권한 API로 검증한 계획을 만들고 고정 연결을 부여한다", async () => {
    const context = await captureMcpContext(scene, workspace);
    const plan = await prepareMcpPlan(args(context.id), context, scene, workspace);
    expect(plan.items[0].estimated_credits).toBe(3);
    expect(plan.items[0].request.canvas_link.scene_id).toBe("scene");
    expect(plan.items[0].request.canvas_link.attempt_id).toMatch(/^[\da-f-]{36}$/);
  });
  it("씬이 수정되면 API 조회 전에 거절한다", async () => {
    const context = await captureMcpContext(scene, workspace);
    await expect(prepareMcpPlan(args(context.id), context, { ...scene, name: "Changed" }, workspace)).rejects.toThrow("바뀌었습니다");
    expect(api.projects).not.toHaveBeenCalled();
  });
  it("알 수 없는 reference handle은 견적·생성 전에 거절한다", async () => {
    const context = await captureMcpContext(scene, workspace);
    const input = args(context.id);
    await expect(prepareMcpPlan({ ...input, items: [{ ...input.items[0], reference_ids: ["invented"] }] }, context, scene, workspace)).rejects.toThrow("알 수 없는 참고 자료");
    expect(api.estimateCost).not.toHaveBeenCalled();
  });
  it("존재하지 않는 컷 폴더는 거절한다", async () => {
    const context = await captureMcpContext(scene, workspace);
    const input = args(context.id);
    await expect(prepareMcpPlan({ ...input, items: [{ ...input.items[0], folder_path: "invented" }] }, context, scene, workspace)).rejects.toThrow("컷 폴더");
  });
  it.each([NaN, -1, Infinity])("불명확한 견적 %s는 승인 계획을 만들지 않는다", async (credits) => {
    vi.mocked(api.estimateCost).mockResolvedValue({ credits });
    const context = await captureMcpContext(scene, workspace);
    await expect(prepareMcpPlan(args(context.id), context, scene, workspace)).rejects.toThrow("크레딧");
  });
  it("에셋의 실제 현재 버전을 조회하고 임의 외부 URL을 거절한다", async () => {
    vi.mocked(api.assetTree).mockResolvedValue({ project: "P", name: "P", children: [{ path: "a.png", name: "a", type: "image", version: "100-20" }] });
    expect(await versionMcpReferences([{ file_path: "asset:P|a.png", type: "image" }])).toEqual([{ file_path: "asset:P|a.png", type: "image", asset_version: "100-20" }]);
    expect(api.assetTree).toHaveBeenCalledWith("P", true);
    await expect(versionMcpReferences([{ file_path: "https://unknown/secret", type: "image" }])).rejects.toThrow("버전을 확인할 수 없는");
  });
});

describe("MCP reply recovery", () => {
  const reply = { id: "request", result: { cards: [] } };
  const failure = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
  it("정상 응답은 한 번만 전송한다", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    await sendMcpReply(reply, send);
    expect(send).toHaveBeenCalledExactlyOnceWith(reply);
  });
  it("큰 결과는 작은 오류 응답 한 번으로 대체하고 연결을 유지한다", async () => {
    const send = vi.fn().mockRejectedValueOnce(failure(413)).mockResolvedValueOnce({ ok: true });
    await sendMcpReply(reply, send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ id: "request", error: "결과가 너무 큽니다. 조회 범위를 줄이세요." });
  });
  it("만료된 요청 응답은 버리고 다음 요청을 계속 처리할 수 있다", async () => {
    const send = vi.fn().mockRejectedValueOnce(failure(404)).mockResolvedValueOnce({ ok: true });
    await sendMcpReply(reply, send);
    await sendMcpReply({ ...reply, id: "next" }, send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ ...reply, id: "next" });
  });
  it("큰 결과 오류 응답까지 만료되어도 연결을 유지한다", async () => {
    const send = vi.fn().mockRejectedValueOnce(failure(413)).mockRejectedValueOnce(failure(404));
    await expect(sendMcpReply(reply, send)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
  });
  it.each([401, 403, 409, 500])("권한 또는 서버 오류 %s는 연결 종료 경로에 전달한다", async (status) => {
    const error = failure(status);
    const send = vi.fn().mockRejectedValue(error);
    await expect(sendMcpReply(reply, send)).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each([403, 409, 413, 500])("작은 응답의 %s 오류를 숨기거나 반복하지 않는다", async (status) => {
    const error = failure(status);
    const send = vi.fn().mockRejectedValueOnce(failure(413)).mockRejectedValueOnce(error);
    await expect(sendMcpReply(reply, send)).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("네트워크 오류를 만료로 오해하지 않는다", async () => {
    const error = new TypeError("Failed to fetch");
    await expect(sendMcpReply(reply, vi.fn().mockRejectedValue(error))).rejects.toBe(error);
  });
});
