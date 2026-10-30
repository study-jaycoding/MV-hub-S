import { useCallback, useEffect, useRef, useState } from "react";
import { APP_EVENTS } from "./appEvents";
import { comfyApi, type ComfyUnresolvedRun } from "./comfyApi";
import { COMFY_CANVAS_RUNS_FEATURE, hubHasFeature } from "./hubFeatures";
import { notifyCanvasComfyRuns } from "./useCanvasComfyRuns";
import { getAccountNamespace, getConnectionKey } from "./accountScope";
import { listScenes } from "./scenes";

// 카드 수명과 무관한 설정 목록. 서버 원장이 정답이며 새 생성 요청은 이 훅에서 호출하지 않는다.
export function useComfyUnresolvedRuns() {
  const [runs, setRuns] = useState<ComfyUnresolvedRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [foreignCount, setForeignCount] = useState(0);
  const epoch = useRef(0);
  const requestSeq = useRef(0);
  const occupied = useRef(false);

  const refresh = useCallback(async () => {
    const current = epoch.current;
    const seq = ++requestSeq.current;
    const account = getAccountNamespace(), connection = getConnectionKey();
    const valid = () => current === epoch.current && seq === requestSeq.current
      && account === getAccountNamespace() && connection === getConnectionKey();
    try {
      const result = await comfyApi.unresolvedRuns();
      if (!valid()) return;
      setRuns(result.runs); setError("");
      if (hubHasFeature(COMFY_CANVAS_RUNS_FEATURE) && listScenes(null).some(scene => scene.comfyRuns?.length)) {
        const origin = await comfyApi.canvasOrigin();
        if (valid()) setForeignCount(listScenes(null).flatMap(scene => scene.comfyRuns || [])
          .filter(run => run.originHubId !== origin.hub_id || run.originDeviceId !== origin.device_id).length);
      } else setForeignCount(0);
    } catch (reason) {
      if (valid()) setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const reset = () => {
      epoch.current += 1;
      occupied.current = false;
      setRuns([]);
      setBusy(false);
      setError("");
      setForeignCount(0);
      void refresh();
    };
    window.addEventListener(APP_EVENTS.accountUpdated, reset);
    return () => { epoch.current += 1; window.removeEventListener(APP_EVENTS.accountUpdated, reset); };
  }, [refresh]);

  const act = async (action: () => Promise<unknown>) => {
    if (occupied.current) return;
    // 실제 액션만 기존 GET을 무효화한다. 무시된 중복 호출은 진행 중 refresh를 건드리지 않는다.
    requestSeq.current += 1;
    occupied.current = true;
    const current = epoch.current;
    setBusy(true);
    setError("");
    let failure = "";
    try { await action(); }
    catch (reason) { failure = reason instanceof Error ? reason.message : String(reason); }
    finally {
      // collect의 임시 job은 폴링용이다. 카드 정산은 원래 attempt를 다시 조회한다.
      if (hubHasFeature(COMFY_CANVAS_RUNS_FEATURE)) notifyCanvasComfyRuns();
      if (current === epoch.current) {
        await refresh();
        if (current === epoch.current) {
          occupied.current = false;
          setBusy(false);
          if (failure) setError(failure);
        }
      }
    }
  };

  return {
    runs, busy, error, foreignCount, refresh,
    collect: (run: ComfyUnresolvedRun) => act(() => comfyApi.collectRun(run.job_id)),
    resave: (run: ComfyUnresolvedRun) => act(() => comfyApi.saveToLibrary({
      outputs: run.outputs.filter((output) => output.downloaded && !output.acked)
        .map(({ url, kind }) => ({ url, kind })),
    })),
    dismiss: (run: ComfyUnresolvedRun) => act(() => comfyApi.dismissRuns([run.job_id])),
  };
}
