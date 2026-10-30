import { ApiPausedError, authFormHeaders, getAuthToken, HttpError, jsonBody, jsonFetch, NO_RESPONSE_MESSAGE, throwHttpError } from "./http";
import { t } from "./i18n";
import { getAccountNamespace, getConnectionKey } from "./accountScope";
import { COMFY_CANVAS_RUNS_FEATURE, EXPECT_ACCOUNT_HEADER, hubHasFeature, REQUEST_RETRY_FEATURE } from "./hubFeatures";
import type { AssetReferenceIdentity } from "../shared/contracts/assets";
import type { ComfyCanvasAck, ComfyCanvasResolution, ComfyCanvasResolveResponse } from "./comfyRunState";

export interface ComfyCanvasSubmission {
  canvas_run: { attempt_id: string; run_group_id: string; group_seq: number; copy_index: number;
    scene_id: string; card_id: string; config_fp: string; input_fp: string };
  save_meta: { name: string };
  isCurrent: () => boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const RUN_POLL_MS = 1500; // /run_status 폴링 간격
const RUN_POLL_NET_TOLERANCE = 40; // 상태 폴링의 '일시적' 네트워크 실패 관용 횟수(잡은 서버에서 계속 진행)

// 실행 시 연결된 레퍼런스를 타입별로 실어 보내는 미디어 항목(순서 = 슬롯 채움 순서).
export interface ComfyRunMedia extends AssetReferenceIdentity {
  type: "image" | "video";
  name: string;
  blob: Blob;
  source_url?: string;
  source_gen_id?: string | null;
  role?: string;
}

// ComfyUI 통합 API — 연결 설정·파싱(노출 후보)·단독 실행. 항상 로컬 허브에서 처리(/api/comfy).

export interface ComfySettings {
  comfy_url: string;
  comfy_target: "local" | "cloud";
  comfy_api_key: string; // GET 응답에선 "***"(저장됨) 또는 "" (없음)
  has_api_key: boolean;
  comfy_concurrency: number;
  comfy_input_dir: string;
}

export interface ComfyParamCandidate {
  node_id: string;
  class_type: string;
  title: string;
  field: string;
  value: string | number | boolean;
  type: "bool" | "number" | "text";
  label: string;
  choices?: (string | number)[] | null; // 드롭다운 후보(있으면)
  curated: boolean; // 라벨/드롭다운 제공(노출 강제 아님)
  exposed: boolean;
}

export interface ComfyParseResult {
  slots: {
    image_slots: { node_id: string; title: string; class_type: string; field: string; current: unknown }[];
    video_slots: { node_id: string; title: string; class_type: string; field: string; current: unknown; mode: string }[];
    unknown_video_like: { node_id: string; class_type: string; inputs: string[] }[];
    node_count: number;
    params: { node_id: string; title: string; fields: unknown[] }[];
  };
  candidates: ComfyParamCandidate[];
  node_count: number;
}

export interface ComfyOutput {
  kind: "image" | "video" | "text";
  url?: string; // 미디어 출력
  text?: string; // 텍스트 출력
}

export interface ComfyRunResult {
  outputs: ComfyOutput[]; // 복수·혼합 출력(SaveText/SaveImage/VideoCombine 등)
  prompt_id: string;
}

// Comfy 출력 → '내 작업' 저장 요청/응답.
export interface ComfySaveRef extends AssetReferenceIdentity {
  url: string;
  type: "image" | "video";
  source_gen_id?: string | null;
  name?: string | null;
  source_url?: string | null;
  role?: string | null;
}
export interface ComfySavePayload {
  outputs: { url: string; kind: "image" | "video" | "text" }[];
  name?: string; // 워크플로 이름
  prompt?: string; // 프롬프트(text 파라미터 값)
  params?: Record<string, unknown>;
  inputs?: ComfySaveRef[]; // 연결된 입력 레퍼런스(계보)
  project_id?: string | null;
  folder_path?: string | null;
  elapsed_seconds?: number | null; // 실행 누른→결과 나온 소요시간(초). PM 메트릭용.
}
export interface ComfySaveResult {
  saved: { url: string; generation_id: string; existed: boolean }[];
}

export interface ComfyUnresolvedRun {
  job_id: string;
  phase: string;
  prompt_id: string | null;
  target_kind: string;
  base_host: string | null;
  created_at: number | null;
  last_status_code: number | null;
  last_error_class: string | null;
  outputs: { url: string; kind: "image" | "video"; name: string; downloaded: boolean; acked: boolean; unavailable: string | null }[];
  can_collect: boolean;
  can_resave: boolean;
  can_dismiss: boolean;
  device_matches_current: boolean;
  target_matches_current: boolean;
}

export class ComfyUnresolvedRunError extends HttpError {
  readonly jobId: string;

