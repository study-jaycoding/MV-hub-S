export interface UsageExportRowLike {
  date: string;
  user_email: string;
  user_id: string | null;
  model: string;
  credits_used: number;
  jobs: number;
}

export interface OutputTypeRowLike {
  output_type: string;
  count: number;
  credits: number;
}

export interface OutputModelRowLike extends OutputTypeRowLike {
  model: string;
}

export interface OutputModelUsage {
  model: string;
  count: number;
  credits: number;
}

export interface ModelUsageRowLike {
  model: string;
  count: number;
  credits: number;
}

export interface UsageFolderLevels {
  episode: string;
  scene: string;
}

export type OutputCategoryKey = "video" | "image" | "text" | "audio" | "other";

export interface OutputCreditCategory {
  key: OutputCategoryKey;
  label: string;
  color: string;
  count: number;
  credits: number;
}

const OUTPUT_CATEGORY_META: Record<OutputCategoryKey, Pick<OutputCreditCategory, "label" | "color">> = {
  video: { label: "Video", color: "#8bdce5" },
  image: { label: "Image", color: "#bfff32" },
  text: { label: "Text/AI", color: "#8a8d91" },
  audio: { label: "Audio/Speech", color: "#9b7525" },
  other: { label: "Other", color: "#4a4d50" },
};

const OUTPUT_CATEGORY_ORDER: OutputCategoryKey[] = ["video", "image", "text", "audio", "other"];

function outputCategory(value: string): OutputCategoryKey {
  const type = (value || "").trim().toLowerCase();
  if (type.includes("video")) return "video";
  if (type.includes("image") || type === "img") return "image";
  if (type.includes("audio") || type.includes("speech") || type.includes("voice")) return "audio";
  if (type.includes("text") || type === "ai") return "text";
  return "other";
}

function inferredModelOutputType(model: string): OutputCategoryKey {
  const value = (model || "").trim().toLowerCase();
  if (/(seedance|kling|veo|sora|hailuo|minimax|video)/.test(value)) return "video";
  if (/(nano[_ -]?banana|gpt[_ -]?image|imagen|flux|ideogram|seedream|recraft|z[_ -]?image|image)/.test(value)) return "image";
  if (/(audio|speech|voice|music|elevenlabs)/.test(value)) return "audio";
  if (/(text|chat|llm|claude)/.test(value)) return "text";
  return "other";
}

export function inferOutputModels(rows: ModelUsageRowLike[]): OutputModelRowLike[] {
  return (rows || []).map((row) => ({
    ...row,
    output_type: inferredModelOutputType(row.model),
  }));
}

export function splitUsageFolderPath(folderPath: string): UsageFolderLevels {
  const normalized = (folderPath || "").trim().replace(/\\/g, "/");
  if (!normalized || normalized === "(폴더 미지정)") return { episode: "—", scene: "—" };
  const levels = normalized.split("/").map((value) => value.trim()).filter(Boolean);
  return {
    episode: levels[0] || "—",
    scene: levels.length > 1 ? levels.slice(1).join("/") : "—",
  };
}

export function groupOutputCredits(rows: OutputTypeRowLike[]): OutputCreditCategory[] {
  const grouped = new Map<OutputCategoryKey, { count: number; credits: number }>();
  for (const row of rows || []) {
    const key = outputCategory(row.output_type);
    const current = grouped.get(key) || { count: 0, credits: 0 };
    current.count += Number(row.count) || 0;
    current.credits += Number(row.credits) || 0;
    grouped.set(key, current);
  }
  return OUTPUT_CATEGORY_ORDER.map((key) => ({
    key,
    ...OUTPUT_CATEGORY_META[key],
    count: grouped.get(key)?.count || 0,
    credits: grouped.get(key)?.credits || 0,
  }));
}

export function groupOutputModels(
  rows: OutputModelRowLike[],
): Record<OutputCategoryKey, OutputModelUsage[]> {
  const grouped = new Map<OutputCategoryKey, Map<string, OutputModelUsage>>();
  for (const row of rows || []) {
    const key = outputCategory(row.output_type);
    const models = grouped.get(key) || new Map<string, OutputModelUsage>();
    const model = (row.model || "").trim() || "알 수 없음";
    const current = models.get(model) || { model, count: 0, credits: 0 };
    current.count += Number(row.count) || 0;
    current.credits += Number(row.credits) || 0;
    models.set(model, current);
    grouped.set(key, models);
  }

  return Object.fromEntries(OUTPUT_CATEGORY_ORDER.map((key) => [
    key,
    [...(grouped.get(key)?.values() || [])].sort(
      (left, right) => right.credits - left.credits || right.count - left.count,
    ),
  ])) as Record<OutputCategoryKey, OutputModelUsage[]>;
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function reportCredits(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export function buildHfUsageCsv(
  rows: UsageExportRowLike[],
  modelDisplayName: (model: string) => string,
): string {
  const table: unknown[][] = [
    ["Date", "User Email", "User ID", "Model", "Credits Used", "# of Jobs"],
    ...(rows || []).map((row) => [
      row.date,
      row.user_email,
      row.user_id || "",
      modelDisplayName(row.model),
      reportCredits(row.credits_used),
      Math.round(Number(row.jobs) || 0),
    ]),
  ];
  return table.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export const HF_USAGE_REPORT_FILENAME = "team-members-usage.csv";
