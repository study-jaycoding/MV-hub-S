// 모델/파라미터/비용 로직 — SpotlightPrompt 본문에서 그대로 추출한 커스텀 훅.
//  · 훅 호출 순서·effect deps 를 SpotlightPrompt 와 동일하게 유지(동작 100% 보존).
//  · 모델 로드 실패 시 주입받은 onError 로 보고(기존 setError 자리).
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { autoRatioForCost } from "./aspectAuto";
import { EMPTY_MODEL_SET, modelAllowed } from "./modelPolicyCore";
import type { ModelInfo, ModelParam, ModelParamsOut } from "../types";
import { fetchModelCatalog } from "./modelCatalogCache";

// 노출 모델 화이트리스트(타입별, 표시 순서대로).
//  이미지: Nano Banana 2(nano_banana_flash) · Nano Banana 2 Lite(nano_banana_2_lite) · Nano Banana Pro(nano_banana_pro) · GPT Image 2.5(gpt_image_2_5) · GPT Image 2(gpt_image_2)
//  비디오: Seedance 2.5(seedance_2_5, duration 4~30s·오디오 생성 지원·480p/720p/1080p) · Seedance 2.0(seedance_2_0) · Seedance 2.0 Mini(seedance_2_0_mini, 저가·빠름·최대 720p)
//   ※ Gemini Omni Flash(gemini_omni)는 2026-09-15 노출 제외(Jay 요청). CLI 카탈로그엔 남아 있고 이 목록에서만 뺐다 —
//     이 모델로 만든 생성물은 0건이라 기존 카드 표시엔 영향 없다(DB 대조 확인).
// 각 모델의 옵션은 CLI 스키마(get_model_params)로 동적 렌더 — 모델마다 다른 파라미터 자동 반영.
// ※ CLI 업데이트로 Nano Banana Pro 코드가 nano_banana_2 → nano_banana_pro 로 개명됨(옛 코드는 CLI 목록에서 사라져 매칭 실패→드롭다운 누락이었음).
//   ai_stylist/skin_enhancer/shots 변형도 표시명은 "Nano Banana Pro"지만 프리셋 전용(프롬프트 없음)이라 일반 드롭다운엔 제외.
export const ALLOWED: Record<"image" | "video", string[]> = {
  image: ["nano_banana_flash", "nano_banana_2_lite", "nano_banana_pro", "gpt_image_2_5", "gpt_image_2"],
  video: ["seedance_2_5", "seedance_2_0", "seedance_2_0_mini"],
};

/** 모델 키로 이미지/영상을 판정한다 — **한쪽 목록에만** 속할 때만 확정한다.
 *
 * ★왜(2026-09-13): 씬의 모델 노드를 열면 저장된 `type` 이 없거나 틀릴 수 있다. 그때 훅의
 *  기본 타입(image)이 남으면, 아래 자동 선택이 "이 타입의 모델이 아니다" 라며 **영상 모델을
 *  첫 이미지 모델로 갈아치운다**(코덱스가 실제 화면에서 재현: seedance_2_0_mini → Nano Banana 2).
 *  모델 키가 곧 타입의 근거이므로, 저장값보다 **모델을 먼저** 믿는다.
 * ★양쪽에 없거나(옛 키·개명) 양쪽에 다 있으면 **확정하지 않는다** — 억지로 image 로 떨어뜨리면
 *  같은 사고가 난다. 호출측이 저장값·사용자 선택으로 메운다.
 */
