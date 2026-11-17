import { jsonBody, jsonFetch } from "./http";

export type ReleaseUpdateState =
  | "unavailable"
  | "check_failed"
  | "up_to_date"
  | "available"
  | "starting"
  | "checking"
  | "downloading"
  | "installing"
  | "restarting"
  | "complete"
  | "failed";

export interface ReleaseUpdateStatus {
  state: ReleaseUpdateState;
  message: string;
  install_mode: "release" | "server" | "development";
  current_version: string;
  latest_version: string;
  can_update: boolean;
  generation_active: number;
  comfy_active: number;
  resolve_active: number; // 진행 중 Resolve 직접 전송(요청 안에서 준비·반입·저장)
  result_write_active?: number;
  active_total: number;
  updated_at: string;
  accepted?: boolean;
  percent?: number; // 업데이트 실행기(bat)가 기록하는 전체 진행률 0~100
  // 실패 시 설치 트리 상태(워커가 기록): not_started(앱 무사)·rolled_back(구버전 복원)·
  // new_committed(신버전 커밋됐지만 재시작 실패)·recovery_required(롤백 미완 — 수동 복구 필요)
  recovery?: string;
  // 관리자 PC 에만 — NAS 에 공지 전 후보가 있으면 그 버전(B안). 설치·버튼과는 무관한 안내 한 줄.
  candidate_version?: string;
  // 이 PC 가 공지 전 후보를 쓰는 중(관리자 선설치, 2026-10-03) — 상태 문구는 서버 문구를 그대로 보인다.
  candidate?: boolean;
}

export interface LatestReleaseMetadata {
  version: string;
  file: string;
  sha256: string;
  size: number;
  created_at: string;
  // B안(2026-10-02) — 옛 로컬 허브는 없음. source=candidate 면 위 5필드는 NAS 의 후보(candidate.json).
  source?: "candidate" | "latest";
  candidate_error?: string | null; // 후보 파일이 있는데 못 읽음 — 등록·공지·배포를 막는다
  published?: { version: string; sha256: string; file?: string } | null; // 팀원이 지금 받는 판(latest.json)
  published_state?: "ok" | "missing" | "error";
  pending?: boolean | null; // 후보가 아직 팀에 배포 안 됨. null = 공개 표지를 못 읽어 확인 불가
}

// 업데이트 탭(2026-10-05) — NAS 의 모든 판. 팀 배포(promote·deploy-package)는 2026-10-23 서버 관리 창 [릴리스]로 옮겼다.
export interface ReleasePackage {
  file: string;
  version: string;
  size: number;
  modified: string;
}

export function listReleasePackages() {
  return jsonFetch<ReleasePackage[]>("/api/release-update/packages");
}

// 업데이트 실행기(update_release.bat)는 CP949 인코딩 함정 때문에 상태 message를
// 영어(ASCII)로만 기록한다 — 한글이 bat 안에 있으면 표준 한국어 Windows 에서 추출이
// 깨져 업데이트 자체가 죽는다(실측). 화면 한글은 여기서 state 코드로 매핑한다.
const STATE_LABEL_KO: Partial<Record<ReleaseUpdateState, string>> = {
  starting: "업데이트 실행기를 준비하는 중…",
  checking: "최신 릴리스를 확인하는 중…",
  downloading: "업데이트 파일을 내려받는 중…",
  installing: "검증된 새 버전을 설치하는 중…",
  restarting: "새 버전으로 프로그램을 다시 시작하는 중…",
  complete: "업데이트가 완료됐습니다.",
  up_to_date: "최신 버전입니다.",
};

