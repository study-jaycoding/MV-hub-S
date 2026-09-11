// 그룹별 제한 모델 정책 — 순수 도메인(React·API·저장소 의존 없음). 키 계산과 상태 전이만 둔다.
// 구독·조회·캐시는 modelRestrictions.ts 가 담당한다(테스트는 이 파일만 읽으면 된다).
//
// 뜻: 매니저가 크레딧 그룹에 적어 둔 "제한 모델"(힉스필드 User Group → Restricted Models 와 같은 차단 목록).
// 실제 강제는 힉스필드가 하고, 우리 앱은 모델 목록에서 숨기고 제출 직전에 막아 헛 시도를 줄인다(보안 통제 아님).
import type { WorkspaceContext } from "../types";

/** none=정책 대상 아님(개인 공간·미로그인) · loading=첫 조회 중(캐시 없음) · ready=서버 값 · stale=캐시로 표시 중(조회 중/실패)
 *  · unsupported=구서버(라우트 없음, 제한 없음으로 동작) · error=조회 실패(캐시가 있으면 그 값을 계속 쓴다). */
export type PolicyStatus = "none" | "loading" | "ready" | "stale" | "unsupported" | "error";

export interface ModelPolicyState {
  key: string; // `${서버}|${이메일}|${워크스페이스}` — 신원·공간이 바뀌면 다른 정책
  workspaceId: string; // 이 정책이 어느 워크스페이스 것인가(다른 공간의 요청에는 적용하지 않는다)
  status: PolicyStatus;
  restricted: ReadonlySet<string>;
  groupName: string | null;
  revision: number | null;
  fetchedAt: number | null; // ms
}

/** localStorage 에 남기는 마지막 서버 값 — 오프라인·재시작 직후에도 같은 목록을 보여 주기 위해. */
export interface ModelPolicyCache {
  restricted: string[];
  groupName: string | null;
  revision: number | null;
  fetchedAt: number;
}

export interface ModelPolicyPayload {
  restricted_models?: string[] | null;
  group_name?: string | null;
  revision?: number | null;
}

export const EMPTY_RESTRICTED: ReadonlySet<string> = new Set<string>();

export const NO_POLICY: ModelPolicyState = {
  key: "",
  workspaceId: "",
  status: "none",
  restricted: EMPTY_RESTRICTED,
  groupName: null,
  revision: null,
  fetchedAt: null,
};

/** 키에서 워크스페이스 id 만 — `${서버}|${이메일}|${워크스페이스}` 의 마지막 조각. */
export function workspaceOfKey(key: string): string {
  const at = key.lastIndexOf("|");
  return at < 0 ? "" : key.slice(at + 1);
}

/** 정책 키. 팀 공간 + 로그인 이메일일 때만 값이 있고, 개인·미확정 공간이나 미로그인은 ""(정책 없음). */
export function policyKey(
  context: WorkspaceContext,
  email: string | null | undefined,
  serverKey: string,
): string {
  if (context.scope !== "team") return "";
  const workspaceId = (context.id || "").trim();
  const mail = (email || "").trim().toLowerCase();
  if (!workspaceId || !mail) return "";
  return `${serverKey || ""}|${mail}|${workspaceId}`;
}

export function sameRestricted(a: ReadonlySet<string>, list: readonly string[]): boolean {
  if (a.size !== list.length) return false;
  for (const item of list) if (!a.has(item)) return false;
  return true;
}

/** 목록 → Set. 내용이 같으면 이전 Set 을 그대로 돌려줘(참조 동일) 소비자 effect 가 헛돌지 않게 한다. */
export function restrictedSet(
  list: readonly string[] | null | undefined,
  previous: ReadonlySet<string> = EMPTY_RESTRICTED,
): ReadonlySet<string> {
  const clean = Array.from(new Set((list || []).map((m) => String(m).trim().toLowerCase()).filter(Boolean)));
  if (sameRestricted(previous, clean)) return previous;
  return clean.length ? new Set(clean) : EMPTY_RESTRICTED;
}

