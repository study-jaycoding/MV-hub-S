import { describe, expect, it, vi } from "vitest";
import { executeMcpPlan, McpPreflightError, mcpFailureMessage, mcpDraftMatches, mcpPlanCards, mcpSceneHash, parseMcpPlan, type McpExecutionPorts, type McpPlanRecord } from "../src/lib/mcpPlans";
import type { Scene } from "../src/lib/scenes";

const workspace = { scope: "personal" as const, id: null, name: null };
const scene: Scene = { id: "scene", name: "Scene", cards: [], edges: [], created_at: 1 };
const record = (): McpPlanRecord => ({
  id: "plan", revision: 0, status: "proposed", items: [{ state: "pending", error: null }],
  plan: { title: "test", context_id: "ctx", scene_id: "scene", scene_hash: "hash", workspace, items: [{ label: "Cut 1", estimated_credits: 4, reference_snapshot: [], request: { kind: "create", workspace, create: { prompt: "A bird", model: "model", project_id: "project", folder_path: "cut1", params: {} }, canvas_link: { scene_id: "scene", card_id: "card", generation_id: "gen", attempt_id: "attempt" } } }] },
});

function ports(): McpExecutionPorts {
  return {
    check: vi.fn(async () => {}),
    approve: vi.fn(async (row) => ({ ...row, revision: row.revision + 1, status: "approved" })),
    persistCards: vi.fn(async () => {}), persistLinks: vi.fn(async () => {}),
    state: vi.fn(async (row, index, state) => ({ ...row, revision: row.revision + 1, items: row.items.map((item, i) => i === index ? { ...item, state } : item) })),
    submit: vi.fn(async () => {}), discard: vi.fn(), changed: vi.fn(),
  };
}

describe("MCP plan execution boundaries", () => {
  it("카드 저장이 실패하면 생성 요청을 보내지 않는다", async () => {
    const io = ports();
    io.persistCards = vi.fn(async () => { throw new Error("storage"); });
    await expect(executeMcpPlan(record(), io)).rejects.toThrow("storage");
    expect(io.persistLinks).not.toHaveBeenCalled();
    expect(io.submit).not.toHaveBeenCalled();
  });
  it("연결 표식 저장이 실패하면 생성 요청을 보내지 않는다", async () => {
    const io = ports();
    io.persistLinks = vi.fn(async () => { throw new Error("durability"); });
    await expect(executeMcpPlan(record(), io)).rejects.toThrow("durability");
    expect(io.submit).not.toHaveBeenCalled();
  });
  it("계정이나 문맥이 바뀌면 승인하지 않는다", async () => {
    const io = ports();
    io.check = vi.fn(async () => { throw new Error("account changed"); });
    await expect(executeMcpPlan(record(), io)).rejects.toThrow("account changed");
    expect(io.approve).not.toHaveBeenCalled();
    expect(io.submit).not.toHaveBeenCalled();
  });
  it("동일 revision 중복 승인은 CAS로 한 번만 제출된다", async () => {
    const io = ports();
    // 승인 자체는 멱등이다. 항목별 submitting의 revision CAS가 제출권을 한 번만 준다.
    let revision = 1;
    io.state = vi.fn(async (row, index, state) => {
      if (row.revision !== revision) throw new Error("revision conflict");
      revision++;
      return { ...row, revision, items: row.items.map((item, i) => i === index ? { ...item, state } : item) };
    });
    await Promise.allSettled([executeMcpPlan(record(), io), executeMcpPlan(record(), io)]);
    expect(io.submit).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, 408, 409, 429, 500])("불명확한 제출(%s)은 표식을 유지하고 uncertain으로 기록한다", async (status) => {
    const io = ports();
    io.submit = vi.fn(async () => { throw Object.assign(new Error("uncertain"), { status }); });
    await expect(executeMcpPlan(record(), io)).rejects.toThrow("제출 결과");
    expect(io.discard).not.toHaveBeenCalled();
    expect(io.state).toHaveBeenLastCalledWith(expect.anything(), 0, "uncertain", expect.any(String));
  });
  it("확정 422 거절만 표식을 정리한다", async () => {
    const io = ports();
    io.submit = vi.fn(async () => { throw Object.assign(new Error("invalid"), { status: 422 }); });
    const result = await executeMcpPlan(record(), io);
    expect(result.items[0].state).toBe("rejected");
    expect(io.discard).toHaveBeenCalledTimes(1);
  });
  it("submitting CAS 실패 시 API를 호출하지 않는다", async () => {
    const io = ports();
    io.state = vi.fn(async () => { throw new Error("conflict"); });
    await expect(executeMcpPlan(record(), io)).rejects.toThrow("conflict");
    expect(io.submit).not.toHaveBeenCalled();
  });
  it("이미 승인한 계획은 새 ID로 재실행하지 않는다", async () => {
    const io = ports();
    await expect(executeMcpPlan({ ...record(), status: "approved" }, io)).rejects.toThrow("이미 승인");
    expect(io.approve).not.toHaveBeenCalled();
  });
  it("사전 확인 실패의 안전한 원인을 DB 상태 갱신에 전달한다", async () => {
    const io = ports();
    io.submit = vi.fn(async () => { throw new McpPreflightError("references"); });
    await executeMcpPlan(record(), io);
    expect(io.state).toHaveBeenLastCalledWith(expect.anything(), 0, "rejected", "참고 자료가 바뀌었거나 현재 버전을 확인하지 못해 제출하지 않았습니다.");
  });
  it("원격 오류 본문의 토큰·경로를 이력에 복제하지 않는다", () => {
    const message = mcpFailureMessage(Object.assign(new Error("token=not-a-real-secret C:\\private\\person"), { status: 422 }));
    expect(message).toContain("HTTP 422");
    expect(message).not.toContain("not-a-real-secret");
    expect(message).not.toContain("private");
  });
});

