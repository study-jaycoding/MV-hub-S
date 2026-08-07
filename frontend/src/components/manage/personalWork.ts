// 팀 작업(Task) 한 행을 현재 생성자 기준 개인 작업으로 좁힌다.
// 수동 배정만 기다리지 않고, 실제로 만든 컷의 creator_uid를 기준으로 작업량을 자동 계산한다.
import type { Cut, Task } from "./types";

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
  if (cuts.some((cut) => !!cut.shared)) return "publish";
  return "in_progress";
}

export function scopeTaskToCreator(task: Task, creatorUid: string): Task | null {
  const allCuts = task.cuts || [];
  const cuts = allCuts.filter((cut) => cut.creator_uid === creatorUid);
  const assigned = (task.assigned_creators || []).some((member) => member.uid === creatorUid);
  if (!cuts.length && !assigned) return null;

  const dates = cuts
    .map((cut) => cut.created_at?.slice(0, 10))
    .filter((date): date is string => !!date)
    .sort();
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
    derived_start: dates[0] || null,
    derived_due: dates[dates.length - 1] || null,
    derived_date: dates[0] || null,
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
