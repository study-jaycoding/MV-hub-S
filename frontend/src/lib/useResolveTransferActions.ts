import { useCallback, useRef, useState } from "react";
import type { Generation } from "../types";
import {
  checkResolveSelection,
  createResolveTransfer,
  resolveTransferSummary,
} from "./resolveTransfer";
import { SerialTaskQueue, type SerialTaskQueueState } from "./serialTaskQueue";

interface UseResolveTransferActionsArgs {
  flash: (message: string) => void;
}

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^\d+:\s*/, "") || "Resolve 전송에 실패했습니다";
}

export function useResolveTransferActions({ flash }: UseResolveTransferActionsArgs) {
  const [queueState, setQueueState] = useState<SerialTaskQueueState>({
    active: false,
    queued: 0,
    total: 0,
  });
  const flashRef = useRef(flash);
  flashRef.current = flash;
  const queueRef = useRef<SerialTaskQueue<{ genIds: string[] }> | null>(null);
  if (!queueRef.current) {
    queueRef.current = new SerialTaskQueue(
      async ({ genIds }) => {
        flashRef.current(
          `Resolve 원본 ${genIds.length}개 처리 중…`,
        );
        const result = await createResolveTransfer(genIds);
        flashRef.current(resolveTransferSummary(result));
      },
      setQueueState,
      (error) => {
        flashRef.current(`Resolve 전송 실패: ${readableError(error)}`);
      },
    );
  }

  const sendToResolve = useCallback(
    (selected: Generation[]) => {
      const checked = checkResolveSelection(selected);
      if (!checked.ok) {
        flash(checked.message);
        return;
      }

      const ahead = queueRef.current!.snapshot().total;
      flash(
        ahead
          ? `Resolve 원본 ${checked.genIds.length}개를 대기열에 추가했습니다 · 앞 작업 ${ahead}건`
          : `Resolve 원본 ${checked.genIds.length}개 전송을 시작합니다…`,
      );
      queueRef.current!.enqueue({ genIds: checked.genIds });
    },
    [flash],
  );

  return {
    busy: queueState.total > 0,
    pendingCount: queueState.total,
    sendToResolve,
  };
}