describe("MCP plan input and scene", () => {
  const input = () => ({ title: "Plan", context_id: "ctx", items: [{ label: "Cut", prompt: "A bird", model: "model", params: {}, reference_ids: [], project_id: "project", folder_path: "cut1" }] });
  it("연쇄 의존과 임의 파일경로 필드를 거절한다", () => {
    expect(() => parseMcpPlan({ ...input(), depends_on: [] })).toThrow("지원하지 않는 필드");
    const raw = input();
    expect(() => parseMcpPlan({ ...raw, items: [{ ...raw.items[0], file_path: "private" }] })).toThrow("지원하지 않는 필드");
  });
  it("범위를 벗어난 수량·경로·옵션을 거절한다", () => {
    expect(() => parseMcpPlan({ ...input(), items: [] })).toThrow("1~20");
    const raw = input();
    expect(() => parseMcpPlan({ ...raw, items: [{ ...raw.items[0], folder_path: "../private" }] })).toThrow("컷 폴더");
    expect(() => parseMcpPlan({ ...raw, items: [{ ...raw.items[0], params: { duration: NaN } }] })).toThrow("유한 숫자");
  });
  it("생성 카드·모델·컷 배정을 다시 재현하고 변경을 탐지한다", () => {
    const plan = record().plan;
    const patch = mcpPlanCards(plan, scene);
    const prepared = { ...scene, ...patch };
    expect(mcpDraftMatches(plan, prepared)).toBe(true);
    expect(mcpDraftMatches(plan, { ...prepared, cards: prepared.cards.filter((card) => card.kind !== "model") })).toBe(false);
    expect(mcpDraftMatches(plan, { ...prepared, cards: prepared.cards.map((card) => card.kind === "generation" ? { ...card, prompt: "changed" } : card) })).toBe(false);
    expect(() => mcpPlanCards(plan, prepared)).toThrow("이미 존재");
  });
  it("카메라 이동은 허용하지만 프롬프트 변경은 해시가 달라진다", async () => {
    const original = await mcpSceneHash(scene);
    expect(await mcpSceneHash({ ...scene, camera: { x: 20, y: 20, z: 1 } })).toBe(original);
    expect(await mcpSceneHash({ ...scene, cards: [{ id: "c", kind: "generation", x: 0, y: 0, prompt: "new" }] })).not.toBe(original);
  });
});
