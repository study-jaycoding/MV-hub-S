import { describe, expect, it } from "vitest";
import {
  buildHfUsageCsv,
  buildProjectDetailCsv,
  groupOutputCredits,
  groupOutputModels,
  HF_USAGE_REPORT_FILENAME,
  inferOutputModels,
  PROJECT_DETAIL_REPORT_FILENAME,
  splitUsageFolderPath,
} from "../src/lib/usageReport";

describe("usage report", () => {
  it("builds the per-generation project detail CSV with episode/cut split and a BOM", () => {
    const csv = buildProjectDetailCsv([
      {
        date: "2026-09-01",
        created_local: "2026-09-01 09:00:00",
        user_email: "artist@example.com",
        user_id: "user_1",
        user_name: "아티스트",
        workspace_name: "뻘뻘뻘",
        project_name: "Project, A",
        folder_path: "e001/s02/c0010",
        model: "seedance",
        output_type: "video",
        status: "done",
        credits: 12.346,
        credit_basis: "real",
        elapsed_seconds: 83.26,
        started_local: "2026-09-01 09:00:05",
        completed_local: "2026-09-01 09:01:28",
        is_final: 1,
        is_shared: 0,
        is_deleted: 0,
        job_id: "job-1",
      },
      {
        date: null,
        created_local: null,
        user_email: "b@example.com",
        user_id: null,
        user_name: null,
        workspace_name: null,
        project_name: "=1+1",
        folder_path: "-e001/@c0010",
        model: "알 수 없음",
        output_type: null,
        status: null,
        credits: 0,
        credit_basis: "unknown",
        elapsed_seconds: null,
        started_local: null,
        completed_local: null,
        is_final: 0,
        is_shared: 0,
        is_deleted: 1,
        job_id: null,
      },
    ], (model) => model === "seedance" ? "Seedance 2.5" : model);

    const lines = csv.split("\r\n");
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(lines[0].slice(1)).toBe(
      "날짜,생성 시각,워크스페이스,프로젝트,에피소드,씬/컷,폴더 경로,작성자,이메일,작성자 ID,모델,출력,상태," +
      "크레딧,크레딧 근거,소요시간(초),시작,완료,최종본,공유,삭제,Job ID",
    );
    expect(lines[1]).toBe(
      '2026-09-01,2026-09-01 09:00:00,뻘뻘뻘,"Project, A",e001,s02/c0010,e001/s02/c0010,아티스트,artist@example.com,' +
      "user_1,Seedance 2.5,video,done,12.346,실제 차감,83.3,2026-09-01 09:00:05,2026-09-01 09:01:28,예,,,job-1",
    );
    // 날짜 없는 행도 실리고, 수식 시작 글자(= - @)는 작은따옴표로 글자 고정(CSV 주입 방지).
    expect(lines[2]).toBe(",,,'=1+1,'-e001,'@c0010,'-e001/@c0010,,b@example.com,,알 수 없음,,,0,미확인,,,,,,예,");
    expect(PROJECT_DETAIL_REPORT_FILENAME).toBe("project-detail-report.csv");
  });

  it("matches the Higgsfield usage CSV columns and row granularity", () => {
    const csv = buildHfUsageCsv([
      {
        date: "2026-08-02",
        user_email: "artist@example.com",
        user_id: "user_1",
        model: "nano_banana_flash",
        credits_used: 7.199999,
        jobs: 3,
      },
    ], (model) => model === "nano_banana_flash" ? "Nano Banana 2" : model);

    expect(csv).toBe(
      "Date,User Email,User ID,Model,Credits Used,# of Jobs\r\n" +
      "2026-08-02,artist@example.com,user_1,Nano Banana 2,7.2,3",
    );
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
    expect(HF_USAGE_REPORT_FILENAME).toBe("team-members-usage.csv");
  });

  it("groups raw output types into the five dashboard categories", () => {
    const categories = groupOutputCredits([
      { output_type: "video", count: 2, credits: 10 },
      { output_type: "image", count: 3, credits: 6 },
      { output_type: "speech", count: 1, credits: 2 },
      { output_type: "unknown", count: 4, credits: 0 },
    ]);

    expect(categories.map((row) => row.label)).toEqual([
      "Video", "Image", "Text/AI", "Audio/Speech", "Other",
    ]);
    expect(categories.find((row) => row.key === "audio")).toMatchObject({ count: 1, credits: 2 });
    expect(categories.find((row) => row.key === "other")).toMatchObject({ count: 4, credits: 0 });
  });

  it("groups model usage under the matching output category", () => {
    const groups = groupOutputModels([
      { output_type: "video", model: "seedance", count: 2, credits: 8 },
      { output_type: "video/mp4", model: "seedance", count: 1, credits: 4 },
      { output_type: "video", model: "veo", count: 1, credits: 3 },
      { output_type: "image", model: "nano", count: 4, credits: 6 },
    ]);

    expect(groups.video).toEqual([
      { model: "seedance", count: 3, credits: 12 },
      { model: "veo", count: 1, credits: 3 },
    ]);
    expect(groups.image).toEqual([{ model: "nano", count: 4, credits: 6 }]);
    expect(groups.audio).toEqual([]);
  });

  it("infers output categories for older overview responses without output_models", () => {
    expect(inferOutputModels([
      { model: "seedance_2_0", count: 3, credits: 12 },
      { model: "nano_banana_flash", count: 4, credits: 6 },
      { model: "comfy", count: 1, credits: 0 },
    ])).toEqual([
      { model: "seedance_2_0", count: 3, credits: 12, output_type: "video" },
      { model: "nano_banana_flash", count: 4, credits: 6, output_type: "image" },
      { model: "comfy", count: 1, credits: 0, output_type: "other" },
    ]);
  });

  it("splits folder paths into episode and scene columns", () => {
    expect(splitUsageFolderPath("ep001/c0010")).toEqual({ episode: "ep001", scene: "c0010" });
    expect(splitUsageFolderPath("shots\\020")).toEqual({ episode: "shots", scene: "020" });
    expect(splitUsageFolderPath("(폴더 미지정)")).toEqual({ episode: "—", scene: "—" });
  });
});
