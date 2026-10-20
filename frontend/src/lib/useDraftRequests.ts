import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Generation } from "../types";
import type { SubmissionContext } from "../shared/contracts/generation";
import { isWatchingGeneration, seedPending, subscribeRecentDone } from "./sceneRecentDoneStore";

type DraftAttempt = {
  parentId: string;
  scope: Pick<SubmissionContext, "isCurrent">;
  childId?: string;
  checking?: boolean;
  terminal?: boolean;
};

export function useDraftRequests(generations: Generation[]) {
  const attempts = useRef(new Map<string, DraftAttempt>());
  const [, redraw] = useState(0);
  const current = useCallback((attempt: DraftAttempt) =>
    attempts.current.get(attempt.parentId) === attempt && attempt.scope.isCurrent?.() !== false, []);
  const release = useCallback((attempt: DraftAttempt) => {
    if (attempts.current.get(attempt.parentId) !== attempt) return;
    attempts.current.delete(attempt.parentId);
    redraw((version) => version + 1);
  }, []);
  const observe = useCallback((attempt: DraftAttempt, child: Generation) => {
    if (!current(attempt) || attempt.terminal || child.id !== attempt.childId || child.execution_phase === "recovery_required") return;
    if (child.status === "failed" || child.status === "nsfw") release(attempt);
    else if (child.status === "done") {
      attempt.terminal = true;
      redraw((version) => version + 1);
    }
  }, [current, release]);
  const checkSettled = useCallback(() => {
    for (const attempt of attempts.current.values()) {
      if (!current(attempt) || !attempt.childId || attempt.terminal || attempt.checking || isWatchingGeneration(attempt.childId)) continue;
      attempt.checking = true;
      // 기존 완료 감시가 종료를 알린 때만 사실을 조회한다. 시간초과·누락 자체로 재제출을 허용하지 않는다.
      void api.getGeneration(attempt.childId).then((child) => observe(attempt, child)).catch(() => {})
        .finally(() => { attempt.checking = false; });
    }
  }, [current, observe]);
  useEffect(() => {
    const off = subscribeRecentDone(checkSettled);
    return () => { off(); attempts.current.clear(); };
  }, [checkSettled]);
  useEffect(() => {
    for (const attempt of attempts.current.values()) {
      const child = generations.find((generation) => generation.id === attempt.childId);
      if (child) observe(attempt, child);
    }
  }, [generations, observe]);
  const begin = useCallback((parentId: string, scope: DraftAttempt["scope"]) => {
    const previous = attempts.current.get(parentId);
    if (previous && current(previous)) return null;
    const attempt: DraftAttempt = { parentId, scope };
    attempts.current.set(parentId, attempt);
    redraw((version) => version + 1);
    return attempt;
  }, [current]);
  const accept = useCallback((attempt: DraftAttempt, child: Generation) => {
    if (!current(attempt)) return;
    attempt.childId = child.id;
    observe(attempt, child);
    if (!current(attempt) || attempt.terminal) return;
    seedPending([child.id]);
    checkSettled();
  }, [checkSettled, current, observe]);
  const active = [...attempts.current.values()].filter(current);
  return { begin, accept, release,
    pending: new Set(active.filter((attempt) => !attempt.terminal).map((attempt) => attempt.parentId)),
    completed: new Set(active.filter((attempt) => attempt.terminal).map((attempt) => attempt.parentId)) };
}
