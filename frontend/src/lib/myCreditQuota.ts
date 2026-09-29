import { useEffect, useState } from "react";
import { jsonFetch } from "./http";
import { connectProgress } from "./progressSocket";

export interface MyCreditQuota {
  workspace_id: string;
  source: "auto" | "override" | "unlimited" | "unassigned" | "unavailable";
  group_id: string | null;
  group_name: string | null;
  quota: number | null;
  used_real: number;
  used_estimated: number;
  estimated_count: number;
  unknown_count: number;
  used: number;
  remaining: number | null;
  limit_period: "day" | "week" | "month" | null;
  period_start: string | null;
  period_end: string | null;
  revision: number;
  enforcement: "advisory";
  // 내 몫이 없을 때만(그룹 한도 없음 unlimited · 그룹 미배정 unassigned) — 이번 충전 달의 정기 + 긴급 충전 총량.
  // 구서버는 키 없음.
  pool_total?: number | null;
}

export function hasPersonalQuota(value: MyCreditQuota | null): value is MyCreditQuota & { quota: number; remaining: number } {
  return Boolean(value && (value.source === "auto" || value.source === "override") &&
    typeof value.quota === "number" && Number.isFinite(value.quota) && value.quota >= 0 &&
    typeof value.remaining === "number" && Number.isFinite(value.remaining));
}

// 내 몫 대신 워크스페이스 남은 크레딧을 보여 줄 사람 — 그룹 한도가 없거나 그룹에 들지 않았다(Jay 2026-09-29).
export function showsWorkspacePool(value: MyCreditQuota | null): boolean {
  return value?.source === "unlimited" || value?.source === "unassigned";
}

export function quotaUncertainty(value: MyCreditQuota | null): string {
  if (!value) return "";
  const notes: string[] = [];
  if (value.estimated_count > 0) notes.push(`견적 사용량 ${value.estimated_count}건 포함`);
  if (value.unknown_count > 0) notes.push(`사용량 미확인 ${value.unknown_count}건`);
  return notes.join(" · ");
}

export function useMyCreditQuota(workspaceId: string | null, accountKey: string, open: boolean) {
  const [state, setState] = useState<{ key: string; value: MyCreditQuota | null; loading: boolean }>({
    key: "", value: null, loading: false,
  });
  const key = `${accountKey}:${workspaceId ?? ""}`;
  useEffect(() => {
    let alive = true;
    let sequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controllers = new Set<AbortController>();
    setState((current) => current.key === key ? current : { key, value: null, loading: Boolean(workspaceId) });
    if (!workspaceId) return;
    const refresh = async () => {
      if (document.hidden) return;
      const ticket = ++sequence;
      const controller = new AbortController();
      controllers.add(controller);
      try {
        const value = await jsonFetch<MyCreditQuota>(
          `/api/manage/credit-plan/my-quota?workspace_id=${encodeURIComponent(workspaceId)}`,
          { signal: controller.signal },
        );
        if (alive && sequence === ticket) {
          setState({ key, value: value.workspace_id === workspaceId ? value : null, loading: false });
        }
      } catch {
        if (alive && sequence === ticket) setState({ key, value: null, loading: false });
      } finally {
        controllers.delete(controller);
      }
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void refresh(); }, 250);
    };
    void refresh();
    const disconnect = open ? connectProgress((message) => {
      if (["manage_changed", "synced", "progress", "done", "failed"].includes(message.type)) schedule();
    }, schedule) : undefined;
    const poll = open ? setInterval(() => { void refresh(); }, 30_000) : undefined;
    if (open) window.addEventListener("focus", schedule);
    return () => {
      alive = false;
      controllers.forEach((controller) => controller.abort());
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      disconnect?.();
      window.removeEventListener("focus", schedule);
    };
  }, [key, workspaceId, open]);
  return state.key === key ? state : { key, value: null, loading: Boolean(workspaceId) };
}
