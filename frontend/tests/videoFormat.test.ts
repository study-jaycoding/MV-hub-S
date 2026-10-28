// Kling 영상 수정 미리 알림 — MP4 머리 읽기(에이전트 agent_push._probe_video_format 과 같은 경계 사례·같은 결과,
//  backend/tests/test_agent_kling_video_convert.py 와 짝). 설계: docs/status/Kling_영상수정_코덱변환_2026-10-28.md
import { describe, expect, it } from "vitest";
import { klingVideoVerdict, probeVideoFormat } from "../src/lib/videoFormat";

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >>> 8) & 255, n & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const zeros = (n: number) => new Array<number>(n).fill(0);
const box = (kind: string, payload: number[] = []) => [...u32(8 + payload.length), ...ascii(kind), ...payload];
const bigBox = (kind: string, payload: number[]) => [...u32(1), ...ascii(kind), ...u32(0), ...u32(16 + payload.length), ...payload];

function mp4({ codec = "hvc1", width = 854, height = 480, profile = 2, bitDepth = 10, moovLast = false, videoTraks = 1, entries = 1,
  largeMoov = false, openMdat = false, badConfig = false, badAudioTrak = false }: { codec?: string; width?: number; height?: number;
  profile?: number; bitDepth?: number; moovLast?: boolean; videoTraks?: number; entries?: number; largeMoov?: boolean;
  openMdat?: boolean; badConfig?: boolean; badAudioTrak?: boolean } = {}) {
  const avc = codec === "avc1" || codec === "avc3";
  const config = avc ? box("avcC", [1, profile, 0, 31, 0xff, 0xe1])
    : box("hvcC", [1, profile & 0x1f, ...zeros(15), 0xf8 | (bitDepth - 8), 0xf8 | (bitDepth - 8), ...zeros(4)]);
  if (badConfig) config.splice(0, 4, ...u32(config.length + 100)); // 설정 상자 크기가 항목 밖까지 — 판별 불가여야 한다
  const entryBody = [...zeros(24), ...u16(width), ...u16(height), ...zeros(50), ...config];
  const entry = [...u32(8 + entryBody.length), ...ascii(codec), ...entryBody];
  const stsd = box("stsd", [...zeros(4), ...u32(entries), ...Array.from({ length: entries }, () => entry).flat()]);
  const trak = (handler: string, sample: number[]) =>
    box("trak", box("mdia", [...box("hdlr", [...zeros(8), ...ascii(handler), ...zeros(12)]), ...box("minf", box("stbl", sample))]));
  const traks = badAudioTrak // 소리 trak 의 hdlr 크기가 mdia 밖까지 — 영상 trak 이 멀쩡해도 판별 불가여야 한다
    ? [...box("trak", box("mdia", [...u32(999), ...ascii("hdlr"), ...zeros(8)]))]
    : [...trak("soun", box("stsd", zeros(8)))]; // 소리 trak 이 먼저
  for (let i = 0; i < videoTraks; i++) traks.push(...trak("vide", stsd));
  const moov = largeMoov ? bigBox("moov", traks) : box("moov", traks);
  const head = box("ftyp", [...ascii("isom"), ...zeros(4), ...ascii("isomavc1")]);
  if (openMdat) return new Blob([new Uint8Array([...head, ...moov, ...u32(0), ...ascii("mdat"), ...zeros(64)])]); // 크기 0 = 끝까지
  const mdat = box("mdat", zeros(64));
  return new Blob([new Uint8Array([...head, ...(moovLast ? [...mdat, ...moov] : [...moov, ...mdat])])]);
}

describe("probeVideoFormat · klingVideoVerdict", () => {
  it.each([
    [{}, "out_of_range"], // 앱의 Seedance 2.5 결과(HEVC 10비트 854×480)
    [{ codec: "avc1", width: 1280, height: 720, profile: 100 }, "skip"],
    [{ codec: "avc3", width: 720, height: 1280, profile: 77 }, "skip"], // 세로 — 짧은 변 720
    [{ codec: "avc1", width: 1920, height: 1080, profile: 110 }, "convert"], // High10
    [{ codec: "hvc1", width: 1920, height: 1080, profile: 1, bitDepth: 8 }, "convert"],
    [{ codec: "avc1", width: 4096, height: 2304, profile: 100 }, "out_of_range"],
    [{ moovLast: true }, "out_of_range"], // 머리가 파일 끝에 있어도
    [{ largeMoov: true }, "out_of_range"], // 64비트 크기 상자
    [{ openMdat: true }, "out_of_range"], // 크기 0(끝까지) 상자
  ] as const)("%o → %s", async (opts, verdict) => {
    expect(klingVideoVerdict(await probeVideoFormat(mp4(opts)))).toBe(verdict);
  });

  it("코덱·크기·profile·bit depth 를 읽는다", async () => {
    expect(await probeVideoFormat(mp4())).toEqual({ codec: "hvc1", width: 854, height: 480, profile: 2, bitDepth: 10 });
  });

  it("영상 trak 둘·stsd 항목 둘·잘린 상자·범위 밖 크기·영상 아님은 판별 불가(null)", async () => {
    expect(await probeVideoFormat(mp4({ videoTraks: 2 }))).toBeNull();
    expect(await probeVideoFormat(mp4({ entries: 2 }))).toBeNull();
    const whole = new Uint8Array(await mp4().arrayBuffer());
    expect(await probeVideoFormat(new Blob([whole.slice(0, whole.length - 70)]))).toBeNull(); // 잘림
    expect(await probeVideoFormat(mp4({ badConfig: true }))).toBeNull(); // 설정 상자 깨짐 — '범위 밖'이 아니라 판별 불가
    // 깨진 소리 trak — 영상 trak 이 'skip' 이어도 판별 불가
    expect(await probeVideoFormat(mp4({ codec: "avc1", width: 1280, height: 720, profile: 100, badAudioTrak: true }))).toBeNull();
    expect(await probeVideoFormat(new Blob([new Uint8Array([...u32(999), ...ascii("moov")])]))).toBeNull();
    expect(await probeVideoFormat(new Blob(["not a video"]))).toBeNull();
    expect(await probeVideoFormat(new Blob([]))).toBeNull();
    expect(klingVideoVerdict(null)).toBe("unknown");
  });

  it.each([{}, { moovLast: true }, { openMdat: true }, { largeMoov: true }])("상자 머리만 읽고 mdat 내용은 읽지 않는다 %o", async (opts) => {
    const blob = mp4(opts);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const at = bytes.findIndex((_, i) => String.fromCharCode(...bytes.slice(i, i + 4)) === "mdat") - 4;
    const end = opts.openMdat ? bytes.length : at + new DataView(bytes.buffer).getUint32(at);
    const reads: [number, number][] = [];
    const recording = { size: blob.size, slice: (s: number, e: number) => (reads.push([s, Math.min(e, blob.size)]), blob.slice(s, e)) };
    expect(await probeVideoFormat(recording as unknown as Blob)).not.toBeNull();
    expect(reads.filter(([s, e]) => s < end && at + 8 < e)).toEqual([]);
  });
});
