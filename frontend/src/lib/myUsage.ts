import { useEffect, useState } from "react";
import { isHttpStatus, jsonFetch } from "./http";
import type { UsageBasis } from "./creditUsage";

export type UsageRange = "today" | "week" | "period" | "previous";
export type UsageSpace = "this" | "all";
export interface MyUsageRow {
  row_id: string; created_at: number; source: string; type: string;
  model: string | null; workspace_id: string; workspace_name: string | null;
  status: string | null; state: string | null; error_code: string | null;
  charged: number | null; refunded: number | null; net: number; pending: boolean;
}
export interface MyUsage extends UsageBasis {
  workspace_id: string; range: UsageRange; space: UsageSpace;
  used: number | null; used_real: number | null; used_estimated: number | null;
  refunded: number | null; generation_count: number | null;
  estimated_count: number | null; unknown_count: number | null; overdue_pending_count: number | null; pending_count: number | null;
  failed_count: number | null; failed_refunded_count: number | null;
  sources: { source: string; net: number }[]; rows: MyUsageRow[];
  total_count: number; returned_count: number; truncated: boolean;
}

export function useMyUsage(workspaceId: string, accountKey: string, range: UsageRange, space: UsageSpace) {
  const key = JSON.stringify([workspaceId, accountKey, range, space]);
  const [state, setState] = useState<{ key: string; value: MyUsage | null; error: "update" | "offline" | null }>({ key: "", value: null, error: null });
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setState({ key, value: null, error: null });
    void jsonFetch<MyUsage>(`/api/manage/credit-plan/my-usage?workspace_id=${encodeURIComponent(workspaceId)}&range=${range}&space=${space}`, { signal: controller.signal })
      .then(value => {
        const valid = value.workspace_id === workspaceId && value.basis;
        if (alive) setState({ key, value: valid ? value : null, error: valid ? null : value.basis ? "offline" : "update" });
      }).catch(error => {
        if (alive) setState({ key, value: null, error: isHttpStatus(error, 404) ? "update" : "offline" });
      });
    return () => { alive = false; controller.abort(); };
  }, [key, workspaceId, range, space]);
  return state.key === key ? state : { key, value: null, error: null };
}
