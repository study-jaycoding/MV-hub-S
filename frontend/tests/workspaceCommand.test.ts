import { describe, expect, it } from "vitest";
import { parseWorkspacePickerCommand } from "../src/lib/workspaceCommand";

describe("parseWorkspacePickerCommand", () => {
  it("전역 모드에서 #+와 #-만 워크스페이스 선택 명령으로 해석한다", () => {
    expect(parseWorkspacePickerCommand("#+", true)).toEqual({ operation: "assign" });
    expect(parseWorkspacePickerCommand("#-", true)).toEqual({ operation: "remove" });
  });

  it("일반 태그 모드에서는 같은 문자를 워크스페이스 명령으로 해석하지 않는다", () => {
    expect(parseWorkspacePickerCommand("#+", false)).toBeNull();
    expect(parseWorkspacePickerCommand("#-", false)).toBeNull();
  });

  it("기존 수동 이름 입력과 불완전한 명령은 허용하지 않는다", () => {
    expect(parseWorkspacePickerCommand("+", true)).toBeNull();
    expect(parseWorkspacePickerCommand("-", true)).toBeNull();
    expect(parseWorkspacePickerCommand("#+티타임", true)).toBeNull();
    expect(parseWorkspacePickerCommand("#-티타임", true)).toBeNull();
  });
});
