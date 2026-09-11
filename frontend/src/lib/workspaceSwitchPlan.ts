// 씬 탭을 눌렀을 때 워크스페이스 전환을 어떻게 다룰지 정하는 순수 규칙(React·API 의존 없음).
//
// 왜 따로 있나(Jay 2026-09-11): 전환 한 번이 CLI 왕복 두 번이라 1초 넘게 걸린다. 그동안 사용자가
// 다른 씬 탭을 누르면 예전 코드는 `if (switching) return` 으로 **그 클릭의 전환 의도를 버렸다**.
// 씬은 열리고 공간은 안 바뀌어서, 그 캔버스에서 생성이 막힌 채(sceneWorkspaceBlock) 스스로 풀리지
// 않는 어긋난 상태가 남았다. 여기서는 버리지 않고 '기다렸다 이어간다'로 정한다.
import type { SceneWorkspace } from "./sceneWorkspace";
import type { WorkspaceContext } from "../types";

/** 씬 탭 클릭에 대한 결정.
 *
 *  ★`none` 은 "아무것도 안 함" 이 아니라 **"여기 그대로"** 라는 뜻이다 — 기다리던 의도가 있으면
 *   지워야 한다. 안 지우면 B(전환 중)→C(대기)→B(다시 클릭) 에서, 사용자는 B 씬을 보고 있는데
 *   B 가 끝난 뒤 대기하던 C 로 넘어간다(코덱스 리뷰에서 재현). */
export type SwitchPlan =
  /** 바꿀 것이 없다 — 지정이 없거나 이미 그 공간이고 실패 기록도 없다. 기다리던 의도는 버린다. */
  | { kind: "none" }
  /** 지금 전환을 시작한다. */
  | { kind: "start"; target: SceneWorkspace }
  /** 진행 중인 전환이 있다 — 끝나면 이 대상으로 이어간다. */
  | { kind: "queue"; target: SceneWorkspace };

export function planSceneSwitch(input: {
  /** 이 씬에 지정된 공간(없으면 undefined). */
  assigned: SceneWorkspace | undefined;
  /** 지금 앱이 보고 있는 공간. */
  context: WorkspaceContext;
  /** 전환이 진행 중인가. */
  switching: boolean;
  /** 직전 CLI 전환이 실패한 공간 id(없으면 null). */
  failedWorkspaceId: string | null;
}): SwitchPlan {
  const { assigned, context, switching, failedWorkspaceId } = input;
  if (!assigned) return { kind: "none" }; // 지정 없는 씬은 어느 공간에서나 연다
  const already = context.scope === "team" && (context.id || "") === assigned.id;
  // 이미 그 공간이어도 **직전 전환이 실패했으면** 다시 시도한다(같은 탭 재클릭 = 재시도).
  //  전환 중이라 아직 확인 전일 수도 있지만, 그 전환이 같은 대상을 향하므로 새로 걸 필요가 없다.
  if (already && failedWorkspaceId !== assigned.id) return { kind: "none" };
  if (switching) return { kind: "queue", target: assigned };
  return { kind: "start", target: assigned };
}

/** 기다리던 의도를 지금 실행해도 되는가.
 *
 *  담아 둔 뒤 공간이 또 바뀌었으면(계정 메뉴·다른 탭) 그 의도는 낡았다 — 사용자의 마지막 뜻이
 *  아니다. 반대로 **바뀐 뒤에 다시 담은 것**은 최신이므로 실행해야 한다. 그래서 '담은 시점의
 *  변경 순번' 을 현재와 맞대 본다(코덱스 리뷰: stale 을 무조건 앞세우면 그 경우를 잘못 버린다).
 *
 *  담는 것 자체는 공간을 바꾸지 않아 순번을 올리지 않는다 — 그래서 같은 값이면 '그 사이 아무도
 *  공간을 안 건드렸다' 는 뜻이 된다. */
export function queuedIsFresh(
  queued: { atEpoch: number } | null | undefined,
  currentEpoch: number,
): boolean {
  return !!queued && queued.atEpoch === currentEpoch;
}

/** 담아 둔 의도가 **아직 그 자리인가** — 그 씬이 지금 열려 있고, 지정도 그대로인가.
 *
 *  ★순번(queuedIsFresh)만으로는 부족하다. 순번이 증명하는 것은 '그 사이 공간이 안 바뀌었다'뿐이고,
 *   **씬 쪽 사정**은 증명하지 못한다. 씬 삭제·추가·가져오기는 씬 탭 클릭 관문을 거치지 않고 바로
 *   다른 씬으로 옮기므로(useSceneCoordination), 담아 둔 의도가 **사라진 씬의 것**으로 남을 수 있다.
 *   실제로 B(전환 중)→C 대기→C 삭제→자동으로 B 로 이동→B 응답 도착 순서에서, 존재하지도 않는 C 의
 *   공간으로 넘어갔다(코덱스 재현). 그래서 실행 직전에 '지금'을 다시 본다. */
