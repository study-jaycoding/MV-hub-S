import { describe, expect, it } from "vitest";
import {
  buildHfUsageCsv,
  groupOutputCredits,
  groupOutputModels,
  HF_USAGE_REPORT_FILENAME,
  inferOutputModels,
  splitUsageFolderPath,
} from "../src/lib/usageReport";

describe("usage report", () => {
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