// 상태 문구 — 진행 상태는 한글 라벨(+퍼센트), 실패는 한글 접두 + 원문(영어 디테일 보존).
export function releaseUpdateMessage(status: ReleaseUpdateStatus | null): string {
  if (!status) return "";
  if (status.candidate && status.message) return status.message; // 공지 전 후보 사용 중·손상 안내
  const label = STATE_LABEL_KO[status.state];
  if (label) {
    const pct = typeof status.percent === "number" ? ` (${Math.min(100, status.percent)}%)` : "";
    return label + pct;
  }
  if (status.state === "failed") {
    const raw = status.message || "";
    const text = raw.startsWith("업데이트 실패") ? raw : `업데이트 실패: ${raw}`;
    if (status.recovery === "recovery_required") {
      // 롤백이 끝까지 안 된 유일한 위험 상태 — 재시도보다 로그 확인이 먼저다.
      // 복구 자체는 안전하다: 다음 실행이 백업을 격리 보존한 채 새로 설치한다.
      return (
        text
        + " — 자동 복구가 완료되지 않았습니다. %LOCALAPPDATA%\\MVHub\\updates\\update.log 를 확인한 뒤, 설정의 '강제 업데이트'로 재시도하세요(백업은 보존됩니다)."
      );
    }
    return text;
  }
  return status.message || "";
}

/** 업데이트 중 백엔드 무응답(연속)이 이 시간을 넘으면 멈춘 진행률 대신 정직한 안내로 바꾼다. */
export const UPDATE_UNREACHABLE_WARN_MS = 90_000;

/** 폴링 연속 실패 안내 — 교체·재시작 구간의 짧은 무응답은 null(직전 문구 유지).
 * 업데이터가 아직 롤백·복사 중일 수 있으므로 "직접 실행하라"는 안내는 하지 않는다
 * (사용자가 앱을 띄우면 런타임 파일을 다시 잠가 2차 실패를 만든다 — 코덱스 검토). */
export function pollFailureMessage(firstFailedAt: number | null, now: number): string | null {
  if (firstFailedAt == null) return null;
  if (now - firstFailedAt < UPDATE_UNREACHABLE_WARN_MS) return null;
  return "앱 응답이 90초 넘게 없습니다. 업데이트가 아직 실행 중일 수 있으니 프로그램을 직접 실행하지 말고 잠시 기다려주세요.";
}

// 자동 확인 제한(덮개·설정 창 공통) — 시작부터 재는 고정 5분은 정상 설치를 끊었다: 파일 교체·확인 동안 앱이 꺼져 진행을
//  읽을 수 없고, 그 구간만 이 PC 실측 약 4분(설치 전체 약 5분, 2026-11-18 0632→0602·11-17 →0632). 진행이 바뀌는 동안은
//  기다리고, 멈췄을 때만 끊는다. docs/status/업데이트덮개_시간초과_2026-11-18.md
// 상태 그대로 10분 — 70% 고정인 파일 준비(이 PC 31초)가 느린 PC 에서 길어질 수 있고, 시간 초과 화면은 [강제 업데이트]를 내주므로
//  늦게 알리는 쪽이 잘못 알리는 쪽보다 안전하다.
export const UPDATE_STALL_MS = 10 * 60_000; // 앱이 답하는데 상태가 그대로인 시간
export const UPDATE_SILENT_MS = 15 * 60_000; // 앱이 답하지 않는 시간(교체·확인·다시 시작 — 실패하면 업데이터가 옛 판으로 되돌린다)
export const UPDATE_MAX_MS = 40 * 60_000; // 시작부터 전체 상한(무한 대기 방지 — 2026-10-03 CXF-6)
export const UPDATE_SLOW_ANSWER_MS = 30_000; // 이만큼 늦게 온 답은 그 사이 앱이 꺼졌다 뜬 것일 수 있어 진행으로 본다

export const UPDATE_TIMEOUT_MESSAGE =
  "자동 확인 시간이 초과됐습니다. 설치가 이미 끝났을 수 있으니 닫기를 누른 뒤 새로 고침해 판을 먼저 확인하세요. 프로그램 창과 업데이트 로그(%LOCALAPPDATA%\\MVHub\\updates\\update.log)도 확인해주세요.";

/** 진행 비교용 열쇠 — 단계·퍼센트·문구·지금 판 중 하나라도 바뀌면 진행으로 본다. */
export function updateProgressKey(status: ReleaseUpdateStatus): string {
  return JSON.stringify([status.state, status.percent ?? null, status.message ?? "", status.current_version ?? ""]);
}