export function inferModelType(model: string | null | undefined): "image" | "video" | undefined {
  if (!model) return undefined;
  const isImage = ALLOWED.image.includes(model);
  const isVideo = ALLOWED.video.includes(model);
  if (isImage === isVideo) return undefined; // 둘 다거나 둘 다 아니면 모른다
  return isImage ? "image" : "video";
}

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
  gpt_image_2_5: "GPT Image 2.5", // 휴머나이즈는 "Gpt Image 2 5"(소문자 pt·마침표 소실)라 표기 교정
  gpt_image_2: "GPT Image 2", // 휴머나이즈는 "Gpt Image 2"(소문자 pt)라 표기 교정
  seedance_2_5: "Seedance 2.5",
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
// is_inpaint/mask: 힉스필드 미문서·미사용 파라미터(2026-09-01 실측 — 웹 편집기도 안 쓴다).
// 노출하면 효과 없는 옵션이 떠서 혼란만 준다.
export const HIDDEN_PARAMS = new Set([
  "prompt", "medias", "input_images", "folder_id", "batch_size",
  "image_references", "video_references", "audio_references", "start_image", "end_image",
  "is_inpaint", "mask",
]);

// 외부에서 들어오는 옵션 덩어리(씬 카드 저장분·initial.params 등)에서 숨김 파라미터 제거 —
// setOptionValues/pending 경로로 숨김 키가 되살아나 요청 body 에 실리는 것을 막는다(코덱스).
export function stripHiddenParams<T>(opts: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(opts)) {
    if (!HIDDEN_PARAMS.has(k)) out[k] = v;
  }
  return out;
}

// 기본값 오버라이드 — 모델 스키마 기본값 대신 우리가 쓸 기본값.
//  · bitrate_mode: 힉스필드 네이티브 UI 와 동일하게 'high' 를 기본으로(high 가 standard 와 크레딧
//    동일 → 화질만 올라가는 '공짜' 개선). 해당 enum 에 그 값이 있을 때만 적용(타 모델 안전).
//    2026-09-15 재실측(generate cost): seedance_2_5 32.5=32.5 · seedance_2_0 22.5=22.5 ·
//    seedance_2_0_mini 12.5=12.5 · ad_multiplier 32.5=32.5 — 넷 다 여전히 동일.
//    ★위 MODEL_CONSTRAINTS 의 '가격이 같다고 숨기지 말라' 와 혼동 금지(2026-09-15 Jay 결정):
//      값이 같다고 **선택지를 뺏는 것**은 금지. 값이 같을 때 **유리한 쪽을 기본으로 골라주는 것**은 유지 —
//      사용자가 언제든 바꿀 수 있으므로 선택을 뺏지 않는다. 가격이 갈리면 이 기본값을 다시 판단할 것.
//  · duration: 비디오 기본 길이를 4s 로(스키마/CLI 기본 5s 대신 — 최소·최저 크레딧). duration 파라미터를
//    가진 비디오 모델(seedance_2_0·seedance_2_0_mini, 모두 min 4s)에 적용된다. enum 없는 수치.
export const DEFAULT_OVERRIDE: Record<string, string> = { bitrate_mode: "high", duration: "4" };
export const MODEL_DEFAULT_OVERRIDE: Record<string, Record<string, string>> = {
  seedance_2_5: { mode: "omni_reference" },
};

// 파라미터의 '실효 기본값' — 오버라이드(enum 에 존재할 때) > 스키마 default > enum 첫값.
export function effectiveDefault(p: {
  name: string;
  default?: unknown;
  enum?: string[] | null;
}, model = ""): string | number | undefined {
  const ov = MODEL_DEFAULT_OVERRIDE[model]?.[p.name] ?? DEFAULT_OVERRIDE[p.name];
  if (ov != null && (!p.enum?.length || p.enum.includes(ov))) return ov;
  if (p.default != null) return p.default as string | number;
  if (p.enum?.length) return p.enum[0];
  return undefined;
}

// ── 모델별 파라미터 조합 제약 ──────────────────────────────────────────────
// 힉스필드가 **명시적으로 거부**하는 조합만 UI 에서 막는다. 막지 않으면 사용자가 제출에서 실패한다.
//  예) seedance_2_0 mode=fast + 1080p → CLI 가 거부(2026-09-15 실측):
//      "mode 'fast' supports only 480p/720p; use mode 'std' for 1080p/4k"
// ★금지(2026-09-15 Jay 결정): **견적 크레딧이 같다**는 이유로 옵션을 숨기지 않는다.
//   값이 같아도 실제 결과물은 다를 수 있고, 같은지 확인하려면 실제 생성=과금이 필요하다.
//   그 근거로 gpt_image_2 의 quality=low → resolution 1k 제한을 제거했다(low 는 1k·2k 가 0.5 로
//   같지만 4k 는 0.75 로 다르다 — 값이 같다는 것만으로 무효라고 단정할 수 없다).
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
};

