// 영상 파일 머리(MP4/MOV — moov → 영상 trak → stsd 항목)에서 코덱·크기·profile·bit depth 를 읽는다(ffmpeg 없이).
//  수정 창이 Kling 영상 수정에 보낼 원본을 미리 알리는 데만 쓴다 — 같은 정책의 실제 판단·변환은 작업자 PC 의
//  에이전트(agent_push._kling_video_verdict)가 create 직전에 한다. 내용(mdat)은 읽지 않고 상자 머리만 잘라 읽는다.
//  설계·합의: docs/status/Kling_영상수정_코덱변환_2026-10-28.md
export interface VideoFormat { codec: string; width: number; height: number; profile: number | null; bitDepth: number | null }
/** 로컬 정책(보장 아님): skip = 변환 생략 후보 · convert / out_of_range = 변환 대상(해상도 범위 밖이면 out_of_range) · unknown = 판별 불가 */
export type KlingVerdict = "skip" | "convert" | "out_of_range" | "unknown";

// agent_push.py 의 _KLING_* 와 같은 값 — 10-28 유료 실측 + 제3자 문서(720p~2160p). profile 로 8비트 4:2:0 을 미루어 볼 뿐(휴리스틱).
const KLING_H264_PROFILES = new Set([66, 77, 88, 100]); // Baseline·Main·Extended·High
const KLING_SHORT_SIDE = [720, 2160] as const;
const MAX_BOXES = 512; // 한 단계에서 훑는 상자 수 상한 — 깨진 파일에서 끝없이 돌지 않게
export const KLING_VIDEO_EDIT_MODELS = new Set(["kling_video_edit", "kling4_0"]);

type Box = { kind: string; body: number; end: number };
const view = async (blob: Blob, start: number, end: number) => new DataView(await blob.slice(start, end).arrayBuffer());
const fourcc = (v: DataView, at: number) => String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));

/** [start, end) 안의 상자 머리들. 크기가 부모를 벗어나거나 잘렸거나 상자가 너무 많으면 null(판별 불가). */
async function boxes(blob: Blob, start: number, end: number): Promise<Box[] | null> {
  const out: Box[] = [];
  for (let pos = start; pos < end;) {
    if (out.length >= MAX_BOXES || pos + 8 > end) return null;
    const head = await view(blob, pos, pos + 8); // 머리 8바이트만 — 확장 크기일 때만 8바이트 더(내용은 읽지 않는다)
    if (head.byteLength < 8) return null;
    let size = head.getUint32(0);
    let body = pos + 8;
    if (size === 1) {
      if (pos + 16 > end) return null;
      const ext = await view(blob, pos + 8, pos + 16);
      if (ext.byteLength < 8) return null;
      size = Number(ext.getBigUint64(0));
      body = pos + 16;
    } else if (size === 0) size = end - pos;
    if (size < body - pos || pos + size > end) return null;
    out.push({ kind: fourcc(head, 4), body, end: pos + size });
    pos += size;
  }
  return out;
}
/** box 안에서 kind 상자 하나 — 없거나 둘 이상이면 undefined. */
async function only(blob: Blob, box: Box | undefined, kind: string) {
  const found = box ? ((await boxes(blob, box.body, box.end)) ?? []).filter((b) => b.kind === kind) : [];
  return found.length === 1 ? found[0] : undefined;
}

/** 영상 trak·stsd 항목이 정확히 하나일 때만 읽는다(ffmpeg 의 0:v:0 와 같은 것). 못 읽으면 null — 창을 깨뜨리지 않는다.
 *  어느 trak 이든 mdia·hdlr 을 못 읽으면(소리 trak 이라도) null — 깨진 trak 이 영상인지 모르므로. */
export async function probeVideoFormat(blob: Blob): Promise<VideoFormat | null> {
  try {
    const moovs = ((await boxes(blob, 0, blob.size)) ?? []).filter((b) => b.kind === "moov");
    if (moovs.length !== 1) return null;
    const videos: Box[] = [];
    for (const trak of ((await boxes(blob, moovs[0].body, moovs[0].end)) ?? []).filter((b) => b.kind === "trak")) {
      const mdia = await only(blob, trak, "mdia");
      const hdlr = await only(blob, mdia, "hdlr");
      if (!mdia || !hdlr || hdlr.end - hdlr.body < 12) return null;
      if (fourcc(await view(blob, hdlr.body + 8, hdlr.body + 12), 0) === "vide") videos.push(mdia);
    }
    if (videos.length !== 1) return null;
    const stsd = await only(blob, await only(blob, await only(blob, videos[0], "minf"), "stbl"), "stsd");
    if (!stsd || stsd.end - stsd.body < 8 + 86 || (await view(blob, stsd.body + 4, stsd.body + 8)).getUint32(0) !== 1) return null;
    const entry = stsd.body + 8;
    const head = await view(blob, entry, entry + 86);
    const size = head.getUint32(0);
    if (size < 86 || entry + size > stsd.end) return null;
    const info: VideoFormat = { codec: fourcc(head, 4), width: head.getUint16(32), height: head.getUint16(34), profile: null, bitDepth: null };
    const avc = info.codec === "avc1" || info.codec === "avc3";
    const children = await boxes(blob, entry + 86, entry + size);
    if (!children) return null; // 표본 항목 안 상자가 깨졌으면 판별 불가(설정 상자가 없는 것과 다르다)
    const config = children.filter((b) => b.kind === (avc ? "avcC" : "hvcC"));
    if (config.length === 1) {
      const raw = await view(blob, config[0].body, Math.min(config[0].end, config[0].body + 32));
      if (avc && raw.byteLength >= 2) info.profile = raw.getUint8(1);
      else if (!avc && raw.byteLength >= 19) {
        info.profile = raw.getUint8(1) & 0x1f;
        info.bitDepth = (raw.getUint8(17) & 0x07) + 8;
      }
    }
    return info;
  } catch {
    return null;
  }
}

export function klingVideoVerdict(info: VideoFormat | null): KlingVerdict {
  if (!info || !info.width || !info.height) return "unknown";
  const short = Math.min(info.width, info.height);
  if (short < KLING_SHORT_SIDE[0] || short > KLING_SHORT_SIDE[1]) return "out_of_range";
  return (info.codec === "avc1" || info.codec === "avc3") && info.profile != null && KLING_H264_PROFILES.has(info.profile) ? "skip" : "convert";
}
