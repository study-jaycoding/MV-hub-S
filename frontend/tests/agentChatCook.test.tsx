// @vitest-environment jsdom
// MV Agent 요리(2-A, docs/status/AskAgent_앱동작도구_설계_2026-11-09.md A2-3·A4) — 진행 스냅샷 합치기 규칙과 보낸 계획 카드.
//  가짜는 바깥 경계(fetch)에만 둔다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPlanCard, itemKind } from "../src/components/agent-chat/AgentPlanCard";
import type { AgentPlanSnapshot } from "../src/lib/agentChatApi";
import { applyAgentEvent, applyPlanSnapshot, fillPlanProgress, restorePlans, type AgentMessage } from "../src/lib/useAgentChat";
import type { Generation, PreviewTarget } from "../src/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PlanMessage = Extract<AgentMessage, { kind: "plan" }>;
const PLAN = { plan_id: "p1", title: "고양이", status: "planned", items: [{ model: "M", prompt: "고양이 1" }, { model: "M", prompt: "고양이 2" }] };
const card = (): PlanMessage => ({ kind: "plan", id: "t1:1", plan: PLAN });
const snap = (observed: string, items: AgentPlanSnapshot["items"], status = "submitted"): AgentPlanSnapshot =>
  ({ plan_id: "p1", plan_status: status, observed_at: observed, items });
const sub = (index: number, generation_status?: string | null, generation_id = `g${index}`) =>
  ({ index, state: "submitted", generation_id, ...(generation_status !== undefined ? { generation_status } : {}) });

describe("진행 스냅샷 합치기(설계 A2-3)", () => {
  it("번호가 지금보다 클 때만 넣는다 — 같거나 옛것은 무시, 19자리 넘는 번호도 BigInt 로 비교", () => {
    const a = applyPlanSnapshot(card(), snap("1800000000000000000001", [sub(0, "running")]));
    const older = applyPlanSnapshot(a, snap("1800000000000000000000", [sub(0, "done")]));
    expect(older.progress!.items[0].generation_status).toBe("running");
    const same = applyPlanSnapshot(a, snap("1800000000000000000001", [sub(0, "done")]));
    expect(same).toBe(a); // 같은 스냅샷 두 번 = 같은 결과
    const newer = applyPlanSnapshot(a, snap("1800000000000000000002", [sub(0, "done")]));
    expect(newer.progress!.items[0].generation_status).toBe("done");
  });

  it("허브의 복구 전이(uncertain→submitted, submitting→pending)를 그대로 보인다 — 상태 순위로 막지 않는다", () => {
    let m = applyPlanSnapshot(card(), snap("1", [{ index: 0, state: "uncertain", generation_id: null }, { index: 1, state: "submitting", generation_id: null }], "attention"));
    m = applyPlanSnapshot(m, snap("2", [sub(0, "running"), { index: 1, state: "pending", generation_id: null }], "attention"));
    expect(m.progress!.items[0]).toMatchObject({ state: "submitted", generation_status: "running" });
    expect(m.progress!.items[1].state).toBe("pending");
  });

  it("생성 상태가 빠진 항목(허브가 잠깐 못 읽음)은 앞 값을 둔다 · 제목·프롬프트는 건드리지 않는다", () => {
    let m = applyPlanSnapshot(card(), snap("1", [sub(0, "running"), sub(1, "running")]));
    m = applyPlanSnapshot(m, snap("2", [sub(0, "done"), sub(1)]));
    expect([m.progress!.items[0].generation_status, m.progress!.items[1].generation_status]).toEqual(["done", "running"]);
    expect(m.plan).toBe(PLAN);
  });

  it("스냅샷 없는 실행 응답은 빈 카드에만 — 최신 submitted+id 뒤 늦은 submitting+null 은 무시", () => {
    const fresh = applyPlanSnapshot(card(), snap("5", [sub(0, "running"), sub(1, "running")]));
    const late = fillPlanProgress(fresh, { ...PLAN, status: "executing", items: [{ state: "submitting", generation_id: null }, { state: "pending" }] });
    expect(late).toBe(fresh);
    const empty = fillPlanProgress(card(), { ...PLAN, status: "submitted", items: [{ state: "submitted", generation_id: "g0" }, { state: "submitted", generation_id: "g1" }] });
    expect(empty.progress).toMatchObject({ observed: null, planStatus: "submitted" });
    expect(empty.progress!.items[1].generation_id).toBe("g1");
  });

  it("대화 복원 스냅샷은 조건 없이 넣고 기준이 된다 · 빠진 계획은 기준만 비워 다음 사건을 받는다(재시작 전 큰 번호)", () => {
    const other: PlanMessage = { kind: "plan", id: "t1:2", plan: { ...PLAN, plan_id: "p2" } };
    const big = "9999999999999999999999";
    const replayed: AgentMessage[] = [applyPlanSnapshot(card(), snap(big, [sub(0, "running")])),
      applyPlanSnapshot(other, { ...snap(big, [sub(0, "running")]), plan_id: "p2" })];
    const restored = restorePlans(replayed, [snap("10", [sub(0, "done")])]) as PlanMessage[];
    expect(restored[0].progress).toMatchObject({ observed: "10" });
    expect(restored[0].progress!.items[0].generation_status).toBe("done");
    expect(restored[1].progress!.observed).toBeNull(); // 예산 밖 — 사건으로 복원한 상태는 두고 기준만 비움
    const next = applyAgentEvent(restored, { seq: 9, kind: "plan_progress", ...snap("11", [sub(0, "done")]), plan_id: "p2" }, "t2") as PlanMessage[];
    expect(next[1].progress!.items[0].generation_status).toBe("done");
  });
});

