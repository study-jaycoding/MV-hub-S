// SpotlightPrompt 옵션 표시/검증 보조값.
import { hubHasFeature } from "./hubFeatures";

export const AUDIO_MODELS_V1 = ["seed_audio", "elevenlabs_v4", "elevenlabs_v4_turbo", "qwen_audio_tts"] as const;
export const AUDIO_PARAMS: Record<string, readonly string[]> = {
  text2speech_v2: ["variant", "voice_id", "voice_type"],
  seed_audio: ["voice_id", "voice_type", "format", "sample_rate", "speech_rate", "pitch_rate", "loudness_rate"],
  elevenlabs_v4: ["voice_id", "voice_type", "stability", "similarity_boost"],
  elevenlabs_v4_turbo: ["voice_id", "voice_type", "stability", "similarity_boost"],
  qwen_audio_tts: ["voice_id", "voice_type", "instruction", "language", "speech_rate", "pitch_rate", "volume", "format", "sample_rate", "seed"],
};
export const isTtsModel = (model: string): boolean => Object.prototype.hasOwnProperty.call(AUDIO_PARAMS, model);

// ElevenLabs 오디오 태그 — 힉스필드 웹 v4 대사 칸의 `+ 태그` 목록 그대로(2026-10-28 웹 번들). 대본 글자([sighing])로 들어간다.
//  웹은 v4 에서만 태그 단추를 보이지만, 유료 시험에서 v3(text2speech_v2·elevenlabs)도 태그대로 연기했다(10-28 Jay 판정).
//  같은 모델의 MiniMax·Seed Speech, v4 Turbo 는 확인 안 함 — 켜지 않는다.
export const AUDIO_TAG_GROUPS: [string, string[]][] = [
  ["Emotion", ["weak", "angry", "bored", "menacing", "playful", "tired", "excited"]],
  ["Vocalizations", ["clears throat", "coughing", "chuckling", "sighing", "sniffling", "yawning", "laughing", "sharp exhale", "scoffing", "humming", "panting", "gasping"]],
  ["Delivery", ["whispering", "singing", "slowly", "softly", "pause", "voice breaking"]],
  ["Character", ["sleepy drowsy voice", "witch voice", "drunken voice"]],
  ["Sound effects", ["keyboard typing", "echoing", "knocking on door", "bell ringing", "phone ringing", "dog barking", "crowd cheering", "applause", "rain falling", "drum roll", "heartbeat", "engine starting"]],
];
export const audioTagModel = (model: string, variant?: unknown): boolean =>
  model === "elevenlabs_v4" || (model === "text2speech_v2" && variant === "elevenlabs");
/** `[` 목록 — 검색어를 담은 태그(묶음 순서), 똑같은 태그가 없으면 검색어 그대로를 끝에(Custom — 웹과 같다). */
export function audioTagMatches(query: string): { group: string; tag: string }[] {
  const q = query.trim().toLowerCase();
  const hits = AUDIO_TAG_GROUPS.flatMap(([group, tags]) => tags.filter((tag) => tag.includes(q)).map((tag) => ({ group, tag })));
  return q && !hits.some((h) => h.tag === q) ? [...hits, { group: "Custom", tag: query.trim() }] : hits;
}

