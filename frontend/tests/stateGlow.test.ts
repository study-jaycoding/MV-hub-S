// '방금 내가 상태를 바꾼 카드'의 빛(lib/stateGlow) — 켜지는 조건·꺼지는 조건·새로고침 뒤 유지.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ackStateGlow, armStateGlow, getStateGlowVersion, observeReviewStates, resetStateGlowForTest, stateGlowOf } from "../src/lib/stateGlow";

// vitest 기본 환경(node)엔 localStorage 가 없다 — 메모리 스텁(teamSeen.test.ts 와 같은 방식).
const mem = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => void mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};

const gen = (id: string, over: { shared?: boolean; is_held?: boolean; is_final?: boolean; job_id?: string | null } = {}) =>
  ({ id, job_id: null, shared: false, is_held: false, is_final: false, ...over });

beforeEach(() => { mem.clear(); resetStateGlowForTest(); vi.useRealTimers(); });

describe("stateGlow", () => {
  it("내가 바꾼 직후의 재조회에서 상태가 달라진 카드만 그 상태로 빛난다", () => {
    observeReviewStates([gen("a"), gen("b"), gen("c", { shared: true })]);
    armStateGlow(["a"]);
    observeReviewStates([gen("a", { shared: true }), gen("b"), gen("c", { shared: true })]);
    expect(stateGlowOf(gen("a", { shared: true }))).toBe("shared");
    expect(stateGlowOf(gen("b"))).toBeNull();
    expect(stateGlowOf(gen("c", { shared: true }))).toBeNull(); // 원래 공유였던 카드는 바뀐 게 없다
  });

  it("보류·최종도 같은 규칙 — 상태가 또 바뀌면 새 상태로 빛난다", () => {
    observeReviewStates([gen("a", { shared: true })]);
    armStateGlow(["a"]);
    observeReviewStates([gen("a", { shared: true, is_held: true })]);
    expect(stateGlowOf(gen("a", { shared: true, is_held: true }))).toBe("held");
    armStateGlow(["a"]);
    observeReviewStates([gen("a", { shared: true, is_final: true })]);
    expect(stateGlowOf(gen("a", { shared: true, is_final: true }))).toBe("final");
    expect(stateGlowOf(gen("a", { shared: true, is_held: true }))).toBeNull(); // 옛 상태의 기록은 무효
  });

  it("처음 보는 카드와, 내가 바꾸지 않은 변화(자동 새로고침으로 들어온 남의 변경)는 빛나지 않는다", () => {
    armStateGlow(["first"]);
    observeReviewStates([gen("first", { shared: true })]); // 비교할 이전 상태가 없다
    expect(stateGlowOf(gen("first", { shared: true }))).toBeNull();
    resetStateGlowForTest();
    observeReviewStates([gen("a")]);
    observeReviewStates([gen("a", { is_final: true, shared: true })]); // armed 아님
    expect(stateGlowOf(gen("a", { is_final: true, shared: true }))).toBeNull();
  });

  it("armed 창(20초)이 지나면 변화를 기록하지 않는다", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 21, 9, 0, 0));
    observeReviewStates([gen("a")]);
    armStateGlow(["a"]);
    vi.setSystemTime(new Date(2026, 8, 21, 9, 0, 21));
    observeReviewStates([gen("a", { shared: true })]);
    expect(stateGlowOf(gen("a", { shared: true }))).toBeNull();
  });

  it("선택(확인)하면 꺼지고, 빛나지 않던 카드의 확인은 아무것도 저장하지 않는다", () => {
    observeReviewStates([gen("a"), gen("b")]);
    armStateGlow(["a"]);
    observeReviewStates([gen("a", { shared: true }), gen("b")]);
    const before = getStateGlowVersion();
    ackStateGlow([gen("b")]);
    expect(getStateGlowVersion()).toBe(before);
    ackStateGlow([gen("a"), gen("b")]);
    expect(getStateGlowVersion()).toBe(before + 1);
    expect(stateGlowOf(gen("a", { shared: true }))).toBeNull();
  });

  it("일반으로 돌아가면 기록이 지워져, 나중에 남이 다시 공유해도 빛나지 않는다", () => {
    observeReviewStates([gen("a")]);
    armStateGlow(["a"]);
    observeReviewStates([gen("a", { shared: true })]);
    observeReviewStates([gen("a")]); // 공유 해제
    resetStateGlowForTest(); // 새로고침 — 저장된 기록만 남는다
    expect(stateGlowOf(gen("a", { shared: true }))).toBeNull();
  });

  it("새로고침 뒤에도 선택 전까지 유지되고, 작업 공간(로컬 id)과 공유&리뷰(서버 id)가 job_id 로 같은 기록을 쓴다", () => {
    observeReviewStates([gen("local-1", { job_id: "job-9" })]);
    armStateGlow(["local-1"]);
    observeReviewStates([gen("local-1", { job_id: "job-9", shared: true })]);
    resetStateGlowForTest();
    expect(stateGlowOf(gen("server-uuid", { job_id: "job-9", shared: true }))).toBe("shared");
    ackStateGlow([gen("server-uuid", { job_id: "job-9" })]);
    expect(stateGlowOf(gen("local-1", { job_id: "job-9", shared: true }))).toBeNull();
  });

  // Codex 리뷰 P2 — '내가 바꾼 카드만': 후보가 아닌 카드가 같은 재조회에서 바뀌었어도(남이 바꾼 것·자동 새로고침) 빛나지 않는다.
  it("후보가 아닌 카드의 변화는 armed 중이어도 빛나지 않고, 실패해서 안 바뀐 후보도 빛나지 않는다", () => {
    observeReviewStates([gen("mine"), gen("failed"), gen("other")]);
    armStateGlow(["mine", "failed"]);
    observeReviewStates([gen("mine", { shared: true }), gen("failed"), gen("other", { shared: true })]);
    expect(stateGlowOf(gen("mine", { shared: true }))).toBe("shared");
    expect(stateGlowOf(gen("failed"))).toBeNull();
    expect(stateGlowOf(gen("other", { shared: true }))).toBeNull();
  });

  // Codex 리뷰 P2 — 작업 공간(로컬 행)과 공유&리뷰(서버 행)는 미러가 늦는 동안 잠깐 다른 상태일 수 있다. 탭만 바꿔도 '바뀜'으로 읽히면 안 된다.
  it("이전 상태는 탭별로 비교한다 — 탭 전환만으로 빛이 생기거나 기록이 지워지지 않는다", () => {
    observeReviewStates([gen("l", { job_id: "j" })], "my");
    armStateGlow(["l"]);
    observeReviewStates([gen("l", { job_id: "j", shared: true })], "my"); // 내가 공유 → 기록
    observeReviewStates([gen("s", { job_id: "j" })], "team"); // 팀 탭의 늦은 행(아직 미공유로 보임) — 처음 보는 탭이라 비교 없음
    expect(stateGlowOf(gen("l", { job_id: "j", shared: true }))).toBe("shared");
    observeReviewStates([gen("s", { job_id: "j", shared: true })], "team"); // 미러가 따라옴 — 후보(s)가 아니므로 새 기록도, 삭제도 없다
    expect(stateGlowOf(gen("l", { job_id: "j", shared: true }))).toBe("shared");
  });
});
