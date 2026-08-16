import { isFolderDisabled, type DisabledFolders } from "./deactivated";
import type { Generation } from "../types";

export const GENERATION_STATUS_LABEL: Record<string, string> = {
  pending: "생성중",
  running: "생성중",
  done: "완료",
  failed: "실패",
  nsfw: "NSFW 차단",
};

// pending/running 카드는 '내 PC 에이전트가 실행'하는 로컬 생성 — 에이전트가 떠 있어야 완료된다.
export const LOCAL_EXEC_HINT =
  "내 PC의 에이전트가 로컬 CLI로 생성 중입니다. 에이전트(push_agent --watch)가 떠 있어야 완료됩니다.";

export function generationStatusLabel(status: string): string {
  return GENERATION_STATUS_LABEL[status] || status;
}

// '확인중' 마커 — 서버 repo.VERIFYING_NOTE 와 짝. 모호한 결말(타임아웃/파싱실패)에서 job_id 만 확보한
//  카드는 running 이되 error 에 이 문구가 담긴다 → '생성중' 대신 '확인중'으로 표시(재조정이 곧 확정).
export const VERIFYING_MARK = "확인중";

const EXECUTION_PHASE_LABEL: Record<string, string> = {
  pending: "대기",
  claimed: "준비 중",
  submitting: "제출 중",
  tracking: "생성 중",
  verifying: "확인 중",
  blocked: "조치 필요",
  recovery_required: "복구 확인 필요",
  done: "완료",
  failed: "실패",
};

export function isVerifying(status: string, error: string | null | undefined): boolean {
  return (status === "running" || status === "pending") && !!error && error.includes(VERIFYING_MARK);
}

export function generationStatusLabelFor(
  status: string,
  error?: string | null,
  executionPhase?: string | null,
): string {
  if (executionPhase && EXECUTION_PHASE_LABEL[executionPhase]) return EXECUTION_PHASE_LABEL[executionPhase];
  return isVerifying(status, error) ? "확인 중" : generationStatusLabel(status);
}

export function generationStatusTitle(
  status: string,
  error: string | null,
  executionPhase?: string | null,
  providerStatus?: string | null,
  lastCheckedAt?: string | null,
  nextCheckAt?: string | null,
): string | undefined {
  const details: string[] = [];
  if (executionPhase) details.push(`단계: ${EXECUTION_PHASE_LABEL[executionPhase] || executionPhase}`);
  if (providerStatus) details.push(`Higgsfield 상태: ${providerStatus}`);
  if (lastCheckedAt) details.push(`마지막 확인: ${formatGenerationDateTime(lastCheckedAt)}`);
  if (nextCheckAt && !["done", "failed"].includes(executionPhase || "")) {
    details.push(`다음 확인: ${formatGenerationDateTime(nextCheckAt)}`);
  }
  if (error) details.push(error);
  if (details.length) return details.join("\n");
  if (isVerifying(status, error)) return error || undefined; // "확인중 — 실제 상태 재확인 대기"
  if (status === "failed" && error) return error;
  if (status === "pending" || status === "running") return LOCAL_EXEC_HINT;
  return undefined;
}

// created_at 은 UTC "YYYY-MM-DD HH:MM:SS"(대개 tz 표기 없음)로 저장된다 — comfy=SQLite datetime('now'),
// 힉스필드=epoch_to_iso 모두 UTC. tz 표기 없이 new Date() 하면 로컬로 오인하므로 UTC(Z)로 파싱해
// 로컬 시각으로 표시한다(표시만; dateGroups.dayInfoFromUtcString 과 동일 규칙).
function parseCreatedAt(value: string): Date {
  let s = value.replace(" ", "T");
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += "Z"; // tz 표기 없으면 UTC 로 간주
  return new Date(s);
}

export function formatGenerationDate(value: string): string {
  const d = parseCreatedAt(value);
  if (isNaN(d.getTime())) return value.slice(0, 10);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

// 생성일 + 시각(로컬) — 정보 팝업 등 정확한 시각이 필요한 곳.
export function formatGenerationDateTime(value: string): string {
  if (!value) return value;
  const d = parseCreatedAt(value);
  return isNaN(d.getTime()) ? value : d.toLocaleString();
}

// 영상 길이 표기 — 숫자든 숫자문자열("4")이든 "4.0s" 로 통일(힉스필드 기본 duration 은 문자열이라 통일 필요).
// 숫자로 못 읽는 문자열은 그대로, 값이 없으면 undefined(Row·배지 자동 생략).
function formatDurationSec(d: unknown): string | undefined {
  const n = typeof d === "number" ? d : typeof d === "string" && d.trim() !== "" ? Number(d) : NaN;
  if (Number.isFinite(n)) return `${n.toFixed(1)}s`;
  return typeof d === "string" ? d : undefined;
}

export function generationListMeta(params: Record<string, unknown>): {
  resolution?: string;
  duration?: string;
  aspect?: string;
} {
  return {
    resolution: typeof params.resolution === "string" ? params.resolution : undefined,
    duration: formatDurationSec(params.duration),
    aspect: typeof params.aspect_ratio === "string" ? params.aspect_ratio : undefined,
  };
}

export function hasActiveGenerationJob(gens: Generation[]): boolean {
  return gens.some((g) => g.status === "pending" || g.status === "running");
}

export function filterDisabledGenerations(
  gens: Generation[],
  disabledIds: Set<string>,
  hideDisabled: boolean,
): Generation[] {
  return hideDisabled ? gens.filter((g) => !disabledIds.has(g.id)) : gens;
}

// id 만 받는 소비자(엣지·썸네일그리드·보드노드)에 넘길 '확장된 비활성 id 집합'.
// 폴더 규칙이 없으면 기존 id 집합을 그대로 돌려줘 불필요한 순회를 피한다.
export function expandDisabledGenerationIds(
  gens: Pick<Generation, "id" | "project_id" | "folder_path">[],
  disabledIds: Set<string>,
  disabledFolders: DisabledFolders,
): Set<string> {
  if (!Object.keys(disabledFolders).length) return disabledIds;
  const s = new Set(disabledIds);
  for (const g of gens) {
    if (isFolderDisabled(disabledFolders, g.project_id, g.folder_path)) s.add(g.id);
  }
  return s;
}

export function canFinalizeGeneration(g: Generation, finalizeProjects: Set<string>): boolean {
  return (
    finalizeProjects.has("*") ||
    (!!g.project_id && finalizeProjects.has(g.project_id)) ||
    (!g.project_id && !!g.is_mine)
  );
}

export function shareableGenerations(gens: Generation[]): Generation[] {
  return gens.filter((g) => g.is_mine && g.status === "done" && !g.shared);
}