/** 자동 확인을 멈출 때인가 — silentSince = 앱이 답하지 않기 시작한 때(답하는 중이면 null). */
export function updateWaitExpired(t: { now: number; startedAt: number; lastChangeAt: number; silentSince: number | null }): boolean {
  if (t.now - t.startedAt >= UPDATE_MAX_MS) return true;
  if (t.silentSince != null) return t.now - t.silentSince >= UPDATE_SILENT_MS;
  return t.now - t.lastChangeAt >= UPDATE_STALL_MS;
}

/** 덮개·설정 창이 같이 쓰는 자동 확인 시계 — 요청을 보낸 때·받은 답·실패를 알려 주면 멈출 때인지 답한다.
 *  답을 기다리는 요청이 있는 동안은 '응답 없음'으로 잰다: 상태가 그대로인 채 정체 기준 직전에 앱이 꺼지면(교체 시작), 그 요청은
 *  아직 실패도 답도 아니다 — 정체로 재면 정상 설치를 끊는다(Codex 리뷰 1차 높음). */
export function createUpdateWaitClock(now = Date.now()) {
  const startedAt = now;
  let lastChangeAt = now;
  let lastKey = "";
  let askedAt: number | null = null;
  let failedSince: number | null = null;
  return {
    asked(at = Date.now()) {
      askedAt = at;
    },
    answered(status: ReleaseUpdateStatus, at = Date.now()) {
      const key = updateProgressKey(status);
      // 앱이 다시 답하기 시작한 것(교체 뒤 새 앱)·오래 걸린 답도 진행이다 — 꺼지기 전과 같은 상태여도 정체 시계를 새로 잰다
      if (key !== lastKey || failedSince != null || (askedAt != null && at - askedAt >= UPDATE_SLOW_ANSWER_MS)) {
        lastKey = key;
        lastChangeAt = at;
      }
      askedAt = null;
      failedSince = null;
    },
    failed(at = Date.now()) {
      failedSince ??= askedAt ?? at;
      askedAt = null;
    },
    /** 연속 실패가 시작된 때 — 90초 안내(pollFailureMessage)용. 답을 기다리는 중은 넣지 않는다. */
    failedSince: () => failedSince,
    expired(at = Date.now()) {
      return updateWaitExpired({ now: at, startedAt, lastChangeAt, silentSince: failedSince ?? askedAt });
    },
  };
}

export const UPDATE_WAIT_VERSION_KEY = "mvhub.release-update.wait-version";

export function isReleaseUpdateRunning(state: ReleaseUpdateState | undefined): boolean {
  return state === "starting"
    || state === "checking"
    || state === "downloading"
    || state === "installing"
    || state === "restarting";
}

export function getReleaseUpdateStatus(refresh = false): Promise<ReleaseUpdateStatus> {
  return jsonFetch<ReleaseUpdateStatus>(
    `/api/release-update/status${refresh ? "?refresh=true" : ""}`,
  );
}

export function getLatestReleaseMetadata(): Promise<LatestReleaseMetadata> {
  return jsonFetch<LatestReleaseMetadata>("/api/release-update/latest-metadata");
}

// 업데이트를 시작하는 자리가 둘이다(설정 패널·알림센터). 진행 덮개가 어느 쪽에서 눌러도 뜨도록
// 호출부마다 붙이지 않고 **시작 함수 한 곳에서** 알린다(Jay 2026-09-28).
const startListeners = new Set<() => void>();

/** 업데이트가 시작되면 부른다. 반환값을 호출하면 구독을 푼다. */
export function onReleaseUpdateStarted(fn: () => void): () => void {
  startListeners.add(fn);
  return () => {
    startListeners.delete(fn);
  };
}

/** force=true — 활동 수 검사만 우회하는 비상 옵션.
 * 업데이트 상태 안전 검사는 유지하며, bat 직접 실행과 동일하지 않다. */
