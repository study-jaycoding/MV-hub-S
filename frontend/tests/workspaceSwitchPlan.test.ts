import { describe, expect, it } from "vitest";
import {
  canAdoptWorkspaceList,
  planSceneSwitch,
  queuedIsFresh,
  queuedStillApplies,
  settleSwitch,
} from "../src/lib/workspaceSwitchPlan";
import type { WorkspaceContext } from "../src/types";

const TEAM_B: WorkspaceContext = { scope: "team", id: "ws-b", name: "뻘뻘뻘" };
const TEAM_C: WorkspaceContext = { scope: "team", id: "ws-c", name: "R&D" };
const PERSONAL: WorkspaceContext = { scope: "personal", id: null, name: null };
const B = { id: "ws-b", name: "뻘뻘뻘" };
const C = { id: "ws-c", name: "R&D" };

describe("planSceneSwitch (씬 탭 클릭 → 전환 결정)", () => {
  it("지정 없는 씬은 어느 공간에서나 그냥 연다", () => {
    expect(
      planSceneSwitch({ assigned: undefined, context: TEAM_B, switching: false, failedWorkspaceId: null }),
    ).toEqual({ kind: "none" });
  });

  it("이미 그 공간이면 아무것도 하지 않는다", () => {
    expect(
      planSceneSwitch({ assigned: B, context: TEAM_B, switching: false, failedWorkspaceId: null }),
    ).toEqual({ kind: "none" });
  });

  it("이미 그 공간이어도 직전 전환이 실패했으면 다시 시도한다(같은 탭 재클릭 = 재시도)", () => {
    expect(
      planSceneSwitch({ assigned: B, context: TEAM_B, switching: false, failedWorkspaceId: "ws-b" }),
    ).toEqual({ kind: "start", target: B });
  });

  it("다른 공간이면 전환을 시작한다 — 개인 공간에서도", () => {
    expect(
      planSceneSwitch({ assigned: B, context: PERSONAL, switching: false, failedWorkspaceId: null }),
    ).toEqual({ kind: "start", target: B });
  });

  // ★이 시험이 옛 버그를 잡는다. 예전엔 전환 중 클릭이 그냥 버려져서(`if (switching) return`),
  //  씬은 C 것이 열렸는데 공간은 B 로 남아 그 캔버스에서 생성이 영영 막혔다.
  it("전환 중에 다른 공간의 씬을 누르면 버리지 않고 기다린다", () => {
    expect(
      planSceneSwitch({ assigned: C, context: TEAM_B, switching: true, failedWorkspaceId: null }),
    ).toEqual({ kind: "queue", target: C });
  });

  it("전환 중이어도 '이미 그 공간' 이면 새로 걸지 않는다 — 진행 중인 전환이 같은 대상이다", () => {
    expect(
      planSceneSwitch({ assigned: B, context: TEAM_B, switching: true, failedWorkspaceId: null }),
    ).toEqual({ kind: "none" });
  });

  it("공간 미확정(unknown)에서 지정 씬을 누르면 전환한다", () => {
    expect(
      planSceneSwitch({
        assigned: C,
        context: { scope: "unknown", id: null, name: null },
        switching: false,
        failedWorkspaceId: null,
      }),
    ).toEqual({ kind: "start", target: C });
  });
});

describe("queuedIsFresh (기다리던 의도가 아직 최신인가)", () => {
  it("담은 뒤 아무도 공간을 안 건드렸으면 최신이다", () => {
    expect(queuedIsFresh({ atEpoch: 7 }, 7)).toBe(true);
  });

  // ★B(전환 중) → C(대기) → 계정 메뉴로 D 선택. D 가 순번을 올리므로 C 는 낡았다.
  it("담은 뒤 다른 경로가 공간을 바꿨으면 낡았다", () => {
    expect(queuedIsFresh({ atEpoch: 7 }, 8)).toBe(false);
  });

  // ★반대로 D 를 고른 **뒤** 다시 C 를 눌렀다면 그 C 는 최신이라 실행해야 한다.
  it("바뀐 뒤에 다시 담은 것은 최신이다", () => {
    expect(queuedIsFresh({ atEpoch: 8 }, 8)).toBe(true);
  });

  it("담긴 것이 없으면 최신일 수 없다", () => {
    expect(queuedIsFresh(null, 3)).toBe(false);
    expect(queuedIsFresh(undefined, 3)).toBe(false);
  });
});