// ── 조건부 파라미터 게이트 ────────────────────────────────────────────────
// "특정 값 조합에서만 허용되는 파라미터" — 스키마(model get)엔 표현이 없고 CLI 가 제출 시
// 명시 거부한다. 조건이 깨지면 UI 에서 숨기고 제출 본문에서도 제외해야 생성이 안 깨진다.
//  예) seedance_2_5.extension_mode: mode=video_extension 에서만 허용 — 실측(generate cost):
//      다른 모드에 실으면 "'extension_mode' is only allowed for mode 'video_extension'" 거부.
//      기본값 규칙(enum 첫값)이 backward 를 자동 선택해 모든 생성이 실패하던 버그의 원인.
export const PARAM_GATES: Record<string, Record<string, { whenParam: string; whenIn: string[] }>> = {
  seedance_2_5: {
    extension_mode: { whenParam: "mode", whenIn: ["video_extension"] },
  },
};

// 이 파라미터가 현재 옵션 조합에서 허용되는가 — 게이트 없는 파라미터는 항상 허용.
export function paramGateAllows(
  model: string,
  name: string,
  optionValues: Record<string, string | number | boolean>,
): boolean {
  const gate = PARAM_GATES[model]?.[name];
  if (!gate) return true;
  return gate.whenIn.includes(String(optionValues[gate.whenParam] ?? ""));
}

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
  model = "",
): Record<string, string | number | boolean> {
  const init: Record<string, string | number | boolean> = {};
  for (const p of params) {
    if (HIDDEN_PARAMS.has(p.name)) continue;
    const dv = effectiveDefault(p, model); // 공통·모델별 오버라이드 반영
    if (dv != null) init[p.name] = dv;
  }
  // 기본값 조합에서 게이트 조건이 깨진 파라미터는 처음부터 싣지 않는다
  // (예: mode 기본 t2v 인데 extension_mode=backward 가 자동 세팅되는 것 방지).
  for (const [pname, gate] of Object.entries(PARAM_GATES[model] || {})) {
    if (!gate.whenIn.includes(String(init[gate.whenParam] ?? ""))) delete init[pname];
  }
  return init;
}

