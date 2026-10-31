import { useEffect, useRef } from "react";
import type { CanvasDocumentPort } from "../features/canvas/api";
import { getAccountNamespace, getConnectionKey } from "./accountScope";
import { comfyApi } from "./comfyApi";
import type { ComfyApplicationReceipt, ComfyCanvasRun } from "./comfyRunState";
import { COMFY_CANVAS_RUNS_FEATURE, hubHasFeature } from "./hubFeatures";
import { getApiPause, getAuthToken } from "./http";
import { isCanvasFloating } from "./popupWindows";
import { listScenes, type Scene } from "./scenes";
import { isComfyAttemptActive } from "./sceneComfyRunningStore";

// 다른 창이 닫히며 보낸 요청이 늦게 접수될 여유를 두고, 서로 다른 조회에서 두 번 확인한다.
const NOT_FOUND_GRACE_MS = 30_000;
type MissingObservation = { since: number; attempt: string };

const listeners = new Set<() => void>();
export function notifyCanvasComfyRuns(): void { listeners.forEach(listener => listener()); }

const sameReceipt = (run: ComfyCanvasRun | undefined, receipt: ComfyApplicationReceipt) => run?.localState === "applied"
  && run.attemptId === receipt.attemptId && run.receipt?.resultRevision === receipt.resultRevision
  && run.receipt.disposition === receipt.disposition;

