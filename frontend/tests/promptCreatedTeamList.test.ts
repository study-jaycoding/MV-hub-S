// 새 생성물은 내 로컬 카드다 — 공유 & 리뷰 목록(팀 카드)에는 끼워 넣지 않는다.
// 제출 응답이 오기 전에 그 탭으로 가거나 편집 탭에서 폴더 창을 열면 목록은 공유 & 리뷰의 것이라, 그대로 넣으면 로컬 id 로
// 팀 요청(폴더 담기 등)이 나간다(Codex 코드 리뷰 2026-10-08).
import { expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: { deriveFrom: vi.fn(() => Promise.resolve()) } }));
vi.mock("../src/lib/libraryBroadcast", () => ({ postLibraryChanged: vi.fn() }));

import { usePromptCreatedActions } from "../src/lib/usePromptCreatedActions";
import type { Filters, Generation } from "../src/types";

const gen = (id: string) => ({ id }) as Generation;

it.each([["my", ["new", "old"]], ["compose", ["new", "old"]], ["team", ["old"]]] as const)(
  "%s 목록: 방금 만든 것을 %j 로 둔다 — 어느 쪽이든 다시 받는다",
  async (tab, expected) => {
    let gens = [gen("old")];
    const reload = vi.fn(() => Promise.resolve());
    const { handlePromptCreated } = usePromptCreatedActions({
      boardFocusIdRef: { current: null }, boardSelectedRef: { current: [] }, bumpBoard: vi.fn(),
      filtersRef: { current: { tab } as Filters }, flash: vi.fn(), reload,
      setGens: (action) => { gens = typeof action === "function" ? action(gens) : action; },
    });
    await handlePromptCreated([gen("new")]);
    expect(gens.map((item) => item.id)).toEqual(expected);
    expect(reload).toHaveBeenCalledTimes(1);
  },
);
