import { describe, expect, it } from "vitest";
import { parseWorkspaceCommand } from "../src/lib/workspaceCommand";

describe("parseWorkspaceCommand", () => {
  it("전역 모드에서 +와 -를 워크스페이스 명령으로 해석한다", () => {
    expect(parseWorkspaceCommand(" +티타임 ", true)).toEqual({
      operation: "assign",
      workspaceName: "티타임",
    });
    expect(parseWorkspaceCommand("-티타임", true)).toEqual({
      operation: "remove",
      workspaceName: "티타임",
    });
  });

  it("일반 태그 모드에서는 +이름을 태그 입력으로 남긴다", () => {
    expect(parseWorkspaceCommand("+티타임", false)).toBeNull();
  });

  it("부호 뒤 이름이 없으면 명확한 입력 오류를 반환한다", () => {
    expect(parseWorkspaceCommand("+", true)).toEqual({
      error: "워크스페이스 이름을 입력하세요",
    });
  });

  it("부호가 없는 전역 입력은 기존 태그 흐름을 유지한다", () => {
    expect(parseWorkspaceCommand("티타임", true)).toBeNull();
  });
});
