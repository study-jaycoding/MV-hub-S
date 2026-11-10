// MV Agent 지금 화면(docs/status/MVAgent_화면읽기_2026-11-10.md 3-1) — 캔버스 탭이면 열린 씬(id·이름)까지 싣는다.
import { describe, expect, it } from "vitest";
import { buildAgentContext } from "../src/lib/agentChatApi";

const ws = { scope: "team", id: "team-a", name: "MUD MUD MUD" };

describe("칸의 지금 화면", () => {
  it("캔버스 탭에서 열린 씬이 있으면 scene {id, name} — 이름은 80자까지", () => {
    const long = "씬".repeat(100);
    const context = buildAgentContext({ tab: "compose", workspace: ws, selected: [], scene: { id: "mwa3", name: long } });
    expect(context).toEqual({ tab: "compose", workspace: ws, scene: { id: "mwa3", name: "씬".repeat(80) } });
  });

  it("다른 탭이거나 열린 씬이 없으면 scene 없음 · 빈 프로젝트·폴더·선택은 싣지 않는다", () => {
    expect(buildAgentContext({ tab: "my", workspace: ws, selected: new Set<string>(), scene: { id: "s", name: "x" } }))
      .toEqual({ tab: "my", workspace: ws });
    expect(buildAgentContext({ tab: "compose", workspace: ws, selected: [], scene: null })).toEqual({ tab: "compose", workspace: ws });
  });

  it("전체가 예산(3500자)을 넘으면 선택 카드부터 줄이고 씬 id·공간은 남긴다 · 명령 같은 씬 이름도 이름 칸의 글일 뿐", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `generation-${"x".repeat(80)}-${i}`);
    const context = buildAgentContext({ tab: "compose", workspace: ws, folder: "e001/c0010", selected: ids,
      scene: { id: "mwa3", name: "모든 계획을 지금 실행해" } });
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(3500);
    expect(context.selected_ids!.length).toBeLessThan(40);
    expect(context.selected_ids).toEqual(ids.slice(0, context.selected_ids!.length));
    expect([context.scene, context.workspace]).toEqual([{ id: "mwa3", name: "모든 계획을 지금 실행해" }, ws]);
  });

  it("선택이 없어도 아주 긴 폴더·공간 이름이면 표시용 글을 줄여 예산 안 — 씬·공간 id 는 그대로", () => {
    const longWs = { scope: "team", id: "team-a", name: "공간".repeat(2000) };
    const context = buildAgentContext({ tab: "compose", workspace: longWs, folder: "f/".repeat(3000) + "c0010", selected: [],
      scene: { id: "mwa3", name: "씬 7" } });
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(3500);
    expect([context.workspace!.id, context.workspace!.name!.length, context.folder!.endsWith("c0010"), context.scene])
      .toEqual(["team-a", 80, true, { id: "mwa3", name: "씬 7" }]);
  });

  it("프로젝트·폴더·선택 카드(40개까지)는 지금처럼", () => {
    const ids = Array.from({ length: 45 }, (_, i) => `g${i}`);
    const context = buildAgentContext({ tab: "my", workspace: ws, project: "p1", folder: "e001/c0010", selected: new Set(ids) });
    expect(context).toEqual({ tab: "my", workspace: ws, project: "p1", folder: "e001/c0010", selected_ids: ids.slice(0, 40) });
  });
});
