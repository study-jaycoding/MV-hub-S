import { useCallback, useEffect, useRef, useState } from "react";
import { APP_EVENTS } from "./appEvents";
import { comfyApi, type ComfyUnresolvedRun } from "./comfyApi";

// 카드 수명과 무관한 설정 목록. 서버 원장이 정답이며 새 생성 요청은 이 훅에서 호출하지 않는다.
export function useComfyUnresolvedRuns() {
  const [runs, setRuns] = useState<ComfyUnresolvedRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const requestSeq = useRef(0);
  const occupied = useRef(false);

  const refresh = useCallback(async () => {
    const current = epoch.current;
    const seq = ++requestSeq.current;
    try {
      const result = await comfyApi.unresolvedRuns();
      if (current === epoch.current && seq === requestSeq.current) { setRuns(result.runs); setError(""); }
    } catch (reason) {
      if (current === epoch.current && seq === requestSeq.current) setError(reason instanceof Error ? reason.message : String(reason));
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
    runs, busy, error, refresh,
    collect: (run: ComfyUnresolvedRun) => act(() => comfyApi.collectRun(run.job_id)),
    resave: (run: ComfyUnresolvedRun) => act(() => comfyApi.saveToLibrary({
      outputs: run.outputs.filter((output) => output.downloaded && !output.acked)
        .map(({ url, kind }) => ({ url, kind })),
    })),
    dismiss: (run: ComfyUnresolvedRun) => act(() => comfyApi.dismissRuns([run.job_id])),
  };
}