  constructor(error: HttpError, jobId: string) {
    super(error.status, `${error.message} — ${t("설정의 Comfy 미회수 실행에서 확인하세요. 다시 생성하지 마세요.")}`, error.detail);
    this.name = "ComfyUnresolvedRunError";
    this.jobId = jobId;
  }
}

async function waitForRun(jobId: string, isCurrent?: () => boolean): Promise<ComfyRunResult> {
  let netFails = 0;
  for (;;) {
    await sleep(RUN_POLL_MS);
    if (isCurrent && !isCurrent()) throw new DOMException("실행 확인을 다른 창에 넘겼습니다", "AbortError");
    let data: ComfyRunResult & { state?: string };
    try {
      const url = `/api/comfy/run_status?job_id=${encodeURIComponent(jobId)}`;
      const response = await fetch(url, { headers: authFormHeaders() });
      if (!response.ok) {
        try {
          await throwHttpError(response, url);
        } catch (error) {
          if (response.headers.get("X-Comfy-Unresolved") === "1" && error instanceof HttpError) {
            throw new ComfyUnresolvedRunError(error, jobId);
          }
          throw error;
        }
      }
      data = await response.json();
    } catch (error) {
      if (error instanceof TypeError && netFails < RUN_POLL_NET_TOLERANCE) {
        netFails += 1;
        continue;
      }
      throw error;
    }
    netFails = 0;
    if (Array.isArray(data.outputs)) return data;
  }
}

export const comfyApi = {
  resolveCanvasRuns: (attemptIds: string[]) => jsonFetch<ComfyCanvasResolveResponse>("/api/comfy/canvas-runs/resolve", {
    method: "POST", body: jsonBody({ attempt_ids: attemptIds }), headers: { [EXPECT_ACCOUNT_HEADER]: getAccountNamespace() },
  }),
  ackCanvasRun: (receipt: ComfyCanvasAck) => jsonFetch<ComfyCanvasResolution>("/api/comfy/canvas-runs/ack", {
    method: "POST", body: jsonBody(receipt), headers: { [EXPECT_ACCOUNT_HEADER]: getAccountNamespace() },
  }),
  // 없는 UUID 조회도 현재 허브/기기를 돌려준다. 별도 원본 식별 API나 로컬 추정값을 만들지 않는다.
  canvasOrigin: async () => {
    const { runs } = await comfyApi.resolveCanvasRuns([crypto.randomUUID()]);
    const origin = runs[0]?.origin;
    if (!origin?.hub_id || !origin.device_id) throw new Error("Comfy 실행 원본을 확인하지 못했습니다");
    return origin;
  },
  settings: () => jsonFetch<ComfySettings>("/api/comfy/settings"),
  setSettings: (patch: Partial<Omit<ComfySettings, "has_api_key">>) =>
    jsonFetch<ComfySettings>("/api/comfy/settings", { method: "PUT", body: jsonBody(patch) }),
  health: () => jsonFetch<{ alive: boolean; target: string }>("/api/comfy/health"),
  parse: (content: string, exposed?: string[]) =>
    jsonFetch<ComfyParseResult>("/api/comfy/parse", {
      method: "POST",
      body: jsonBody({ content, exposed: exposed ?? [] }),
    }),
  // Comfy 출력(이미지/영상)을 라이브러리 generation 으로 저장 → '내 작업'에 편입. 텍스트는 서버가 제외.
  saveToLibrary: (payload: ComfySavePayload) =>
    jsonFetch<ComfySaveResult>("/api/comfy/save-to-library", { method: "POST", body: jsonBody(payload) }),
  unresolvedRuns: () => jsonFetch<{ cap: number; used: number; runs: ComfyUnresolvedRun[] }>("/api/comfy/unresolved-runs"),
  collectRun: async (jobId: string): Promise<ComfyRunResult> => {
    const account = getAccountNamespace(), connection = getConnectionKey(), token = getAuthToken();
    const current = hubHasFeature(COMFY_CANVAS_RUNS_FEATURE)
      ? () => account === getAccountNamespace() && connection === getConnectionKey() && token === getAuthToken() : undefined;
    const accepted = await jsonFetch<{ job_id: string }>(`/api/comfy/unresolved-runs/${encodeURIComponent(jobId)}/collect`, { method: "POST" });
    return waitForRun(accepted.job_id, current);
  },
  dismissRuns: (jobIds: string[]) => jsonFetch<{ dismissed: number }>("/api/comfy/unresolved-runs/dismiss", {
    method: "POST", body: jsonBody({ job_ids: jobIds, acknowledged: true }),
  }),
  // 실행 — 멀티파트(FormData). content + param_values(JSON) + media_meta(JSON) + media 파일들.
  // media 순서가 백엔드의 타입별 슬롯 채움 순서를 결정한다.
  //  ★백엔드가 제출/폴링/다운로드를 백그라운드로 분리 → /run 은 즉시 job_id 만 주고, 여기서 /run_status 를
  //   완료까지 짧게 폴링한다. 반환형(ComfyRunResult)은 예전과 동일해 호출부(runComfyRaw·배치 짝)는 안 바뀐다.
  run: async (
    content: string,
    paramValues?: Record<string, string | number | boolean>,
    media?: ComfyRunMedia[],
    projectId?: string,
    canvas?: ComfyCanvasSubmission,
  ): Promise<ComfyRunResult> => {
    const fd = new FormData();
    fd.append("content", content);
    fd.append("param_values", JSON.stringify(paramValues ?? {}));
    fd.append("media_meta", JSON.stringify((media ?? []).map((m) => ({ type: m.type,
      source_url: m.source_url, source_gen_id: m.source_gen_id, role: m.role, asset_content_id: m.asset_content_id }))));
    if (projectId) fd.append("project_id", projectId);
    if (canvas) {
      fd.append("canvas_run", JSON.stringify(canvas.canvas_run));
      fd.append("save_meta", JSON.stringify(canvas.save_meta));
    }
    for (const m of media ?? []) fd.append("media", m.blob, m.name);
    // 요청표(run_key) — 허브가 재전송 계약을 알릴 때만. 답을 받지 못하면(전송 TypeError·본문 끊김) 1초 뒤 **같은 키·같은 FormData** 로
    //  한 번 더 보낸다 — 허브가 같은 요청이면 처음 잡을 돌려준다(Comfy Cloud 두 번 과금 방지, Jay 결정 2A). 옛 허브엔 지금처럼 한 번만.
    const retry = !!canvas || (hubHasFeature(REQUEST_RETRY_FEATURE) && typeof crypto?.randomUUID === "function");
    if (retry) fd.append("run_key", canvas?.canvas_run.attempt_id || crypto.randomUUID());
    const account = getAccountNamespace(), connection = getConnectionKey();
    const isCurrent = () => account === getAccountNamespace() && connection === getConnectionKey() && (!canvas || canvas.isCurrent());
    const headers = { ...authFormHeaders(), ...(retry ? { [EXPECT_ACCOUNT_HEADER]: getAccountNamespace() } : {}) };
    const send = async () => {
      if (canvas && !isCurrent()) throw new DOMException("실행 대상이 변경되었습니다", "AbortError");
      const res = await fetch("/api/comfy/run", { method: "POST", body: fd, headers });
      if (!res.ok) await throwHttpError(res, "/api/comfy/run");
      return (await res.json()) as ComfyRunResult & { job_id?: string };
    };
    let first: ComfyRunResult & { job_id?: string };
    try {
      first = await send();
    } catch (error) {
      // 멈춤(다른 탭 로그아웃 — 4B)은 보내지 않은 것이다 — 다시 보내거나 '들어갔을 수 있다'로 바꾸지 않는다(Codex E9)
      if (!retry || error instanceof HttpError || error instanceof ApiPausedError || (error instanceof DOMException && error.name === "AbortError")) throw error;
      await new Promise((done) => setTimeout(done, 1000));
      try {
        first = await send();
      } catch {
        // 다시 보내기가 멈춤으로 못 나갔거나(Codex 61회차) 거절됐어도(62회차) 첫 요청은 들어갔을 수 있다
        throw new Error(NO_RESPONSE_MESSAGE);
      }
    }
    // 구버전 백엔드(동기)는 {outputs} 를 바로 준다 → 재시작 전 새로고침해도 깨지지 않게 그대로 반환.
    if (Array.isArray(first.outputs)) return first;
    const job_id = first.job_id;
    if (!job_id) throw new Error("실행 작업 ID를 받지 못했습니다");

    return waitForRun(job_id, canvas ? isCurrent : undefined);
  },
};