// 보이스 체인지·번역(2-B) — 영상 1개를 받는 프롬프트 없는 워크플로. backend/app/models.py VIDEO_VOICE_* 와 같아야 한다
//  (언어 표는 백엔드 정의 일치 시험이 직접 읽는다 — 형식 ["코드", "이름"] 을 유지할 것).
export const VIDEO_VOICE_MODELS = ["voice_change", "dubbing"] as const;
export const isVideoVoiceModel = (model: string): boolean => (VIDEO_VOICE_MODELS as readonly string[]).includes(model);
/** Audio 의 세 가지 일 ↔ 실행 키. 일은 모델에서 나온다 — 재사용·복원이 모델만 돌려줘도 같은 일로 돌아온다. */
export const AUDIO_TASK_MODELS: Record<string, string> = { "voice-change": "voice_change", translate: "dubbing" };
export const audioTaskOf = (model: string): string => model === "voice_change" ? "voice-change" : model === "dubbing" ? "translate" : "tts";
export const DUBBING_LANGUAGES: [string, string][] = [
  ["kor", "한국어"], ["eng", "영어"], ["jpn", "일본어"], ["cmn", "중국어(표준)"], ["spa", "스페인어"], ["fra", "프랑스어"],
  ["deu", "독일어"], ["ita", "이탈리아어"], ["por", "포르투갈어"], ["rus", "러시아어"], ["hin", "힌디어"], ["ara", "아랍어"],
  ["tur", "튀르키예어"], ["pol", "폴란드어"], ["ind", "인도네시아어"], ["fil", "필리핀어"], ["swe", "스웨덴어"], ["fin", "핀란드어"],
];
export const VIDEO_VOICE_INPUT_ERROR = "영상 1개를 넣으세요";
export function videoVoiceReferenceError(refs: { type: string; file_path?: string }[]): string | null {
  return refs.length !== 1 || refs[0].type !== "video" || !refs[0].file_path ? VIDEO_VOICE_INPUT_ERROR : null;
}
/** 견적 문맥 — 실제 입력 파일에서 읽은 길이(초)와 그 입력의 식별자. 번역 fps 는 모르면 넣지 않는다(CLI 기본 25). */
export interface VideoCostContext { duration: number; fps?: number; input_ref: string }
export const videoVoiceInputRef = (ref: { asset_content_id?: string | null; file_path: string }): string => ref.asset_content_id || ref.file_path;

export const audioModelBlocked = (model: string): string | null =>
  ((AUDIO_MODELS_V1 as readonly string[]).includes(model) && !hubHasFeature("audio-models-v1"))
  || (isVideoVoiceModel(model) && !hubHasFeature("video-voice-v1")) ? "서버 업데이트 필요" : null;

// 모델별 '추천' 목소리 — CLI voices list 에는 모델 구분이 없어, 힉스필드 웹 목록을 이름→CLI id 로 고정한다(2026-10-28 비로그인 화면,
//  끝까지 스크롤해 센 값: Qwen 만 47개, 나머지 엔진은 114 전부라 표가 없다). 추천만 표시하고 나머지를 막지 않는다(Jay 결정 ①·Codex A6).
//  shortcut: 힉스필드가 목록을 바꾸면 낡는다 — CLI 가 모델별 목소리를 줄 때 이 표를 없앤다.
const QWEN_WEB_VOICE_IDS: ReadonlySet<string> = new Set([
  "30fc8796-ceb6-4a66-b3a7-4a145ef7f346", "d8ba9f14-8a24-44db-932b-99e16c45bd32", "6b3e3642-f7b7-4cb8-9688-51e233c4b92f",
  "6b528d43-c056-4a2f-9d82-1591a7ba13b0", "caeba733-3c17-43db-863e-69c7025512cd", "858499d9-fef5-40e1-bc29-b4dc661dc283",
  "8911390e-4b59-459b-ba84-19010917e1df", "549ff70a-3ee7-4f04-a4d9-89a24fab7709", "0178ef57-ada4-43d9-992b-8d9221045bb4",
  "b9c5c5db-4eb7-468a-a0b7-d06423af0335", "6f98d3dd-324f-4845-8c28-c1d1647a06cd", "9eb5a147-c322-4f8a-8bc5-a30679dfaf5c",
  "023ebf5e-1970-40d8-825c-a5ef6a1dd4ff", "75e72cd5-011b-4130-a474-e8b1ab341f04", "f6448975-768e-4327-b932-1b7c973d58e9",
  "c2acff45-84b2-4974-892d-89fa2d4e5598", "f32c8f51-449e-4ddf-bdf7-1527e11df917", "c25f78a0-714e-42af-8da3-a399cef94968",
  "1ad38ba4-9cc4-4f2f-9fde-b0fefdf67ae5", "1fb253b8-928b-4d29-a349-f242a71eaddf", "fa64fba4-ad02-405e-99d0-1f085d87c706",
  "dc382508-c8bd-443c-8cb2-46e57b8d2e6f", "b0f766b7-8703-4bd1-b973-f857c36837b6", "80914268-dfae-4f76-8306-36f2d55f58f8",
  "573e5163-59b3-4926-aab1-951ef2985f81", "3811e986-0891-47cf-a1f5-78a1d62a547a", "d0374db1-44b9-4f05-939e-0a9ae9dbbe6a",
  "d9d5c263-f84e-4752-97b5-3750fcc6fd2f", "f1373f24-3b96-433f-9a68-e595810ef608", "530df032-c311-483b-a750-cb3c9e1bcdfd",
  "b57b22a0-f287-405b-bc82-6f08f5e6bb1f", "ef70cc83-3015-4bad-9359-0ea968c43ec0", "375a3398-e3b4-4f91-845d-42181e352899",
  "95429266-c0ac-4137-a209-63b8812b0f23", "27c04473-84a9-4b60-a41f-c8e8458bd4f1", "c3204739-4084-41a3-9dc5-c805b307ec18",
  "ed69c516-92d2-4b30-a967-617737a342e5", "f1e8226e-2248-4d5f-b43c-0a79e9949dbf", "e9cfbbf0-4476-46be-b396-596eb774b165",
  "43173c95-3ec8-446a-a162-6504332c578b", "e5666b9c-99a2-4fac-8b4e-abee078b186d", "ca83ca7f-c186-493d-bd69-0d765fa861b2",
  "d081b915-6623-4a44-bacf-80d0f1c90a03", "41023a48-71ab-478a-bea7-c7b5a78f6b36", "7c2133e5-68ab-511f-9aed-9a67664382b1",
  "80924413-1ea8-4e64-9719-e00b86796f05", "73a45c18-0c56-4642-a61e-f6b303f8ded1",
]);
export function recommendedVoiceIds(model: string): ReadonlySet<string> | null {
  return model === "qwen_audio_tts" ? QWEN_WEB_VOICE_IDS : null;
}

