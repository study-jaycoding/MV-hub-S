import { describe, expect, it } from "vitest";
import {
  appliedFailure,
  appliedResponse,
  blockedModels,
  cacheOf,
  EMPTY_MODEL_SET,
  initialState,
  modelAllowed,
  modelSet,
  NO_POLICY,
  policyKey,
  policyNote,
  policyReady,
  submitBlockMessage,
  workspaceOfKey,
} from "../src/lib/modelPolicyCore";

const team = { scope: "team" as const, id: "ws1", name: "WS1" };

describe("policyKey — 팀 공간 + 로그인 이메일일 때만 정책", () => {
  it("개인·미확정 공간이나 이메일 없음은 빈 키", () => {
    expect(policyKey({ scope: "personal", id: null, name: null }, "a@x", "srv")).toBe("");
    expect(policyKey({ scope: "unknown", id: null, name: null }, "a@x", "srv")).toBe("");
    expect(policyKey(team, "", "srv")).toBe("");
    expect(policyKey({ ...team, id: " " }, "a@x", "srv")).toBe("");
  });
  it("서버·이메일(소문자)·워크스페이스로 키를 만든다 — 계정이나 서버가 바뀌면 다른 정책", () => {
    expect(policyKey(team, " A@X ", "https://s")).toBe("https://s|a@x|ws1");
    expect(policyKey(team, "a@x", "https://t")).not.toBe(policyKey(team, "a@x", "https://s"));
  });
});

describe("modelSet — 내용이 같으면 같은 Set 을 돌려준다", () => {
  it("정리(소문자·공백·중복)하고, 같으면 이전 참조 유지", () => {
    const first = modelSet([" Seedance_2_5", "seedance_2_5", "gpt_image_2"]);
    expect([...first]).toEqual(["seedance_2_5", "gpt_image_2"]);
    expect(modelSet(["gpt_image_2", "seedance_2_5"], first)).toBe(first);
    expect(modelSet([], first)).toBe(EMPTY_MODEL_SET);
    expect(modelSet(null)).toBe(EMPTY_MODEL_SET);
  });
});

describe("modelAllowed — 허용 목록이 비면 전부 허용", () => {
  const key = "srv|a@x|ws1";
  it("빈 목록은 제한 없음, 값이 있으면 그 안에 든 것만", () => {
    const none = initialState(key, null); // allowed 비어 있음
    expect(modelAllowed(none, "gpt_image_2")).toBe(true);
    expect(blockedModels(none, ["gpt_image_2", "seedance_2_5"])).toEqual([]);
    const only = appliedResponse(none, key, { allowed_models: ["gpt_image_2"] }, 1);
    expect(modelAllowed(only, "gpt_image_2")).toBe(true);
    expect(modelAllowed(only, "seedance_2_5")).toBe(false);
    expect(modelAllowed(only, "")).toBe(true); // 모델 미선택은 판정 대상이 아니다
    expect(blockedModels(only, ["gpt_image_2", "seedance_2_5"])).toEqual(["seedance_2_5"]);
  });
  it("부분 수정 전용 고정 모델은 허용 목록과 무관하게 늘 쓸 수 있다(재생성·복구가 막히지 않게)", () => {
    const only = appliedResponse(initialState(key, null), key, { allowed_models: ["gpt_image_2"] }, 1);
    expect(modelAllowed(only, "seedream_v5_pro")).toBe(true);
    expect(blockedModels(only, ["seedream_v5_pro", "seedance_2_5"])).toEqual(["seedance_2_5"]);
    expect(submitBlockMessage(only, "seedream_v5_pro")).toBeNull();
  });
});