describe("settleSwitch (전환 한 건이 끝났을 때)", () => {
  it("성공하고 기다리는 것이 없으면 확정 — 여기서만 알림을 띄운다", () => {
    expect(settleSwitch({ queuedFresh: false, ok: true, stale: false })).toEqual({ kind: "confirm" });
  });

  it("실패하면 fail — 그 공간의 생성을 막는다", () => {
    expect(settleSwitch({ queuedFresh: false, ok: false, stale: false })).toEqual({ kind: "fail" });
  });

  // ★중간 단계에서 성공 알림을 띄우면 거짓이 된다 — 사용자는 이미 다음 씬을 보고 있다.
  it("최신 의도가 기다리면 성공이어도 알리지 않고 이어간다", () => {
    expect(settleSwitch({ queuedFresh: true, ok: true, stale: false })).toEqual({ kind: "run-queued" });
  });

  it("최신 의도가 기다리면 실패여도 이어간다 — 마지막 선택이 사용자의 뜻이다", () => {
    expect(settleSwitch({ queuedFresh: true, ok: false, stale: false })).toEqual({ kind: "run-queued" });
  });

  // ★이 시험이 코덱스 반례를 고정한다. 계정 메뉴가 D 를 고른 뒤 옛 B 응답이 도착하면, 낡은 C 의도를
  //  이어가면 안 된다 — 그러면 사용자의 마지막 선택 D 를 C 가 덮는다.
  it("낡은 의도밖에 없고 공간이 또 바뀌었으면 버린다 — 마지막 선택을 덮지 않게", () => {
    expect(settleSwitch({ queuedFresh: false, ok: true, stale: true })).toEqual({ kind: "drop" });
  });

  // ★바뀐 뒤 다시 담은 의도는 stale 이어도 이어간다(그 의도가 사용자의 마지막 뜻이다).
  it("최신 의도는 stale 보다 앞선다", () => {
    expect(settleSwitch({ queuedFresh: true, ok: true, stale: true })).toEqual({ kind: "run-queued" });
  });
});

describe("queuedStillApplies (담아 둔 의도가 아직 그 자리인가)", () => {
  const QUEUED = { sceneId: "s-c", target: C };

  it("그 씬이 아직 열려 있고 지정도 그대로면 유효하다", () => {
    expect(queuedStillApplies(QUEUED, "s-c", C)).toBe(true);
  });

  // ★코덱스 재현: B 전환 중 → C 씬 클릭으로 C 대기 → 그 C 씬을 삭제 → 앱이 다른 씬으로 옮김
  //  → B 응답 도착 → 존재하지도 않는 C 의 공간으로 넘어갔다.
  it("그 씬을 떠났으면(삭제·자동 이동) 유령 의도다", () => {
    expect(queuedStillApplies(QUEUED, "s-b", B)).toBe(false);
    expect(queuedStillApplies(QUEUED, null, undefined)).toBe(false);
  });

  it("그 사이 그 씬의 지정이 바뀌었으면 낡은 의도다", () => {
    expect(queuedStillApplies(QUEUED, "s-c", B)).toBe(false);
    expect(queuedStillApplies(QUEUED, "s-c", undefined)).toBe(false);
  });

  it("담긴 것이 없으면 유효할 수 없다", () => {
    expect(queuedStillApplies(null, "s-c", C)).toBe(false);
  });
});

describe("canAdoptWorkspaceList (늦게 온 CLI 목록을 채택해도 되는가)", () => {
  const BASE = {
    startedEpoch: 7,
    currentEpoch: 7,
    startedSwitchGen: 3,
    currentSwitchGen: 3,
    startedWhileSwitching: false,
    switchingNow: false,
  };

  it("아무 일도 없었으면 채택한다", () => {
    expect(canAdoptWorkspaceList(BASE)).toBe(true);
  });

  it("전환 직후의 직접 반영(startedEpoch 없음)은 언제나 채택한다", () => {
    expect(canAdoptWorkspaceList({ ...BASE, startedEpoch: undefined })).toBe(true);
  });

  it("지금 전환이 돌고 있으면 CLI 는 아직 옛 공간이다 — 채택하지 않는다", () => {
    expect(canAdoptWorkspaceList({ ...BASE, switchingNow: true })).toBe(false);
  });

  // ★코덱스 재현: 메뉴 재열기 조회가 전환 중 시작 → 전환이 먼저 끝남(ref 해제, 순번 그대로)
  //  → 늦게 온 옛 목록이 채택돼 앱이 B 에서 A 로 되돌아갔다. 전환 순번이 이것을 잡는다.
  it("조회를 시작한 뒤 전환이 끼었으면 그 응답은 옛 값이다", () => {
    expect(canAdoptWorkspaceList({ ...BASE, startedSwitchGen: 3, currentSwitchGen: 5 })).toBe(false);
  });

  it("조회 뒤 공간이 바뀌었으면 채택하지 않는다(기존 규칙 유지)", () => {
    expect(canAdoptWorkspaceList({ ...BASE, startedEpoch: 7, currentEpoch: 8 })).toBe(false);
  });

  // ★씬 전환이 **실패**로 끝나면 공간 순번이 안 오른다. 그때 전환 순번을 올리는 effect 가 늦게
  //  돌면 epoch·순번·switchingNow 가 모두 '깨끗'해 보여 옛 목록이 통과한다(코덱스 3차).
  //  시작 시점 판정은 그 타이밍에 기대지 않는다.
  it("조회를 시작할 때 이미 전환 중이었으면, 뒤에 다 깨끗해 보여도 채택하지 않는다", () => {
    expect(canAdoptWorkspaceList({ ...BASE, startedWhileSwitching: true })).toBe(false);
  });
});
