// @vitest-environment jsdom
// 계정을 바꿔도 편집 탭의 문서는 지우지 않는다(2026-10-10 점검 — P1).
//  개인 설정 정리(clearPersonalSettings)는 `ch.` 로 시작하는 것을 지운다. 편집 문서(`ch.editTimeline:<계정>:<프로젝트>:<폴더>`)는 계정별
//  네임스페이스인데도 같이 지워져, 다른 계정으로 잠깐 로그인했다 돌아오면 편집본이 통째로 사라졌다(브라우저에만 있고 백업이 없다).
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/lib/assetBroadcast", () => ({ postAssetSessionReset: vi.fn() }));

import { clearPersonalSettings } from "../src/lib/personalSettings";

beforeEach(() => localStorage.clear());

it("편집 문서·못 읽은 원문의 보관본·마지막으로 연 시퀀스는 남기고, 다른 개인 설정은 지운다", () => {
  const keep = {
    "ch.editTimeline:me@x:p1:e070": "{\"clips\":[1]}",
    "ch.editTimeline:other@x:p1:e070": "{\"clips\":[2]}", // 다른 계정의 것도 그 계정 것이다
    "ch.editTimeline:me@x:p1:e070.bad": "broken",
    "ch.editTimeline.last:me@x": "{\"projectId\":\"p1\",\"seq\":\"e070\"}",
    "ch.auth.token": "t",
  };
  const drop = { "ch.editTimeline.ui": "{}", "ch.filtersV2": "{}", "ch.promptHistory": "[]" };
  // 문서의 새 자리(2026-10-13)는 `ch.` 로 시작하지 않아 애초에 정리 대상이 아니다 — 편집 탭이 없던 옛 판의 정리도 건드리지 않는다
  const untouched = { "other.app": "1", "mvhub.editDoc:me@x:p1:e070": "{\"clips\":[3]}", "mvhub.editDoc:me@x:p1:e070.bad": "broken" };
  for (const [key, value] of Object.entries({ ...keep, ...drop, ...untouched })) localStorage.setItem(key, value);
  clearPersonalSettings();
  for (const [key, value] of Object.entries({ ...keep, ...untouched })) expect(localStorage.getItem(key), key).toBe(value);
  for (const key of Object.keys(drop)) expect(localStorage.getItem(key), key).toBeNull();
});

// Codex 43회차 — 캔버스 카드 소속의 '아직 못 보낸 빼기·되살리기' 대기열도 계정별(lib/sceneCardLinks)이다. 지우면 되살리기(Undo)를 보내지 못한 채
//  계정을 오간 뒤 DB 의 빼기 기록이 되살린 결과를 카드에서 다시 뺐다.
it("캔버스 카드 소속의 못 보낸 빼기·되살리기 대기열은 계정을 바꿔도 남는다", () => {
  const link = JSON.stringify([{ scene_id: "s1", card_id: "c1", generation_id: "g1" }]);
  const keep = {
    "ch.sceneCardRevives.v1.me%40x": link,
    "ch.sceneCardRemovals.v1.me%40x": link,
    "ch.sceneCardRevives.v1.other%40x": link,
  };
  for (const [key, value] of Object.entries(keep)) localStorage.setItem(key, value);
  localStorage.setItem("ch.sceneCardSomethingElse", "1");
  clearPersonalSettings();
  for (const [key, value] of Object.entries(keep)) expect(localStorage.getItem(key), key).toBe(value);
  expect(localStorage.getItem("ch.sceneCardSomethingElse")).toBeNull();
});
