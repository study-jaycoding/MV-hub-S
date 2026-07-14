import type { ChipRef, PromptPart } from "./promptEditor";
import {
  emptySeedanceTokenRoles,
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
  type SeedanceRefType,
} from "./seedancePrompt";

export interface SpotlightCreateBody {
  prompt: string;
  display_prompt?: string;
  model: string;
  params?: Record<string, unknown>;
  auto_tags?: string[];
  references?: {
    file_path: string;
    type: string;
    role: string;
    name?: string;
    thumbnail?: string;
    source_gen_id?: string;
  }[];
  project_id?: string;
  folder_path?: string;
}

interface Params {
  text: string;
  inlineRefs: ChipRef[];
  trayRefs: ChipRef[];
  parts: PromptPart[];
  displayPrompt: string;
  model: string;
  optionValues: Record<string, unknown>;
  armedAutoTags: string[];
  activeProjectId?: string;
  folderPath?: string; // 무장 폴더(렌더 루트 상대 경로) — 생성물 folder_path 로 저장
}

export function buildSpotlightCreateBody({
  text,
  inlineRefs,
  trayRefs,
  parts,
  displayPrompt,
  model,
  optionValues,
  armedAutoTags,
  activeProjectId,
  folderPath,
}: Params): { body: SpotlightCreateBody | null; error: string | null } {
  const seedanceMode = usesSeedanceMediaRefs(model);
  const tokenRoles = seedanceMode ? seedanceTokenRoles(text) : emptySeedanceTokenRoles();
  if (seedanceMode) {
    const tokenError = validateSeedanceTokenRoles(trayRefs, tokenRoles);
    if (tokenError) return { body: null, error: tokenError };
  }

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
      params: optionValues,
      auto_tags: armedAutoTags,
      references: refs.map((ref) => ({
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
