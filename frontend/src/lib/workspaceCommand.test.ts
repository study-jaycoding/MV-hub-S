import { describe, expect, it } from "vitest";
import { parseWorkspacePickerCommand, workspaceCommandLabels } from "./workspaceCommand";

describe("workspace commands", () => {
  it("opens only the explicit picker commands in global mode", () => {
    expect(parseWorkspacePickerCommand("#+", true)).toEqual({ operation: "assign" });
    expect(parseWorkspacePickerCommand("#-", true)).toEqual({ operation: "remove" });
    expect(parseWorkspacePickerCommand("#+", false)).toBeNull();
    expect(parseWorkspacePickerCommand("티타임", true)).toBeNull();
  });

  it("disambiguates duplicate display names with stable id suffixes", () => {
    const labels = workspaceCommandLabels([
      { id: "11111111-1111-1111-1111-d551aa7d", name: "뻘뻘뻘" },
      { id: "22222222-2222-2222-2222-f5d47c27", name: "뻘뻘뻘" },
      { id: "33333333-3333-3333-3333-12345678", name: "MILLIONVOLT" },
    ]);

    expect(labels.get("11111111-1111-1111-1111-d551aa7d")).toBe("뻘뻘뻘 · d551aa7d");
    expect(labels.get("22222222-2222-2222-2222-f5d47c27")).toBe("뻘뻘뻘 · f5d47c27");
    expect(labels.get("33333333-3333-3333-3333-12345678")).toBe("MILLIONVOLT");
  });

  it("uses the full id only when duplicate suffixes also collide", () => {
    const first = "11111111-1111-1111-1111-deadbeef";
    const second = "22222222-2222-2222-2222-deadbeef";
    const labels = workspaceCommandLabels([
      { id: first, name: "Same" },
      { id: second, name: "same" },
    ]);

    expect(labels.get(first)).toBe(`Same · ${first}`);
    expect(labels.get(second)).toBe(`same · ${second}`);
  });
});