export function startReleaseUpdate(force = false): Promise<ReleaseUpdateStatus> {
  return jsonFetch<ReleaseUpdateStatus>("/api/release-update/start", {
    method: "POST",
    headers: { "X-MVHub-Update": "1" },
    body: jsonBody({ confirm: true, force }),
  }).then(afterUpdateStarted);
}

/** 관리자 창 업데이트 탭 — '목록에 등록'한 후보를 [공지] 전에 이 PC 에만 먼저 설치한다(2026-10-03).
 * 등록·Admin 은 공유 서버가 판정하고, 팀원 PC·공개 표지는 바뀌지 않는다. */
export function startCandidateUpdate(noticeId: string, sha256: string): Promise<ReleaseUpdateStatus> {
  return jsonFetch<ReleaseUpdateStatus>("/api/release-update/start-candidate", {
    method: "POST",
    headers: { "X-MVHub-Update": "1" },
    body: jsonBody({ notice_id: noticeId, sha256, confirm: true }),
  }).then(afterUpdateStarted);
}

function afterUpdateStarted(status: ReleaseUpdateStatus): ReleaseUpdateStatus {
  // 대기 표시 — 업데이트가 앱을 재시작시키므로, 새 화면이 떠도 덮개가 이어지게 남긴다.
  try {
    if (status.latest_version) {
      window.sessionStorage.setItem(UPDATE_WAIT_VERSION_KEY, status.latest_version);
    }
  } catch {
    // 사생활 보호 창 등 — 없어도 같은 화면에서는 시작 신호로 동작한다.
  }
  startListeners.forEach((fn) => fn());
  return status;
}

/** 강제 업데이트 확인창에 덧붙이는 안내 — 강제는 공개된 판을 다시 깐다(관리자가 먼저 깐 후보보다 옛 판일 수 있다). */
export const FORCE_UPDATE_INSTALLS_PUBLIC =
  "현재 공개된 판을 설치합니다. 이 PC 에 먼저 설치한 후보가 있으면 그보다 이전 버전으로 돌아갈 수 있습니다.";

/** 진행 덮개의 단계 목록 — 실행기가 지나가는 순서 그대로. */
export const UPDATE_STAGES: { key: ReleaseUpdateState; label: string }[] = [
  { key: "checking", label: "최신 버전 확인" },
  { key: "downloading", label: "파일 내려받기" },
  { key: "installing", label: "검증 후 설치" },
  { key: "restarting", label: "새 버전으로 다시 시작" },
];

/** 지금 몇 번째 단계인가. 끝난 단계는 이 값보다 작다. complete 는 전부 끝난 것(=길이). */
export function updateStageIndex(state: ReleaseUpdateState): number {
  if (state === "complete") return UPDATE_STAGES.length;
  // starting 은 실행기를 띄우는 중 — 첫 단계(확인)를 진행 중으로 본다.
  if (state === "starting") return 0;
  const at = UPDATE_STAGES.findIndex((s) => s.key === state);
  return at < 0 ? 0 : at;
}

/** 업데이트를 막는 진행 중 작업을 사람이 읽는 문구로 — 유료 생성·Comfy 와 Resolve 전송을 나눠 말한다. */
export function updateBlockersText(
  status: Pick<ReleaseUpdateStatus, "active_total" | "resolve_active"> & Partial<Pick<ReleaseUpdateStatus, "result_write_active" | "comfy_active">> | null | undefined,
): string {
  const active = status?.active_total || 0;
  const resolveActive = status?.resolve_active || 0;
  const detailed = typeof status?.result_write_active === "number";
  const writes = status?.result_write_active || 0;
  const comfy = detailed ? status?.comfy_active || 0 : 0;
  const generationActive = Math.max(0, active - resolveActive - writes - comfy);
  return [
    generationActive > 0 ? `${detailed ? "생성 제출" : "생성"} ${generationActive}건` : "",
    writes > 0 ? `결과 저장 ${writes}건` : "",
    comfy > 0 ? `ComfyUI 실행 ${comfy}건` : "",
    resolveActive > 0 ? `Resolve 전송 ${resolveActive}건` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
