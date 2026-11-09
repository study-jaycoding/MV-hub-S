// 허브가 GET /api/auth/config 의 features 로 알린 기능 표식. 없거나 못 읽으면 빈 목록 — 그 기능을 쓰지 않는다.
//  request_retry_v1 = 생성·Comfy 요청을 답이 없을 때 같은 요청표로 한 번 더 보내도 되는 허브(계정 확인 + run_key 장부, Jay 결정 2A).
let features = new Set<string>();

export function setHubFeatures(list: unknown): void {
  features = new Set(Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []);
}

export const hubHasFeature = (name: string): boolean => features.has(name);

export const REQUEST_RETRY_FEATURE = "request_retry_v1";
export const COMFY_CANVAS_RUNS_FEATURE = "comfy_canvas_runs_v1";
/** Ask Agent 옆 칸 — 로컬 허브가 `CONTENT_HUB_AGENT_CHAT=1` 일 때만 알린다(docs/status/AskAgent_옆칸_설계_2026-11-09.md 10절). */
export const AGENT_CHAT_FEATURE = "agent_chat_v1";
/** 이 탭의 계정 범위(`acct:<email>` | `local`) — 허브가 그사이 다른 계정으로 바뀌었으면 실행 전에 거절한다(backend deps.expected_account_differs). */
export const EXPECT_ACCOUNT_HEADER = "X-MVHub-Expect-Account";
