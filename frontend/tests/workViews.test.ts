import { describe, expect, it } from "vitest";
import { BOARD_STATUS_VALUES } from "../src/components/manage/KanbanBoard";
import {
  mutationErrorsForScope,
  recoverTaskWriteFailure,
  taskLoadResultIsCurrent,
  taskWriteErrorMessage,
} from "../src/components/manage/WorkBoard";
import {
  taskCalendarTitle,
  taskSpan,
} from "../src/components/manage/MonthlyTaskCalendar";
import { taskIsReadOnly, type Task } from "../src/components/manage/types";
import { HttpError } from "../src/lib/http";

function task(patch: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    project_id: "project-1",
    project_name: "뻘뻘뻘",
    name: "ep001",
    sequence: "c0010",
    status: "in_progress",
    created_at: "2026-08-01T00:00:00Z",
    ...patch,
  };
}

describe("work board flow", () => {
  it("shows only generation, sharing, and completion columns", () => {
    expect(BOARD_STATUS_VALUES).toEqual(["in_progress", "publish", "done"]);
    expect(BOARD_STATUS_VALUES).not.toContain("not_started");
    expect(BOARD_STATUS_VALUES).not.toContain("omit");
  });

  it("locks historical and unresolved workspace tasks", () => {
    expect(taskIsReadOnly(task())).toBe(false);
    expect(taskIsReadOnly(task(), true)).toBe(true);
    expect(taskIsReadOnly(task({ workspace_historical: true }))).toBe(true);
    expect(taskIsReadOnly(task({ workspace_unresolved: true }))).toBe(true);
  });

  it("explains stale writes and tells the user that the list will refresh", () => {
    expect(taskWriteErrorMessage("작업 수정", new HttpError(404, "404: 작업 없음"))).toContain(
      "작업 목록이 다른 사용자에 의해 변경",
    );
    expect(taskWriteErrorMessage("작업 수정", new HttpError(409, "409: 과거 작업"))).toContain(
      "워크스페이스가 변경",
    );
    expect(taskWriteErrorMessage("작업 수정", new Error("network down"))).toBe(
      "작업 수정 실패: network down",
    );
  });

  it("notifies before reloading after a stale write", async () => {
    const events: string[] = [];

    await recoverTaskWriteFailure(
      "작업 수정",
      new HttpError(409, "409: 과거 작업"),
      (message) => events.push(`alert:${message}`),
      async () => {
        events.push("reload");
      },
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toContain("alert:작업 수정 실패");
    expect(events[0]).toContain("최신 목록을 다시 불러옵니다");
    expect(events[1]).toBe("reload");
  });

  it("drops late mutation failures from a workspace scope that is no longer visible", () => {
    const currentError = new Error("current scope failed");
    const unscopedError = new Error("legacy operation failed");

    expect(
      mutationErrorsForScope(
        [
          { mutationScope: "workspace-old:active", cause: new Error("stale") },
          { mutationScope: "workspace-new:active", cause: currentError },
          unscopedError,
        ],
        "workspace-new:active",
      ),
    ).toEqual([currentError, unscopedError]);
  });

  it("keeps an undefined rejection reason when it belongs to the active scope", () => {
    const errors = mutationErrorsForScope(
      [{ mutationScope: "workspace-new:active", cause: undefined }],
      "workspace-new:active",
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeUndefined();
  });

  it("drops a full task reload that started before another task save completed", () => {
    expect(taskLoadResultIsCurrent("workspace-a:active", "workspace-a:active", 7, 7)).toBe(true);
    expect(taskLoadResultIsCurrent("workspace-a:active", "workspace-a:active", 7, 8)).toBe(false);
    expect(taskLoadResultIsCurrent("workspace-a:active", "workspace-b:active", 7, 7)).toBe(false);
  });
});

describe("live work calendar presentation", () => {
  it("uses generated dates when project dates are not set", () => {
    const span = taskSpan(task({ derived_start: "2026-07-31", derived_due: "2026-08-06" }));
    expect(span?.label).toBe("ep001 c0010");
    expect(span?.start.getDate()).toBe(31);
    expect(span?.end.getDate()).toBe(6);
  });

  it("shows the same live creator, generation, credit, time, and period data in the tooltip", () => {
    const row = task({
      creators: ["제이", "리버"],
      gen_count: 6,
      credits: 12,
      elapsed: 248,
    });
    const title = taskCalendarTitle(
      row,
      "ep001 c0010",
      new Date(2026, 6, 31),
      new Date(2026, 7, 6),
    );

    expect(title).toContain("뻘뻘뻘 · ep001 c0010");
    expect(title).toContain("상태: 생성 · 생성자: 제이, 리버");
    expect(title).toContain("생성: 6개 · 크레딧: 12 cr · 생성시간: 4m8s");
    expect(title).toContain("생성기간: 2026-07-31 ~ 2026-08-06");
  });
});
