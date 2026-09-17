// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { useGenerationAutoTagActions } from "../src/lib/useGenerationAutoTagActions";

vi.mock("../src/api", () => ({ api: { createAutoTag: vi.fn(), deleteAutoTag: vi.fn() } }));
const args = () => ({ askPrompt: vi.fn(), flash: vi.fn(), reload: vi.fn(async () => {}),
  setArmedAutoTags: vi.fn(), setWorkspaceChips: vi.fn(),
  workspaceContext: { scope: "team" as const, id: "a", name: "R&D" } });
beforeEach(() => vi.clearAllMocks());

it("공유 자동 보기에서는 숨겨진 W 칩을 등록하지 않고 툴바를 안내한다", async () => {
  const input = args();
  input.askPrompt.mockResolvedValue("#+");
  await useGenerationAutoTagActions({ ...input, allowWorkspaceChipRegistration: false }).addAutoTag();
  expect(input.askPrompt).toHaveBeenCalledWith(expect.any(String), "", expect.not.stringContaining("#+"), { workspaceSuggest: false });
  expect(input.setWorkspaceChips).not.toHaveBeenCalled();
  expect(api.createAutoTag).not.toHaveBeenCalled();
  expect(input.flash).toHaveBeenCalledWith(expect.stringContaining("W"));
});

it("공유 보기의 일반 전역 태그 추가는 그대로 유지한다", async () => {
  const input = args();
  input.askPrompt.mockResolvedValue("review");
  await useGenerationAutoTagActions({ ...input, allowWorkspaceChipRegistration: false }).addAutoTag();
  expect(api.createAutoTag).toHaveBeenCalledExactlyOnceWith("review");
  expect(input.reload).toHaveBeenCalledOnce();
});

it("작업 공간은 기존 W 칩 등록 동작을 유지한다", async () => {
  const input = args();
  input.askPrompt.mockResolvedValue("#+");
  await useGenerationAutoTagActions(input).addAutoTag();
  expect(input.askPrompt).toHaveBeenCalledWith(expect.any(String), "", expect.stringContaining("#+"), { workspaceSuggest: true });
  const update = input.setWorkspaceChips.mock.calls[0][0];
  expect(update([])).toEqual([{ id: "a", name: "R&D" }]);
  expect(api.createAutoTag).not.toHaveBeenCalled();
});
