// @vitest-environment jsdom
// 목록 다시 받기가 방금 칠한 색을 덮지 않는다(2026-10-10).
//  목록 응답은 '출발할 때의 서버 값'이다. 색 키 뒤에 도착한 낡은 응답이 화면을 직전 색으로 되돌리면, 다음 색 키는 그 낡은 값을 기준으로
//  토글을 계산해 **틀린 색을 저장**한다. 격리 브라우저 실측: 색 키를 0.4초 간격으로 이으면 80번 중 11번 직전 색으로 돌아갔고(색 저장의
//  통보로 0.8초 뒤 도는 재조회가 두 번 뒤 키와 겹친다), g×9 직후 r g b r g 의 끝이 초록이 아니라 '색 없음'으로 저장됐다.
//  규칙(씬의 색 장부와 같다): 조회 출발 뒤에 칠했거나 저장이 대기 중인 카드는 화면의 색을 지키고, 나머지 필드는 응답대로 받는다.
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { KEY_COLORS } from "../src/lib/appConstants";
import { useGenerationKeyboardActions } from "../src/lib/useGenerationKeyboardActions";
import { useGenerationLibraryData } from "../src/lib/useGenerationLibraryData";
import type { Filters, GenQuery, Generation } from "../src/types";

vi.mock("../src/api", () => ({ GEN_PAGE: 200, api: {
  listGenerations: vi.fn(), projects: vi.fn(), facets: vi.fn(), generationStats: vi.fn(), listTrash: vi.fn(), locateGenerations: vi.fn(),
  setColorsBatch: vi.fn(),
} }));

const QUERY: GenQuery = { tab: "my" };
const gen = (id: string, color: string | null, prompt = "p") => ({
  id, sort_ts: 10, status: "done", assets: [], tags: [], auto_tags: [], color, prompt,
}) as unknown as Generation;

let root: Root;
let host: HTMLDivElement;
let data: ReturnType<typeof useGenerationLibraryData>;
function Harness() {
  const filters: Filters = { tab: "my" };
  data = useGenerationLibraryData({ authReady: true, filters, genQuery: QUERY, flash: () => {} });
  const filtersRef = useRef(filters);
  const selectedRef = useRef(new Set(["g1"]));
  // App 과 같은 배선 — 목록 훅의 gens·색 장부를 키보드 훅에 넘긴다.
  useGenerationKeyboardActions({
    clearSelect: () => {}, filtersRef, flash: () => {}, gensRef: data.gensRef, reload: data.reload, selectedRef, setGens: data.setGens,
    colorLedger: data.colorLedger,
  });
  return null;
}
// 조회는 시험이 직접 부른다 — 자동 재조회가 끼면 멈춰 둔 응답이 '낡은 실행'으로 버려져 덮는 경로를 못 본다.
const mount = async () => { act(() => root.render(<Harness />)); await act(async () => { await data.reload(); }); await settle(); };
const settle = async () => { await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); }); };
const press = (key: string) => act(() => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
const color = () => data.gens.find((g) => g.id === "g1")?.color ?? null;
const saved = () => vi.mocked(api.setColorsBatch).mock.calls.map((call) => call[1]);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const call of Object.values(api)) vi.mocked(call as () => unknown).mockReset();
  vi.mocked(api.listGenerations).mockResolvedValue([gen("g1", null)]);
  vi.mocked(api.projects).mockResolvedValue({ projects: [], unassigned: 0 } as never);
  vi.mocked(api.facets).mockResolvedValue({ tags: [], auto_tags: [], models: [] } as never);
  vi.mocked(api.generationStats).mockResolvedValue({ failed_count: 0, has_unread: false } as never);
  vi.mocked(api.locateGenerations).mockResolvedValue(null as never);
  vi.mocked(api.setColorsBatch).mockResolvedValue({ succeeded: ["g1"], failed: [] } as never);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("색 키보다 먼저 출발한 재조회의 응답이 방금 칠한 색을 덮지 않는다 — 다음 키의 토글 기준도 틀어지지 않는다", async () => {
  await mount();
  expect(color()).toBeNull();

  // 재조회가 출발했다(응답은 아직) — 색 저장의 통보로 0.8초 뒤 도는 것, 주기 조회, 다른 저장 뒤의 재조회 모두 같은 길이다
  const held = deferred<Generation[]>();
  vi.mocked(api.listGenerations).mockReturnValueOnce(held.promise);
  act(() => { void data.reload(true); });
  press("r"); // 화면은 바로 빨강, 저장도 끝난다
  await settle();
  expect(color()).toBe(KEY_COLORS.r);
  expect(saved()).toEqual([KEY_COLORS.r]);

  // 낡은 응답(출발할 때의 서버 값 = 색 없음)이 도착한다 — 색은 지키고 다른 필드는 받는다
  await act(async () => { held.resolve([gen("g1", null, "새 프롬프트")]); });
  await settle();
  expect(color()).toBe(KEY_COLORS.r);
  expect(data.gens[0].prompt).toBe("새 프롬프트");

  press("r"); // 빨강인 카드에 r = 해제. 낡은 값(색 없음)이 기준이었다면 빨강을 또 저장한다
  await settle();
  expect(color()).toBeNull();
  expect(saved()).toEqual([KEY_COLORS.r, null]);
});

it("저장이 끝난 뒤에 출발한 재조회는 서버 값을 그대로 받는다 — 보호가 다른 곳의 변경을 영영 막지 않는다", async () => {
  await mount();
  press("r");
  await settle();
  expect(color()).toBe(KEY_COLORS.r);
  vi.mocked(api.listGenerations).mockResolvedValueOnce([gen("g1", KEY_COLORS.b)]); // 다른 창에서 파랑으로 바꿨다
  await act(async () => { await data.reload(true); });
  await settle();
  expect(color()).toBe(KEY_COLORS.b);
});

it("저장이 대기 중인 동안 출발한 재조회도 덮지 않는다 — 저장이 실패하면 복구 재조회가 서버 값으로 되돌린다", async () => {
  await mount();
  const save = deferred<{ succeeded: string[]; failed: string[] }>();
  vi.mocked(api.setColorsBatch).mockReturnValueOnce(save.promise as never);
  press("g"); // 저장은 아직 대기
  await settle();
  await act(async () => { await data.reload(true); }); // 대기 중에 출발·도착한 재조회(서버는 아직 색 없음)
  await settle();
  expect(color()).toBe(KEY_COLORS.g);
  await act(async () => { save.resolve({ succeeded: [], failed: ["g1"] }); }); // 저장 실패 → 복구 재조회(서버 값 = 색 없음)
  await settle();
  expect(color()).toBeNull();
});
