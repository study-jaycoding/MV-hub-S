// 편집 공유(Jay 2026-10-23 — 서버에 저장 · 다른 편집 보기 · V0) — 내 화면의 재생 배치를 펼친 '보이는 것 한 줄'(스냅샷 v1)과, 받은 것을 다시 배치로.
//  규칙의 정본: docs/status/편집탭_편집공유_설계_2026-10-23.md(§1~2·§6). 서버의 같은 검사: backend/app/repo/edit_shares.py.
//  React·fetch 를 쓰지 않는다(sha256Hex 는 브라우저 crypto — 없으면 같은 계산의 JS sha256Js).
import { clipSpeed, folderOf, mediaAt, SPEED_MAX, SPEED_MIN, visibleSegments, type EditDoc, type EditLayout, type SlotClip } from "./editTimeline";

export type SharePart =
  | { len: number; gap: true }
  | { len: number; gap?: false; gen: string; job?: string; kind: "video" | "image"; head: number; speed?: number };
export interface ShareCut { name: string; folder: string; len: number; parts: SharePart[] }
export interface ShareSnapshot { v: 1; total: number; cuts: ShareCut[] }

export const SHARE_MAX = 256 * 1024; // 'ASCII 로 감싼 길이' 상한(서버와 같다)
export const TAIL_KEY = "//v0-tail"; // 재생용 빈 꼬리 자리 — 앞 폴더 부분이 비어 실제 자리 열쇠(validSlotKey)와 겹치지 않는다
const TOTAL_MAX = 6 * 3600;

// 지금 보이는 것을 펼친다 — 컷마다 visibleSegments(그 순간 맨 위에 보이는 것 하나씩), 조각 head = 그 조각 시작의 원본 시각. 키 순서를 고정해
//  만든다(JSON.stringify 가 넣은 순서대로 쓴다 — 보낸 글자가 hash 의 원천이다). 컷이 없으면 null(올릴 것이 없다).
export function shareSnapshot(layout: EditLayout, doc: EditDoc): ShareSnapshot | null {
  if (!layout.cuts.length) return null;
  const cuts = layout.cuts.map((slot): ShareCut => ({
    name: slot.name,
    folder: folderOf(slot.path),
    len: slot.len,
    parts: visibleSegments(doc, slot).map(({ from, to, clip }): SharePart => {
      if (!clip) return { len: to - from, gap: true };
      const speed = clipSpeed(clip);
      return {
        len: to - from, gen: clip.gen, ...(clip.job ? { job: clip.job } : {}), kind: clip.kind === "image" ? "image" : "video",
        head: mediaAt(clip, from), ...(speed !== 1 ? { speed } : {}),
      };
    }),
  }));
  return { v: 1, total: layout.total, cuts };
}

// 'ASCII 로 감싼 길이' = Python 의 len(json.dumps(text)) — 코드 포인트마다 0x20~0x7E = 1('"'·'\' = 2), \b\f\n\r\t = 2,
//  그 밖의 0x00~0x1F 와 0x7F = 6, 0x80~0xFFFF = 6, 보조 평면 = 12, 앞뒤 따옴표 +2. (UTF-16 단위가 아니라 코드 포인트로 센다)
export function asciiJsonLength(text: string): number {
  let length = 2;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code > 0xffff) length += 12;
    else if (code >= 0x80 || code === 0x7f) length += 6;
    else if (code === 0x22 || code === 0x5c || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) length += 2;
    else length += code < 0x20 ? 6 : 1;
  }
  return length;
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
// 글자 수 = 코드 포인트 수(Python len 과 같다 — UTF-16 단위인 .length 가 아니다)
const text = (value: unknown, limit: number) => typeof value === "string" && value.length > 0 && [...value].length <= limit;

// 받은 글자를 읽는다 — 서버와 같은 검사. 하나라도 틀리면 null(화면은 'V0 을 읽지 못함').
export function parseShareSnapshot(raw: string): ShareSnapshot | null {
  if (asciiJsonLength(raw) > SHARE_MAX) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  const snap = doc as Partial<ShareSnapshot> | null;
  const total = num(snap?.total);
  if (!snap || typeof snap !== "object" || snap.v !== 1 || total === null || total <= 0 || total > TOTAL_MAX
    || !Array.isArray(snap.cuts) || !snap.cuts.length || snap.cuts.length > 2000) return null;
  let cutSum = 0;
  for (const cut of snap.cuts) {
    const len = num(cut?.len);
    if (!cut || !text(cut.name, 200) || !text(cut.folder, 1000) || len === null || len <= 0
      || !Array.isArray(cut.parts) || !cut.parts.length || cut.parts.length > 64) return null;
    let partSum = 0;
    for (const part of cut.parts as Record<string, unknown>[]) {
      const span = num(part?.len);
      if (span === null || span <= 0) return null;
      if (part.gap !== true) {
        const head = num(part.head);
        const speed = part.speed === undefined ? 1 : num(part.speed);
        if (!text(part.gen, 200) || (part.job !== undefined && part.job !== null && !text(part.job, 200))
          || (part.kind !== "video" && part.kind !== "image") || head === null || head < 0
          || speed === null || speed < SPEED_MIN - 1e-9 || speed > SPEED_MAX + 1e-9) return null;
      }
      partSum += span;
    }
    if (Math.abs(partSum - len) > 1e-6) return null;
    cutSum += len;
  }
  return Math.abs(cutSum - total) > 1e-6 ? null : (snap as ShareSnapshot);
}

