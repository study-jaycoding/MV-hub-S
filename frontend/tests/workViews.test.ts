import { describe, expect, it } from "vitest";
import { BOARD_STATUS_VALUES } from "../src/components/manage/KanbanBoard";
import {
  taskCalendarTitle,
  taskSpan,
} from "../src/components/manage/MonthlyTaskCalendar";
import type { Task } from "../src/components/manage/types";

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
