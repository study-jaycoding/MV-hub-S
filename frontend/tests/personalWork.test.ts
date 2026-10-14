import { describe, expect, it } from "vitest";
import { creatorCalendarRows } from "../src/components/manage/CalendarView";
import { scopeTaskToCreator, taskModelUsage, withKstDerived } from "../src/components/manage/personalWork";
import type { Task } from "../src/components/manage/types";
import { kstDay } from "../src/lib/dateGroups";

// 서버셋 설계 ②(Jay 결정 9A, 10-15): 컷의 생성 시각은 UTC 다 — 새벽(KST 00~09시, UTC 15:00 이후)에 만든 컷이 앞 10글자로는
//  전날 칸에 놓였다. 기존 시험은 T10:00Z(KST 19시)라 이 경계를 못 봤다.
describe("한국 날짜 — 작업 달력·파생 기간", () => {
  it("UTC 15:00 이후는 한국 다음 날이다(두 시각 형식 모두, 시간대 표기가 있으면 그대로)", () => {
    expect(kstDay("2026-08-02T15:30:00Z")).toBe("2026-08-03");
    expect(kstDay("2026-08-02 15:30:00")).toBe("2026-08-03");
    expect(kstDay("2026-08-02T14:59:59Z")).toBe("2026-08-02");
    expect(kstDay("2026-08-03T00:30:00+09:00")).toBe("2026-08-03");
    expect(kstDay(null)).toBeNull();
  });

  it("파생 기간·개인 범위·생성자별 달력이 한국 날짜를 쓴다(옛 서버의 UTC 파생값은 덮는다)", () => {
    const source = task();
    source.cuts![0].created_at = "2026-08-02T16:00:00Z"; // 한국 08-03 01:00
    source.derived_start = "2026-08-02"; // 옛 서버 값
    expect(withKstDerived(source)).toMatchObject({ derived_start: "2026-08-03", derived_due: "2026-08-04" });
    expect(scopeTaskToCreator(source, "user-jay")).toMatchObject({ derived_start: "2026-08-03" });
    const rows = creatorCalendarRows([source], 2026, 7);
    expect(Object.keys(rows.find((row) => row.key === "user-jay")!.byDay).sort()).toEqual(["3", "4"]);
  });
});

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

  it("본인 컷에만 완료 > 보류 > 공유 > 생성 우선순위를 적용한다", () => {
    const source = task();
    source.cuts![0].shared = true;
    source.cuts![0].is_held = true;
    // 본인의 다른 최종 컷이 우선한다.
    expect(scopeTaskToCreator(source, "user-jay")?.status).toBe("done");
    source.cuts![1].is_final = false;
    expect(scopeTaskToCreator(source, "user-jay")?.status).toBe("hold");
    expect(scopeTaskToCreator(source, "user-river")?.status).toBe("in_progress");
    source.cuts![0].is_held = false;
    expect(scopeTaskToCreator(source, "user-jay")?.status).toBe("publish");
    source.cuts![0].shared = false;
    source.cuts![0].is_held = true; // 미공유에 남은 잘못된 플래그는 무시한다.
    expect(scopeTaskToCreator(source, "user-jay")?.status).toBe("in_progress");
    source.status = "omit";
    source.cuts![0].shared = true;
    expect(scopeTaskToCreator(source, "user-jay")?.status).toBe("omit");
  });

  it("구서버의 보류 필드 누락을 보류로 추측하지 않는다", () => {
    const source = task();
    source.cuts![2].shared = true;
    source.status = "hold";
    expect(scopeTaskToCreator(source, "user-river")?.status).toBe("publish");
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
