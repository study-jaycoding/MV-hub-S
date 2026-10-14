// 팀 작업(Task) 한 행을 현재 생성자 기준 개인 작업으로 좁힌다.
// 실제로 만든 컷의 creator_uid 기준 자동 파생만 사용한다(수동 담당 배정 개념은 2026-08-21 폐기).
import { kstDay } from "../../lib/dateGroups";
import type { Cut, Task } from "./types";

// 연결 컷의 생성일 범위(한국 날짜). 서버도 같은 컷 집합에서 같은 값을 내지만, 옛 서버는 UTC 날짜를 준다 —
//  화면이 컷에서 다시 계산하면 서버 판과 상관없이 달력·칸반·표가 하루 어긋나지 않는다(서버셋 설계 ②).
function derivedDays(cuts: Cut[]): Pick<Task, "derived_start" | "derived_due" | "derived_date"> {
  const dates = cuts
    .map((cut) => kstDay(cut.created_at))
    .filter((date): date is string => !!date)
    .sort();
  return { derived_start: dates[0] || null, derived_due: dates[dates.length - 1] || null, derived_date: dates[0] || null };
}

/** 서버가 준 작업의 파생 기간을 컷에서 한국 날짜로 다시 계산한다(컷이 없는 옛 응답은 그대로). */
export function withKstDerived(task: Task): Task {
  return Array.isArray(task.cuts) ? { ...task, ...derivedDays(task.cuts) } : task;
}

export interface TaskModelUsage {
  model: string;
  count: number;
  credits: number;
  final_count: number;
}

function sum(cuts: Cut[], pick: (cut: Cut) => number | undefined): number {
  return cuts.reduce((total, cut) => total + (pick(cut) || 0), 0);
}

function personalStatus(task: Task, cuts: Cut[]): string {
  if (task.status === "omit" || !cuts.length) return task.status;
  if (cuts.some((cut) => !!cut.is_final)) return "done";
  if (cuts.some((cut) => !!cut.shared && !!cut.is_held)) return "hold";
  if (cuts.some((cut) => !!cut.shared)) return "publish";
  return "in_progress";
}

export function scopeTaskToCreator(task: Task, creatorUid: string): Task | null {
  const allCuts = task.cuts || [];
  const cuts = allCuts.filter((cut) => cut.creator_uid === creatorUid);
  if (!cuts.length) return null;

  const creators = [...new Set(
    cuts.map((cut) => cut.creator_name).filter((name): name is string => !!name),
  )];
  const hasPerCutElapsed = cuts.some((cut) => cut.elapsed !== undefined);
  const hasPerCutComments = cuts.some((cut) => cut.comment_count !== undefined);
  // 구버전 서버는 컷별 시간·댓글을 주지 않는다. 행의 모든 컷이 본인 것이라면 작업 전체 합계와
  // 개인 합계가 같으므로 기존 값을 안전하게 사용한다. 작업자가 섞인 행은 추측하지 않는다.
  const ownsEveryCut = cuts.length > 0 && cuts.length === allCuts.length;

  return {
    ...task,
    status: personalStatus(task, cuts),
    cuts,
    gen_count: cuts.length,
    creators,
    credits: sum(cuts, (cut) => cut.credits),
    elapsed: hasPerCutElapsed ? sum(cuts, (cut) => cut.elapsed) : (ownsEveryCut ? task.elapsed || 0 : 0),
    comment_count: hasPerCutComments
      ? sum(cuts, (cut) => cut.comment_count)
      : (ownsEveryCut ? task.comment_count || 0 : 0),
    ...derivedDays(cuts),
  };
}

export function scopeTasksToCreator(tasks: Task[], creatorUid: string): Task[] {
  return tasks
    .map((task) => scopeTaskToCreator(task, creatorUid))
    .filter((task): task is Task => task !== null);
}

export function taskModelUsage(task: Task): TaskModelUsage[] {
  const byModel = new Map<string, TaskModelUsage>();
  for (const cut of task.cuts || []) {
    const model = cut.model?.trim() || "알 수 없음";
    const row = byModel.get(model) || { model, count: 0, credits: 0, final_count: 0 };
    row.count += 1;
    row.credits += cut.credits || 0;
    row.final_count += cut.is_final ? 1 : 0;
    byModel.set(model, row);
  }
  return [...byModel.values()].sort(
    (a, b) => b.credits - a.credits || b.count - a.count || a.model.localeCompare(b.model),
  );
}
