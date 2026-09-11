// 그룹별 사용 모델 정책 — 앱 수준에서 하나만 구독하는 모듈 저장소(useModels·캔버스 모델 노드·제출 가드가 함께 읽는다).
//  · App 이 (워크스페이스 컨텍스트, 로그인 이메일, 서버) 를 configureModelPolicy 로 넣으면 키가 바뀔 때만 다시 조회한다.
//  · 조회는 GET /api/manage/credit-plan/my-models(로컬 허브 → 공유 서버 프록시). 구서버(라우트 없음)는 제한 없음.
//  · 서버가 주는 것은 **허용 목록**이고 빈 목록은 제한 없음이다 — 판정은 modelPolicyCore 의 modelAllowed/blockedModels 로만.
//  · 늦은 응답은 요청 순번 + 키 대조로 버린다(A→B→A 전환·포커스 재조회 역전 방지).
//  · 마지막 서버 값은 localStorage 에 남겨 재시작·오프라인에도 같은 목록을 쓴다(status=stale 로 '미확인' 표시).
//  · 갱신: 키 변경 · 창 포커스(30초 간격) · 10분 주기 · 같은 앱에서 매니저가 그룹을 저장한 직후(refreshModelPolicy).
import { useSyncExternalStore } from "react";
import { isHttpStatus, isRouteMissing } from "./http";
import { manageApi } from "./manageApi";
import { loadJSON, saveJSON } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";
import type { WorkspaceContext } from "../types";
import {
  appliedFailure,
  appliedResponse,
  cacheOf,
  initialState,
  modelAllowed,
  NO_POLICY,
  policyKey,
  submitBlockMessage,
  type ModelPolicyCache,
  type ModelPolicyState,
} from "./modelPolicyCore";

const REFRESH_MS = 10 * 60_000;
const FOCUS_THROTTLE_MS = 30_000;
// ★'확인 중'으로 제출을 막아 두는 최대 시간(코덱스 배포 전 점검 P2). 정책은 공유 서버까지 갔다
//  오는데, 서버가 멎으면 프록시 소켓 시간제한(60초)까지 생성이 막힌다. 그때까지 기다리게 두지
//  않고 '제한 없음'으로 열어 준다 — 조회 자체는 계속 살아 있어, 늦게라도 답이 오면 그때 반영한다.
//  캐시가 있으면 애초에 stale 로 시작해 안 막히므로, 이 길은 프로필을 처음 쓰는 순간에만 쓰인다.
const LOADING_BLOCK_MS = 8_000;

let state: ModelPolicyState = NO_POLICY;
let workspaceId = "";
let seq = 0;
let lastFetchAt = 0;
let timer: number | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

// v2 = 허용 목록 형식({allowed:[]}). 옛 v1 캐시({restricted:[]})는 뜻이 반대라 읽지 않고 버린다.
function cacheKey(key: string): string {
  return `${STORAGE_KEYS.modelPolicy}.v2:${key}`;
}

async function fetchPolicy(): Promise<void> {
  const key = state.key;
  if (!key) return;
  const mySeq = ++seq;
  lastFetchAt = Date.now();
  // 오래 걸리면 기다리기를 멈추고 연다. 응답이 오면 아래 try 가 그대로 덮어쓴다.
  const openUp = window.setTimeout(() => {
    if (mySeq !== seq || key !== state.key || state.status !== "loading") return;
    state = appliedFailure(state, key, "error");
    emit();
  }, LOADING_BLOCK_MS);
  try {
    const payload = await manageApi.creditPlanMyModels(workspaceId);
    if (mySeq !== seq || key !== state.key) return; // 늦은 응답(다른 키·더 새 요청이 있음)
    state = appliedResponse(state, key, payload, Date.now());
    const cache = cacheOf(state);
    if (cache) saveJSON(cacheKey(key), cache);
    emit();
  } catch (error) {
    if (mySeq !== seq || key !== state.key) return;
    const kind = isRouteMissing(error) ? "unsupported" : isHttpStatus(error, 401, 403) ? "auth" : "error";
    state = appliedFailure(state, key, kind);
    emit();
  } finally {
    window.clearTimeout(openUp);
  }
}

function armTimer(): void {
  if (timer != null) {
    window.clearInterval(timer);
    timer = null;
  }
  if (!state.key || typeof window === "undefined") return;
  timer = window.setInterval(() => {
    void fetchPolicy();
  }, REFRESH_MS);
}

/** App 이 신원·공간이 바뀔 때마다 부른다. 키가 같으면 아무것도 하지 않는다(재조회는 refreshModelPolicy). */
export function configureModelPolicy(input: {
  context: WorkspaceContext;
  email: string | null | undefined;
  serverKey: string;
}): void {
  const key = policyKey(input.context, input.email, input.serverKey);
  if (key === state.key) return;
  workspaceId = key ? (input.context.id || "").trim() : "";
  state = initialState(key, key ? loadJSON<ModelPolicyCache>(cacheKey(key)) : null);
  emit();
  armTimer();
  if (key) void fetchPolicy();
}

/** 같은 앱에서 매니저가 그룹을 저장했을 때 등 — 지금 키로 즉시 다시 조회. */
export function refreshModelPolicy(): void {
  if (!state.key) return;
  void fetchPolicy();
}

function onWindowFocus(): void {
  if (!state.key) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  if (Date.now() - lastFetchAt < FOCUS_THROTTLE_MS) return;
  void fetchPolicy();
}

if (typeof window !== "undefined") {
  window.addEventListener("focus", onWindowFocus);
  document.addEventListener("visibilitychange", onWindowFocus);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): ModelPolicyState {
  return state;
}

/** 컴포넌트용 — 정책 상태 구독. */
export function useModelPolicy(): ModelPolicyState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** 비컴포넌트(제출 함수 안 등)용 — 지금 상태 읽기. */
export function currentModelPolicy(): ModelPolicyState {
  return state;
}

export function isModelAllowed(model: string | null | undefined): boolean {
  return modelAllowed(state, model);
}

/** 제출 직전 가드 문구(통과면 null). 캔버스 Render·재생성·복구 재실행처럼 useModels 를 안 거치는 경로가 쓴다.
 *  forWorkspaceId 를 주면 그 공간의 요청이라는 뜻 — 지금 정책이 다른 공간 것이면 검사하지 않는다. */
export function modelBlockMessage(
  model: string | null | undefined,
  options: { modelLabel?: string; forWorkspaceId?: string | null } = {},
): string | null {
  return submitBlockMessage(state, model, options.modelLabel, options.forWorkspaceId);
}
