import type { ChipRef, PromptPart } from "./promptEditor";

export function usesSeedanceMediaRefs(model: string): boolean {
  return model.startsWith("seedance");
}

export type SeedanceTokenKind = "image" | "start" | "end" | "video" | "audio";
export type SeedanceTrayRole = "omni" | "start" | "end" | "video";
export type SeedanceTokenRoles = Map<number, Set<SeedanceTokenKind>>;

export function seedanceTokenRoles(text: string): SeedanceTokenRoles {
  const roles: SeedanceTokenRoles = new Map();
  const re = /<<<\s*(simage|eimage|image|video|vedio|audio)\s*(\d+)\s*>>>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const rawKind = m[1].toLowerCase();
    const idx = Number(m[2]);
    if (!Number.isFinite(idx) || idx < 1) continue;
    const kind: SeedanceTokenKind =
      rawKind === "simage"
        ? "start"
        : rawKind === "eimage"
          ? "end"
          : rawKind === "vedio"
            ? "video"
            : (rawKind as SeedanceTokenKind);
    const set = roles.get(idx) || new Set<SeedanceTokenKind>();
    set.add(kind);
    roles.set(idx, set);
  }
  return roles;
}

export function seedanceTrayRole(
  ref: Pick<ChipRef, "type">,
  index: number,
  roles: SeedanceTokenRoles,
): SeedanceTrayRole {
  const marked = roles.get(index + 1);
  if (ref.type === "video") return "video";
  if (marked?.has("start")) return "start";
  if (marked?.has("end")) return "end";
  return "omni";
}

export function seedanceTrayBadge(role: SeedanceTrayRole): string {
  if (role === "start") return "S";
  if (role === "end") return "E";
  if (role === "video") return "V";
  return "O";
}

export function seedanceTrayBadgeTitle(role: SeedanceTrayRole): string {
  if (role === "start") return "첫 프레임";
  if (role === "end") return "끝 프레임";
  if (role === "video") return "비디오 레퍼런스";
  return "옴니 레퍼런스";
}

export function validateSeedanceTokenRoles(
  trayRefs: Array<Pick<ChipRef, "type">>,
  roles: SeedanceTokenRoles,
): string | null {
  let starts = 0;
  let ends = 0;
  for (const [idx, kinds] of roles) {
    const ref = trayRefs[idx - 1];
    if (!ref) return `Seedance 레퍼런스 ${idx}번이 트레이에 없습니다.`;
    if (kinds.has("audio")) {
      return "audio 토큰은 아직 트레이/에셋 타입 확장이 필요합니다. 우선 image/video 레퍼런스로 생성해 주세요.";
    }
    const usesImageToken = kinds.has("image") || kinds.has("start") || kinds.has("end");
    if (usesImageToken && ref.type !== "image") {
      return `${idx}번 레퍼런스는 이미지가 아니어서 image/simage/eimage 토큰으로 쓸 수 없습니다.`;
    }
    if (kinds.has("video") && ref.type !== "video") {
      return `${idx}번 레퍼런스는 비디오가 아니어서 video 토큰으로 쓸 수 없습니다.`;
    }
    if (kinds.has("start") && kinds.has("end")) {
      return `${idx}번 레퍼런스를 첫 프레임과 끝 프레임으로 동시에 지정할 수 없습니다.`;
    }
    if ((kinds.has("start") || kinds.has("end")) && kinds.has("image")) {
      return `${idx}번 레퍼런스는 옴니와 첫/끝 프레임 중 하나로만 지정해 주세요.`;
    }
    if (ref.type === "image") {
      const role = seedanceTrayRole(ref, idx - 1, roles);
      if (role === "start") starts += 1;
      if (role === "end") ends += 1;
    }
  }
  if (starts > 1) return "Seedance 시작 프레임은 1장만 지정할 수 있습니다.";
  if (ends > 1) return "Seedance 끝 프레임은 1장만 지정할 수 있습니다.";
  return null;
}

export function seedanceOmniImageIndexMap(
  trayRefs: Array<Pick<ChipRef, "type">>,
  roles: SeedanceTokenRoles,
): Map<number, number> {
  const map = new Map<number, number>();
  let n = 0;
  trayRefs.forEach((ref, i) => {
    if (ref.type === "image" && seedanceTrayRole(ref, i, roles) === "omni") {
      map.set(i + 1, ++n);
    }
  });
  return map;
}

export function seedanceVideoIndexMap(trayRefs: Array<Pick<ChipRef, "type">>): Map<number, number> {
  const map = new Map<number, number>();
  let n = 0;
  trayRefs.forEach((ref, i) => {
    if (ref.type === "video") map.set(i + 1, ++n);
  });
  return map;
}

export function normalizeSeedancePromptTokens(
  text: string,
  imageIndexMap?: Map<number, number>,
  videoIndexMap?: Map<number, number>,
): string {
  return text.replace(/<<<\s*(simage|eimage|image|video|vedio|audio)\s*(\d+)\s*>>>/gi, (_m, rawKind, n) => {
    const kind = String(rawKind).toLowerCase();
    if (kind === "simage") return "첫 프레임";
    if (kind === "eimage") return "끝 프레임";
    if (kind === "image") return `<<<image${imageIndexMap?.get(Number(n)) || n}>>>`;
    if (kind === "video" || kind === "vedio") return `<<<video${videoIndexMap?.get(Number(n)) || n}>>>`;
    return `<<<${kind}${n}>>>`;
  });
}

export function seedancePromptText(
  parts: PromptPart[],
  trayImageCount: number,
  imageIndexMap?: Map<number, number>,
  trayVideoCount = 0,
  videoIndexMap?: Map<number, number>,
): string {
  let imgN = trayImageCount;
  let videoN = trayVideoCount;
  return parts
    .map((p) => {
      if (p.t === "text") return normalizeSeedancePromptTokens(p.v, imageIndexMap, videoIndexMap);
      if (p.ref?.type === "image") return `<<<image${++imgN}>>>`;
      if (p.ref?.type === "video") return `<<<video${++videoN}>>>`;
      return "";
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}