/** 키가 정해졌을 때의 시작 상태 — 캐시가 있으면 stale(그 값으로 바로 거르고 조회), 없으면 loading. */
export function initialState(key: string, cache: ModelPolicyCache | null): ModelPolicyState {
  if (!key) return NO_POLICY;
  const workspaceId = workspaceOfKey(key);
  if (cache) {
    return {
      key,
      workspaceId,
      status: "stale",
      restricted: restrictedSet(cache.restricted),
      groupName: cache.groupName ?? null,
      revision: cache.revision ?? null,
      fetchedAt: cache.fetchedAt ?? null,
    };
  }
  return { key, workspaceId, status: "loading", restricted: EMPTY_RESTRICTED, groupName: null, revision: null, fetchedAt: null };
}

/** 서버 응답 반영. 다른 키의 늦은 응답은 무시한다(호출자가 순번도 따로 검사). */
export function appliedResponse(
  state: ModelPolicyState,
  key: string,
  payload: ModelPolicyPayload,
  now: number,
): ModelPolicyState {
  if (!key || key !== state.key) return state;
  return {
    key,
    workspaceId: state.workspaceId,
    status: "ready",
    restricted: restrictedSet(payload.restricted_models, state.restricted),
    groupName: payload.group_name ?? null,
    revision: payload.revision ?? null,
    fetchedAt: now,
  };
}

export type PolicyFailure = "unsupported" | "auth" | "error";

/** 조회 실패 반영. 구서버(unsupported)는 제한 없음으로 확정. 권한·통신 실패는 캐시 값을 유지하되 status 로 '미확인'을 드러낸다
 *  — 401/403 을 마지막 캐시의 정상 성공으로 보지 않는다(코덱스 P1). */
export function appliedFailure(state: ModelPolicyState, key: string, kind: PolicyFailure): ModelPolicyState {
  if (!key || key !== state.key) return state;
  if (kind === "unsupported") {
    return { ...state, status: "unsupported", restricted: EMPTY_RESTRICTED, groupName: null };
  }
  return { ...state, status: state.fetchedAt != null ? "stale" : "error" };
}

export function cacheOf(state: ModelPolicyState): ModelPolicyCache | null {
  if (state.status !== "ready" || state.fetchedAt == null) return null;
  return {
    restricted: Array.from(state.restricted),
    groupName: state.groupName,
    revision: state.revision,
    fetchedAt: state.fetchedAt,
  };
}

/** 모델 목록을 걸러도 되는가 — 첫 조회가 끝나기 전(loading)에는 워밍 프리페치 같은 부수 작업을 미룬다. */
export function policyReady(state: ModelPolicyState): boolean {
  return state.status !== "loading";
}

export function isRestricted(state: ModelPolicyState, model: string | null | undefined): boolean {
  return !!model && state.restricted.has(model);
}

/** 제출 직전 검사 문구. null 이면 통과. 첫 조회 중(캐시 없음)이면 잠시 보류, 제한 모델이면 그룹 이름과 함께 막는다.
 *  forWorkspaceId 를 주면 그 공간의 요청이라는 뜻 — 지금 정책이 다른 공간 것이면 검사하지 않는다(복구 재실행처럼
 *  원 생성물의 공간으로 나가는 요청에 지금 고른 공간의 제한을 씌우지 않게 — 코덱스 P1). */
export function submitBlockMessage(
  state: ModelPolicyState,
  model: string | null | undefined,
  modelLabel?: string,
  forWorkspaceId?: string | null,
): string | null {
  if (forWorkspaceId !== undefined && forWorkspaceId !== null && forWorkspaceId !== state.workspaceId) return null;
  if (state.status === "loading") return "그룹 모델 정책을 확인하는 중입니다. 잠시 후 다시 시도하세요.";
  if (isRestricted(state, model)) {
    const label = modelLabel || model;
    const group = state.groupName ? `'${state.groupName}' 그룹` : "그룹";
    return `${label} 모델은 ${group}에서 제한되어 있습니다. 다른 모델을 고르세요.`;
  }
  return null;
}

/** 정책을 지금 확신할 수 있는가 — stale(캐시로 표시 중)·error 면 화면에 '미확인'을 드러낸다(코덱스 P2). */
export function policyNote(state: ModelPolicyState): string | null {
  if (state.status === "stale") return "그룹 모델 정책이 마지막으로 받은 값입니다(다시 확인 중).";
  if (state.status === "error") return "그룹 모델 정책을 확인하지 못했습니다. 제한 모델이 그대로 보일 수 있습니다.";
  return null;
}