/** 레퍼런스 칸을 보일까 — 레퍼런스를 안 받는 음성 모델이라도 남은 것이 있으면 보인다. 숨기면 지울 길 없이 제출만 막힌다(Codex A-1). */
export const refTrayShown = (model: string, refCount: number): boolean => !isTtsModel(model) || model === "seed_audio" || refCount > 0;

export function audioReferenceError(model: string, params: Record<string, unknown>, refs: { type: string; file_path?: string }[]): string | null {
  if (!isTtsModel(model)) return null;
  if (model !== "seed_audio") return refs.length ? "이 음성 모델에는 레퍼런스를 사용할 수 없습니다" : null;
  const images = refs.filter((r) => r.type === "image").length;
  const audios = refs.filter((r) => r.type === "audio").length;
  if (images + audios !== refs.length || refs.some((r) => !r.file_path)) return "Seed Audio에는 이미지 또는 오디오 파일만 사용할 수 있습니다";
  if (images && audios) return "Seed Audio의 이미지와 오디오 레퍼런스는 함께 사용할 수 없습니다";
  if (images > 1) return "Seed Audio의 이미지 레퍼런스는 1개까지 사용할 수 있습니다";
  if (images && params.voice_id) return "Seed Audio의 목소리와 이미지 레퍼런스는 함께 사용할 수 없습니다";
  if (audios > (params.voice_id ? 2 : 3)) return "Seed Audio의 오디오 레퍼런스는 목소리 선택 시 2개, 미선택 시 3개까지 사용할 수 있습니다";
  return null;
}

export function audioParamsError(model: string, params: Record<string, unknown>): string | null {
  if (!isTtsModel(model)) return null;
  if (Object.keys(params).some((key) => !AUDIO_PARAMS[model].includes(key))) return "지원하지 않는 음성 생성 옵션입니다";
  if (model !== "seed_audio" || params.voice_id != null || params.voice_type != null) {
    if (typeof params.voice_id !== "string" || !params.voice_id.trim() || params.voice_type !== "preset") return "공식 프리셋 목소리를 선택하세요";
  }
  for (const [key, value] of Object.entries(params)) {
    if (["stability", "similarity_boost", "speech_rate", "pitch_rate", "loudness_rate", "volume", "sample_rate", "seed"].includes(key)) {
      const integer = ["volume", "sample_rate", "seed", "loudness_rate"].includes(key) || model === "seed_audio";
      if (typeof value !== "number" || !Number.isFinite(value) || integer && !Number.isSafeInteger(value)) return "음성 생성 숫자 옵션을 확인하세요";
      if (["stability", "similarity_boost"].includes(key) && (value < 0 || value > 1)) return "안정성과 유사도는 0~100% 범위에서 선택하세요";
    } else if (typeof value !== "string") return "음성 생성 옵션의 형식이 올바르지 않습니다";
  }
  if (params.language != null && !["zh", "en", "fr", "de", "ja", "ko", "ru", "pt", "th", "id", "vi", "it", "ms"].includes(String(params.language))) return "지원하지 않는 음성 언어입니다";
  return null;
}