export function queuedStillApplies(
  queued: { sceneId: string; target: SceneWorkspace } | null | undefined,
  activeSceneId: string | null,
  activeAssigned: SceneWorkspace | undefined,
): boolean {
  if (!queued) return false;
  if (queued.sceneId !== activeSceneId) return false; // 그 씬을 떠났다(삭제·자동 이동 포함)
  return activeAssigned?.id === queued.target.id; // 그 사이 지정이 바뀌었을 수도 있다
}

/** CLI 워크스페이스 목록 응답을 '지금 선택' 으로 채택해도 되는가.
 *
 *  ★전환이 도는 동안 CLI 는 아직 옛 공간이다. 그때 시작된 조회는 **응답이 전환보다 늦게 와도**
 *   채택하면 안 된다 — '응답 시점에 전환 중인가' 만 보면, 전환이 먼저 끝난 뒤 도착한 옛 목록이
 *   사용자의 선택을 되돌린다(코덱스 재현: 앱이 B→A 로 되돌아감).
 *   그래서 '조회를 시작한 뒤 전환이 하나라도 끼었는가'를 순번으로 본다. */
export function canAdoptWorkspaceList(input: {
  /** 조회 시작 시점의 공간 변경 순번. undefined = 전환 직후의 직접 반영(언제나 채택). */
  startedEpoch: number | undefined;
  currentEpoch: number;
  /** 조회 시작 시점의 전환 순번(전환이 시작·종료할 때마다 오른다). */
  startedSwitchGen: number;
  currentSwitchGen: number;
  /** 조회를 **시작할 때** 이미 전환이 돌고 있었는가. 그랬다면 응답은 옛 CLI 값이다. */
  startedWhileSwitching: boolean;
  /** 지금 전환이 돌고 있는가(씬 탭이든 계정 메뉴든). */
  switchingNow: boolean;
}): boolean {
  if (input.startedEpoch === undefined) return true;
  // ★시작 시점 판정을 먼저 본다 — 순번만 믿으면, 씬 전환이 **실패**로 끝났을 때(공간 순번이 안 오른다)
  //  순번을 올리는 effect 가 늦게 돌아 그 사이 도착한 옛 목록이 통과할 수 있다(코덱스 3차).
  if (input.startedWhileSwitching) return false;
  if (input.switchingNow) return false;
  if (input.startedSwitchGen !== input.currentSwitchGen) return false;
  return input.startedEpoch === input.currentEpoch;
}

/** 전환 한 건이 끝났을 때 무엇을 할지. */
export type SwitchSettlement =
  /** 기다리던 다음 대상으로 이어간다 — 중간 단계라 알림은 띄우지 않는다. */
  | { kind: "run-queued" }
  /** 확정 — 알림을 띄운다. */
  | { kind: "confirm" }
  /** 실패 — 그 공간의 생성을 막고 알린다. */
  | { kind: "fail" }
  /** 늦게 온 옛 응답 — 아무것도 하지 않는다. */
  | { kind: "drop" };

export function settleSwitch(input: {
  /** 기다리는 다음 대상이 **아직 최신인가**(queuedIsFresh 결과). 낡은 것은 호출부가 버린다. */
  queuedFresh: boolean;
  /** CLI 전환이 성공했는가(하우스 계정이 아니라 403 인 경우도 성공으로 본다). */
  ok: boolean;
  /** 이 요청을 시작한 뒤 공간이 또 바뀌었는가. */
  stale: boolean;
}): SwitchSettlement {
  // 최신 의도가 기다리고 있으면 성패와 무관하게 이어간다 — 그게 사용자가 마지막에 고른 공간이다.
  //  ★중간 단계에서 알림을 띄우면 거짓이 된다: 사용자는 이미 다른 씬을 보고 있다.
  if (input.queuedFresh) return { kind: "run-queued" };
  // 낡은 의도밖에 없는데 그 사이 공간이 바뀌었다면, 이 응답도 늦게 온 옛 것이다.
  if (input.stale) return { kind: "drop" };
  return input.ok ? { kind: "confirm" } : { kind: "fail" };
}
