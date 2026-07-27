import { authFormHeaders, jsonBody, jsonFetch, throwHttpError } from "./http";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const RUN_POLL_MS = 1500; // /run_status 폴링 간격
const RUN_POLL_NET_TOLERANCE = 40; // 상태 폴링의 '일시적' 네트워크 실패 관용 횟수(잡은 서버에서 계속 진행)

// 실행 시 연결된 레퍼런스를 타입별로 실어 보내는 미디어 항목(순서 = 슬롯 채움 순서).
export interface ComfyRunMedia {
  type: "image" | "video";
  name: string;
  blob: Blob;
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

export const comfyApi = {
  settings: () => jsonFetch<ComfySettings>("/api/comfy/settings"),
  setSettings: (patch: Partial<Omit<ComfySettings, "has_api_key">>) =>
    jsonFetch<ComfySettings>("/api/comfy/settings", { method: "PUT", body: jsonBody(patch) }),
  health: () => jsonFetch<{ alive: boolean; target: string }>("/api/comfy/health"),
  parse: (content: string, exposed?: string[]) =>
    jsonFetch<ComfyParseResult>("/api/comfy/parse", {
      method: "POST",
      body: jsonBody({ content, exposed: exposed ?? [] }),
    }),
  // 실행 — 멀티파트(FormData). content + param_values(JSON) + media_meta(JSON) + media 파일들.
  // media 순서가 백엔드의 타입별 슬롯 채움 순서를 결정한다.
  //  ★백엔드가 제출/폴링/다운로드를 백그라운드로 분리 → /run 은 즉시 job_id 만 주고, 여기서 /run_status 를
  //   완료까지 짧게 폴링한다. 반환형(ComfyRunResult)은 예전과 동일해 호출부(runComfyRaw·배치 짝)는 안 바뀐다.
  run: async (
    content: string,
    paramValues?: Record<string, string | number | boolean>,
    media?: ComfyRunMedia[],
  ): Promise<ComfyRunResult> => {
    const fd = new FormData();
    fd.append("content", content);
    fd.append("param_values", JSON.stringify(paramValues ?? {}));
    fd.append("media_meta", JSON.stringify((media ?? []).map((m) => ({ type: m.type }))));
    for (const m of media ?? []) fd.append("media", m.blob, m.name);
    const res = await fetch("/api/comfy/run", { method: "POST", body: fd, headers: authFormHeaders() });
    if (!res.ok) await throwHttpError(res, "/api/comfy/run");
    const first = (await res.json()) as ComfyRunResult & { job_id?: string };
    // 구버전 백엔드(동기)는 {outputs} 를 바로 준다 → 재시작 전 새로고침해도 깨지지 않게 그대로 반환.
    if (Array.isArray(first.outputs)) return first;
    const job_id = first.job_id;
    if (!job_id) throw new Error("실행 작업 ID를 받지 못했습니다");

    // 완료까지 폴링. 짧은 요청이라 잘 안 끊기지만, 일시적 네트워크 실패는 관용(잡은 서버에서 계속 진행).
    let netFails = 0;
    for (;;) {
      await sleep(RUN_POLL_MS);
      let data: ComfyRunResult & { state?: string };
      try {
        data = await jsonFetch<ComfyRunResult & { state?: string }>(
          `/api/comfy/run_status?job_id=${encodeURIComponent(job_id)}`,
        );
      } catch (e) {
        // 서버가 4xx/5xx(실패)로 응답하면 jsonFetch 가 "코드: 메시지" 로 throw → 그대로 전파.
        // "Failed to fetch"(네트워크 단절)만 일시적일 수 있어 관용 후 재시도.
        if (e instanceof TypeError && netFails < RUN_POLL_NET_TOLERANCE) {
          netFails += 1;
          continue;
        }
        throw e;
      }
      netFails = 0;
      if (Array.isArray(data.outputs)) return data; // 완료 — {outputs, prompt_id}
      // else pending/running → 계속 대기
    }
  },
};
