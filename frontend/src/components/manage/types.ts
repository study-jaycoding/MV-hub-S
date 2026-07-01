// PM 대시보드(매니징먼트) 타입 — 분리형 모듈. 공용 types.ts 와 분리해 제거 용이.
import { DRAG_TYPES } from "../../lib/dragTypes";
import { getLang } from "../../lib/i18n";

export interface Planning {
  project_id?: string;
  status?: string | null; // active | done | hold
  start_date?: string | null;
  due_date?: string | null;
  budget_credits?: number | null;
  note?: string | null;
}

export interface TypeCounts {
  image: number;
  video: number;
  "3d": number;
  audio: number;
}

export interface Workspace {
  id: string;
  name: string;
  credits: number | null;
  plan_type?: string | null;
  user_role?: string | null;
}

export interface ManageProject {
  pid: string | null;
  name: string;
  gen_count: number;
  done_count: number;
  real_credits: number;
  credits: number; // COALESCE(실제, 견적)
  metric_count: number;
  elapsed_total: number;
  planning?: Planning | null;
  types?: TypeCounts;
  video_seconds?: number;
}

export interface ManageWorker {
  uid: string | null;
  name: string;
  gen_count: number;
  credits: number;
  elapsed_total: number;
}

export interface ManageTotals {
  gen_count: number;
  done_count: number;
  credits: number;
  real_credits: number;
  elapsed_total: number;
  metric_count: number;
  types?: TypeCounts;
  video_seconds?: number;
  spend_credits?: number;
  refund_credits?: number;
  grant_credits?: number;
  net_credits?: number;
}

export interface Agent {
  label: string;
  cli_version?: string | null;
  plan?: string | null;
  credits?: number | null;
}

export interface ManageSummary {
  projects: ManageProject[];
  workers: ManageWorker[];
  totals: ManageTotals;
  workspaces?: Workspace[];
  agents?: Agent[];
}

export interface TimePoint {
  bucket: string;
  count: number;
  credits: number;
}

export interface MatrixCell {
  count: number;
  credits: number;
}

export interface MatrixData {
  workers: { uid: string; name: string }[];
  projects: { pid: string; name: string }[];
  cells: Record<string, Record<string, MatrixCell>>;
}

// 드래그 dataTransfer 키 — 생성물(컷)을 작업에 드롭 연결
export const GEN_MIME = DRAG_TYPES.generation;
// 보드 카드 상태 이동 드래그 키
export const TASK_MIME = DRAG_TYPES.task;

// 작업 상태(보드 열·테이블 셀 공유 단일 소스) — Notion 스타일 3그룹 7세분 상태.
// group: 보드를 큰 묶음(할 일/진행 중/완료)으로 띠 구분. color: 상태 칩·열 헤더 색.
export interface StatusDef {
  v: string;
  ko: string; // 한글 라벨
  en: string; // 영문 라벨
  color: string;
  group: string;
}
export const STATUS_GROUPS = ["할 일", "진행 중", "완료"] as const;
const GROUP_EN: Record<string, string> = {
  "할 일": "To-do",
  "진행 중": "In progress",
  "완료": "Done",
};
export const STATUSES: StatusDef[] = [
  { v: "not_started", ko: "시작 전", en: "Not started", color: "#9aa0a6", group: "할 일" },
  { v: "pending", ko: "대기", en: "Pending", color: "#c2557a", group: "진행 중" },
  { v: "in_progress", ko: "진행", en: "In progress", color: "#3b7bd4", group: "진행 중" },
  { v: "publish", ko: "게시", en: "Publish", color: "#c79320", group: "진행 중" },
  { v: "done", ko: "완료", en: "Done", color: "#3f9d6b", group: "완료" },
  { v: "omit", ko: "생략", en: "Omit", color: "#787c82", group: "완료" },
];
export const DEFAULT_STATUS = "not_started";
export function statusDef(v?: string | null): StatusDef | undefined {
  return STATUSES.find((s) => s.v === v);
}
// 선택 언어 하나만 표시(병기 아님) — i18n 토글(한글/English)에 따름.
export function statusText(s: StatusDef): string {
  return getLang() === "en" ? s.en : s.ko;
}
export function groupLabel(g: string): string {
  return getLang() === "en" ? GROUP_EN[g] ?? g : g;
}
export function statusLabel(v?: string | null): string {
  const d = statusDef(v);
  return d ? statusText(d) : v || "—";
}
export function statusColor(v?: string | null): string {
  return statusDef(v)?.color ?? "#787c82";
}

// 보드/테이블 뷰가 공유하는 props(WorkBoard 가 데이터·핸들러 주입)
export interface WorkViewProps {
  tasks: Task[];
  seqOptions: string[];
  thumb: (path?: string | null) => string | undefined;
  onCreate: (status: string, name: string) => void;
  onPatch: (tid: string, patch: Partial<Task>) => void;
  onDelete: (tid: string) => void;
  onLinkGen: (tid: string, genId: string) => void;
  onUnlinkGen: (tid: string, genId: string) => void;
}

export interface Cut {
  id: string;
  status: string;
  creator_uid?: string | null;
  creator_name?: string | null;
  thumb?: string | null;
  is_final?: number | boolean; // 최종(골드)
  shared?: number | boolean; // 팀 공유됨
  linked?: number | boolean; // 수동 드래그 링크(✕ 해제 가능). 시퀀스 자동 귀속은 false
}
// 카드 썸네일 노출 한도 — 최종→공유→일반 순(백엔드 정렬)에서 앞 3장.
export const CUT_THUMB_MAX = 3;

export interface Task {
  id: string;
  project_id: string;
  name: string;
  status: string; // not_started|pending|in_progress|publish|retake|omit|done
  assignee_uid?: string | null;
  start_date?: string | null;
  due_date?: string | null;
  sort_order?: number | null;
  note?: string | null;
  sequence?: string | null; // 전역 태그명
  description?: string | null;
  created_at: string;
  // 파생(연결 생성물에서)
  gen_count?: number;
  cuts?: Cut[];
  creators?: string[];
  credits?: number;
  elapsed?: number;
  comment_count?: number;
  assignee_name?: string | null;
}