describe("항목 칸 글(설계 A4)", () => {
  it.each([
    ["rejected", undefined, undefined, "rejected"], ["uncertain", undefined, undefined, "unconfirmed"],
    ["submitting", undefined, undefined, "sending"], ["pending", undefined, undefined, "unsent"],
    ["submitted", undefined, undefined, "accepted"], ["submitted", "running", undefined, "making"],
    ["submitted", "done", undefined, "done"], ["submitted", "failed", undefined, "failed"],
    ["submitted", "missing", undefined, "missing"], ["submitted", "running", "done", "done"], // 라이브러리가 끝났으면 그쪽
    ["submitted", undefined, "pending", "making"],
  ])("state=%s 서버=%s 라이브러리=%s → %s", (state, server, library, kind) => {
    expect(itemKind(state, server, library)).toBe(kind);
  });

  it("계획이 아직 보내는 중(executing)이면 대기 항목은 보내는 중 — 끝난 뒤에만 미제출(독립 리뷰 P1)", () => {
    expect(itemKind("pending", undefined, undefined, "executing")).toBe("sending");
    expect(itemKind("pending", undefined, undefined, "attention")).toBe("unsent");
  });
});

let host: HTMLDivElement;
let root: Root;
let fetched: string[];
const gen = (id: string, file = `/media/${id}.png`): Generation =>
  ({ id, prompt: "고양이 결과", status: "done", assets: [{ id: `a-${id}`, generation_id: id, type: "image", file_path: file, thumbnail_path: null, source_url: null, cached: true }] }) as unknown as Generation;
