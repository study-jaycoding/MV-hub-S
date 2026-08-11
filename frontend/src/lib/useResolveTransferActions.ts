import { useCallback, useRef, useState } from "react";
import type { Generation } from "../types";
import {
  checkResolveSelection,
  createResolveTransfer,
  resolveTransferSummary,
} from "./resolveTransfer";

interface UseResolveTransferActionsArgs {
  flash: (message: string) => void;
}

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^\d+:\s*/, "") || "Resolve 전송에 실패했습니다";
}

export function useResolveTransferActions({ flash }: UseResolveTransferActionsArgs) {
  const [busy, setBusy] = useState(false);
  const runningRef = useRef(false);

  const sendToResolve = useCallback(
    async (selected: Generation[]) => {
      if (runningRef.current) return;
      const checked = checkResolveSelection(selected);
      if (!checked.ok) {
        flash(checked.message);
        return;
      }

      runningRef.current = true;
      setBusy(true);
      flash(`Resolve 원본 ${checked.genIds.length}개를 준비하고 있습니다…`);
      try {
        const result = await createResolveTransfer(checked.genIds);
        flash(resolveTransferSummary(result));
      } catch (error) {
        flash(`Resolve 전송 실패: ${readableError(error)}`);
      } finally {
        runningRef.current = false;
        setBusy(false);
      }
    },
    [flash],
  );

  return { busy, sendToResolve };
}
