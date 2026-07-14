import type { ChipRef, PromptPart } from "./promptEditor";

export function usesSeedanceMediaRefs(model: string): boolean {
  return model.startsWith("seedance");
}

// 레퍼런스 토큰(<<<imageN>>> · @imageN)을 쓰는 모델인가 — 현재 이미지·영상 모델 전부 레퍼런스를 쓴다.
// 이 게이트는 '알약 시각화·@피커·클릭편집·자동 알약화·기본 정규화'를 켠다(이미지 모델도 포함).
// seedance 전용 로직(시작/끝 프레임·검증·역할 배지·번호 remapping)은 usesSeedanceMediaRefs 로 별도 게이트.
// 알약은 제출 시 <<<imageN>>> 원형으로 정규화돼 CLI 로 나가므로 어느 모델이든 왕복이 바이트 단위로 안전하다.
export function usesMediaRefTokens(model: string): boolean {
  return !!model;
}

// 이 텍스트가 레퍼런스 토큰(<<<imageN>>> · @imageN)을 담고 있나 — 재사용 시 '트레이-토큰 방식' 생성물을
// 가려내는 데 쓴다(토큰이 있으면 레퍼런스를 트레이로, 없으면 인라인 소스칩으로 복원).
export function hasMediaRefTokens(text: string): boolean {
  return new RegExp(SEEDANCE_TOKEN_SRC, "i").test(text || "");
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

// 트레이 레퍼런스 토큰 — 두 문법 + 선택 언더바를 모두 인식한다:
//   · <<<image1>>> / <<<image_1>>> (공백 허용)   · @image1 / @image_1 (붙여쓰기)
// 그룹1/2 = <<<>>> 형태(kind, num), 그룹3/4 = @ 형태(kind, num). 둘 다 제출 시 CLI용 <<<>>> 로 정규화된다.
// @ 형태는 앞뒤 경계를 둔다: 앞이 영문/숫자/밑줄이면 토큰 아님(예: foo@image1 은 이메일 등으로 오인 방지),
// 뒤에 영문/숫자/밑줄이 붙어도 토큰 아님(@image1x, @image1_ 거절).
export const SEEDANCE_TOKEN_SRC =
  "<<<\\s*(simage|eimage|image|video|vedio|audio)\\s*_?\\s*(\\d+)\\s*>>>" +
  "|(?<![A-Za-z0-9_])@(simage|eimage|image|video|vedio|audio)_?(\\d+)(?![A-Za-z0-9_])";

// 토큰 원종류 → 색/아이콘용 분류(이미지/시작/끝/비디오/오디오).
export function seedanceAtTokenKind(raw: string): "image" | "start" | "end" | "video" | "audio" {
  const k = raw.toLowerCase();
  if (k === "simage") return "start";
  if (k === "eimage") return "end";
  if (k === "video" || k === "vedio") return "video";
  if (k === "audio") return "audio";
  return "image";
}

// 알약 표시/삽입용 정규 토큰(@kindN) — <<<>>>·언더바·vedio 오타를 @image1 형태로 통일(둘 다 like @).
export function seedanceCanonToken(raw: string, n: string | number): string {
  const k = raw.toLowerCase();
  return "@" + (k === "vedio" ? "video" : k) + n;
}

export function seedanceTokenRoles(text: string): SeedanceTokenRoles {
  const roles = emptySeedanceTokenRoles();
  const re = new RegExp(SEEDANCE_TOKEN_SRC, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const rawKind = (m[1] || m[3]).toLowerCase();
    const idx = Number(m[2] || m[4]);
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

// 트레이 항목을 가리키는 @ 토큰 문자열(@image1 / @video1 / @audio1) — @ 피커에서 항목을 고르면 이걸
// 프롬프트에 넣는다(<<<imageN>>> 과 동일하게 해석됨). 번호 = 뱃지에 보이는 타입별 순번.
export function seedanceTrayToken(trayRefs: SeedanceRefLike[], index: number): string {
  const type = seedanceRefType(trayRefs[index]);
  const n = seedanceTrayTypeIndex(trayRefs, index);
  const kind = type === "video" ? "video" : type === "audio" ? "audio" : "image";
  return `@${kind}${n}`;
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
  return text.replace(new RegExp(SEEDANCE_TOKEN_SRC, "gi"), (_m, k1, n1, k2, n2) => {
    const kind = String(k1 || k2).toLowerCase();
    const n = n1 || n2; // <<<>>> 또는 @ 어느 형태든 같은 CLI 토큰(<<<>>>)으로 출력
    const idx = Number(n);
    if (kind === "simage") return "첫 프레임";
    if (kind === "eimage") return "끝 프레임";
    if (kind === "image") return `<<<image${imageIndexMap?.get(idx) || n}>>>`;
    if (kind === "video" || kind === "vedio") return `<<<video${videoIndexMap?.get(idx) || n}>>>`;
    if (kind === "audio") return `<<<audio${audioIndexMap?.get(idx) || n}>>>`;
    return `<<<${kind}${n}>>>`;
  });
}

// 비-seedance 모델용 단순 정규화 — @imageN·<<<image_N>>> 등을 CLI 용 <<<kindN>>> 원형으로만 바꾼다.
// 번호 remapping·시작/끝 프레임(simage/eimage) 개념은 seedance 전용이라 여기선 image 로 취급한다.
// 알약이 @imageN 으로 serialize 돼도 이 정규화로 <<<imageN>>> 이 나가므로, 손으로 <<<imageN>>> 을 친 경우와
// 바이트 단위로 동일한 CLI 프롬프트가 된다(생성 영향 0).
export function normalizeMediaRefTokensBasic(text: string): string {
  return text.replace(new RegExp(SEEDANCE_TOKEN_SRC, "gi"), (_m, k1, n1, k2, n2) => {
    const raw = String(k1 || k2).toLowerCase();
    const n = n1 || n2;
    const kind = raw === "vedio" ? "video" : raw === "simage" || raw === "eimage" ? "image" : raw;
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
    // ★CLI 프롬프트는 한 줄이어야 한다 — 줄바꿈이 들어가면 Higgsfield 가 레퍼런스(입력 이미지)를 못 붙인다(실측).
    //  줄바꿈 보존은 display_prompt(partsDisplay)에서만. 여기서 접어야 생성이 정상 동작한다.
    .replace(/\s+/g, " ")
    .trim();
}