// duration 초 범위 — CLI 스키마(model get)에 min/max 가 없어 모델 스펙(models_explore)으로 보강.
const DURATION_RANGE: Record<string, { min: number; max: number }> = {
  seedance_2_5: { min: 4, max: 30 }, // 실측(generate cost): 3 거부·30 허용·31 거부. 6.5크레딧/초(720p)
  seedance_2_0: { min: 4, max: 15 },
  seedance_2_0_mini: { min: 4, max: 15 },
  gemini_omni: { min: 4, max: 10 }, // 실측(generate cost): 4 미만/10 초과 거부
};

export function durationRange(model: string, fallback: number): { min: number; max: number } {
  return DURATION_RANGE[model] || { min: 1, max: Math.max(12, fallback * 2) };
}

// 자주 바꾸는 핵심 파라미터만 인라인 칩으로 두고, 나머지는 고급 팝오버로 모은다.
export const SPOTLIGHT_PRIMARY_PARAMS = new Set(["aspect_ratio", "resolution", "duration"]);

// 허용값 제한/표시 게이트와 별개: 유효하지만 CLI가 이 모드에서 무시하는 값.
// 화면에서는 흐리게 + 조작 불가로 두고(2026-09-15 Jay), 값과 전송은 그대로 유지한다
// — 모드를 되돌리면 고르던 값이 살아 있어야 하고, CLI 는 어차피 이 값을 버린다.
export function spotlightIgnoredOptions(model: string, mode: unknown): {
  params: readonly string[];
  note: string | null;
  billingNote?: string;
} {
  if (model === "seedance_2_5") {
    if (mode === "video_edit") return {
      params: ["duration", "aspect_ratio"],
      note: "길이·비율은 넣은 영상을 따릅니다.",
      billingNote: "요금도 그 영상 길이로 매겨집니다.",
    };
    if (mode === "video_extension") return {
      params: ["aspect_ratio"],
      note: "비율은 넣은 영상을 따릅니다.",
    };
  }
  return { params: [], note: null };
}

// ── 모델 드롭다운 '변형' ────────────────────────────────────────────────────
// CLI 모델 하나를 옵션 고정값으로 갈라 **드롭다운에서만** 별도 항목처럼 보여준다. 힉스필드 웹이
// Seedance 2.0 / 2.0 Fast 를 따로 내놓는 것과 같은 표시다.
// ★CLI 에는 `seedance_2_0_fast` 라는 job_type 이 **없다**. 제출·견적·DB 저장은 그대로
//   (model=seedance_2_0, mode=fast) 로 나가므로 카탈로그 대조·재생성·씬 노드·팩트 집계가 전부
//   종전대로 동작한다. 가짜 모델 키를 만들면 저 경로 전부에 번역기를 달아야 한다 — 그래서 화면에서만 가른다.
// 표시명은 CLI 카탈로그 display_name 에 suffix 를 붙여 만든다(힉스필드가 이름을 바꿔도 따라간다).
//  · 2026-09-15 견적 실측(4초): std 480p 12 · 720p 18 · 1080p 36 · 4k 88 / fast 480p 6 · 720p 14.
//    fast 는 1080p·4k 를 CLI 가 명시 거부 → 해상도는 MODEL_CONSTRAINTS(useModels) 가 함께 좁힌다.
//  ★seedance_2_5.mode 는 가르지 않는다 — 속도가 아니라 생성 방식(t2v/omni_reference/video_edit/
//    video_extension)이 갈려 모델 이름으로 표현할 성질이 아니고, 기본값이 틀어지면 레퍼런스가 거부된다.
//  · text2speech_v2.variant(2026-10-28 Jay·Codex 합의): 엔진을 '고급'에 날 값으로 두던 것을 모델 줄로 꺼낸다.
//    표시명은 웹 제품명 — 웹 번들의 엔진 표가 elevenlabs=ElevenLabs v3 · minimax=MiniMax Speech 2.8 HD 로 쓴다(10-28 확인, Jay "이름 바꾸기").
//    vibe_voice·cozy_voice 는 웹에 없는 엔진이라 새 선택지에서 빼되(legacy), 저장된 값은 '기존 설정' 줄로 보존한다.
//    requireChoice: 값이 비면 첫 항목으로 간주하지 않는다 — 복원값에 엔진이 빠졌으면 고를 때까지 막는다(Codex B1).
type ModelVariantEntry = { value: string; suffix: string; name?: string; legacy?: boolean };
type ModelVariantConfig = { param: string; entries: ModelVariantEntry[]; requireChoice?: boolean };
const MODEL_VARIANTS: Record<string, ModelVariantConfig> = {
  seedance_2_0: {
    param: "mode",
    entries: [
      { value: "std", suffix: "" },
      { value: "fast", suffix: " Fast" },
    ],
  },
  text2speech_v2: {
    param: "variant",
    requireChoice: true,
    entries: [
      { value: "elevenlabs", suffix: "", name: "ElevenLabs v3" },
      { value: "minimax", suffix: "", name: "MiniMax Speech 2.8 HD" },
      { value: "seed_speech", suffix: "", name: "Seed Speech" },
      { value: "vibe_voice", suffix: "", name: "Vibe Voice", legacy: true },
      { value: "cozy_voice", suffix: "", name: "Cozy Voice", legacy: true },
    ],
  },
};

