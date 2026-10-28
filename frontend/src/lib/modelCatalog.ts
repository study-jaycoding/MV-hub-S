// 공유 모델 카탈로그 — CLI(model list)의 display_name 을 한 곳에 캐시해, 모든 화면(카드·비교·
// 정보팝업·관리 등)이 동일한 '정답' 모델 이름을 쓰게 한다. 카탈로그 미로딩/목록 밖 모델은
// 하드코딩 교정맵 → 휴머나이즈 순으로 폴백. (이전엔 각 컴포넌트가 제각기 추측해 이름이 어긋났음)
import { useEffect, useState } from "react";
import { fetchModelCatalog } from "./modelCatalogCache";
import { MODEL_DISPLAY_NAMES } from "./useModels";
import { variantDisplayName } from "./spotlightPromptConfig";

let nameMap: Record<string, string> = {};
let typeMap: Record<string, string> = {};
let loaded = false;
let loading: Promise<void> | null = null;
let lastAttemptAt: number | null = null;
let failures = 0; // 잇단 실패 수
const RETRY_INTERVAL_MS = 1000;
const RETRY_MAX_MS = 60_000;
const listeners = new Set<() => void>();

export function ensureModelCatalog(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (loading) return loading;
  const now = Date.now();
  // 실패/빈 맵은 다음 mount·호출에서 재시도한다. picker의 명시적 재시도는 제한하지 않는다.
  //  잇달아 실패하면 기다림을 1초에서 두 배씩 늘린다(최대 1분) — 카드가 붙을 때마다 묻는데 서버는 실패를 캐시하지 않아
  //  묻는 족족 CLI 를 다시 띄운다(70회차 격리 실측: 탭을 옮길 때마다 /api/models).
  const wait = Math.min(RETRY_MAX_MS, RETRY_INTERVAL_MS * 2 ** Math.max(0, failures - 1));
  if (lastAttemptAt !== null && now - lastAttemptAt < wait) return Promise.resolve();
  lastAttemptAt = now;
  loading = fetchModelCatalog()
    .then((ms) => {
      const m: Record<string, string> = {};
      const types: Record<string, string> = {};
      for (const x of ms) {
        if (typeof x.job_set_type === "string" && x.job_set_type.trim()
          && typeof x.display_name === "string" && x.display_name.trim()) {
          m[x.job_set_type] = x.display_name;
          if (typeof x.type === "string") types[x.job_set_type] = x.type;
        }
      }
      nameMap = m;
      typeMap = types;
      loaded = Object.keys(m).length > 0;
      failures = loaded ? 0 : failures + 1;
      if (loaded) listeners.forEach((l) => l());
    })
    .catch(() => {
      failures += 1; // 실패해도 폴백(교정맵·휴머나이즈)으로 동작
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

function humanize(m: string): string {
  const words: string[] = [];
  let nums: string[] = [];
  for (const part of m.split("_")) {
    if (/^\d+$/.test(part)) {
      nums.push(part);
    } else {
      if (nums.length) {
        words.push(nums.join("."));
        nums = [];
      }
      words.push(part.charAt(0).toUpperCase() + part.slice(1));
    }
  }
  if (nums.length) words.push(nums.join("."));
  return words.join(" ");
}

// 모델 코드(job_set_type) → 표시명. 우선순위: CLI 카탈로그 > 하드코딩 교정맵 > 휴머나이즈.
//  생성물 하나를 그릴 때는 params 도 넘긴다 — 엔진 이름이 있는 변형(text2speech_v2 의 variant)이면 그 이름.
//  집계(관리·사용량)는 params 없이 불러 모델 키 이름 그대로 둔다(엔진별 집계가 아니므로 — Codex B2).
export function modelDisplayName(code?: string | null, params?: Record<string, unknown> | null): string {
  if (!code) return "—";
  return variantDisplayName(code, params) || nameMap[code] || MODEL_DISPLAY_NAMES[code] || humanize(code);
}

// 모델 코드 → CLI 카탈로그의 결과 종류(image·video·audio 등). 생성창 목록(ALLOWED)에 없는 수정 모델까지 덮는다.
//  카탈로그가 아직 없거나 목록 밖이면 undefined — 화면은 useModelDisplayName 의 다시 그리기로 갱신된다.
export function modelMediaType(code?: string | null): string | undefined {
  return code ? typeMap[code] : undefined;
}

// 카탈로그가 로드되면 리렌더해 정확한 이름으로 갱신되게 하는 훅. 컴포넌트에서:
//   const modelName = useModelDisplayName();  ...  {modelName(gen.model)}
export function useModelDisplayName(): (code?: string | null, params?: Record<string, unknown> | null) => string {
  const [, force] = useState(0);
  useEffect(() => {
    ensureModelCatalog();
    const l = () => force((x) => x + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return modelDisplayName;
}
