// 목록·위치 확인 요청의 제한 시간(Jay 결정 15A, 10-15) — 넘으면 실제로 끊고 이 글로 실패한다. 허브가 멎으면 목록 줄이 끝없이 막혔다.
//  목록은 같은 PC 의 허브가 답하므로 30초면 넉넉하다고 본다(재 본 값은 아님).
import { withRequestTimeout } from "./http";

export const LIBRARY_LIST_TIMEOUT_MS = 30_000;
export const LIBRARY_LIST_TIMEOUT_MESSAGE = "목록이 30초 동안 오지 않아 멈췄습니다 — 다시 받아 주세요";

export const timedLibraryRequest = <T,>(run: (signal: AbortSignal) => Promise<T>): Promise<T> =>
  withRequestTimeout(run, LIBRARY_LIST_TIMEOUT_MS, LIBRARY_LIST_TIMEOUT_MESSAGE);
