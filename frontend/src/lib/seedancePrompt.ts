import type { ChipRef, PromptPart } from "./promptEditor";

export function usesSeedanceMediaRefs(model: string): boolean {
  return model.startsWith("seedance");
}

export type SeedanceRefType = ChipRef["type"] | "audio";
export type SeedanceRefLike = { type: string };
export type SeedanceTokenKind = "image" | "start" | "end" | "video" | "audio";
export type SeedanceImageTokenKind = "image" | "start" | "end";
export type SeedanceTrayRole = "omni" | "start" | "end" | "video" | "audio";

// 토큰 번호는 "타입 그룹별 순번"이다: image N = N번째 이미지 ref, video N = N번째 비디오, audio N = N번째 오디오.
// 첫/끝 프레임(simage/eimage)은 이미지 그룹에 속하므로 image 맵에 start/end 역할로 담는다.
export interface SeedanceTokenRoles {
  image: Map<number, Set<SeedanceImageTokenKind>>;
  video: Set<number>;
  audio: Set<number>;
}

export function emptySeedanceTokenRoles(): SeedanceTokenRoles {
  return { image: new Map(), video: new Set(), audio: new Set() };
}

export function seedanceHasTokenRoles(roles: SeedanceTokenRoles): boolean {
  return roles.image.size > 0 || roles.video.size > 0 || roles.audio.size > 0;
}

function seedanceRefType(ref: SeedanceRefLike | undefined): SeedanceRefType | null {
  const type = ref?.type;
  if (type === "image" || type === "video" || type === "audio") return type;
  return null;
}

function addImageRole(roles: SeedanceTokenRoles, idx: number, kind: SeedanceImageTokenKind): void {
  const set = roles.image.get(idx) || new Set<SeedanceImageTokenKind>();
  set.add(kind);
  roles.image.set(idx, set);
}

export function seedanceTokenRoles(text: string): SeedanceTokenRoles {
  const roles = emptySeedanceTokenRoles();
  const re = /<<<\s*(simage|eimage|image|video|vedio|audio)\s*(\d+)\s*>>>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const rawKind = m[1].toLowerCase();
    const idx = Number(m[2]);
    if (!Number.isFinite(idx) || idx < 1) continue;
    if (rawKind === "simage") addImageRole(roles, idx, "start");
    else if (rawKind === "eimage") addImageRole(roles, idx, "end");
    else if (rawKind === "image") addImageRole(roles, idx, "image");
    else if (rawKind === "video" || rawKind === "vedio") roles.video.add(idx);
    else if (rawKind === "audio") roles.audio.add(idx);
  }
  return roles;
}

// 트레이 항목의 "타입별 순번"(뱃지 표시용) — 보이는 번호 = 프롬프트에 쓰는 번호.
export function seedanceTrayTypeIndex(trayRefs: SeedanceRefLike[], index: number): number {
  const targetType = seedanceRefType(trayRefs[index]);
  if (!targetType) return index + 1;
  let n = 0;
  for (let i = 0; i <= index && i < trayRefs.length; i++) {
    if (seedanceRefType(trayRefs[i]) === targetType) n += 1;
  }
  return n;
}

// 이미지 그룹 내 순번(1-based) — simage/eimage/image 토큰의 N 과 매칭하는 좌표.
export function seedanceImageGroupIndex(trayRefs: SeedanceRefLike[], index: number): number {
  let n = 0;
  for (let i = 0; i <= index && i < trayRefs.length; i++) {
    if (seedanceRefType(trayRefs[i]) === "image") n += 1;
  }
  return n;
}

export function seedanceTrayRole(
  trayRefs: SeedanceRefLike[],
  index: number,
  roles: SeedanceTokenRoles,
): SeedanceTrayRole {
  const type = seedanceRefType(trayRefs[index]);
  if (type === "video") return "video";
  if (type === "audio") return "audio";
  if (type !== "image") return "omni";
  const imageN = seedanceImageGroupIndex(trayRefs, index);
  const marked = roles.image.get(imageN);
  if (marked?.has("start")) return "start";
  if (marked?.has("end")) return "end";
  return "omni";
}

export function seedanceTrayBadge(role: SeedanceTrayRole): string {
  if (role === "start") return "S";
  if (role === "end") return "E";
  if (role === "video") return "V";
  if (role === "audio") return "A";
  return "O";
}

export function seedanceTrayBadgeTitle(role: SeedanceTrayRole): string {
  if (role === "start") return "첫 프레임";
  if (role === "end") return "끝 프레임";
  if (role === "video") return "비디오 레퍼런스";
  if (role === "audio") return "오디오 레퍼런스";
  return "옴니 레퍼런스";
}

function countRefsByType(trayRefs: SeedanceRefLike[], type: SeedanceRefType): number {
  return trayRefs.filter((ref) => seedanceRefType(ref) === type).length;
}

