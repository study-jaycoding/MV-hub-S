import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createEditArchive, createRecoveryArchive, knownDocEquals, MAX_ARCHIVE_BYTES, parseEditArchive, utf8Bytes } from "../src/lib/editArchive";
import { emptyEditDoc, parseEditDoc, type EditDoc } from "../src/lib/editTimeline";

const target = { projectId: "project", seq: "seq" };
const fullDoc = (): EditDoc => ({
  v: 1, clips: [{ cut: "seq/a", gen: "g", job: "j", track: 2, off: true, dur: 12, durExact: true, kind: "video", trim: 4, head: 2 }],
  tracksOff: [1], tracksLocked: [2], muted: true, cutsOn: ["seq/a"], cutsOff: ["seq/b"], hideOff: true,
  tracks: 4, trackColors: { 1: "#123456", 128: "#ABCDEF" }, markIn: { cut: "seq/a", local: 0 },
  markOut: { cut: "seq/b", local: 8 }, markers: [{ cut: "seq/b", local: 2, color: "#987654", name: "표시" }], cutOrder: ["seq/b", "seq/a"],
});
const readDoc = (doc: unknown) => parseEditArchive(JSON.stringify({ ...createEditArchive(emptyEditDoc(), target, false), docRaw: JSON.stringify(doc) }), target);
const readEnvelope = (patch: Record<string, unknown>) => parseEditArchive(JSON.stringify({ ...createEditArchive(fullDoc(), target, true), ...patch }), target);