// 저장된 옵션(모델 카드 등)을 하단 바에 적용할 때 — 통째로 바꿔치기하지 않고 실효 기본값 위에 얹는다.
//  힉스필드 잡 기록엔 mode 가 없어 옛 생성물에서 복사한 설정은 mode 가 빈다(2026-09-09). 통째로 바꾸면 화면은
//  기본값(omni_reference)이 켜진 것처럼 보이는데 실제 전송값은 비어 CLI 기본 t2v 로 제출되던 불일치를 막는다.
//  모델 카드 편집창(pendingOpts → {...init, ...opts})과 같은 규칙.
export function withEffectiveDefaults(
  params: ModelParam[],
  model: string,
  saved: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  return { ...defaultOptions(params, model), ...saved };
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
  // ③ 조건부 게이트 — 조건이 깨진 파라미터는 제거(CLI 가 거부), 조건이 성립했는데 값이
  //    없으면 실효 기본값을 채운다(모드 전환으로 다시 나타날 때 빈 값 방지). 멱등.
  for (const [pname, gate] of Object.entries(PARAM_GATES[model] || {})) {
    const base = next ?? optionValues;
    const ok = gate.whenIn.includes(String(base[gate.whenParam] ?? ""));
    if (!ok && pname in base) {
      next ||= { ...optionValues };
      delete next[pname];
    } else if (ok && base[pname] == null) {
      const p = params.find((x) => x.name === pname);
      const dv = p ? effectiveDefault(p, model) : undefined;
      if (dv != null) (next ||= { ...optionValues })[pname] = dv;
    }
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

// ── 모델 파라미터·비용 캐시(모듈 스코프) ──────────────────────────────────
// 훅 인스턴스(ref)에 두면 모델 모달을 닫았다 열 때마다(=리마운트) 같은 17~18건을 다시 받는다.
// 모듈 스코프면 창이 살아 있는 동안 한 번만 받는다. ★계정 전환은 useHubAuth 가 location.reload()
// 하므로(계정 email 변경·프록시 연결·범위 변경 모두) 이 캐시가 다른 계정으로 새지 않는다.
const paramsCache = new Map<string, ModelParamsOut>(); // 완료된 결과 — 동기 적중(토글 딜레이 0)
const paramsInflight = new Map<string, Promise<ModelParamsOut>>(); // 진행 중 요청 — 중복 요청 흡수
const costCache = new Map<string, number>(); // cost(예상 크레딧) 결과 — 키=model+옵션값

// 같은 모델 요청이 겹치면 하나로 합친다(모달과 프리페치가 동시에 부르는 경우).
function loadModelParams(model: string): Promise<ModelParamsOut> {
  const done = paramsCache.get(model);
  if (done) return Promise.resolve(done);
  const flying = paramsInflight.get(model);
  if (flying) return flying;
  const p = api
    .modelParams(model)
    .then((r) => {
      paramsCache.set(model, r);
      paramsInflight.delete(model);
      return r;
    })
    .catch((e) => {
      paramsInflight.delete(model); // 실패는 캐시하지 않는다 — 다음 시도에 재요청
      throw e;
    });
  paramsInflight.set(model, p);
  return p;
}

// 캐시 삽입 공통 관문 — 크기 상한(장기 세션 무한 누적 방지). 넘으면 통째 리셋(재조회 싼 캐시라 LRU 불필요).
//  ★모든 삽입은 이 함수로 — 경로별로 직접 대입하면 상한이 절반만 작동한다(코덱스 리뷰).
function putCost(key: string, credits: number): void {
  if (costCache.size >= 500) costCache.clear();
  costCache.set(key, credits);
}

export function useModels(
  onError: (msg: string) => void,
  // 그룹별 사용 모델 정책(modelPolicy). allowed 가 **비어 있으면 제한 없음**(전부 사용). ready=첫 조회가 끝남
  // (워밍 프리페치를 그 뒤로 미룬다).
  policy?: {
    allowed: ReadonlySet<string>;
    ready: boolean;
    // ★복원값은 **초기 상태**로 받는다(2026-09-13). effect 로 나중에 넣으면 카탈로그 도착과 경쟁한다 —
    //  `setModel` 이 `explicitRef` 를 동기로 바꾸는 동안 `model` 상태는 아직 낡아 있어서,
    //  그 틈에 도는 자동 선택이 낡은 값으로 판단해 **복원한 모델을 덮었다**(실측 로그로 확인).
    //  마운트 때 이미 올바른 값이면 그 틈이 아예 없다. 안 넘기면 종전과 똑같다.
    initialType?: "image" | "video";
    initialModel?: string;
    initialOpts?: Record<string, string | number | boolean>;
  },
) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [type, setType] = useState<"image" | "video">(policy?.initialType ?? "image");
  const [model, setModelState] = useState(policy?.initialModel ?? "");
  const allowed = policy?.allowed ?? EMPTY_MODEL_SET;
  const policyReady = policy ? policy.ready : true;
  // 이 모델이 지금 그룹에서 막혔는가 — 판정은 **공통 함수 하나**로만 한다.
  // ★조건식을 여기 복제하면 안 된다(2026-09-13, 코덱스 실측): 종전엔
  //  `allowed.size > 0 && !allowed.has(jt)` 를 따로 갖고 있어 **면제 모델**
  //  (`POLICY_EXEMPT_MODELS` — 부분 수정 전용 고정 모델)에서 답이 갈렸다. 그 결과
  //  모달의 저장 버튼은 `selectedBlocked` 로 **막히는데** 안내 문구는
  //  `submitBlockMessage`(=`modelAllowed`) 로 계산돼 **null** 이라, 이유 없이 저장이
  //  거부됐다(카드 표시는 `modelAllowed` 라 '안 막힘' 으로 보였다). 3/3 재현.
  const blocked = (jt: string) => !modelAllowed({ allowed }, jt);
  // 지금 model 을 누가 골랐나 — true=사용자·복원(재사용·씬 바인딩·모델 노드)이 명시적으로, false=훅이 자동으로.
  // 명시 선택은 나중에 못 쓰게 돼도 바꾸지 않는다(selectedBlocked 로 알리고 제출만 막는다 — Jay). 자동 선택은 다시 고른다.
  // 복원값을 받았으면 **처음부터 명시 선택**이다 — 자동 선택이 갈아치우지 못하게.
  const explicitRef = useRef(!!policy?.initialModel);
  // explicit=false 로 부르면 '자동 대체'(예: 지원 목록 밖 모델을 재사용할 때의 폴백)라 나중에 정책이 바뀌면 다시 고른다.
  // 다른 모델로 옮기면 복원 대기 옵션을 버린다 — 나중에 원래 모델로 돌아와도 되살아나지 않게.
  // ★`setModel` 과 **자동 선택의 직접 호출** 둘 다에서 불러야 한다(2026-09-13, 코덱스 재현):
  //  탭을 눌러(Image→Video) 자동 선택이 모델을 바꾸면 `setModel` 을 안 거치므로, 그 길로 나갔다
  //  드롭다운으로 원래 모델을 다시 고르면 **옛 옵션이 부활**했다.
  const dropStalePendingOpts = useCallback((next: string) => {
    if (pendingOptsRef.current && pendingOptsRef.current.model !== next) {
      pendingOptsRef.current = null;
    }
  }, []);

  const setModel = useCallback((m: string, explicit = true) => {
    explicitRef.current = explicit;
    dropStalePendingOpts(m);
    setModelState(m);
  }, [dropStalePendingOpts]);
  // 같은 모델로 복원하는 경로(setModel 이 no-op)도 선택 출처를 기록한다 — 명시 복원이면 true(제한돼도 안 바뀜),
  // 자동 대체면 false(정책이 바뀌면 다시 고름). 둘 다 기록해야 이전 값이 잘못 남지 않는다(코덱스 P2).
  // 자동 선택으로 되돌린 순간에는 지금 정책으로 다시 평가해야 한다(모델 값이 그대로여도) — 그 트리거.
  const [selectionTick, setSelectionTick] = useState(0);
  const markModelSelection = useCallback((explicit: boolean) => {
    if (explicitRef.current === explicit) return;
    explicitRef.current = explicit;
    if (!explicit) setSelectionTick((t) => t + 1);
  }, []);
  /** 지금 모델을 사용자·복원이 명시적으로 골랐는가(false=훅이 자동 선택). 저장·복원 경로가 출처를 함께 보존할 때 쓴다. */
  const modelPickedByUser = useCallback(() => explicitRef.current, []);
  // 비동기(`await`) 뒤에 읽어야 하는 값들 — 렌더 클로저를 잡으면 그 사이 바뀐 정책·모델을 놓친다(코덱스 P1).
  // 대입은 effect 에서 한다(렌더 본문 대입은 중단된 렌더의 값이 새어 나갈 수 있다).
  const allowedRef = useRef(allowed);
  const modelRef = useRef(model);
  useEffect(() => {
    allowedRef.current = allowed;
    modelRef.current = model;
  }, [allowed, model]);
  /** 이 타입에서 지금 고를 수 있는 첫 모델 — 재사용·복원 폴백이 못 쓰는 모델을 집지 않게.
   *  ★여기도 같은 공통 함수를 쓴다. 지금 카탈로그(`ALLOWED`)에는 면제 모델이 없어 결과는
   *   같지만, 판정을 두 벌로 두면 다음 정책 변경 때 또 어긋난다(코덱스). */
  const firstAllowed = useCallback(
    (t: "image" | "video") =>
      ALLOWED[t].find((jt) => modelAllowed({ allowed: allowedRef.current }, jt)) ?? "",
    [],
  );
  /** 지금 고른 모델 — 비동기 작업이 끝난 뒤 '현재' 모델과 비교할 때 쓴다(시작 시점 값이 아니라). */
  const currentModel = useCallback(() => modelRef.current, []);
  const [params, setParams] = useState<ModelParam[]>([]);
  const [optionValues, setOptionValues] = useState<Record<string, string | number | boolean>>({});
  const [cost, setCost] = useState<number | null>(null);
  const [costLoading, setCostLoading] = useState(false);
  // 현재 params/optionValues 가 '어느 모델' 것인지 + 로딩 중인지 — 모델 전환 직후 스키마가 바뀌기 전
  // stale 옵션으로 제출·견적하는 것을 막는다(제출은 paramsModel===model 일 때만).
  const [paramsModel, setParamsModel] = useState("");
  // ★파라미터 조회가 **실패**했나 — 성공한 빈 스키마(`params: []`)와 구별해야 한다(코덱스).
  //  종전에는 실패해도 `paramsModel=model` 로 두어 "정합" 으로 보였고, 그대로 저장하면
  //  옵션이 `{}` 로 덮였다. 이제 실패면 정합을 깨고(저장 차단) 이 깃발로 안내한다.
  const [paramsError, setParamsError] = useState(false);
  const [paramsLoading, setParamsLoading] = useState(false);
  // 카드 드롭 복원 시: 모델 변경 effect 가 기본값으로 옵션을 덮어쓰기 전, 복원할 옵션을 임시 보관.
  // 드롭/재사용이 '이 모델로 바꾼 뒤 이 옵션을 덮어라'를 예약. model 스탬프로 — 빠른 연속 재사용 시
  // 다른 생성물의 옵션이 엉뚱한 모델에 적용되던 경쟁을 막는다(model 일치할 때만 소비).
  const pendingOptsRef = useRef<{
    model: string;
    opts: Record<string, string | number | boolean>;
  } | null>(
    policy?.initialModel && policy?.initialOpts
      ? { model: policy.initialModel, opts: policy.initialOpts }
      : null,
  );
  // 모델별 파라미터·cost 캐시는 모듈 스코프(paramsCache/costCache) — 위 정의 참고.
  // 드롭다운 닫기 브리지 — open/setOpen 은 컴포넌트 UI 상태로 남으므로,
  // setOpt 가 옵션 선택 후 드롭다운을 닫도록 컴포넌트가 setOpen 을 여기 등록한다.
  const setOpenRef = useRef<((v: string | null) => void) | null>(null);

  // 화이트리스트 모델만 노출(타입별 다중, 화이트리스트 순서 유지) — 그룹이 쓸 수 없는 모델은 목록에서 뺀다.
  const typeModels = ALLOWED[type]
    .filter((jt) => !blocked(jt))
    .map((jt) => models.find((m) => m.job_set_type === jt))
    .filter((m): m is ModelInfo => !!m);
  // 지금 고른 모델이 막혔는가 — 목록에는 없지만 값은 남아 있는 상태(안내·제출 차단의 근거).
  const selectedBlocked = !!model && blocked(model);
  // 이 타입이 통째로 막혔는가 — 카탈로그가 아직 안 와서 목록이 빈 것과 구별해야 안내 문구가 정직하다(코덱스).
  const typeFullyBlocked = ALLOWED[type].every((jt) => blocked(jt));
  const modelName =
    models.find((m) => m.job_set_type === model)?.display_name || "모델 선택";
  // 동적 옵션으로 보여줄 파라미터(프롬프트·미디어 제외)
  const tunable = params.filter((p) => !HIDDEN_PARAMS.has(p.name));

  useEffect(() => {
    // 훅 인스턴스마다 같은 목록을 다시 받지 않는다 — 단일비행 + 짧은 TTL(`modelCatalogCache`).
    fetchModelCatalog().then(setModels).catch((e) => onError(String(e)));
  }, []);

  useEffect(() => {
    // 명시적으로 고른 **지원 목록 밖** 모델은 특수 목적(부분 수정의 고정 모델 등)이라 건드리지 않는다.
    if (model && explicitRef.current && !ALLOWED.image.includes(model) && !ALLOWED.video.includes(model)) return;
    // 유지: 이 타입의 모델이고 (막히지 않았거나 명시적으로 고른 것). 그 밖엔 첫 사용 가능 모델로 자동 선택.
    const inType = ALLOWED[type].includes(model);
    if (inType && (!blocked(model) || explicitRef.current)) return;
    const first = typeModels[0]?.job_set_type ?? "";
    if (!first) {
      // 목록이 아직 없거나 이 타입을 전부 못 씀 — 다른 타입의 모델이 남아 있으면 비워 엉뚱한 타입으로 제출되지 않게 한다.
      if (!inType && model) {
        explicitRef.current = false;
        // ★이 줄은 **이중 방어**다 — 여기서 모델을 비운 뒤 다시 고르려면 반드시 아래 교체 분기를
        //  거치고 거기서 이미 정리되므로, 되돌려 확인으로 관측되지 않는다(검출됐다고 적지 않는다).
        dropStalePendingOpts("");
        setModelState("");
      }
      return;
    }
    if (first !== model) {
      explicitRef.current = false;
      dropStalePendingOpts(first);
      setModelState(first);
    }
    // model·selectionTick 도 본다 — 복원으로 '자동 선택된, 지금은 못 쓰는 모델'이 되돌아왔을 때 다시 고르게(코덱스 P2).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, models, allowed, model, selectionTick]);

  // 모델 바뀌면 CLI 파라미터 로드 + 기본값으로 옵션 초기화.
  useEffect(() => {
    if (!model) {
      setParams([]);
      setOptionValues({});
      setParamsModel("");
      setParamsError(false);
      setParamsLoading(false);
      return;
    }
    // 파라미터 → params + 기본값 옵션 적용. 드롭 복원이 대기 중이면 기본값 위에 덮음.
    const apply = (r: ModelParamsOut) => {
      setParams(r.params);
      const init = defaultOptions(r.params, model); // 실효 기본값(오버라이드·게이트 반영)
      // 이 모델용 예약 옵션일 때만 덮는다(다른 모델용이면 그 모델 로드 때 적용되도록 보존).
      const pend = pendingOptsRef.current;
      if (pend && pend.model === model) {
        setOptionValues({ ...init, ...pend.opts });
        // ★여기서 **비우지 않는다**(코덱스 반례). StrictMode 는 effect 를 실행→정리→재실행하는데,
        //  파라미터가 캐시 적중이면 두 번째 실행이 곧바로 다시 돈다. 그때 비어 있으면
        //  **기본값만** 들어가 복원한 옵션이 사라진다. 같은 모델의 재적용은 결과가 같다(멱등).
        //  비우는 것은 아래 `setModel` 이 **다른 모델로 옮길 때** 한다.
      } else {
        setOptionValues(init);
      }
      setParamsModel(model); // 이제 params/optionValues 가 이 model 것으로 정합
      setParamsError(false);
      setParamsLoading(false);
    };
    // 캐시 적중 → 네트워크 없이 즉시 적용(토글 딜레이 제거).
    const cached = paramsCache.get(model);
    if (cached) {
      apply(cached);
      return;
    }
    setParamsLoading(true); // 네트워크 로드 시작 — 완료 전까지 옵션/스키마는 이전 모델 것(stale)
    let alive = true;
    loadModelParams(model)
      .then((r) => {
        if (alive) apply(r);
      })
      .catch(() => {
        if (alive) {
          setParams([]);
          setOptionValues({});
          // ★정합을 **깬다**(2026-09-13). 종전엔 `model` 을 넣어 성공과 구별되지 않았고,
          //  `paramsModel === model` 을 저장 조건으로 쓰는 곳들(모델 노드 모달·부분 수정·
          //  Spotlight 제출)이 **빈 옵션을 정상으로 보고 저장·제출**할 수 있었다.
          setParamsModel("");
          setParamsError(true);
          setParamsLoading(false);
          // 복원 대기 옵션은 **소비하지 않는다** — 다시 조회에 성공하면 그때 덮는다.
        }
      });
    return () => {
      alive = false;
    };
  }, [model]);

  // 두 모델(이미지/비디오) 파라미터를 미리 받아 캐시 → 첫 토글부터 즉시 전환.
  // 추가로 각 모델 '정착 기본옵션'의 비용도 미리 추정해 cost 캐시에 넣어 둠(B) → 첫 토글의 비용 멈칫도 제거.
  // 그룹 정책의 첫 조회가 끝난 뒤(ready) 쓸 수 있는 모델만 예열한다 — 못 쓰는 모델의 params·cost 조회를 헛되이 시작하지 않게.
  useEffect(() => {
    if (!policyReady) return;
    // 기본옵션을 제약 보정까지 적용해 '정착' 상태로 만든 뒤 그 비용을 예열(모델 선택 시 cost effect 가 낼 키와 일치).
    const warmCost = (m: string, params: ModelParam[]) => {
      let opts = defaultOptions(params, m);
      for (let i = 0; i < 4; i++) {
        const c = correctedOptions(m, params, opts);
        if (c === opts) break; // 정착(멱등)
        opts = c;
      }
      const key = costKey(m, opts);
      if (costCache.has(key)) return;
      api
        .estimateCost(m, opts)
        .then((r) => {
          putCost(key, r.credits);
        })
        .catch(() => {});
    };
    for (const m of [...ALLOWED.image, ...ALLOWED.video].filter((jt) => !blocked(jt))) {
      const cached = paramsCache.get(m);
      if (cached) {
        warmCost(m, cached.params);
        continue;
      }
      loadModelParams(m)
        .then((r) => {
          warmCost(m, r.params);
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policyReady, allowed]);

  // 모델/옵션 바뀌면 예상 크레딧 재추정. 같은 조합은 캐시 적중 → 즉시(디바운스·CLI 생략), 새 조합만 debounce 250ms + CLI.
  useEffect(() => {
    if (!model) {
      setCost(null);
      setCostLoading(false); // 이 타입을 전부 못 써서 모델이 비는 경우에도 '계산 중…'이 남지 않게(코덱스 P2)
      return;
    }
    // 모델 전환 직후 새 params 로드 전(stale)이면 이전 스키마로 견적하지 않는다 — 로드 완료 시 재실행된다.
    // 그동안 이전 모델의 cost 가 남아 보이지 않게 '계산 중'으로 둔다(오해 방지).
    // ★파라미터 조회가 실패했으면 견적을 시도하지 않고 '계산 중' 도 끝낸다(2026-09-13).
    //  실패 시 `paramsModel` 이 비므로 아래 조건만으론 영영 '계산 중' 으로 남는다(코덱스 지적).
    if (paramsError) {
      setCost(null);
      setCostLoading(false);
      return;
    }
    if (paramsModel !== model || paramsLoading) {
      setCostLoading(true);
      return;
    }
    const key = costKey(model, optionValues);
    const hit = costCache.get(key);
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
            (putCost(key, r.credits),
            setCost(r.credits),
            setCostLoading(false)),
        )
        .catch(() => alive && (setCost(null), setCostLoading(false)));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [model, optionValues, paramsModel, paramsLoading, paramsError]);

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

  return { models, type, setType, model, setModel, markModelSelection, modelPickedByUser, firstAllowed, currentModel,
           params, tunable, constraints,
           typeModels, modelName, optionValues, setOptionValues, setOpt, cost, costLoading, paramsModel, paramsLoading, paramsError,
           pendingOptsRef, setOpenRef, selectedBlocked, typeFullyBlocked };
}