const LEGACY_LABEL = " (기존 설정)";

function entryLabel(baseName: string, e: ModelVariantEntry): string {
  return (e.name ?? baseName + e.suffix) + (e.legacy ? LEGACY_LABEL : "");
}

/** 드롭다운 한 줄. 평범한 모델이면 1줄, 변형이 있으면 값마다 1줄(param/value 가 붙는다). */
export type ModelRow = {
  key: string;
  model: string;
  display_name: string;
  param?: string;
  value?: string;
  description?: string;
};

/** legacy 변형은 지금 고른 값일 때만 '기존 설정' 줄로 끼운다(새 선택지로는 내놓지 않는다). */
export function modelRows(
  models: { job_set_type: string; display_name: string }[],
  current?: { model: string; optionValues: Record<string, string | number | boolean> },
): ModelRow[] {
  const out: ModelRow[] = [];
  for (const m of models) {
    const v = MODEL_VARIANTS[m.job_set_type];
    if (!v) {
      out.push({ key: m.job_set_type, model: m.job_set_type, display_name: m.display_name });
      continue;
    }
    const cur = current?.model === m.job_set_type ? String(current.optionValues[v.param] ?? "") : "";
    for (const e of v.entries) {
      if (e.legacy && e.value !== cur) continue;
      out.push({
        key: `${m.job_set_type}:${e.value}`,
        model: m.job_set_type,
        display_name: entryLabel(m.display_name, e),
        param: v.param,
        value: e.value,
      });
    }
  }
  const audioOrder = ["seed_audio", "elevenlabs_v4", "elevenlabs_v4_turbo", "text2speech_v2:elevenlabs", "qwen_audio_tts", "text2speech_v2:minimax", "text2speech_v2:seed_speech"];
  if (models.every((m) => isTtsModel(m.job_set_type))) {
    out.sort((a, b) => (audioOrder.indexOf(a.key) < 0 ? 7 : audioOrder.indexOf(a.key)) - (audioOrder.indexOf(b.key) < 0 ? 7 : audioOrder.indexOf(b.key)));
    for (const row of out) row.description = AUDIO_DESCRIPTIONS[row.key] ?? "저장된 음성 엔진 설정";
  }
  return out;
}

const AUDIO_DESCRIPTIONS: Record<string, string> = {
  seed_audio: "목소리 또는 오디오·이미지 참고로 음성 생성",
  elevenlabs_v4: "안정성과 목소리 유사도를 조절하는 음성 생성",
  elevenlabs_v4_turbo: "빠른 v4 음성 생성",
  "text2speech_v2:elevenlabs": "ElevenLabs 엔진으로 대본 읽기",
  qwen_audio_tts: "언어와 말하는 방식을 조절하는 음성 생성",
  "text2speech_v2:minimax": "MiniMax 엔진으로 대본 읽기",
  "text2speech_v2:seed_speech": "Seed Speech 엔진으로 대본 읽기",
};

/** 지금 옵션값이 가리키는 변형 값. 아직 안 실렸으면 첫 항목(=기본)으로 본다 — requireChoice 면 빈 값 그대로(""). */
export function currentVariantValue(
  model: string,
  optionValues: Record<string, string | number | boolean>,
): string | null {
  const v = MODEL_VARIANTS[model];
  if (!v) return null;
  const cur = String(optionValues[v.param] ?? "");
  return v.requireChoice ? cur : cur || v.entries[0].value;
}