// 받은 것을 재생용 배치로 — **조각마다 자리 하나**(열쇠 '<컷>:<조각>' — 같은 폴더가 여러 번 나와도, 같은 영상이 두 조각에 있어도 겹치지 않는다).
//  클립의 head·speed·len 은 받은 값 그대로(clipHead·clipLen 으로 다시 반올림하지 않는다) — useEditFollow 의 head + 자리 안 시각 × speed 가
//  곧 '조각 head + (컷 안 시각 − 조각 시작) × speed' 다. 실제 폴더·gen·job 은 parts 표로 따로(V0 링크가 본다). boxes = 그리기용 컷 상자.
export interface ShareLayout {
  layout: EditLayout;
  parts: Map<string, { folder: string; gen: string; job?: string }>;
  boxes: { index: number; name: string; start: number; len: number; keys: string[] }[];
}
export function shareLayout(snap: ShareSnapshot): ShareLayout {
  const cuts: EditLayout["cuts"] = [];
  const parts: ShareLayout["parts"] = new Map();
  const boxes: ShareLayout["boxes"] = [];
  let start = 0;
  snap.cuts.forEach((cut, index) => {
    const box = { index, name: cut.name, start, len: cut.len, keys: [] as string[] };
    cut.parts.forEach((part, at) => {
      const key = `${index}:${at}`;
      const clips: SlotClip[] = [];
      if (part.gap !== true) { // 검사와 같은 기준 — gap: false 는 영상·그림 조각이다
        const speed = part.speed ?? 1;
        clips.push({
          cut: key, gen: part.gen, ...(part.job ? { job: part.job } : {}), track: 1, kind: part.kind, ...(speed !== 1 ? { speed } : {}),
          len: part.len, full: part.head + part.len * speed, head: part.head,
        });
        parts.set(key, { folder: cut.folder, gen: part.gen, ...(part.job ? { job: part.job } : {}) });
      }
      cuts.push({ path: key, name: cut.name, start, len: part.len, clips });
      box.keys.push(key);
      start += part.len;
    });
    boxes.push(box);
  });
  return { layout: { cuts, total: snap.total, tracks: 1 }, parts, boxes };
}

// 재생용 배치 — 내 배치 뒤에 클립 없는 꼬리 자리를 붙여 끝을 total 까지 늘린다(다른 편집 보기 중 V0 이 더 길 때). 짧으면 그대로.
//  내 편집이 비어 있으면 꼬리 자리 하나. 엔진·타임라인 폭·눈금·End·전체 보기에만 쓴다(설계 §6).
export function withTail(layout: EditLayout, total: number): EditLayout {
  if (!(total > layout.total + 1e-9)) return layout;
  return { ...layout, cuts: [...layout.cuts, { path: TAIL_KEY, name: "", start: layout.total, len: total - layout.total, clips: [] }], total };
}

// 보낸 글자의 SHA-256(서버 data_hash 와 같은 값 — UTF-8 바이트). 라임 판정은 이것과 서버가 확인해 준 hash 를 견준다.
//  공유 서버에 http LAN 주소로 바로 붙은 화면은 보안 문맥이 아니라 crypto.subtle 이 없다 — 그때는 같은 계산을 JS 로 한다(거부하지 않는다).
export async function sha256Hex(raw: string): Promise<string> {
  const bytes = new TextEncoder().encode(raw);
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) return [...new Uint8Array(await subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    // 아래 JS 계산으로
  }
  return sha256Js(bytes);
}

const K = Uint32Array.of(
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
);
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
// FIPS 180-4 SHA-256 — sha256Hex 의 보안 문맥 밖 대신(같은 값인지는 시험이 표준 값·crypto.subtle 과 견준다)
export function sha256Js(bytes: Uint8Array): string {
  const words = ((bytes.length + 9 + 63) >> 6) << 4; // 64바이트 블록 × 16 낱말
  const m = new Uint32Array(words);
  bytes.forEach((byte, i) => { m[i >> 2] |= byte << (24 - (i & 3) * 8); });
  m[bytes.length >> 2] |= 0x80 << (24 - (bytes.length & 3) * 8);
  m[words - 2] = Math.floor(bytes.length / 0x20000000); // 비트 길이의 위 32비트
  m[words - 1] = bytes.length * 8; // 아래 32비트(Uint32Array 가 2^32 로 자른다)
  const h = Uint32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19);
  const w = new Uint32Array(64);
  for (let at = 0; at < words; at += 16) {
    for (let t = 0; t < 64; t++) {
      w[t] = t < 16 ? m[at + t]
        : w[t - 16] + (rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3)) + w[t - 7] + (rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10));
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let t = 0; t < 64; t++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      [k, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0];
    }
    [a, b, c, d, e, f, g, k].forEach((value, i) => { h[i] += value; });
  }
  return [...h].map((value) => value.toString(16).padStart(8, "0")).join("");
}
