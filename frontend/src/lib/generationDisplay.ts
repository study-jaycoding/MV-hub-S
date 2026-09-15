import { isFolderDisabled, type DisabledFolders } from "./deactivated";
import type { Generation } from "../types";

export const GENERATION_STATUS_LABEL: Record<string, string> = {
  pending: "생성 중",
  running: "생성 중",
  done: "완료",
  failed: "실패",
  nsfw: "NSFW 차단",
};

// 사유가 비었을 때 보여줄 문구. failed 는 팝업 라벨('⚠ 실패 사유')과 말이 겹쳐 상태를 되풀이하지 않는다.
// nsfw 처럼 뜻이 분명한 상태만 라벨로 설명하고, 모르는 상태의 원인은 지어내지 않는다.
export function generationErrorFallback(status: string): string {
  if (status === "failed") return "상세 사유를 받지 못했습니다.";
  return Object.prototype.hasOwnProperty.call(GENERATION_STATUS_LABEL, status)
    ? `${GENERATION_STATUS_LABEL[status]} 상태입니다. 상세 사유 정보가 없습니다.`
    : "실패 사유 정보가 없습니다.";
}

// 복구 보류 카드의 error 는 "안내 문구 + 줄바꿈 + 제출 진단: <상세>" 형태다(서버
// repo.gen_requests.SUBMIT_DIAGNOSTIC_PREFIX 와 짝). 팝업은 안내를 이미 따로 보여주므로
// 상세만 잘라 쓴다 — 통째로 붙이면 같은 말이 두 번 나온다.
export const SUBMIT_DIAGNOSTIC_MARK = "제출 진단: ";

export function submitDiagnostic(error: string | null | undefined): string | null {
  if (!error) return null;
  const at = error.indexOf(SUBMIT_DIAGNOSTIC_MARK);
  if (at < 0) return null;
  return error.slice(at + SUBMIT_DIAGNOSTIC_MARK.length).trim() || null;
}

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
  preparing: "요청 준비 중",
  pending: "대기",
  claimed: "준비 중",
  submitting: "제출 중",
  tracking: "생성 중",
  verifying: "확인 중",
  blocked: "조치 필요",
  recovery_required: "HF 확인 필요",
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

// ★카드마다 새로 만들지 않는다(2026-09-12, C-15). `toLocaleDateString(locale, options)` 는
//  호출마다 포맷터를 새로 만든다 — 실측 20,000회에 1201.7ms vs 재사용 34.9ms(**34.4배**),
//  카드 200장이면 12.02ms -> 0.35ms 다. 같은 고침을 `dateGroups.ts` 에선 이미 했다.
//  옵션이 고정(en-US·연·월이름·일)이라 재사용해도 표시가 달라지지 않는다 — 날짜 400개로 전수 대조했다.
const GENERATION_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

export function formatGenerationDate(value: string): string {
  const d = parseCreatedAt(value);
  if (isNaN(d.getTime())) return value.slice(0, 10);
  return GENERATION_DATE_FORMAT.format(d);
}

// 생성일 + 시각(로컬) — 정보 팝업 등 정확한 시각이 필요한 곳.
// ★여기는 카드마다 돌지 않으므로 그대로 둔다. 인자 없는 `toLocaleString()` 은 실행 환경의
//  기본 로케일을 쓰는데, 이를 모듈 수준 포맷터로 바꾸면 그 로케일이 **적재 시점에 굳는다**.
//  (참고로 `new Intl.DateTimeFormat()` 을 옵션 없이 쓰면 **날짜만** 나온다 — 시각이 사라진다.)
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
