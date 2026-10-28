import { tagsProblem } from "./nameGuard";
import { normalizeSeedanceDraftParams } from "./seedanceDraft";
import { audioModelBlocked, audioParamsError, audioReferenceError, isTtsModel } from "./spotlightPromptConfig";
import type { ChipRef, PromptPart } from "./promptEditor";
import {
  SEEDANCE_TOKEN_SRC,
  seedanceAtTokenKind,
  emptySeedanceTokenRoles,
  effectiveSeedanceMode,
  normalizeMediaRefTokensBasic,
  normalizeSeedancePromptTokens,
  seedanceAudioIndexMap,
  seedanceOmniImageIndexMap,
  seedancePromptText,
  seedanceTokenRoles,
  seedanceTrayRole,
  seedanceVideoIndexMap,
  usesMediaRefTokens,
  usesSeedanceMediaRefs,
  validateSeedanceTokenRoles,
  validateSeedanceMode,
  type SeedanceRefType,
} from "./seedancePrompt";

import { assetIdentity, type AssetReferenceIdentity } from "../shared/contracts/assets";

export interface SpotlightCreateBody {
  prompt: string;
  display_prompt?: string;
  model: string;
  params?: Record<string, unknown>;
  tags?: string[];
  auto_tags?: string[];
  references?: (AssetReferenceIdentity & {
    file_path: string;
    type: string;
    role: string;
    name?: string;
    thumbnail?: string;
    source_gen_id?: string;
  })[];
  project_id?: string;
  folder_path?: string;
}

// 내레이션(text2speech_v2) 엔진별 대본 글자 한도 — 제출 검증과 대본 칸의 글자 수 표시가 같은 값을 쓴다.
//  백엔드(models.py SPEECH_PROMPT_LIMITS)·에이전트도 같은 값을 따로 검사한다.
export const SPEECH_TEXT_LIMITS: Record<string, number> = {
  elevenlabs: 5000, minimax: 10000, seed_speech: 15000, vibe_voice: 5000, cozy_voice: 5000,
};

interface Params {
  text: string;
  inlineRefs: ChipRef[];
  trayRefs: ChipRef[];
  parts: PromptPart[];
  displayPrompt: string;
  model: string;
  optionValues: Record<string, unknown>;
  tags?: string[];
  armedAutoTags: string[];
  activeProjectId?: string;
  folderPath?: string; // 무장 폴더(렌더 루트 상대 경로) — 생성물 folder_path 로 저장
}

export function normalizeSpotlightBatch(
  override: unknown,
  fallback: number,
  maxCount: number,
): number {
  const requested =
    typeof override === "number" && Number.isFinite(override)
      ? Math.floor(override)
      : fallback;
  const finite = Number.isFinite(requested) ? Math.floor(requested) : 1;
  return Math.min(maxCount, Math.max(1, finite));
}

// 비-seedance 이미지 모델(Nano Banana·GPT Image 2 등): 프롬프트의 레퍼런스 토큰(@image3·<<<image3>>>)이
// 실제 첨부 refs(트레이+인라인)의 해당 타입 개수를 넘으면 = 트레이에 없는 번호 → CLI 로 가서 크레딧만
// 쓰고 실패/무시된다. 제출 전에 막는다(seedance 는 validateSeedanceTokenRoles 로 이미 검증).
function validateMediaRefTokenPresence(text: string, refs: { type: string }[]): string | null {
  const counts = {
    image: refs.filter((r) => r.type === "image").length,
    video: refs.filter((r) => r.type === "video").length,
    audio: refs.filter((r) => r.type === "audio").length,
  };
  const re = new RegExp(SEEDANCE_TOKEN_SRC, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = String(m[1] || m[3] || "");
    const n = Number(m[2] || m[4]);
    const kind = seedanceAtTokenKind(raw);
    const type = kind === "video" ? "video" : kind === "audio" ? "audio" : "image";
    const label = type === "video" ? "비디오" : type === "audio" ? "오디오" : "이미지";
    if (!Number.isFinite(n) || n < 1) return `${label} 레퍼런스 토큰 번호가 올바르지 않습니다.`;
    if (n > counts[type]) {
      return `${label} 레퍼런스 ${n}번이 없습니다. 빨간 레퍼런스 토큰을 지우거나 레퍼런스를 추가해 주세요.`;
    }
  }
  return null;
}

