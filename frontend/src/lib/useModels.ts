// 모델/파라미터/비용 로직 — SpotlightPrompt 본문에서 그대로 추출한 커스텀 훅.
//  · 훅 호출 순서·effect deps 를 SpotlightPrompt 와 동일하게 유지(동작 100% 보존).
//  · 모델 로드 실패 시 주입받은 onError 로 보고(기존 setError 자리).
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { autoRatioForCost } from "./aspectAuto";
import type { ModelInfo, ModelParam, ModelParamsOut } from "../types";

// 노출 모델 화이트리스트(타입별, 표시 순서대로).
//  이미지: Nano Banana 2(nano_banana_flash) · Nano Banana 2 Lite(nano_banana_2_lite) · Nano Banana Pro(nano_banana_pro) · GPT Image 2(gpt_image_2)
//  비디오: Seedance 2.0(seedance_2_0) · Seedance 2.0 Mini(seedance_2_0_mini, 저가·빠름·최대 720p) · Gemini Omni Flash(gemini_omni, duration 4~10s)
// 각 모델의 옵션은 CLI 스키마(get_model_params)로 동적 렌더 — 모델마다 다른 파라미터 자동 반영.
// ※ CLI 업데이트로 Nano Banana Pro 코드가 nano_banana_2 → nano_banana_pro 로 개명됨(옛 코드는 CLI 목록에서 사라져 매칭 실패→드롭다운 누락이었음).
//   ai_stylist/skin_enhancer/shots 변형도 표시명은 "Nano Banana Pro"지만 프리셋 전용(프롬프트 없음)이라 일반 드롭다운엔 제외.
export const ALLOWED: Record<"image" | "video", string[]> = {
  image: ["nano_banana_flash", "nano_banana_2_lite", "nano_banana_pro", "gpt_image_2"],
  video: ["seedance_2_0", "seedance_2_0_mini", "gemini_omni"],
};

// 생성 카드 모델 라벨 — raw job_set_type 휴머나이즈가 CLI 카탈로그 표시명과 어긋나는 모델을
// 카탈로그 이름으로 교정한다. 힉스필드는 nano_banana_flash 를 "Nano Banana 2", nano_banana_pro 를
// "Nano Banana Pro" 로 부른다(혼동 주의) — 휴머나이즈하면 "Nano Banana Flash"/"Nano Banana Pro"로
// 어긋나 카드와 선택 드롭다운이 달라 보인다. 이 맵은 lib/modelCatalog 의 폴백으로 쓰인다
// (우선순위: CLI 카탈로그 display_name > 이 교정맵 > 휴머나이즈). 모든 화면이 modelCatalog 로 일원화.
export const MODEL_DISPLAY_NAMES: Record<string, string> = {
  nano_banana_flash: "Nano Banana 2",
  nano_banana_2_lite: "Nano Banana 2 Lite",
  nano_banana_pro: "Nano Banana Pro",
  nano_banana_2: "Nano Banana Pro", // 레거시(개명 전 코드)로 만든 과거 카드 표시용 — CLI 목록엔 더 없음
  nano_banana: "Nano Banana",
  gpt_image_2: "GPT Image 2", // 휴머나이즈는 "Gpt Image 2"(소문자 pt)라 표기 교정
  seedance_2_0: "Seedance 2.0",
  seedance_2_0_mini: "Seedance 2.0 Mini",
};
// 동적 옵션에서 제외(프롬프트·미디어·내부용)
//  · batch_size: "한 번에 N장"은 앱 레벨 count(1/4)로 일원화 → UI 에서 숨김(중복·곱셈 함정 제거).
//    숨기면 init/카드복원/body 어디서도 안 실리고 CLI 기본값(1)로 처리된다(gpt_image_2 default=1).
//    ※ 한 generation = asset 1개 파이프라인이라 batch_size>1 은 첫 장만 남고 나머지는 버려짐 — count 로만 N장.
// CLI 1.x 는 seedance 의 옛 단일 `medias` 를 역할별 참조 param(image/video/audio_references,
// start/end_image)으로 쪼개 model 스키마에 노출한다. 이들은 '참조 픽커'가 담당하는 미디어라
// 옵션(스칼라) UI 에 뜨면 안 된다 — 안 숨기면 정체불명 텍스트칸으로 렌더돼 오입력 함정이 된다.
// (generate_audio 는 boolean 토글로 정상 노출 — 숨기지 않는다.)
export const HIDDEN_PARAMS = new Set([
  "prompt", "medias", "input_images", "folder_id", "batch_size",
  "image_references", "video_references", "audio_references", "start_image", "end_image",
]);