/** 꼭 골라야 하는 변형이 비었는가 — 제출·씬 저장을 막는 근거(복원값에 엔진이 빠진 경우). */
export function variantChoiceMissing(
  model: string,
  optionValues: Record<string, string | number | boolean>,
): boolean {
  return !!MODEL_VARIANTS[model]?.requireChoice && currentVariantValue(model, optionValues) === "";
}

/** 꼭 골라야 하는 변형 파라미터 이름 — 복원 때 기본값으로 메우지 않을 키. */
export function requiredVariantParam(model: string): string | null {
  const v = MODEL_VARIANTS[model];
  return v?.requireChoice ? v.param : null;
}

/** 생성물 하나의 엔진 표시명(카드·정보 창 등). 변형 이름이 없는 모델이면 null — 호출측이 모델 이름을 쓴다. */
export function variantDisplayName(model: string | null | undefined, params: Record<string, unknown> | null | undefined): string | null {
  const v = model ? MODEL_VARIANTS[model] : undefined;
  const e = v?.entries.find((x) => x.value === params?.[v.param]);
  return e?.name ?? null;
}

/** 모델 칩 글자 — 이름 있는 변형은 그 이름, 꼭 골라야 하는데 비었으면 '엔진 선택'. */
export function modelChipLabel(
  modelName: string,
  model: string,
  optionValues: Record<string, string | number | boolean>,
): string {
  const v = MODEL_VARIANTS[model];
  if (!v) return modelName;
  if (variantChoiceMissing(model, optionValues)) return "엔진 선택"; // 칩 글자 칸(150px)에 들어가게 짧게
  const cur = currentVariantValue(model, optionValues);
  const e = v.entries.find((x) => x.value === cur);
  return e ? entryLabel(modelName, e) : modelName;
}

/** 이 파라미터를 모델 드롭다운이 대신 맡고 있는가 — 맞으면 '고급'에서 감춘다(같은 설정 두 곳 방지). */
export function isVariantParam(model: string, name: string): boolean {
  return MODEL_VARIANTS[model]?.param === name;
}

const ADVANCED_PARAM_ORDER = ["mode", "genre", "bitrate_mode", "thinking_level", "enable_web_search", "enable_image_search", "seed"];

export function spotlightAdvancedParamRank(name: string): number {
  const index = ADVANCED_PARAM_ORDER.indexOf(name);
  return index === -1 ? ADVANCED_PARAM_ORDER.length : index;
}

const PARAM_LABEL: Record<string, string> = {
  aspect_ratio: "비율",
  resolution: "해상도",
  duration: "길이",
  bitrate_mode: "비트레이트",
  genre: "장르",
  mode: "모드",
  quality: "품질",
  thinking_level: "생각 수준",
  enable_web_search: "웹 검색",
  enable_image_search: "이미지 검색",
  seed: "시드",
  stability: "안정성",
  similarity_boost: "목소리 유사도",
  instruction: "말하는 방식",
  language: "언어",
  target_language: "번역 언어",
  speech_rate: "말하기 속도",
  pitch_rate: "음높이",
  loudness_rate: "음량 조절",
  volume: "음량",
  format: "출력 형식",
  sample_rate: "샘플레이트",
};

export function spotlightParamLabel(name: string): string {
  return PARAM_LABEL[name] || name;
}

const VALUE_LABEL: Record<string, string> = {
  std: "표준(std)",
  fast: "빠름(fast)",
  standard: "표준(standard)",
  high: "고화질(high)",
  auto: "자동(auto)",
};

// 같은 값이 옵션마다 뜻이 다르다 — thinking_level 의 high 는 '고화질'이 아니다.
const PARAM_VALUE_LABEL: Record<string, Record<string, string>> = {
  thinking_level: { minimal: "최소(minimal)", medium: "보통(medium)", high: "깊게(high)" },
  format: { ogg_opus: "OGG", wav: "WAV", mp3: "MP3", pcm: "PCM" },
  language: { "": "자동", zh: "중국어", en: "영어", fr: "프랑스어", de: "독일어", ja: "일본어", ko: "한국어", ru: "러시아어", pt: "포르투갈어", th: "태국어", id: "인도네시아어", vi: "베트남어", it: "이탈리아어", ms: "말레이어" },
  target_language: Object.fromEntries(DUBBING_LANGUAGES),
};

export function spotlightValueLabel(value: string, param = ""): string {
  return PARAM_VALUE_LABEL[param]?.[value] || VALUE_LABEL[value] || value;
}
