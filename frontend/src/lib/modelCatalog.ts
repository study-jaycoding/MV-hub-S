// 공유 모델 카탈로그 — CLI(model list)의 display_name 을 한 곳에 캐시해, 모든 화면(카드·비교·
// 정보팝업·관리 등)이 동일한 '정답' 모델 이름을 쓰게 한다. 카탈로그 미로딩/목록 밖 모델은
// 하드코딩 교정맵 → 휴머나이즈 순으로 폴백. (이전엔 각 컴포넌트가 제각기 추측해 이름이 어긋났음)
import { useEffect, useState } from "react";
import { api } from "../api";
import { MODEL_DISPLAY_NAMES } from "./useModels";

let nameMap: Record<string, string> = {};
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function ensureModelCatalog(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loading) {
    loading = api
      .models()
      .then((ms) => {
        const m: Record<string, string> = {};
        for (const x of ms) {
          if (x.job_set_type && x.display_name) m[x.job_set_type] = x.display_name;
        }
        nameMap = m;
        loaded = true;
        listeners.forEach((l) => l());
      })
      .catch(() => {
        /* 실패해도 폴백(교정맵·휴머나이즈)으로 동작 */
      });
  }
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
export function modelDisplayName(code?: string | null): string {
  if (!code) return "—";
  return nameMap[code] || MODEL_DISPLAY_NAMES[code] || humanize(code);
}

// 카탈로그가 로드되면 리렌더해 정확한 이름으로 갱신되게 하는 훅. 컴포넌트에서:
//   const modelName = useModelDisplayName();  ...  {modelName(gen.model)}
export function useModelDisplayName(): (code?: string | null) => string {
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