describe("edit archive contract", () => {
  it("keeps external-file validation separate from storage, networking and UI", () => {
    const source = readFileSync(new URL("../src/lib/editArchive.ts", import.meta.url), "utf8");
    expect([...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1])).toEqual(["./editTimeline"]);
    expect(source).not.toMatch(/\b(?:fetch|localStorage|sessionStorage|document|window)\s*[.(]/);
  });
  it("round trips every current field, unsaved state and display-only projectName", () => {
    const result = readEnvelope({ projectName: "이름", snapshotKind: "stored" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc).toEqual(parseEditDoc(fullDoc()));
    expect(result.archive).toMatchObject({ projectName: "이름", snapshotKind: "stored", unsaved: true });
    expect(createEditArchive(fullDoc(), target, true).docRaw).toBe(JSON.stringify(fullDoc()));
  });
  it("accepts empty documents and marker-only documents", () => {
    expect(readDoc(emptyEditDoc()).ok).toBe(true);
    expect(readDoc({ ...emptyEditDoc(), markers: [{ cut: "seq/a", local: 0 }] }).ok).toBe(true);
  });
  it.each(["{", "null", "[]", JSON.stringify(emptyEditDoc())])("rejects invalid JSON or an unwrapped document: %s", (text) => {
    expect(parseEditArchive(text, target).ok).toBe(false);
  });
  it.each([
    { format: "other" }, { schemaVersion: 0 }, { schemaVersion: 2 }, { schemaVersion: undefined },
    { exportedAt: undefined }, { exportedAt: "yesterday" }, { exportedAt: "2026-02-30T00:00:00.000Z" },
    { exportedAt: "2026-10-17T24:00:00Z" }, { projectId: "other" }, { seq: "other" },
    { snapshotKind: "other" }, { snapshotKind: undefined }, { unsaved: 1 }, { unsaved: undefined },
    { docRaw: {} }, { projectName: 1 }, { projectName: "n".repeat(1025) }, { unknown: true },
  ])("rejects invalid envelope %j", (patch) => expect(readEnvelope(patch).ok).toBe(false));
  it.each(["projectId", "seq"] as const)("checks %s length even when target matches", (field) => {
    const longTarget = { ...target, [field]: "x".repeat(field === "projectId" ? 257 : 2049) };
    expect(parseEditArchive(JSON.stringify(createEditArchive(emptyEditDoc(), longTarget, false)), longTarget).ok).toBe(false);
  });
  it("accepts ISO timestamps with valid offsets and rejects invalid calendar days", () => {
    expect(readEnvelope({ exportedAt: "2024-02-29T12:00:00+09:00" }).ok).toBe(true);
    expect(readEnvelope({ exportedAt: "2025-02-29T12:00:00Z" }).ok).toBe(false);
  });
  it.each(["document", "clip", "marker", "markIn", "markOut", "trackColors", "envelope", "recovery"])("rejects unknown/unsafe own keys at %s", (level) => {
    for (const key of ["extra", "__proto__", "constructor", "prototype"]) {
      const doc = fullDoc();
      const archive = createEditArchive(doc, target, false);
      const recovery = JSON.parse(createRecoveryArchive(target, archive, null, false));
      const destinations: Record<string, object> = {
        document: doc, clip: doc.clips[0], marker: doc.markers![0], markIn: doc.markIn!, markOut: doc.markOut!, trackColors: doc.trackColors!, envelope: archive, recovery,
      };
      Object.defineProperty(destinations[level], key, { value: true, enumerable: true });
      archive.docRaw = JSON.stringify(doc);
      expect(parseEditArchive(JSON.stringify(level === "recovery" ? recovery : archive), target).ok, `${level}.${key}`).toBe(false);
    }
  });
  it.each(["clips", "markers", "markIn", "markOut", "cutsOn", "cutsOff", "cutOrder"])("checks sequence on every %s cut reference", (field) => {
    for (const path of ["other/a", "seq", "seq/a/deeper", "seq/a/", "seq\\a"]) {
      const doc = fullDoc();
      if (field === "clips") doc.clips[0].cut = path;
      else if (field === "markers") doc.markers![0].cut = path;
      else if (field === "markIn" || field === "markOut") doc[field]!.cut = path;
      else (doc as unknown as Record<string, unknown>)[field] = [path];
      expect(readDoc(doc).ok, `${field}: ${path}`).toBe(false);
    }
  });
  it.each(["tracks", "clip", "tracksOff", "tracksLocked", "trackColors"])("checks 1..128 tracks in %s", (field) => {
    for (const value of [0, -1, 1.5, 129, 1e30]) {
      const doc = fullDoc();
      if (field === "clip") doc.clips[0].track = value;
      else if (field === "tracks") doc.tracks = value;
      else if (field === "trackColors") doc.trackColors = { [value]: "#123456" };
      else doc[field as "tracksOff" | "tracksLocked"] = [value];
      expect(readDoc(doc).ok).toBe(false);
    }
  });
  it.each(["01", "1e0", "1.0", "+1", " 1", "NaN", "Infinity"])("rejects noncanonical trackColors key %s", (key) => {
    expect(readDoc({ ...emptyEditDoc(), trackColors: { [key]: "#123456" } }).ok).toBe(false);
  });
  it.each(["gen", "job"] as const)("checks %s UTF-16 length", (field) => {
    const doc = fullDoc(); doc.clips[0][field] = "x".repeat(512);
    expect(readDoc(doc).ok).toBe(true);
    doc.clips[0][field] += "x";
    expect(readDoc(doc).ok).toBe(false);
  });
  it("checks cut and marker name length boundaries", () => {
    const doc = emptyEditDoc();
    doc.markers = [{ cut: "seq/" + "x".repeat(2044), local: 0, name: "x".repeat(1024) }];
    expect(readDoc(doc).ok).toBe(true);
    doc.markers[0].name += "x";
    expect(readDoc(doc).ok).toBe(false);
    doc.markers[0].name = "ok"; doc.markers[0].cut += "x";
    expect(readDoc(doc).ok).toBe(false);
  });
  it.each(["dur", "trim", "head", "markIn", "markOut", "marker"])("checks time bounds in %s", (field) => {
    for (const value of [-1, 86401, 1e300, "2", null]) {
      const doc = fullDoc();
      if (field === "markIn" || field === "markOut") doc[field]!.local = value as number;
      else if (field === "marker") doc.markers![0].local = value as number;
      else (doc.clips[0] as unknown as Record<string, unknown>)[field] = value;
      expect(readDoc(doc).ok).toBe(false);
    }
  });
  it("reuses existing invariant validation rather than repairing invalid data", () => {
    for (const patch of [{ v: 2 }, { muted: 1 }, { hideOff: "yes" }, { tracksOff: {} }, { markers: {} }, { cutsOn: ["seq/b"] }]) {
      expect(readDoc({ ...fullDoc(), ...patch }).ok).toBe(false);
    }
    const doc = fullDoc(); doc.clips.push({ ...doc.clips[0] });
    expect(readDoc(doc).ok).toBe(false);
    doc.clips.pop(); doc.markers!.push({ ...doc.markers![0] });
    expect(readDoc(doc).ok).toBe(false);
    for (const field of ["dur", "trim", "head"] as const) {
      const zero = fullDoc(); zero.clips[0][field] = 0;
      expect(readDoc(zero).ok).toBe(false);
    }
  });
  it.each(["clips", "markers", "cutsOn", "cutsOff", "cutOrder"])("enforces the 10,000 %s item boundary", (field) => {
    const doc: Record<string, unknown> = emptyEditDoc() as unknown as Record<string, unknown>;
    const items = Array.from({ length: 10_000 }, (_, index) => field === "clips" ? { cut: `seq/${index}`, gen: "g", track: 1 }
      : field === "markers" ? { cut: "seq/a", local: index } : `seq/${index}`);
    doc[field] = items;
    expect(readDoc(doc).ok).toBe(true);
    items.push(items[0]);
    expect(readDoc(doc).ok).toBe(false);
  });
  it("checks unique cuts across every field together", () => {
    const doc = { ...emptyEditDoc(), cutsOn: Array.from({ length: 10_000 }, (_, i) => `seq/${i}`), markIn: { cut: "seq/extra", local: 0 } };
    expect(readDoc(doc).ok).toBe(false);
  });
  it("sums maximum duration per unique cut, including hidden/disabled cuts", () => {
    const doc: EditDoc = { ...emptyEditDoc(), clips: [
      { cut: "seq/a", gen: "a", track: 1, dur: 43200, off: true },
      { cut: "seq/a", gen: "b", track: 2, dur: 43200 },
      { cut: "seq/b", gen: "a", track: 1, dur: 43200 },
    ], hideOff: true, tracksOff: [1, 2] };
    expect(readDoc(doc).ok).toBe(true);
    doc.markIn = { cut: "seq/c", local: 0 };
    expect(readDoc(doc).ok).toBe(false);
    doc.markIn = undefined; doc.clips[2].dur = 43200.001;
    expect(readDoc(doc).ok).toBe(false);
  });
  it("enforces UTF-8 docRaw and whole-file byte boundaries", () => {
    expect(utf8Bytes("한😀")).toBe(7);
    const base = JSON.stringify(emptyEditDoc());
    expect(readEnvelope({ docRaw: base.padEnd(1024 * 1024) }).ok).toBe(true);
    expect(readEnvelope({ docRaw: base.padEnd(1024 * 1024 + 1) }).ok).toBe(false);
    const archive = JSON.stringify(createEditArchive(emptyEditDoc(), target, false));
    expect(parseEditArchive(archive.padEnd(MAX_ARCHIVE_BYTES), target).ok).toBe(true);
    expect(parseEditArchive(archive.padEnd(MAX_ARCHIVE_BYTES + 1), target).ok).toBe(false);
    expect(readEnvelope({ docRaw: base + " ".repeat(1024 * 1024 - base.length - 1) + "한" }).ok).toBe(false);
  });
  it("preserves unbounded rescue exports without pretending they can automatically restore", () => {
    const doc = fullDoc(); doc.clips[0].track = 129;
    const archive = createEditArchive(doc, target, true);
    const raw = "손상".repeat(4_000_000);
    const recovery = createRecoveryArchive(target, archive, raw, true);
    expect(JSON.parse(recovery).storedRaw).toBe(raw);
    expect(parseEditArchive(recovery, target).ok).toBe(false);
    expect(parseEditArchive(JSON.stringify(archive), target).ok).toBe(false);
  });
  it("extracts only workingArchive from recovery and never parses diagnostic storedRaw", () => {
    const working = createEditArchive(fullDoc(), target, true);
    const recovery = createRecoveryArchive(target, working, "{invalid raw\r\n", true);
    const result = parseEditArchive(recovery, target);
    expect(result.ok && result.doc).toEqual(parseEditDoc(fullDoc()));
    expect(JSON.parse(recovery).storedRaw).toBe("{invalid raw\r\n");
    expect(parseEditArchive(createRecoveryArchive(target, null, JSON.stringify(working), false), target)).toMatchObject({ ok: false, message: expect.stringContaining("작업본") });
  });
  it.each([{ storedRaw: 1 }, { storedRaw: undefined }, { storedInvalid: 1 }, { storedInvalid: undefined }, { schemaVersion: 2 }, { exportedAt: "bad" }, { projectId: "other" }, { seq: "other" }, { workingArchive: undefined }])("rejects invalid recovery %j", (patch) => {
    const recovery = JSON.parse(createRecoveryArchive(target, createEditArchive(fullDoc(), target, false), null, false));
    expect(parseEditArchive(JSON.stringify({ ...recovery, ...patch }), target).ok).toBe(false);
  });
  it("rejects mismatched/nested/over-limit working archives inside recovery", () => {
    for (const working of [createEditArchive(fullDoc(), { ...target, seq: "other" }, false), JSON.parse(createRecoveryArchive(target, null, null, false)), { ...createEditArchive(fullDoc(), target, false), extra: true }]) {
      const recovery = { ...JSON.parse(createRecoveryArchive(target, null, null, false)), workingArchive: working };
      expect(parseEditArchive(JSON.stringify(recovery), target).ok).toBe(false);
    }
  });
  it("compares known semantic values while preserving meaningful order and duration differences", () => {
    const first = fullDoc(), second = fullDoc();
    second.tracksOff = [1, 1];
    expect(knownDocEquals(first, second)).toBe(true);
    expect(knownDocEquals(emptyEditDoc(), { ...emptyEditDoc(), muted: false, cutsOn: [], markers: [] })).toBe(true);
    second.cutOrder!.reverse(); expect(knownDocEquals(first, second)).toBe(false);
    second.cutOrder!.reverse(); second.clips[0].dur = 13;
    expect(knownDocEquals(first, second)).toBe(false);
  });
});
