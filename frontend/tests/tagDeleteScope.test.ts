// 태그 전체 삭제의 확인창은 실제로 지워지는 범위를 말한다(조작 규칙 42).
// 2026-10-12(조작 점검 15회차, Codex 전수 검토): 확인창은 지금 목록에서 센 "N건에서 삭제할까요?"였는데, 요청은 태그 이름만 보낸다 —
//  서버는 그 계정의 모든 카드에서 지운다(backend repo/tags.py delete_tag_everywhere). 다른 폴더·아직 불러오지 않은 쪽의 카드도 지워진다.
import { afterEach, expect, it, vi } from "vitest";
import { useGenerationFilterActions } from "../src/lib/useGenerationFilterActions";
import type { Generation } from "../src/types";

const mocks = vi.hoisted(() => ({ deleteTag: vi.fn() }));
vi.mock("../src/api", () => ({ api: mocks }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

const card = (id: string, tags: string[]) => ({ id, tags }) as unknown as Generation;

it("확인창은 '모든 카드에서'라고 말하고 지금 목록의 수는 따로 밝힌다 — 끝나면 서버가 실제로 지운 수를 알린다", async () => {
  const confirm = vi.fn(() => true);
  vi.stubGlobal("window", { confirm });
  mocks.deleteTag.mockResolvedValue({ removed: 7 }); // 다른 폴더의 5건까지
  const flash = vi.fn();
  const reload = vi.fn(async () => {});
  const actions = useGenerationFilterActions({
    flash, reload, gensRef: { current: [card("a", ["cut"]), card("b", ["cut", "x"]), card("c", [])] },
    setColorFilter: vi.fn(), setTagFilter: vi.fn(), setTagPanelOpen: vi.fn(),
  });
  await actions.deleteTagEverywhere("cut");
  const asked = confirm.mock.calls[0][0] as unknown as string;
  expect(asked).toContain('태그 "#cut" 를 모든 카드에서 삭제할까요?');
  expect(asked).toContain("지금 목록에 보이는 것은 2건이지만"); // 전엔 "2건에서 삭제할까요?" 뿐이었다
  expect(mocks.deleteTag).toHaveBeenCalledExactlyOnceWith("cut");
  expect(reload).toHaveBeenCalledTimes(1);
  expect(flash).toHaveBeenCalledExactlyOnceWith('태그 "#cut" 를 7건에서 삭제했습니다.');
  // 취소하면 보내지 않는다
  confirm.mockReturnValueOnce(false);
  await actions.deleteTagEverywhere("cut");
  expect(mocks.deleteTag).toHaveBeenCalledTimes(1);
});
