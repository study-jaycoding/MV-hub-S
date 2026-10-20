import { useEffect, useRef, useState } from "react";
import { downloadGenerationBundle, IncompleteGenerationBundle } from "../lib/generationBundle";

export function GenerationBundleButton({ generationId }: { generationId: string }) {
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(0);
  const [message, setMessage] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const start = async (allowIncomplete: boolean) => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setMessage("");
    try {
      await downloadGenerationBundle(generationId, allowIncomplete, controller.signal);
      if (!controller.signal.aborted) { setMissing(0); setMessage("묶음 다운로드 완료"); }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof IncompleteGenerationBundle) setMissing(error.count);
        else setMessage(error instanceof Error ? error.message : "묶음 다운로드 실패");
      }
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return <div className="info-row" onPointerDown={event => event.stopPropagation()}>
    <button type="button" className="info-board-btn" disabled={busy} onClick={() => void start(false)}>
      {busy ? "원본 확인 중…" : "결과·레퍼런스 ZIP"}
    </button>
    {missing > 0 && <button type="button" className="info-board-btn" disabled={busy} onClick={() => void start(true)}>
      원본 {missing}건 누락 · 있는 자료만 받기
    </button>}
    {message && <span role="status">{message}</span>}
  </div>;
}