// 기본값 오버라이드 — 모델 스키마 기본값 대신 우리가 쓸 기본값.
//  · bitrate_mode: 힉스필드 네이티브 UI 와 동일하게 'high' 를 기본으로(검증결과 high 가 standard 와
//    크레딧 동일 → 화질만 올라가는 '공짜' 개선). 해당 enum 에 그 값이 있을 때만 적용(타 모델 안전).
//  · duration: 비디오 기본 길이를 4s 로(스키마/CLI 기본 5s 대신 — 최소·최저 크레딧). duration 파라미터를
//    가진 비디오 모델(seedance_2_0·seedance_2_0_mini·gemini_omni, 모두 min 4s)에 적용된다. enum 없는 수치.
export const DEFAULT_OVERRIDE: Record<string, string> = { bitrate_mode: "high", duration: "4" };

// 파라미터의 '실효 기본값' — 오버라이드(enum 에 존재할 때) > 스키마 default > enum 첫값.
export function effectiveDefault(p: {
  name: string;
  default?: unknown;
  enum?: string[] | null;
}): string | number | undefined {
  const ov = DEFAULT_OVERRIDE[p.name];
  if (ov != null && (!p.enum?.length || p.enum.includes(ov))) return ov;
  if (p.default != null) return p.default as string | number;
  if (p.enum?.length) return p.enum[0];
  return undefined;
}

// ── 모델별 파라미터 조합 제약 ──────────────────────────────────────────────
// CLI 스키마(model get)·비용(generate cost)이 *막지 않는* 비즈니스 규칙. 힉스필드 네이티브 UI 기준.
//  예) seedance_2_0 Fast 모드는 1080p 미지원 — cost 는 에러 없이 720p 가격(17)으로 조용히
//      다운그레이드되므로(=1080p 무효), 우리가 UI 에서 막아야 사용자가 헛 선택을 안 한다.
//  규칙: whenParam==whenEquals 이면 param 의 허용값을 allow 로 제한. 동일 param 다중 규칙은 교집합.
export type ParamConstraint = {
  whenParam: string;
  whenEquals: string;
  param: string;
  allow: string[];
  note: string;
};
export const MODEL_CONSTRAINTS: Record<string, ParamConstraint[]> = {
  seedance_2_0: [
    {
      whenParam: "mode",
      whenEquals: "fast",
      param: "resolution",
      allow: ["480p", "720p"],
      note: "Fast 모드는 720p 초과 해상도(1080p·4k)를 지원하지 않습니다 (최대 720p).",
    },
  ],
  gpt_image_2: [
    {
      // CLI 검증: quality=low 면 1k/2k/4k 비용이 전부 1로 동일 → 해상도가 적용되지 않음(1k로 처리).
      whenParam: "quality",
      whenEquals: "low",
      param: "resolution",
      allow: ["1k"],
      note: "Low 품질에서는 해상도가 적용되지 않습니다 (1k로 처리).",
    },
  ],
};