// 직접 재생성은 useGenerationCardActions에서 같은 capability 게이트를 적용한다.
export function buildSpotlightCreateBody({
  text,
  inlineRefs,
  trayRefs,
  parts,
  displayPrompt,
  model,
  optionValues,
  tags,
  armedAutoTags,
  activeProjectId,
  folderPath,
}: Params): { body: SpotlightCreateBody | null; error: string | null } {
  // Set 카드의 태그는 검사 없이 여기로 온다 — 주소 한 칸에 못 들어가는 이름(/ · . ..)은 생성 전에 막는다(조작 규칙 53 — lib/nameGuard). 조용히 빼지 않는다.
  const tagProblem = tagsProblem(tags ?? []);
  if (tagProblem) return { body: null, error: `${tagProblem} — Set 카드의 태그를 고친 뒤 생성하세요.` };
  const featureError = audioModelBlocked(model);
  if (featureError) return { body: null, error: featureError };
  if (isTtsModel(model) && model !== "text2speech_v2") {
    if (!text.trim()) return { body: null, error: "내레이션 텍스트를 입력하세요." };
    const params = Object.fromEntries(Object.entries(optionValues).filter(([, value]) => value !== "" && value != null));
    const references = [...trayRefs, ...inlineRefs].map((ref) => ({
      ...assetIdentity(ref), file_path: ref.file_path, type: ref.type,
      role: ref.type === "audio" ? "audio_references" : "image_references",
      name: ref.name, thumbnail: ref.thumb, source_gen_id: ref.source_gen_id,
    }));
    const error = audioParamsError(model, params) || audioReferenceError(model, params, references);
    if (error) return { body: null, error };
    return { error: null, body: { prompt: text, display_prompt: displayPrompt || undefined, model, params, references,
      tags: tags?.length ? tags : undefined, auto_tags: armedAutoTags, project_id: activeProjectId, folder_path: folderPath || undefined } };
  }
  if (model === "text2speech_v2") {
    if (!text.trim()) return { body: null, error: "내레이션 텍스트를 입력하세요." };
    if (trayRefs.length || inlineRefs.length) return { body: null, error: "내레이션 생성은 텍스트와 목소리만 사용합니다. 레퍼런스를 비운 뒤 생성하세요." };
    if (!optionValues.voice_id || optionValues.voice_type !== "preset") return { body: null, error: "목소리 목록에서 내레이션 목소리를 선택하세요." };
    const variant = String(optionValues.variant ?? "");
    if (!variant) return { body: null, error: "모델 목록에서 음성 엔진을 고르세요." };
    const limit = SPEECH_TEXT_LIMITS[variant];
    if (!limit) return { body: null, error: "지원하는 음성 모델 옵션을 선택하세요." };
    if (text.length > limit) return { body: null, error: `선택한 음성 옵션은 최대 ${limit}자까지 지원합니다.` };
    return { error: null, body: {
      prompt: text, display_prompt: displayPrompt || undefined, model,
      params: { variant, voice_id: optionValues.voice_id, voice_type: "preset" }, references: [],
      tags: tags?.length ? tags : undefined, auto_tags: armedAutoTags,
      project_id: activeProjectId, folder_path: folderPath || undefined,
    } };
  }
  const seedanceMode = usesSeedanceMediaRefs(model);
  const tokenRoles = seedanceMode ? seedanceTokenRoles(text) : emptySeedanceTokenRoles();

  let imgN = 0;
  let videoN = 0;
  let audioN = 0;
  const trayWithRoles = trayRefs.map((ref, index) => {
    const refType = ref.type as SeedanceRefType;
    if (refType === "video") return { ...ref, role: `@Video${++videoN}` };
    if (refType === "audio") return { ...ref, role: `@Audio${++audioN}` };
    const role = seedanceMode ? seedanceTrayRole(trayRefs, index, tokenRoles) : "omni";
    if (role === "start") return { ...ref, role: "@Start" };
    if (role === "end") return { ...ref, role: "@End" };
    return { ...ref, role: `@Image${++imgN}` };
  });
  const inlineWithRoles = inlineRefs.map((ref) => {
    const refType = ref.type as SeedanceRefType;
    if (refType === "audio") return { ...ref, role: `@Audio${++audioN}` };
    if (refType === "video") return { ...ref, role: `@Video${++videoN}` };
    return { ...ref, role: `@Image${++imgN}` };
  });
  const refs = [...trayWithRoles, ...inlineWithRoles];
  const params = normalizeSeedanceDraftParams(model, optionValues);
  const effectiveMode = effectiveSeedanceMode(model, params.mode, refs.length);
  if (effectiveMode !== params.mode) params.mode = effectiveMode;

  if (seedanceMode) {
    // 기존 토큰 번호의 기준은 트레이다. 인라인은 모드 판정·영상 개수에만 합산한다.
    const tokenError = validateSeedanceTokenRoles(trayRefs, tokenRoles);
    if (tokenError) return { body: null, error: tokenError };
  }
  const modeError = validateSeedanceMode(model, effectiveMode, refs, tokenRoles, params.extension_mode);
  if (modeError) return { body: null, error: modeError };
  if (model === "seedance_2_5" && effectiveMode !== "video_extension") delete params.extension_mode;

  // 없는 번호의 레퍼런스 토큰(빨강 알약)이 섞인 채 제출되면 CLI 가 크레딧만 쓰고 실패한다 → 차단.
  if (!seedanceMode && usesMediaRefTokens(model)) {
    const tokenError = validateMediaRefTokenPresence(text, refs);
    if (tokenError) return { body: null, error: tokenError };
  }

  const imageIndexMap = seedanceMode ? seedanceOmniImageIndexMap(trayRefs, tokenRoles) : undefined;
  const videoIndexMap = seedanceMode ? seedanceVideoIndexMap(trayRefs) : undefined;
  const audioIndexMap = seedanceMode ? seedanceAudioIndexMap(trayRefs) : undefined;
  const trayOmniImageCount = seedanceMode
    ? trayRefs.filter((ref, index) => ref.type === "image" && seedanceTrayRole(trayRefs, index, tokenRoles) === "omni").length
    : trayRefs.filter((ref) => ref.type === "image").length;
  const trayVideoCount = seedanceMode ? trayRefs.filter((ref) => ref.type === "video").length : 0;
  const trayAudioCount = seedanceMode ? trayRefs.filter((ref) => (ref.type as SeedanceRefType) === "audio").length : 0;
  const promptText = seedanceMode
    ? seedancePromptText(parts, trayOmniImageCount, imageIndexMap, trayVideoCount, videoIndexMap, trayAudioCount, audioIndexMap) ||
      normalizeSeedancePromptTokens(text, imageIndexMap, videoIndexMap, audioIndexMap)
    : usesMediaRefTokens(model)
      ? normalizeMediaRefTokensBasic(text) // 이미지 모델 등: 알약(@imageN)을 CLI 용 <<<imageN>>> 원형으로(바이트 동일)
      : text;
  // ★CLI 프롬프트는 반드시 한 줄 — 프롬프트에 줄바꿈이 있으면 Higgsfield 가 레퍼런스(입력 이미지)를 못 붙여
  //  '엉뚱한 결과물'이 나온다(실측). 줄바꿈은 display_prompt 에만 남긴다. seedance/비-seedance 두 경로 모두 커버.
  const cliPrompt = (promptText || "").replace(/[^\S\n]*\n[^\S\n]*/g, " ").replace(/[^\S\n]+/g, " ").trim();

  return {
    error: null,
    body: {
      prompt: cliPrompt || "(no text)",
      display_prompt: displayPrompt || undefined,
      model,
      params,
      tags: tags?.length ? tags : undefined,
      auto_tags: armedAutoTags,
      references: refs.map((ref) => ({
        ...assetIdentity(ref),
        file_path: ref.file_path,
        type: ref.type,
        role: ref.role,
        name: ref.name,
        thumbnail: ref.thumb,
        source_gen_id: ref.source_gen_id,
      })),
      project_id: activeProjectId,
      folder_path: folderPath || undefined,
    },
  };
}
