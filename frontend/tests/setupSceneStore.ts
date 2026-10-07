// 시험마다 씬 저장소를 비운다.
//
// 씬은 IndexedDB(sceneStore)에 있고, 그 모듈은 읽기를 동기로 주기 위해 **모듈 수준 캐시**를 들고 있다.
// 비우지 않으면 앞 시험이 저장한 씬이 다음 시험으로 새어, 시험 순서에 따라 결과가 달라진다.
// (종전에는 저장소가 localStorage 라 시험이 각자 쓰는 storage mock 으로 자연히 격리됐다.)
import { beforeEach } from "vitest";
import { resetSceneStoreForTest } from "../src/lib/sceneStore";

beforeEach(() => {
  resetSceneStoreForTest();
});