// 정수 파라미터의 허용 범위 — CLI 가 강제하지만 스키마(model get)엔 min/max 가 없는 것.
//  (duration 은 슬라이더 전용 DURATION_RANGE 가 따로 처리 — 여기엔 두지 않는다.)
//  현재 항목 없음(이전의 gpt_image_2.batch_size 는 UI 에서 숨김 처리되어 불필요). 범용 메커니즘은 유지.
export const NUMERIC_RANGE: Record<string, Record<string, { min: number; max: number }>> = {};
export function numericRange(
  model: string,
  name: string,
): { min: number; max: number } | null {
  return NUMERIC_RANGE[model]?.[name] || null;
}

// 현재 옵션값에서 활성화된 제약 → { param: { allow:Set<string>, note } }. 동일 param 은 교집합.
export function activeConstraints(
  model: string,
  optionValues: Record<string, string | number | boolean>,
): Record<string, { allow: Set<string>; note: string }> {
  const out: Record<string, { allow: Set<string>; note: string }> = {};
  for (const c of MODEL_CONSTRAINTS[model] || []) {
    if (String(optionValues[c.whenParam] ?? "") !== c.whenEquals) continue;
    const ex = out[c.param];
    if (ex) {
      ex.allow = new Set([...ex.allow].filter((v) => c.allow.includes(v)));
      ex.note = ex.note ? ex.note + " " + c.note : c.note;
    } else {
      out[c.param] = { allow: new Set(c.allow), note: c.note };
    }
  }
  return out;
}

// 모델 파라미터의 실효 기본값으로 초기 옵션 객체 구성(숨김 파라미터 제외).
//  apply()(모델 선택 시 초기화)와 프리페치(첫 토글 비용 예열)에서 공용 — 둘이 같은 키를 내도록 일원화.
export function defaultOptions(
  params: ModelParam[],
): Record<string, string | number | boolean> {
  const init: Record<string, string | number | boolean> = {};
  for (const p of params) {
    if (HIDDEN_PARAMS.has(p.name)) continue;
    const dv = effectiveDefault(p); // 오버라이드(bitrate=high 등) 반영
    if (dv != null) init[p.name] = dv;
  }
  return init;
}

// 옵션값에 모델 제약을 1회 적용해 보정된 새 객체를 반환(변경 없으면 입력 ref 그대로).
//  ① enum 조합 제약 위반 → 허용값으로 스냅  ② 정수 범위 밖 → 클램프. 멱등.
//  보정 effect 와 프리페치(정착 기본값 산출)가 동일 로직을 쓰도록 추출 — 키 불일치 방지.
export function correctedOptions(
  model: string,
  params: ModelParam[],
  optionValues: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const constraints = activeConstraints(model, optionValues);
  let next: Record<string, string | number | boolean> | null = null;
  // ① enum 조합 제약 → 금지값이면 허용값으로 스냅
  for (const [pname, c] of Object.entries(constraints)) {
    const cur = String(optionValues[pname] ?? "");
    if (cur && !c.allow.has(cur)) {
      const p = params.find((x) => x.name === pname);
      const ordered = (p?.enum || []).filter((v) => c.allow.has(v));
      const snap = ordered.length ? ordered[ordered.length - 1] : [...c.allow][0];
      if (snap != null) (next ||= { ...optionValues })[pname] = snap;
    }
  }
  // ② 정수 범위 제약 → 범위 밖이면 클램프
  for (const [pname, rg] of Object.entries(NUMERIC_RANGE[model] || {})) {
    const v = optionValues[pname];
    if (v === undefined || v === "") continue;
    const n = Number(v);
    if (Number.isNaN(n)) continue;
    const cl = Math.min(rg.max, Math.max(rg.min, n));
    if (cl !== n) (next ||= { ...optionValues })[pname] = cl;
  }
  return next ?? optionValues;
}

