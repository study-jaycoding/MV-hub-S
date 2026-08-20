// PM 대시보드(매니징먼트) 타입 — 분리형 모듈. 공용 types.ts 와 분리해 제거 용이.
import { DRAG_TYPES } from "../../lib/dragTypes";
import { getLang } from "../../lib/i18n";

export interface Planning {
  project_id?: string;
  status?: string | null; // active | done | hold
  start_date?: string | null;
  due_date?: string | null;
  budget_credits?: number | null;
  budget_period?: "day" | "week" | "month" | null;
  archive_after_days?: number | null;
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

export interface ProjectModelUsage {
  model: string;
  count: number;
  credits: number;
  final_count: number;
  elapsed_seconds?: number;
}

export interface ProjectCreatorUsage {
  uid: string;
  name: string;
  count: number;
  credits: number;
  final_count: number;
}

export interface ProjectFolderUsage {
  folder_path: string;
  count: number;
  final_count: number;
  credits: number;
  elapsed_seconds: number;
  created_start?: string | null;
  created_end?: string | null;
  models: ProjectModelUsage[];
  members: ProjectCreatorUsage[];
}

export interface ManageProject {
  pid: string | null;
  name: string;
  gen_count: number;
  done_count: number;
  shared_count: number; // 게시(공유)된 생성물 수
  final_count: number; // 완료(최종선택·골드) 생성물 수
  real_credits: number;
  credits: number; // COALESCE(실제, 견적)
  workspace_moved?: boolean; // 다른 워크스페이스로 이동한 프로젝트의 과거 기록 행(구서버는 미제공)
  budget_used_credits?: number; // 설정된 일/주/월의 현재 기간 사용량(구서버는 미제공)
  models?: ProjectModelUsage[]; // 프로젝트 전체 모델별 생성·크레딧·최종 집계
  budget_models?: ProjectModelUsage[]; // 현재 예산 주기의 모델별 사용 집계
  folders?: ProjectFolderUsage[]; // 등록 폴더+실제 생성물을 합친 시퀀스별 집계
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

export interface ManageSummary {
  projects: ManageProject[];
  workers: ManageWorker[];
  totals: ManageTotals;
  workspaces?: Workspace[];
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
  { v: "publish", ko: "게시", en: "Publish", color: "#3f9d6b", group: "진행 중" },
  { v: "done", ko: "완료", en: "Done", color: "#c79320", group: "완료" },
  { v: "omit", ko: "생략", en: "Omit", color: "#787c82", group: "완료" },
];
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
// 작업 테이블에서는 생성물의 실제 흐름이 바로 읽히도록 상태를 생성·공유·완료로 표현한다.
const WORK_ACTIVITY_STATUS_LABELS: Record<string, string> = {
  not_started: "시작 전",
  pending: "대기",
  in_progress: "생성",
  publish: "공유",
  done: "완료",
  omit: "생략",
};
export function workActivityStatusLabel(v?: string | null): string {
  return (v && WORK_ACTIVITY_STATUS_LABELS[v]) || statusLabel(v);
}
// '시작 전'은 수동 작업·생성물 없는 계획 작업에 의미가 있어 보드 열·드롭다운·필터에 노출한다.
// (폴더 자동 작업은 생성물이 있으면 백엔드가 진행 이상으로 파생하므로 자연히 안 걸린다.)
// 'pending'(대기)만 현재 워크플로에서 미사용이라 숨김. 보드/테이블/필터 단일 소스.
export const HIDDEN_STATUSES = new Set(["pending"]);
export const SELECTABLE_STATUSES = STATUSES.filter((s) => !HIDDEN_STATUSES.has(s.v));

// 작업탭 노션식 필터 — 다중선택 칩 5종 + 자유 검색. 전부 클라이언트에서 적용(백엔드 무관).
export type WorkFilterField = "project" | "episode" | "sequence" | "status" | "creator" | "model";
export const WORK_FILTER_FIELDS: WorkFilterField[] = [
  "project",
  "episode",
  "sequence",
  "status",
  "creator",
  "model",
];
export const WORK_FILTER_LABELS: Record<WorkFilterField, string> = {
  project: "프로젝트",
  episode: "에피소드",
  sequence: "시퀀스",
  status: "상태",
  creator: "생성자",
  model: "모델",
};
export interface WorkFilters {
  active: WorkFilterField[]; // 추가된 칩(표시 순서 유지)
  values: Record<WorkFilterField, string[]>; // 필드별 선택값(빈 배열=조건 없음, 포함 매칭)
  search: string; // 자유 검색어(에피소드·시퀀스·설명·프로젝트·생성자 대상)
}
export function emptyWorkFilters(): WorkFilters {
  return {
    active: [],
    values: { project: [], episode: [], sequence: [], status: [], creator: [], model: [] },
    search: "",
  };
}

// 보드/테이블 뷰가 공유하는 props(WorkBoard 가 데이터·핸들러 주입)
export interface WorkViewProps {
  tasks: Task[];
  seqOptions: string[];
  thumb: (path?: string | null) => string | undefined;
  disabled: Set<string>; // d 로 비활성화(회색)된 생성물 id — 로컬(localStorage) 기준
  colorMap?: Record<string, string>; // 값 색 라벨 "field::value"->colorKey (프로젝트/시퀀스 등)
  myUid?: string | null; // 현재 로그인 uid — '내 작업' 필터·표시용
  readOnly?: boolean; // 과거 워크스페이스 기록 화면 — 모든 변경 동작 차단
  onPatch: (tid: string, patch: Partial<Task>) => void;
  onDelete: (tid: string) => void;
  onLinkGen: (tid: string, genId: string) => void;
  onUnlinkGen: (tid: string, genId: string) => void;
  // 테이블 전용(선택·순서) — 보드/캘린더는 사용 안 함(옵션).
  selected?: Set<string>;
  onToggleSelect?: (id: string) => void;
  onToggleSelectAll?: (ids: string[], on: boolean) => void;
  onReorder?: (draggedId: string, targetId: string) => void;
}

export interface Cut {
  id: string;
  status: string;
  creator_uid?: string | null;
  creator_name?: string | null;
  model?: string | null; // 모델별 크레딧 호버 집계용
  thumb?: string | null; // 포스터/이미지 경로(비디오는 poster 없으면 null)
  media_type?: string | null; // 'image' | 'video' | ... — 비디오면 <video> 로 렌더
  file_path?: string | null; // 원본 파일 경로(비디오 첫 프레임 표시용)
  is_final?: number | boolean; // 최종(골드)
  shared?: number | boolean; // 팀 공유됨
  linked?: number | boolean; // 수동 드래그 링크(✕ 해제 가능). 시퀀스 자동 귀속은 false
  created_at?: string | null; // 생성일 — 캘린더(생성자별 활동) 날짜 배치용
  credits?: number; // 이 컷의 크레딧(참여자별 집계용)
  elapsed?: number; // 이 컷의 생성 소요시간(초) — 개인 작업표 재집계용
  comment_count?: number; // 이 컷의 코멘트 수 — 개인 작업표 재집계용
}
// 카드 썸네일 노출 한도 — 최종→공유→일반 순(백엔드 정렬)에서 앞 3장.
export const CUT_THUMB_MAX = 3;

export interface Task {
  id: string;
  project_id: string;
  name: string;
  status: string; // not_started|pending|in_progress|publish|retake|omit|done
  start_date?: string | null;
  due_date?: string | null;
  sort_order?: number | null;
  note?: string | null;
  sequence?: string | null; // 전역 태그명 또는 폴더 2단계(자동 작업)
  description?: string | null;
  folder_path?: string | null; // 렌더 루트 상대 경로(예 ep001/c0010) — 폴더 자동 작업
  source_kind?: "manual" | "generation" | string;
  source_last_seen_at?: string | null;
  archived?: number | boolean;
  workspace_scope?: "team" | "personal" | "unknown" | string;
  workspace_id?: string | null;
  workspace_name?: string | null;
  workspace_origin?: "snapshot" | "generation" | "unknown" | string;
  workspace_unresolved?: boolean;
  workspace_historical?: boolean;
  project_name?: string | null; // 소속 프로젝트명(전체 프로젝트 병합 뷰에서 프론트가 부착)
  created_at: string;
  // 파생(연결 생성물에서)
  gen_count?: number;
  derived_date?: string | null; // 마감/시작일 없을 때 캘린더가 쓰는 폴백(연결 컷 최초 생성일)
  derived_start?: string | null; // 연결 컷 최초 생성일(YYYY-MM-DD) — PM 미설정 시 시작일 파생
  derived_due?: string | null; // 연결 컷 최종 생성일(YYYY-MM-DD) — PM 미설정 시 마감일 파생
  cuts?: Cut[];
  creators?: string[]; // 실제 생성자(연결 컷 파생)
  credits?: number;
  elapsed?: number;
  comment_count?: number;
}

export function taskIsReadOnly(task: Task, viewReadOnly = false): boolean {
  return viewReadOnly || !!task.workspace_historical || !!task.workspace_unresolved;
}
