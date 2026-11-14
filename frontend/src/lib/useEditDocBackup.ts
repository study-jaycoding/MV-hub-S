import { useEffect, useSyncExternalStore } from "react";
import { startEditDocBackup } from "./editDocBackup";
import { hubHasFeature, subscribeHubFeatures } from "./hubFeatures";
import type { ApiPause } from "./http";

export interface EditDocBackupAuth { authPending: unknown; authReady: boolean; hubAccount: { email: string } | null; apiPause: ApiPause }

/** 로그인이 갖춰지고 허브가 edit_doc_backup_v1 을 알리면 편집 문서 백업을 켠다. 표식이 늦게 와도 켜고, 빠지거나 계정이 바뀌면 끈다. */
export function useEditDocBackup({ authPending, authReady, hubAccount, apiPause }: EditDocBackupAuth): void {
  const enabled = useSyncExternalStore(subscribeHubFeatures, () => hubHasFeature("edit_doc_backup_v1"));
  const ready = !authPending && authReady && !!hubAccount && !apiPause, account = hubAccount?.email;
  useEffect(() => {
    if (!ready || !enabled) return;
    return startEditDocBackup();
  }, [ready, account, enabled]);
}
