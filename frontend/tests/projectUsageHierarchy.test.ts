import { describe, expect, it } from "vitest";
import { buildProjectUsageHierarchy } from "../src/components/manage/projectUsageHierarchy";
import type { ProjectFolderUsage } from "../src/components/manage/types";

function folder(
  folderPath: string,
  count: number,
  finalCount: number,
  credits: number,
  elapsedSeconds: number,
  start: string,
  end: string,
): ProjectFolderUsage {
  return {
    folder_path: folderPath,
    count,
    final_count: finalCount,
    credits,
    elapsed_seconds: elapsedSeconds,
    created_start: start,
    created_end: end,
    models: [{
      model: "model-a",
      count,
      final_count: finalCount,
      credits,
      elapsed_seconds: elapsedSeconds,
    }],
    members: [{
      uid: folderPath.includes("0010") ? "u_jay" : "u_river",
      name: folderPath.includes("0010") ? "제이" : "리버",
      count,
      final_count: finalCount,
      credits,
    }],
  };
}

describe("project usage hierarchy", () => {
  it("에피소드 아래 시퀀스를 묶고 각 단계의 사용량을 합산한다", () => {
    const result = buildProjectUsageHierarchy([
      folder("ep002/c0010", 1, 0, 2, 60, "2026-08-04", "2026-08-04"),
      folder("ep001/c0015", 5, 0, 6, 180, "2026-07-20", "2026-08-03"),
      folder("ep001\\c0010", 6, 1, 2, 240, "2026-07-31", "2026-08-06"),
    ]);

    expect(result.map((episode) => episode.episode_name)).toEqual(["ep001", "ep002"]);
    expect(result[0].sequences.map((sequence) => sequence.sequence_name)).toEqual(["c0010", "c0015"]);
    expect(result[0]).toMatchObject({
      count: 11,
      final_count: 1,
      credits: 8,
      elapsed_seconds: 420,
      created_start: "2026-07-20",
      created_end: "2026-08-06",
    });
    expect(result[0].models).toEqual([{
      model: "model-a",
      count: 11,
      final_count: 1,
      credits: 8,
      elapsed_seconds: 420,
    }]);
    expect(result[0].members).toEqual([
      { uid: "u_jay", name: "제이", count: 6, final_count: 1, credits: 2 },
      { uid: "u_river", name: "리버", count: 5, final_count: 0, credits: 6 },
    ]);
  });

  it("에피소드 바로 아래 생성물도 직접 생성 시퀀스로 보존한다", () => {
    const result = buildProjectUsageHierarchy([
      folder("ep003", 2, 1, 4, 30, "2026-08-07", "2026-08-07"),
    ]);

    expect(result[0].episode_name).toBe("ep003");
    expect(result[0].sequences[0].sequence_name).toBe("(직접 생성)");
  });
});
