import type { ChipRef, PromptPart } from "./promptEditor";
import {
  normalizeSeedancePromptTokens,
  seedanceOmniImageIndexMap,
  seedancePromptText,
  seedanceTokenRoles,
  seedanceTrayRole,
  seedanceVideoIndexMap,
  usesSeedanceMediaRefs,
  validateSeedanceTokenRoles,
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
}: Params): { body: SpotlightCreateBody | null; error: string | null } {
  const seedanceMode = usesSeedanceMediaRefs(model);
  const tokenRoles = seedanceMode ? seedanceTokenRoles(text) : new Map();
  if (seedanceMode) {
    const tokenError = validateSeedanceTokenRoles(trayRefs, tokenRoles);
    if (tokenError) return { body: null, error: tokenError };
  }

  let imgN = 0;
  let videoN = 0;
  const trayWithRoles = trayRefs.map((ref, index) => {
    if (ref.type !== "image") return { ...ref, role: `@Video${++videoN}` };
    const role = seedanceMode ? seedanceTrayRole(ref, index, tokenRoles) : "omni";
    if (role === "start") return { ...ref, role: "@Start" };
    if (role === "end") return { ...ref, role: "@End" };
    return { ...ref, role: `@Image${++imgN}` };
  });
  const inlineWithRoles = inlineRefs.map((ref) =>
    ref.type === "image" ? { ...ref, role: `@Image${++imgN}` } : { ...ref, role: `@Video${++videoN}` },
  );
  const refs = [...trayWithRoles, ...inlineWithRoles];

  const imageIndexMap = seedanceMode ? seedanceOmniImageIndexMap(trayRefs, tokenRoles) : undefined;
  const videoIndexMap = seedanceMode ? seedanceVideoIndexMap(trayRefs) : undefined;
  const trayOmniImageCount = seedanceMode
    ? trayRefs.filter((ref, index) => ref.type === "image" && seedanceTrayRole(ref, index, tokenRoles) === "omni").length
    : trayRefs.filter((ref) => ref.type === "image").length;
  const trayVideoCount = seedanceMode ? trayRefs.filter((ref) => ref.type === "video").length : 0;
  const promptText = seedanceMode
    ? seedancePromptText(parts, trayOmniImageCount, imageIndexMap, trayVideoCount, videoIndexMap) ||
      normalizeSeedancePromptTokens(text, imageIndexMap, videoIndexMap)
    : text;

  return {
    error: null,
    body: {
      prompt: promptText || "(no text)",
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
    },
  };
}
