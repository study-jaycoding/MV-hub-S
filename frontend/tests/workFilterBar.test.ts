import { describe, expect, it } from "vitest";
import { workFilterOptions } from "../src/components/manage/WorkFilterBar";
import type { Task } from "../src/components/manage/types";

const tasks: Task[] = [
  {
    id: "t1",
    project_id: "p1",
    project_name: "뻘뻘뻘",
    name: "ep001",
    sequence: "c0010",
    status: "in_progress",
    created_at: "2026-08-07",
    creators: ["제이"],
    cuts: [{ id: "g1", status: "done", model: "Nano Banana 2" }],
  },
  {
    id: "t2",
    project_id: "p1",
    project_name: "뻘뻘뻘",
    name: "ep001",
    sequence: "c0015",
    status: "publish",
    created_at: "2026-08-07",
    creators: ["리버"],
    cuts: [{ id: "g2", status: "done", model: "Seedance 2.0" }],
  },
  {
    id: "t3",
    project_id: "p1",
    project_name: "뻘뻘뻘",
    name: "ep002",
    sequence: "c0020",
    status: "done",
    created_at: "2026-08-07",
    creators: ["제이"],
    cuts: [{ id: "g3", status: "done", model: "Nano Banana 2" }],
  },
];

describe("workFilterOptions", () => {
  it("현재 표에 존재하는 상태만 생성·공유·완료 명칭으로 제공한다", () => {
    expect(workFilterOptions("status", tasks).map(({ value, label }) => ({ value, label }))).toEqual([
      { value: "in_progress", label: "생성" },
      { value: "publish", label: "공유" },
      { value: "done", label: "완료" },
    ]);
  });

  it("현재 생성물에서 사용한 모델만 중복 없이 제공한다", () => {
    expect(workFilterOptions("model", tasks).map((option) => option.value)).toEqual([
      "Nano Banana 2",
      "Seedance 2.0",
    ]);
  });
});
