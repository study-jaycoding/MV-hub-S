// @vitest-environment jsdom
// 에셋 끌기의 페이로드 읽기(lib/spotlightAssetRefs.readSpotlightAssetPayload).
// 2026-10-12(조작 점검 10회차, Codex 검토): dragstart 가 그 순간의 선택으로 만들어 localStorage 로 넘긴 한 건을, 0.15초 늦게 적히는
//  '저장된 선택'으로 다시 넓혀 — 방금 고르기에서 뺀 파일이 같이 붙었다.
import { beforeEach, expect, it } from "vitest";
import { readSpotlightAssetPayload } from "../src/lib/spotlightAssetRefs";
import { saveJSON, saveString } from "../src/lib/storage";
import { STORAGE_KEYS } from "../src/lib/storageKeys";

const item = (path: string) => ({ project: "p", path, name: path, type: "image" });
const transfer = (raw: string) => ({ getData: () => raw }) as unknown as DataTransfer;

beforeEach(() => localStorage.clear());

it("dragstart 가 넘긴 한 건은 저장된 옛 선택으로 넓히지 않는다", () => {
  saveJSON(STORAGE_KEYS.assetsSelection, [item("a.png"), item("b.png")]); // 늦게 적히는 선택 — 방금 b 를 뺐지만 아직 둘이다
  saveString(STORAGE_KEYS.assetsDrag, JSON.stringify([item("a.png")])); // dragstart 가 넘긴 완전한 값
  expect(JSON.parse(readSpotlightAssetPayload(transfer("")))).toEqual([item("a.png")]);
});

it("dragstart 가 넘긴 여러 건은 그대로다", () => {
  saveString(STORAGE_KEYS.assetsDrag, JSON.stringify([item("a.png"), item("b.png")]));
  expect(JSON.parse(readSpotlightAssetPayload(transfer(JSON.stringify([item("a.png")]))))).toEqual([item("a.png"), item("b.png")]);
});

it("localStorage 로 못 넘긴 경우(dataTransfer 폴백)에는 전처럼 선택 전체로 복구한다 — 창 사이 끌기에서 한 건만 넘어오는 브라우저", () => {
  saveJSON(STORAGE_KEYS.assetsSelection, [item("a.png"), item("b.png")]);
  expect(JSON.parse(readSpotlightAssetPayload(transfer(JSON.stringify([item("a.png")]))))).toEqual([item("a.png"), item("b.png")]);
  // 선택에 없는 파일을 끈 것이면 그 한 건만
  expect(JSON.parse(readSpotlightAssetPayload(transfer(JSON.stringify([item("c.png")]))))).toEqual([item("c.png")]);
});