export function validateSeedanceTokenRoles(
  trayRefs: SeedanceRefLike[],
  roles: SeedanceTokenRoles,
): string | null {
  const imageCount = countRefsByType(trayRefs, "image");
  const videoCount = countRefsByType(trayRefs, "video");
  const audioCount = countRefsByType(trayRefs, "audio");
  let starts = 0;
  let ends = 0;
  for (const [idx, kinds] of roles.image) {
    if (idx > imageCount) return `이미지 레퍼런스 ${idx}번이 없습니다.`;
    if (kinds.has("start") && kinds.has("end")) {
      return `이미지 레퍼런스 ${idx}번을 첫 프레임과 끝 프레임으로 동시에 지정할 수 없습니다.`;
    }
    if ((kinds.has("start") || kinds.has("end")) && kinds.has("image")) {
      return `이미지 레퍼런스 ${idx}번은 옴니와 첫/끝 프레임 중 하나로만 지정해 주세요.`;
    }
    if (kinds.has("start")) starts += 1;
    if (kinds.has("end")) ends += 1;
  }
  for (const idx of roles.video) {
    if (idx > videoCount) return `비디오 레퍼런스 ${idx}번이 없습니다.`;
  }
  for (const idx of roles.audio) {
    if (idx > audioCount) return `오디오 레퍼런스 ${idx}번이 없습니다.`;
  }
  if (starts > 1) return "Seedance 시작 프레임은 1장만 지정할 수 있습니다.";
  if (ends > 1) return "Seedance 끝 프레임은 1장만 지정할 수 있습니다.";
  return null;
}

// 편집기 이미지 그룹 순번 → CLI omni 이미지 전용 순번(첫/끝 프레임은 --start/--end 로 빠지므로 제외).
export function seedanceOmniImageIndexMap(
  trayRefs: SeedanceRefLike[],
  roles: SeedanceTokenRoles,
): Map<number, number> {
  const map = new Map<number, number>();
  let imageN = 0;
  let omniN = 0;
  trayRefs.forEach((ref, index) => {
    if (seedanceRefType(ref) !== "image") return;
    imageN += 1;
    if (seedanceTrayRole(trayRefs, index, roles) === "omni") map.set(imageN, ++omniN);
  });
  return map;
}

// 편집기 비디오/오디오 순번 → CLI 순번(이미 타입별이라 항등).
export function seedanceVideoIndexMap(trayRefs: SeedanceRefLike[]): Map<number, number> {
  const map = new Map<number, number>();
  let videoN = 0;
  trayRefs.forEach((ref) => {
    if (seedanceRefType(ref) === "video") map.set(++videoN, videoN);
  });
  return map;
}

export function seedanceAudioIndexMap(trayRefs: SeedanceRefLike[]): Map<number, number> {
  const map = new Map<number, number>();
  let audioN = 0;
  trayRefs.forEach((ref) => {
    if (seedanceRefType(ref) === "audio") map.set(++audioN, audioN);
  });
  return map;
}

export function normalizeSeedancePromptTokens(
  text: string,
  imageIndexMap?: Map<number, number>,
  videoIndexMap?: Map<number, number>,
  audioIndexMap?: Map<number, number>,
): string {
  return text.replace(/<<<\s*(simage|eimage|image|video|vedio|audio)\s*(\d+)\s*>>>/gi, (_m, rawKind, n) => {
    const kind = String(rawKind).toLowerCase();
    const idx = Number(n);
    if (kind === "simage") return "첫 프레임";
    if (kind === "eimage") return "끝 프레임";
    if (kind === "image") return `<<<image${imageIndexMap?.get(idx) || n}>>>`;
    if (kind === "video" || kind === "vedio") return `<<<video${videoIndexMap?.get(idx) || n}>>>`;
    if (kind === "audio") return `<<<audio${audioIndexMap?.get(idx) || n}>>>`;
    return `<<<${kind}${n}>>>`;
  });
}

export function seedancePromptText(
  parts: PromptPart[],
  trayImageCount: number,
  imageIndexMap?: Map<number, number>,
  trayVideoCount = 0,
  videoIndexMap?: Map<number, number>,
  trayAudioCount = 0,
  audioIndexMap?: Map<number, number>,
): string {
  let imgN = trayImageCount;
  let videoN = trayVideoCount;
  let audioN = trayAudioCount;
  return parts
    .map((p) => {
      if (p.t === "text") return normalizeSeedancePromptTokens(p.v, imageIndexMap, videoIndexMap, audioIndexMap);
      const type = p.ref?.type as SeedanceRefType | undefined;
      if (type === "image") return `<<<image${++imgN}>>>`;
      if (type === "video") return `<<<video${++videoN}>>>`;
      if (type === "audio") return `<<<audio${++audioN}>>>`;
      return "";
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}
