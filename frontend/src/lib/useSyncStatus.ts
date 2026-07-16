// 로컬 텔레메트리(매니징) push 상태를 주기 폴링 — 조용히 묻히던 실패를 UI 로 노출.
// failed>0 일 때만 경고를 띄운다(pending 은 정상 backlog 라 노이즈). read-only 관측.
import { useEffect, useState } from "react";
import { api } from "../api";

export interface SyncStatus {
  pending: number;
  failed: number;
  last_error: string | null;
  oldest_dirty: string | null;
}

export function useSyncStatus(): SyncStatus | null {
  const [status, setStatus] = useState<SyncStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const check = () =>
      api
        .syncStatus()
        .then((s) => alive && setStatus(s))
        .catch(() => alive && setStatus(null));
    check();
    const id = window.setInterval(check, 30000); // 30초 — 관측용이라 자주 안 찔러도 됨
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  return status;
}