beforeEach(() => {
  sessionStorage.setItem("ch.accountScope", "jay@example.com");
  fetched = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    fetched.push(String(url));
    if (String(url).includes("/generations/g1")) return new Response(JSON.stringify(gen("g1")), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ detail: "Not Found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const flush = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};
const tiles = () => [...host.querySelectorAll(".agent-plan-tile")].map((el) => el.textContent);

describe("보낸 계획 카드", () => {
  it("완료 썸네일 세 경로 — 앱이 읽은 카드 / getGeneration 한 번 / 못 읽으면 글 · 누르면 크게 보기", async () => {
    const four = { ...PLAN, items: [0, 1, 2, 3].map((i) => ({ model: "M", prompt: `고양이 ${i}` })) };
    const progress = applyPlanSnapshot({ kind: "plan", id: "x", plan: four }, snap("1", [sub(0, "done"), sub(1, "done"), sub(2, "done"), sub(3, "running")])).progress;
    const previews: PreviewTarget[] = [];
    const known = gen("g0");
    act(() => root.render(<AgentPlanCard plan={four} progress={progress} onExecute={() => {}} onRevise={() => {}}
      findGeneration={(id) => (id === "g0" ? known : undefined)} onPreview={(t) => previews.push(t)} />));
    await flush();
    expect(tiles()).toEqual(["완료", "완료", "완료 — 라이브러리에서 확인", "만드는 중"]);
    expect(fetched.filter((u) => u.includes("/generations/")).sort()).toEqual(["/api/generations/g1", "/api/generations/g2"]); // 한 번씩만
    const thumbs = host.querySelectorAll<HTMLButtonElement>(".agent-plan-tile.is-done");
    expect(thumbs).toHaveLength(2);
    act(() => thumbs[1].click());
    expect(previews).toEqual([expect.objectContaining({ url: "/media/g1.png", type: "image", genId: "g1" })]);
    expect(host.querySelector(".agent-plan-sent")!.textContent).toBe("생성을 보냈어요"); // 아직 하나가 만드는 중
    expect(host.querySelector(".agent-plan-run")).toBeNull();
  });

  it("첫 항목 거절 뒤 나머지는 미제출 · 다 끝나면 끝났어요 줄(결과 없음·미제출은 따로 셈)", async () => {
    const three = { ...PLAN, items: [0, 1, 2].map((i) => ({ model: "M", prompt: `p${i}` })) };
    const rejected = applyPlanSnapshot({ kind: "plan", id: "x", plan: three }, snap("1", [
      { index: 0, state: "rejected", generation_id: null }, { index: 1, state: "pending", generation_id: null }, { index: 2, state: "pending", generation_id: null }], "attention")).progress;
    act(() => root.render(<AgentPlanCard plan={three} progress={rejected} onExecute={() => {}} onRevise={() => {}} />));
    await flush();
    expect(tiles()).toEqual(["거절", "미제출", "미제출"]);
    expect(host.querySelector(".agent-plan-sent")!.textContent).toBe("끝났어요 · 완료 0 · 실패 1 · 미제출 2");
    const mixed = applyPlanSnapshot({ kind: "plan", id: "x", plan: three }, snap("2", [sub(0, "failed"), sub(1, "missing"), sub(2, "failed")])).progress;
    act(() => root.render(<AgentPlanCard plan={three} progress={mixed} onExecute={() => {}} onRevise={() => {}} />));
    await flush();
    expect(tiles()).toEqual(["실패", "결과 없음", "실패"]);
    expect(host.querySelector(".agent-plan-sent")!.textContent).toBe("끝났어요 · 완료 0 · 실패 2 · 결과 없음 1");
  });

  it("보내는 중(executing)인 계획은 대기 항목이 있어도 끝났어요가 아니다 — 끝난 뒤에야 미제출로 센다(독립 리뷰 P1)", async () => {
    const executing = applyPlanSnapshot(card(), snap("1", [sub(0, "failed"), { index: 1, state: "pending", generation_id: null }], "executing")).progress;
    act(() => root.render(<AgentPlanCard plan={PLAN} progress={executing} onExecute={() => {}} onRevise={() => {}} />));
    await flush();
    expect(tiles()).toEqual(["실패", "보내는 중"]);
    expect(host.querySelector(".agent-plan-sent")!.textContent).toBe("생성을 보냈어요");
    const stopped = applyPlanSnapshot(card(), snap("2", [sub(0, "failed"), { index: 1, state: "pending", generation_id: null }], "attention")).progress;
    act(() => root.render(<AgentPlanCard plan={PLAN} progress={stopped} onExecute={() => {}} onRevise={() => {}} />));
    await flush();
    expect(tiles()).toEqual(["실패", "미제출"]);
    expect(host.querySelector(".agent-plan-sent")!.textContent).toBe("끝났어요 · 완료 0 · 실패 1 · 미제출 1");
  });

  it("완료 썸네일은 항목마다 한 번만 읽는다 — 응답이 따로 와도 진행 중 조회를 버리거나 다시 묻지 않는다(독립 리뷰 P2)", async () => {
    const gates: Record<string, (res: Response) => void> = {};
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      fetched.push(String(url));
      return new Promise<Response>((done) => { gates[String(url)] = done; });
    }));
    const ok = (id: string) => new Response(JSON.stringify(gen(id)), { status: 200, headers: { "Content-Type": "application/json" } });
    const progress = applyPlanSnapshot(card(), snap("1", [sub(0, "done"), sub(1, "done")])).progress;
    act(() => root.render(<AgentPlanCard plan={PLAN} progress={progress} onExecute={() => {}} onRevise={() => {}} />));
    await flush();
    const gens = () => fetched.filter((u) => u.includes("/generations/")).sort();
    expect(gens()).toEqual(["/api/generations/g0", "/api/generations/g1"]);
    act(() => gates["/api/generations/g0"](ok("g0")));
    await flush();
    act(() => gates["/api/generations/g1"](ok("g1")));
    await flush();
    expect(gens()).toEqual(["/api/generations/g0", "/api/generations/g1"]); // 다시 묻지 않았다
    expect(host.querySelectorAll(".agent-plan-tile.is-done")).toHaveLength(2); // 늦게 온 응답도 버리지 않았다
  });

  it("계획만(보내기 전)은 지금 그대로 — [실행]·[고치기]·크레딧 경고, 칸 없음", async () => {
    act(() => root.render(<AgentPlanCard plan={PLAN} onExecute={() => {}} onRevise={() => {}} />));
    await flush();
    expect(host.querySelector(".agent-plan-run")!.textContent).toBe("실행");
    expect(host.textContent).toContain("실행하면 크레딧이 나갑니다");
    expect(host.querySelector(".agent-plan-tiles")).toBeNull();
  });
});
