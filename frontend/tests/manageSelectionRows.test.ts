// 관리 탭 순수 로직 — 생성자 행 키. (작업 표 전체 선택 시험은 2026-11-05 줄 선택·삭제를 빼며 함께 뺐다 — Jay B안)
import { describe, expect, it } from "vitest";
import { creatorCalendarRows } from "../src/components/manage/CalendarView";
import type { Cut, Task } from "../src/components/manage/types";

function task(patch: Partial<Task> = {}): Task {
  return {
    id: "t1",
    project_id: "p1",
    name: "ep001",
    status: "in_progress",
    ...patch,
  };
}

const cut = (id: string, over: Partial<Cut> = {}): Cut => ({
  id,
  status: "done",
  created_at: "2026-08-10T00:00:00Z",
  ...over,
});

describe("creatorCalendarRows", () => {
  it("이름이 같아도 uid 가 다르면 행 키가 갈린다(행 섞임 방지)", () => {
    const tasks = [
      task({
        cuts: [
          cut("c1", { creator_uid: "u1", creator_name: "김민수" }),
          cut("c2", { creator_uid: "u2", creator_name: "김민수" }),
        ],
      }),
    ];
    const rows = creatorCalendarRows(tasks, 2026, 7); // 2026-08 (month 는 0-based)
    expect(rows.map((r) => r.key)).toEqual(["u1", "u2"]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length); // 키 유일
    expect(rows.map((r) => r.name)).toEqual(["김민수", "김민수"]); // 표시 이름은 그대로
    expect(rows.map((r) => r.total)).toEqual([1, 1]);
  });

  it("uid 가 없으면 이름, 그것도 없으면 '미상'으로 묶는다(기존 집계 규칙)", () => {
    const tasks = [
      task({ cuts: [cut("c1", { creator_name: "팀원" }), cut("c2", {})] }),
      task({ cuts: [cut("c1", { creator_name: "팀원" })] }), // 다른 작업의 같은 컷 → 중복 제거
    ];
    const rows = creatorCalendarRows(tasks, 2026, 7);
    expect(rows.map((r) => r.key)).toEqual(["팀원", "미상"]);
    expect(rows.map((r) => r.total)).toEqual([1, 1]);
  });

  it("그 달의 컷만 날짜별로 담고, total 은 전체 컷 수 그대로다", () => {
    const tasks = [
      task({
        cuts: [
          cut("c1", { creator_uid: "u1", created_at: "2026-08-10T00:00:00Z" }),
          cut("c2", { creator_uid: "u1", created_at: "2026-08-10T09:00:00Z" }),
          cut("c3", { creator_uid: "u1", created_at: "2026-07-31T00:00:00Z" }), // 다른 달
        ],
      }),
    ];
    const [row] = creatorCalendarRows(tasks, 2026, 7);
    expect(Object.keys(row.byDay)).toEqual(["10"]);
    expect(row.byDay[10].map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(row.total).toBe(3);
  });
});