// cost 캐시 키 — model + 정렬된 옵션값. prompt 는 비용에 무관(현재 호출도 prompt 미전달)하므로 제외.
export function costKey(
  model: string,
  opts: Record<string, string | number | boolean>,
): string {
  const norm = Object.keys(opts)
    .sort()
    .map((k) => k + "=" + String(opts[k]))
    .join("&");
  return model + "|" + norm;
}

export function useModels(onError: (msg: string) => void) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [type, setType] = useState<"image" | "video">("image");
  const [model, setModel] = useState("");
  const [params, setParams] = useState<ModelParam[]>([]);
  const [optionValues, setOptionValues] = useState<Record<string, string | number | boolean>>({});
  const [cost, setCost] = useState<number | null>(null);
  const [costLoading, setCostLoading] = useState(false);
  // 카드 드롭 복원 시: 모델 변경 effect 가 기본값으로 옵션을 덮어쓰기 전, 복원할 옵션을 임시 보관.
  // 드롭/재사용이 '이 모델로 바꾼 뒤 이 옵션을 덮어라'를 예약. model 스탬프로 — 빠른 연속 재사용 시
  // 다른 생성물의 옵션이 엉뚱한 모델에 적용되던 경쟁을 막는다(model 일치할 때만 소비).
  const pendingOptsRef = useRef<{
    model: string;
    opts: Record<string, string | number | boolean>;
  } | null>(null);
  // 모델별 파라미터 캐시 — 이미지/비디오 토글 시 재요청(네트워크) 없이 즉시 전환.
  const paramsCacheRef = useRef<Record<string, ModelParamsOut>>({});
  // cost(예상 크레딧) 결과 캐시 — 키=model+옵션값. 같은 조합 재방문 시 CLI/디바운스 없이 즉시 표시.
  const costCacheRef = useRef<Record<string, number>>({});
  // 드롭다운 닫기 브리지 — open/setOpen 은 컴포넌트 UI 상태로 남으므로,
  // setOpt 가 옵션 선택 후 드롭다운을 닫도록 컴포넌트가 setOpen 을 여기 등록한다.
  const setOpenRef = useRef<((v: string | null) => void) | null>(null);

  // 화이트리스트 모델만 노출(타입별 다중, 화이트리스트 순서 유지).
  const typeModels = ALLOWED[type]
    .map((jt) => models.find((m) => m.job_set_type === jt))
    .filter((m): m is ModelInfo => !!m);
  const modelName =
    models.find((m) => m.job_set_type === model)?.display_name || "모델 선택";
  // 동적 옵션으로 보여줄 파라미터(프롬프트·미디어 제외)
  const tunable = params.filter((p) => !HIDDEN_PARAMS.has(p.name));

  useEffect(() => {
    api.models().then(setModels).catch((e) => onError(String(e)));
  }, []);

  useEffect(() => {
    if (!typeModels.length) return;
    if (!typeModels.some((m) => m.job_set_type === model)) {
      setModel(typeModels[0].job_set_type);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, models]);

  // 모델 바뀌면 CLI 파라미터 로드 + 기본값으로 옵션 초기화.
  useEffect(() => {
    if (!model) {
      setParams([]);
      setOptionValues({});
      return;
    }
    // 파라미터 → params + 기본값 옵션 적용. 드롭 복원이 대기 중이면 기본값 위에 덮음.
    const apply = (r: ModelParamsOut) => {
      setParams(r.params);
      const init = defaultOptions(r.params); // 실효 기본값(오버라이드 반영)
      // 이 모델용 예약 옵션일 때만 덮는다(다른 모델용이면 그 모델 로드 때 적용되도록 보존).
      const pend = pendingOptsRef.current;
      if (pend && pend.model === model) {
        setOptionValues({ ...init, ...pend.opts });
        pendingOptsRef.current = null;
      } else {
        setOptionValues(init);
      }
    };
    // 캐시 적중 → 네트워크 없이 즉시 적용(토글 딜레이 제거).
    const cached = paramsCacheRef.current[model];
    if (cached) {
      apply(cached);
      return;
    }
    let alive = true;
    api
      .modelParams(model)
      .then((r) => {
        paramsCacheRef.current[model] = r;
        if (alive) apply(r);
      })
      .catch(() => {
        if (alive) {
          setParams([]);
          setOptionValues({});
        }
      });
    return () => {
      alive = false;
    };
  }, [model]);

  // 두 모델(이미지/비디오) 파라미터를 미리 받아 캐시 → 첫 토글부터 즉시 전환.
  // 추가로 각 모델 '정착 기본옵션'의 비용도 미리 추정해 cost 캐시에 넣어 둠(B) → 첫 토글의 비용 멈칫도 제거.
  useEffect(() => {
    // 기본옵션을 제약 보정까지 적용해 '정착' 상태로 만든 뒤 그 비용을 예열(모델 선택 시 cost effect 가 낼 키와 일치).
    const warmCost = (m: string, params: ModelParam[]) => {
      let opts = defaultOptions(params);
      for (let i = 0; i < 4; i++) {
        const c = correctedOptions(m, params, opts);
        if (c === opts) break; // 정착(멱등)
        opts = c;
      }
      const key = costKey(m, opts);
      if (costCacheRef.current[key] !== undefined) return;
      api
        .estimateCost(m, opts)
        .then((r) => {
          costCacheRef.current[key] = r.credits;
        })
        .catch(() => {});
    };
    for (const m of [...ALLOWED.image, ...ALLOWED.video]) {
      const cached = paramsCacheRef.current[m];
      if (cached) {
        warmCost(m, cached.params);
        continue;
      }
      api
        .modelParams(m)
        .then((r) => {
          paramsCacheRef.current[m] = r;
          warmCost(m, r.params);
        })
        .catch(() => {});
    }
  }, []);

  // 모델/옵션 바뀌면 예상 크레딧 재추정. 같은 조합은 캐시 적중 → 즉시(디바운스·CLI 생략), 새 조합만 debounce 250ms + CLI.
  useEffect(() => {
    if (!model) {
      setCost(null);
      return;
    }
    const key = costKey(model, optionValues);
    const hit = costCacheRef.current[key];
    if (hit !== undefined) {
      // 캐시 적중(토글 왕복·이전 본 옵션 재선택) → 멈칫 없이 즉시 표시.
      setCost(hit);
      setCostLoading(false);
      return;
    }
    let alive = true;
    setCostLoading(true);
    const t = window.setTimeout(() => {
      api
        .estimateCost(model, autoRatioForCost(optionValues, params))
        .then(
          (r) =>
            alive &&
            ((costCacheRef.current[key] = r.credits),
            setCost(r.credits),
            setCostLoading(false)),
        )
        .catch(() => alive && (setCost(null), setCostLoading(false)));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [model, optionValues]);

  // 현재 옵션에서 활성화된 조합 제약(예: fast → resolution 480p/720p 만).
  const constraints = activeConstraints(model, optionValues);

  // 제약 자동 보정 — 제약으로 금지된 값이 현재 선택돼 있으면 허용값으로 스냅(enum 순서상 가장 높은 것).
  //  예) resolution=1080p 인데 mode 를 fast 로 바꾸면 → 720p 로 자동 하향(헛 생성·오해 방지).
  //  멱등(보정 후엔 유효 → 재실행해도 변화 없음)이라 루프 없음.
  useEffect(() => {
    const next = correctedOptions(model, params, optionValues);
    if (next !== optionValues) setOptionValues(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, optionValues, params]);

  const setOpt = (name: string, value: string | number) => {
    setOptionValues((prev) => ({ ...prev, [name]: value }));
    setOpenRef.current?.(null);
  };

  return { models, type, setType, model, setModel, params, tunable, constraints, typeModels, modelName,
           optionValues, setOptionValues, setOpt, cost, costLoading, pendingOptsRef, setOpenRef };
}