/** 한 주기의 저장/ACK 경계. 살아 있는 Board나 현재 선택된 씬에 의존하지 않는다. */
export async function recoverCanvasComfyRuns(options: {
  canvasDocument: CanvasDocumentPort;
  canWrite: () => boolean;
  scenes?: () => Scene[];
  api?: Pick<typeof comfyApi, "canvasOrigin" | "resolveCanvasRuns" | "ackCanvasRun">;
  missingObservations?: Map<string, MissingObservation>;
  now?: () => number;
}): Promise<void> {
  const api = options.api || comfyApi;
  const scenes = options.scenes || (() => listScenes(null));
  const missing = options.missingObservations || new Map<string, MissingObservation>();
  const now = options.now || Date.now;
  const accountNamespace = getAccountNamespace(), connection = getConnectionKey(), token = getAuthToken();
  const current = () => options.canWrite() && accountNamespace === getAccountNamespace()
    && connection === getConnectionKey() && token === getAuthToken() && !getApiPause() && !isCanvasFloating();
  if (!current() || !scenes().some(scene => scene.comfyRuns?.length)) return;
  const origin = await api.canvasOrigin();
  if (!current()) return;
  const own = (run: ComfyCanvasRun) => run.originHubId === origin.hub_id && run.originDeviceId === origin.device_id;
  for (const scene of scenes()) {
    if (!current()) return;
    const target = { accountNamespace, sceneId: scene.id };
    const snapshot = () => options.canvasDocument.snapshot(target);
    const persisted = () => options.canvasDocument.snapshot(target, true);
    for (const run of scene.comfyRuns || []) {
      if (own(run)) continue;
      if (!current()) return;
      await options.canvasDocument.commit(target, { type: "resolveComfy", canWrite: current, resolution: {
        attempt_id: run.attemptId, state: "origin_mismatch", result_revision: 0, outputs: [],
        origin: { hub_id: run.originHubId, device_id: run.originDeviceId },
      } }).confirmed;
    }
    const observationKey = (id: string) => JSON.stringify([accountNamespace, connection, origin, scene.id, id]);
    const ids = (snapshot()?.comfyRuns || []).filter(own).filter(run => {
      if (!isComfyAttemptActive(accountNamespace, run.attemptId)) return true;
      missing.delete(observationKey(run.attemptId));
      return false;
    }).map(run => run.attemptId);
    for (let offset = 0; offset < ids.length; offset += 100) {
      if (!current()) return;
      const resolutions = await api.resolveCanvasRuns(ids.slice(offset, offset + 100));
      if (!current()) return;
      const seen = new Set<string>();
      for (const resolution of resolutions.runs) {
        if (!current()) return;
        if (resolution.origin.hub_id !== origin.hub_id || resolution.origin.device_id !== origin.device_id
          || !ids.includes(resolution.attempt_id) || seen.has(resolution.attempt_id)) continue;
        seen.add(resolution.attempt_id);
        const key = observationKey(resolution.attempt_id);
        if (isComfyAttemptActive(accountNamespace, resolution.attempt_id)) { missing.delete(key); continue; }
        if (resolution.state === "not_found") {
          const attempt = snapshot()?.comfyRuns?.find(run => run.attemptId === resolution.attempt_id);
          if (!attempt || attempt.localState === "applied" || attempt.receipt) { missing.delete(key); continue; }
          // 전송을 시작한 기록은 시간만으로 지우지 않는다 — 서버의 not_found 는 입력을 복사 중일 수 있어 미접수의 증명이 아니다. 카드 안내로 남기고 사람이 다시 실행할 때 정리한다.
          if (attempt.localState === "reserved") {
            const fingerprint = JSON.stringify(attempt);
            const previous = missing.get(key);
            if (previous?.attempt === fingerprint && now() - previous.since >= NOT_FOUND_GRACE_MS) {
              const cleanup = options.canvasDocument.commit(target, { type: "discardUnsubmittedComfy", attempt,
                canWrite: () => current() && !isComfyAttemptActive(accountNamespace, attempt.attemptId) });
              if (cleanup.queued && await cleanup.confirmed) missing.delete(key);
              continue;
            }
            if (!previous || previous.attempt !== fingerprint) missing.set(key, { since: now(), attempt: fingerprint });
          } else missing.delete(key);
        } else missing.delete(key);
        const write = options.canvasDocument.commit(target, { type: "resolveComfy", resolution, canWrite: current });
        if (!write.queued || !await write.confirmed || !current()) continue;
        const run = snapshot()?.comfyRuns?.find(item => item.attemptId === resolution.attempt_id);
        const receipt = run?.receipt;
        if (!receipt || !sameReceipt(run, receipt)
          || !sameReceipt(persisted()?.comfyRuns?.find(item => item.attemptId === receipt.attemptId), receipt)) continue;
        try {
          const ack = await api.ackCanvasRun({ attempt_id: receipt.attemptId, result_revision: receipt.resultRevision, disposition: receipt.disposition });
          if (!current()) return;
          if (ack.state !== "linked" || ack.attempt_id !== receipt.attemptId || ack.result_revision !== receipt.resultRevision
            || ack.disposition !== receipt.disposition || ack.origin.hub_id !== origin.hub_id || ack.origin.device_id !== origin.device_id) continue;
          // 그 사이 새 revision이 반영되어도 이 영수증과 일치하는 항목만 지운다.
          const cleanup = options.canvasDocument.commit(target, { type: "ackComfy", receipt, canWrite: current });
          await cleanup.confirmed;
        } catch { /* ACK 응답 유실도 같은 영수증으로 다음 주기에 다시 확인한다. */ }
      }
    }
  }
}

export function useCanvasComfyRuns({ authReady, authKey = "", canvasDocument }: {
  authReady: boolean; authKey?: string; canvasDocument: CanvasDocumentPort;
}): void {
  const ready = useRef(authReady); ready.current = authReady;
  const scope = useRef(authKey); scope.current = authKey;
  useEffect(() => {
    let disposed = false, running = false;
    const missingObservations = new Map<string, MissingObservation>();
    const current = () => !disposed && ready.current && scope.current === authKey && hubHasFeature(COMFY_CANVAS_RUNS_FEATURE)
      && document.visibilityState !== "hidden" && !isCanvasFloating();
    const tick = async () => {
      if (running || !current()) return;
      running = true;
      try { await recoverCanvasComfyRuns({ canvasDocument, canWrite: current, missingObservations }); }
      catch { /* 일시 연결 실패로 실행 기록을 지우지 않는다. */ }
      finally { running = false; }
    };
    const wake = () => { void tick(); };
    listeners.add(wake);
    document.addEventListener("visibilitychange", wake);
    const timer = window.setInterval(wake, 2500);
    wake();
    return () => { disposed = true; clearInterval(timer); listeners.delete(wake); document.removeEventListener("visibilitychange", wake); };
  }, [canvasDocument, authReady, authKey]);
}
