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

export interface UsageDetailRowLike {
  date: string | null;
  created_local: string | null;
  user_email: string;
  user_id: string | null;
  user_name: string | null;
  workspace_name: string | null;
  project_name: string | null;
  folder_path: string | null;
  model: string;
  output_type: string | null;
  status: string | null;
  credits: number;
  credit_basis: "real" | "est" | "unknown";
  elapsed_seconds: number | null;
  started_local: string | null;
  completed_local: string | null;
  is_final: number;
  is_shared: number;
  is_deleted: number;
  job_id: string | null;
}

const CREDIT_BASIS_LABEL: Record<UsageDetailRowLike["credit_basis"], string> = {
  real: "실제 차감",
  est: "견적",
  unknown: "미확인",
};

function yesNo(value: number): string {
  return value ? "예" : "";
}

// Excel·시트가 수식으로 해석하는 시작 글자(= + - @, 탭·CR)는 작은따옴표를 앞에 붙여 글자로 고정한다.
// 프로젝트명·폴더명·작성자명은 멤버가 적은 값이라 CSV 주입 경로가 된다(코덱스 P2). 숫자 열엔 쓰지 않는다.
function safeText(value: unknown): string {
  const text = String(value ?? "");
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

// 프로젝트 상세 보고서 — 생성물 1건 = 1행. 폴더 경로는 관리 요약과 같은 규칙으로 에피소드/씬·컷을 쪼갠다.
// 한글 머리글이라 Excel 이 바로 읽도록 UTF-8 BOM 을 앞에 붙인다(HF 호환 CSV 는 BOM 없음 — 그쪽 규격 유지).
// 크레딧은 행별로 반올림하지 않는다 — 합계 대조용이라 원본 정밀도를 지킨다(코덱스 P3). 소요시간만 0.1초로.
export function buildProjectDetailCsv(
  rows: UsageDetailRowLike[],
  modelDisplayName: (model: string) => string,
): string {
  const table: unknown[][] = [
    [
      "날짜", "생성 시각", "워크스페이스", "프로젝트", "에피소드", "씬/컷", "폴더 경로",
      "작성자", "이메일", "작성자 ID", "모델", "출력", "상태",
      "크레딧", "크레딧 근거", "소요시간(초)", "시작", "완료",
      "최종본", "공유", "삭제", "Job ID",
    ],
    ...(rows || []).map((row) => {
      const levels = splitUsageFolderPath(row.folder_path || "");
      return [
        row.date || "",
        row.created_local || "",
        safeText(row.workspace_name),
        safeText(row.project_name),
        levels.episode === "—" ? "" : safeText(levels.episode),
        levels.scene === "—" ? "" : safeText(levels.scene),
        safeText(row.folder_path),
        safeText(row.user_name),
        safeText(row.user_email),
        safeText(row.user_id),
        safeText(modelDisplayName(row.model)),
        safeText(row.output_type),
        safeText(row.status),
        Number(row.credits) || 0,
        CREDIT_BASIS_LABEL[row.credit_basis] || safeText(row.credit_basis),
        row.elapsed_seconds == null ? "" : Math.round(Number(row.elapsed_seconds) * 10) / 10,
        row.started_local || "",
        row.completed_local || "",
        yesNo(row.is_final),
        yesNo(row.is_shared),
        yesNo(row.is_deleted),
        safeText(row.job_id),
      ];
    }),
  ];
  return "\ufeff" + table.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export const PROJECT_DETAIL_REPORT_FILENAME = "project-detail-report.csv";
