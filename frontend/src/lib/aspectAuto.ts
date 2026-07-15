// aspect_ratio "auto" 지원 — 힉스필드 CLI 가 auto 를 안 받는 모델(GPT Image 2·Nano Banana 등)을 위해
// 클라이언트가 레퍼런스 이미지 비율을 재서 그 모델의 허용 비율 중 '가장 가까운 값'으로 치환한다(힉스 웹 auto 흉내).
// CLI enum 에 auto 가 이미 있는 모델(grok 등)은 CLI 가 직접 처리하므로 건드리지 않는다.
import type { ChipRef } from "./promptEditor";
import type { ModelParam } from "../types";
import { refSrc } from "./promptParts";

export const AUTO_RATIO = "auto";

function aspectParam(tunable: ModelParam[]): ModelParam | undefined {
  return tunable.find((x) => x.name === "aspect_ratio");
}

// "16:9" → 1.777…, 파싱 실패 시 null.
function parseRatio(v: string): number | null {
  const m = /^(\d+)\s*:\s*(\d+)$/.exec(v);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!w || !h) return null;
  return w / h;
}

// 실제 비율(ratio)에 가장 가까운 허용값(auto 제외). 유효값 없으면 null.
function snapToEnum(ratio: number, enumVals: string[]): string | null {
  let best: string | null = null;
  let bestDiff = Infinity;
  for (const v of enumVals) {
    if (v === AUTO_RATIO) continue;
    const r = parseRatio(v);
    if (r === null) continue;
    const diff = Math.abs(r - ratio);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = v;
    }
  }
  return best;
}

// 폴백 비율 — enum 에 1:1 있으면 그것, 없으면 첫 유효값.
function fallbackRatio(enumVals: string[]): string {
  if (enumVals.includes("1:1")) return "1:1";
  return enumVals.find((v) => v !== AUTO_RATIO && parseRatio(v) !== null) || "1:1";
}

// 이미지 URL 을 로드해 naturalWidth/Height 비율을 잰다. 실패/타임아웃 → null(폴백으로 처리).
function measureRatio(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    if (!url) {
      resolve(null);
      return;
    }
    const img = new Image();
    let done = false;
    const finish = (r: number | null) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    img.onload = () =>
      finish(img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : null);
    img.onerror = () => finish(null);
    window.setTimeout(() => finish(null), 4000); // 안전 타임아웃(로드 지연 시 폴백)
    img.src = url;
  });
}

// 제출 직전(비동기): aspect_ratio 가 "auto" 이면(어느 모델이든) 실제 비율로 치환한 새 optionValues 를 반환.
// 첫 이미지 레퍼런스 비율을 재서 최근접 허용값으로, 레퍼런스가 없으면 1:1(폴백). CLI 엔 항상 유효값이 간다.
// ★네이티브 auto 모델도 우리가 치환한다 — 그래야 모델 전환 중(스키마 갱신 전) stale 판단으로 auto 가 CLI 로
//   새어나가지 않는다. auto 는 모델 무관하게 '레퍼런스 비율'로 통일된다.
export async function resolveAutoAspectRatio(
  optionValues: Record<string, unknown>,
  tunable: ModelParam[],
  refs: ChipRef[],
): Promise<Record<string, unknown>> {
  const p = aspectParam(tunable);
  if (!p) return optionValues;
  if (String(optionValues.aspect_ratio ?? "") !== AUTO_RATIO) return optionValues;
  const enumVals = p.enum || [];
  const firstImg = refs.find((r) => r.type === "image");
  let chosen: string | null = null;
  if (firstImg) {
    const ratio = await measureRatio(refSrc(firstImg.file_path) || firstImg.thumb);
    if (ratio) chosen = snapToEnum(ratio, enumVals);
  }
  return { ...optionValues, aspect_ratio: chosen || fallbackRatio(enumVals) };
}

// cost 견적 등 동기 경로: auto → 유효 폴백(이미지 측정 없이). 크레딧은 비율과 무관하므로 근사로 충분하고,
// auto 를 그대로 CLI cost 로 보내면 거부되어 견적이 안 나오는 것을 막는다.
export function autoRatioForCost(
  optionValues: Record<string, unknown>,
  tunable: ModelParam[],
): Record<string, unknown> {
  const p = aspectParam(tunable);
  if (!p || String(optionValues.aspect_ratio ?? "") !== AUTO_RATIO) return optionValues;
  return { ...optionValues, aspect_ratio: fallbackRatio(p.enum || []) };
}
