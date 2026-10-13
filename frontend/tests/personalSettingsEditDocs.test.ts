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
  const untouched = { "other.app": "1" };
  for (const [key, value] of Object.entries({ ...keep, ...drop, ...untouched })) localStorage.setItem(key, value);
  clearPersonalSettings();
  for (const [key, value] of Object.entries({ ...keep, ...untouched })) expect(localStorage.getItem(key), key).toBe(value);
  for (const key of Object.keys(drop)) expect(localStorage.getItem(key), key).toBeNull();
});
