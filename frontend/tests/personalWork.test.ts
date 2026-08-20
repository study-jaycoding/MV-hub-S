import { describe, expect, it } from "vitest";
import { scopeTaskToCreator, taskModelUsage } from "../src/components/manage/personalWork";
import type { Task } from "../src/components/manage/types";

function task(): Task {
  return {
    id: "task-1",
    project_id: "project-1",
    project_name: "뻘뻘뻘",
    name: "ep001",
    sequence: "c0010",
    folder_path: "ep001/c0010",
    status: "done",
    created_at: "2026-08-01T00:00:00Z",
    credits: 99,
    elapsed: 999,
    comment_count: 9,
    creators: ["제이", "리버"],
    cuts: [
      {
        id: "jay-1",
        status: "done",
        creator_uid: "user-jay",
        creator_name: "제이",
        model: "Nano Banana 2",
        created_at: "2026-08-02T10:00:00Z",
        credits: 2,
        elapsed: 40,
        comment_count: 1,
      },
      {
        id: "jay-2",
        status: "done",
        creator_uid: "user-jay",
        creator_name: "제이",
        model: "Nano Banana 2",
        created_at: "2026-08-04T10:00:00Z",
        credits: 3,
        elapsed: 50,
        comment_count: 2,
        is_final: true,
      },
      {
        id: "river-1",
        status: "done",
        creator_uid: "user-river",
        creator_name: "리버",
        model: "Seedance 2.0",
        created_at: "2026-08-03T10:00:00Z",
        credits: 10,
        elapsed: 300,
        comment_count: 4,
      },
    ],
  };
}

describe("scopeTaskToCreator", () => {
  it("실제 생성자 컷만 사용해 개인 작업 수치를 다시 계산한다", () => {
    const scoped = scopeTaskToCreator(task(), "user-jay");

    expect(scoped?.cuts?.map((cut) => cut.id)).toEqual(["jay-1", "jay-2"]);
    expect(scoped).toMatchObject({
      gen_count: 2,
      creators: ["제이"],
      credits: 5,
      elapsed: 90,
      comment_count: 3,
      derived_start: "2026-08-02",
      derived_due: "2026-08-04",
      status: "done",
    });
  });

  it("만든 컷이 없는 다른 작업은 개인 목록에서 제외한다", () => {
    expect(scopeTaskToCreator(task(), "user-other")).toBeNull();
  });

  it("휴면 백엔드가 보내는 assigned_creators 는 무시한다 — 배정 개념 폐기 계약", () => {
    // 백엔드 payload 는 여전히 이 필드를 실어올 수 있다(휴면 유지 결정). 프론트 계약은 "무시".
    const source = { ...task(), assigned_creators: [{ uid: "user-other", name: "오지짱" }] } as Task;
    expect(scopeTaskToCreator(source, "user-other")).toBeNull();
  });

  it("구버전 서버에서도 행 전체가 내 컷이면 기존 총 시간을 안전하게 이어 쓴다", () => {
    const source = task();
    source.cuts = source.cuts?.filter((cut) => cut.creator_uid === "user-jay");
    source.cuts?.forEach((cut) => {
      delete cut.elapsed;
      delete cut.comment_count;
    });
    source.elapsed = 90;
    source.comment_count = 3;

    expect(scopeTaskToCreator(source, "user-jay")).toMatchObject({
      elapsed: 90,
      comment_count: 3,
    });
  });

  it("크레딧 호버용 모델별 생성 수와 크레딧을 합산한다", () => {
    expect(taskModelUsage(task())).toEqual([
      { model: "Seedance 2.0", count: 1, credits: 10, final_count: 0 },
      { model: "Nano Banana 2", count: 2, credits: 5, final_count: 1 },
    ]);
  });
});
