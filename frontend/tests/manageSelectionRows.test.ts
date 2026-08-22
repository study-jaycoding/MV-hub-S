// 관리 탭 순수 로직 2건 — 전체 선택(Map 인덱싱)과 생성자 행 키.
import { describe, expect, it } from "vitest";
import { applyTaskSelectAll } from "../src/components/manage/WorkBoard";
import { creatorCalendarRows } from "../src/components/manage/CalendarView";
import { taskIsReadOnly, type Cut, type Task } from "../src/components/manage/types";

function task(patch: Partial<Task> = {}): Task {
  return {
    id: "t1",
    project_id: "p1",
    name: "ep001",
    status: "in_progress",
    ...patch,
  };
}

// 인덱싱 전 구현(ids 마다 tasks.find) — 비교 기준.
function applySelectAllNaive(
  selected: Set<string>,
  ids: string[],
  on: boolean,
  tasks: Task[],
  readOnly: boolean,
): Set<string> {
  const n = new Set(selected);
  ids.forEach((id) => {
    const t = tasks.find((item) => item.id === id);
    if (t && !taskIsReadOnly(t, readOnly)) on ? n.add(id) : n.delete(id);
  });
  return n;
}

describe("applyTaskSelectAll", () => {
  const tasks = [
    task({ id: "a" }),
    task({ id: "b", workspace_historical: true }), // 읽기전용 — 선택 대상 아님
    task({ id: "c", workspace_unresolved: true }), // 읽기전용
    task({ id: "d" }),
  ];

  it("읽기전용 작업은 빼고 선택하고, 인덱싱 전 구현과 결과가 같다", () => {
    const ids = ["a", "b", "c", "d", "없는id"];
    const on = applyTaskSelectAll(new Set(), ids, true, tasks, false);
    expect([...on].sort()).toEqual(["a", "d"]);
    expect(on).toEqual(applySelectAllNaive(new Set(), ids, true, tasks, false));
  });

  it("해제는 선택에서 빼고, 과거 기록 화면(readOnly)에서는 아무것도 선택되지 않는다", () => {
    const base = new Set(["a", "d", "z"]);
    const off = applyTaskSelectAll(base, ["a"], false, tasks, false);
    expect([...off].sort()).toEqual(["d", "z"]); // 무관한 z 는 유지
    expect(off).toEqual(applySelectAllNaive(base, ["a"], false, tasks, false));
    expect([...applyTaskSelectAll(new Set(), ["a", "d"], true, tasks, true)]).toEqual([]);
    expect(base).toEqual(new Set(["a", "d", "z"])); // 원본 Set 불변
  });

  it("같은 id 가 여러 번 있으면 tasks.find 처럼 '첫 항목'으로 판정한다", () => {
    const dup = [task({ id: "a" }), task({ id: "a", workspace_historical: true })];
    expect([...applyTaskSelectAll(new Set(), ["a"], true, dup, false)]).toEqual(["a"]);
    expect(applyTaskSelectAll(new Set(), ["a"], true, dup, false)).toEqual(
      applySelectAllNaive(new Set(), ["a"], true, dup, false),
    );
  });
});

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
