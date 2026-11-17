import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Generation } from "../types";
import { DRAFT_ACTIVE_PHASES, draftRequestKey, type DraftResolution } from "./seedanceDraft";
import type { SubmissionContext } from "../shared/contracts/generation";
import { isWatchingGeneration, seedPending, subscribeRecentDone } from "./sceneRecentDoneStore";

type DraftAttempt = {
  key: string;
  scope: Pick<SubmissionContext, "isCurrent">;
  childId?: string;
  checking?: boolean;
  recheck?: () => Promise<void>;
  rechecking?: boolean;
};

export function useDraftRequests(generations: Generation[]) {
  const attempts = useRef(new Map<string, DraftAttempt>());
  const [revision, redraw] = useState(0);
  const current = useCallback((attempt: DraftAttempt) =>
    attempts.current.get(attempt.key) === attempt && attempt.scope.isCurrent?.() !== false, []);
  const release = useCallback((attempt: DraftAttempt) => {
    if (attempts.current.get(attempt.key) !== attempt) return;
    attempts.current.delete(attempt.key);
    redraw((version) => version + 1);
  }, []);
  const observe = useCallback((attempt: DraftAttempt, child: Generation) => {
    if (!current(attempt) || child.id !== attempt.childId || (child.execution_phase && DRAFT_ACTIVE_PHASES.has(child.execution_phase))) return;
    if (["done", "failed", "nsfw"].includes(child.status)) release(attempt);
  }, [current, release]);
  const checkSettled = useCallback(() => {
    for (const attempt of attempts.current.values()) {
      if (!current(attempt) || !attempt.childId || attempt.checking || isWatchingGeneration(attempt.childId)) continue;
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
  const begin = useCallback((parentId: string, jobId: string, resolution: DraftResolution, scope: DraftAttempt["scope"]) => {
    const key = draftRequestKey(parentId, jobId, resolution);
    const previous = attempts.current.get(key);
    if (previous && current(previous)) return null;
    const attempt: DraftAttempt = { key, scope };
    attempts.current.set(key, attempt);
    redraw((version) => version + 1);
    return attempt;
  }, [current]);
  const recheck = useCallback(async (parentId: string, jobId: string, resolution: DraftResolution) => {
    const attempt = attempts.current.get(draftRequestKey(parentId, jobId, resolution));
    if (!attempt || !current(attempt)) return false;
    if (attempt.recheck && !attempt.rechecking) {
      attempt.rechecking = true;
      redraw((version) => version + 1);
      try { await attempt.recheck(); }
      finally { attempt.rechecking = false; redraw((version) => version + 1); }
    }
    return true;
  }, [current]);
  const retain = useCallback((attempt: DraftAttempt, retry: () => Promise<void>) => {
    if (!current(attempt)) return;
    attempt.recheck = retry;
    redraw((version) => version + 1);
  }, [current]);
  const accept = useCallback((attempt: DraftAttempt, child: Generation) => {
    if (!current(attempt)) return;
    attempt.recheck = undefined;
    attempt.childId = child.id;
    redraw((version) => version + 1);
    observe(attempt, child);
    if (!current(attempt)) return;
    seedPending([child.id]);
    checkSettled();
  }, [checkSettled, current, observe]);
  const active = [...attempts.current.values()].filter(current);
  return { begin, accept, release, recheck, retain, revision,
    pending: new Set(active.filter((attempt) => !attempt.recheck || attempt.rechecking).map((attempt) => attempt.key)),
    uncertain: new Set(active.filter((attempt) => attempt.recheck).map((attempt) => attempt.key)) };
}