describe("상태 전이 — 캐시·응답·실패·늦은 응답", () => {
  const key = "srv|a@x|ws1";
  it("키 없음 = 정책 없음, 캐시 없음 = loading, 캐시 있음 = stale(그 값으로 바로 거른다)", () => {
    expect(initialState("", null)).toBe(NO_POLICY);
    expect(initialState(key, null).status).toBe("loading");
    const stale = initialState(key, { allowed: ["seedance_2_5"], groupName: "Artist", revision: 3, fetchedAt: 10 });
    expect(stale.status).toBe("stale");
    expect(stale.allowed.has("seedance_2_5")).toBe(true);
    expect(policyReady(stale)).toBe(true);
    expect(policyReady(initialState(key, null))).toBe(false);
  });
  it("응답은 같은 키에만 반영되고 캐시로 남는다", () => {
    const loading = initialState(key, null);
    const ready = appliedResponse(loading, key, { allowed_models: ["gpt_image_2"], group_name: "TD", revision: 5 }, 100);
    expect(ready.status).toBe("ready");
    expect(ready.groupName).toBe("TD");
    expect(cacheOf(ready)).toEqual({ allowed: ["gpt_image_2"], groupName: "TD", revision: 5, fetchedAt: 100 });
    // 다른 키(공간 A→B→A 전환 중 옛 공간 응답)는 무시
    expect(appliedResponse(ready, "srv|a@x|ws2", { allowed_models: [] }, 200)).toBe(ready);
    expect(cacheOf(loading)).toBeNull();
  });
  it("구서버는 제한 없음으로 확정, 권한·통신 실패는 캐시 값을 지키되 미확인(stale/error)으로 표시", () => {
    const stale = initialState(key, { allowed: ["seedance_2_5"], groupName: "Artist", revision: 3, fetchedAt: 10 });
    const unsupported = appliedFailure(stale, key, "unsupported");
    expect(unsupported.status).toBe("unsupported");
    expect(unsupported.allowed.size).toBe(0); // 빈 목록 = 전부 사용
    const auth = appliedFailure(stale, key, "auth");
    expect(auth.status).toBe("stale");
    expect(auth.allowed.has("seedance_2_5")).toBe(true);
    expect(appliedFailure(initialState(key, null), key, "error").status).toBe("error");
    expect(appliedFailure(stale, "other", "error")).toBe(stale);
  });
});

describe("submitBlockMessage — 제출 직전 가드", () => {
  const key = "srv|a@x|ws1";
  it("첫 조회 중이면 보류, 못 쓰는 모델이면 그룹 이름과 함께 막고, 그 밖엔 통과", () => {
    expect(submitBlockMessage(initialState(key, null), "gpt_image_2")).toMatch(/확인하는 중/);
    const ready = appliedResponse(initialState(key, null), key, { allowed_models: ["nano_banana_flash"], group_name: "Artist" }, 1);
    expect(submitBlockMessage(ready, "gpt_image_2", "GPT Image 2")).toBe(
      "GPT Image 2 모델은 'Artist' 그룹에서 쓸 수 없습니다. 다른 모델을 고르세요.",
    );
    expect(submitBlockMessage(ready, "nano_banana_flash")).toBeNull();
    expect(submitBlockMessage(NO_POLICY, "gpt_image_2")).toBeNull();
    expect(submitBlockMessage(ready, "")).toBeNull();
  });
  it("다른 공간의 요청(복구 재실행)에는 지금 정책을 적용하지 않는다", () => {
    const ready = appliedResponse(initialState(key, null), key, { allowed_models: ["nano_banana_flash"], group_name: "Artist" }, 1);
    expect(ready.workspaceId).toBe("ws1");
    expect(workspaceOfKey(key)).toBe("ws1");
    expect(submitBlockMessage(ready, "gpt_image_2", undefined, "ws1")).toMatch(/쓸 수 없습니다/); // 같은 공간 = 검사
    expect(submitBlockMessage(ready, "gpt_image_2", undefined, "ws2")).toBeNull(); // 다른 공간 = 검사 안 함
    expect(submitBlockMessage(ready, "gpt_image_2", undefined, null)).toMatch(/쓸 수 없습니다/); // 모르면 지금 정책으로
    // 개인 공간 생성물(""): 팀 그룹 제한이 걸리지 않는다
    expect(submitBlockMessage(ready, "gpt_image_2", undefined, "")).toBeNull();
    // 첫 조회 중이라도 다른 공간이면 보류 문구를 내지 않는다
    expect(submitBlockMessage(initialState(key, null), "gpt_image_2", undefined, "ws2")).toBeNull();
  });
});

describe("policyNote — 정책을 확신할 수 없을 때만 알린다", () => {
  const key = "srv|a@x|ws1";
  it("stale·error 는 문구, ready·unsupported·none 은 없음", () => {
    const stale = initialState(key, { allowed: [], groupName: null, revision: 1, fetchedAt: 5 });
    expect(policyNote(stale)).toMatch(/마지막으로 받은 값/);
    expect(policyNote(appliedFailure(initialState(key, null), key, "error"))).toMatch(/확인하지 못했습니다/);
    expect(policyNote(appliedResponse(initialState(key, null), key, { allowed_models: [] }, 1))).toBeNull();
    expect(policyNote(appliedFailure(stale, key, "unsupported"))).toBeNull();
    expect(policyNote(NO_POLICY)).toBeNull();
  });
});
