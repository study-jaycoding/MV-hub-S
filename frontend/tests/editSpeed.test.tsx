// @vitest-environment jsdom
// 편집 탭 속도 조절(Jay 2026-10-23 Ctrl+R, 다빈치 리타임) — 길이·시각 변환·문서 v2·저장 판 유지·보관 파일·Resolve 계획 v3·속도 막대 화면.
// 계약은 docs/status/편집탭_속도조절_구현_2026-10-23.md · 재생 엔진은 editPlayback·editFollow 시험이 본다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditTree } from "../src/lib/useEditSequence";

const trees = vi.hoisted(() => ({
  p1: { state: "ready", complete: true, note: null, roots: [{ name: "e070", path: "e070", children: [{ name: "c1", path: "e070/c1" }] }] },
  none: { state: "idle", complete: false, note: null, roots: [] },
}));
vi.mock("../src/lib/useEditSequence", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/useEditSequence")>("../src/lib/useEditSequence");
  return {
    ...actual,
    useEditProjects: ({ projectId }: { projectId: string | null }) => ({
      projects: [{ id: "p1", name: "P1" }], projectsState: "ok",
      tree: (trees[(projectId ?? "none") as keyof typeof trees] ?? trees.none) as EditTree, reload: () => {},
      reloadCounts: () => {}, freshByProject: {},
    }),
    useEditGenerations: () => ({ state: "ok", gens: [], error: null, complete: true, reload: () => {} }),
  };
});

import { EditTab } from "../src/components/timeline/EditTab";
import { EditRetime, speedForFrames, trimForFrames, trimStep } from "../src/components/timeline/EditRetime";
import { createEditArchive, parseEditArchive } from "../src/lib/editArchive";
import { buildTimelineExport, type ExportLink } from "../src/lib/editResolveExport";
import {
  buildLayout, clipKey, clipLen, clipSource, editDocVersion, emptyEditDoc, localAt, mediaAt, parseEditDoc, setClipRange, setClipSpeed,
  type EditClip, type EditDoc,
} from "../src/lib/editTimeline";
import { clearUndo, keepUnsavedEditDoc, readEditDoc, writeEditDoc, writeEditRaw } from "../src/lib/editTimelineStore";
import type { Generation } from "../src/types";

const video = (more: Partial<EditClip> = {}): EditClip => ({ cut: "e070/c1", gen: "g1", track: 1, kind: "video", dur: 5, ...more });
const docOf = (...clips: EditClip[]): EditDoc => ({ ...emptyEditDoc(), clips });
const slotClip = (more: Partial<EditClip> = {}) => buildLayout(["e070/c1"], docOf(video(more))).cuts[0].clips[0];

describe("속도 — 길이·시각", () => {
  it("타임라인 길이 = 쓰는 원본 ÷ 속도를 프레임으로 내린 것 — 쓰는 원본 구간은 속도와 무관하다", () => {
    expect([clipLen(video({ speed: 2 })), clipLen(video({ speed: 0.25 }))]).toEqual([2.5, 20]);
    expect(clipLen(video({ speed: 1.27 })) * 24).toBe(94); // 120 ÷ 1.27 = 94.49 → 94(Resolve 와 같은 내림)
    expect([clipSource(video({ speed: 2, head: 1, trim: 2 })), clipLen(video({ speed: 2, head: 1, trim: 2 }))]).toEqual([2, 1]);
    expect(clipLen(video({ kind: "image", speed: 2 }))).toBe(5); // 그림에는 속도가 없다
  });

  it("영상 시각 = 시작점 + 컷 안 시각 × 속도 · 컷 안 시각 = (영상 시각 − 시작점) ÷ 속도", () => {
    const clip = slotClip({ head: 1, speed: 1.5 });
    expect([mediaAt(clip, 2), localAt(clip, 4)]).toEqual([4, 2]);
    expect(localAt(clip, mediaAt(clip, 0.7))).toBeCloseTo(0.7);
  });

  it("속도 정하기 — 문서는 v 2 가 되고, 1 이면 칸을 지운다(판은 2 그대로). 그림·잠긴 트랙·범위 밖·한 프레임도 안 되는 속도는 거부", () => {
    const doc = docOf(video(), video({ gen: "pic", track: 2, kind: "image" }));
    const key = clipKey(doc.clips[0]);
    const fast = setClipSpeed(doc, key, 2)!;
    expect([fast.v, fast.clips[0].speed, fast.clips[0].trim]).toEqual([2, 2, undefined]);
    expect(setClipSpeed(fast, key, 2)).toBeNull(); // 바뀐 것이 없다
    const back = setClipSpeed(fast, key, 1)!;
    expect([back.v, "speed" in back.clips[0]]).toEqual([2, false]);
    expect(setClipSpeed(doc, clipKey(doc.clips[1]), 2)).toBeNull();
    expect(setClipSpeed({ ...doc, tracksLocked: [1] }, key, 2)).toBeNull();
    for (const bad of [0.2, 4.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(setClipSpeed(doc, key, bad)).toBeNull();
    const tiny = docOf(video({ dur: 2 / 24 })); // 원본 2프레임 — 4배면 0프레임
    expect(setClipSpeed(tiny, clipKey(tiny.clips[0]), 4)).toBeNull();
    expect(setClipSpeed(tiny, clipKey(tiny.clips[0]), 2)!.clips[0].speed).toBe(2);
    // 속도가 있으면 한 프레임도 안 되는 구간으로는 자르지 못한다(원본 1프레임 ÷ 2배)
    expect(setClipRange(fast, key, { head: 0, trim: 1 / 24 })).toBeNull();
    expect(setClipRange(fast, key, { head: 0, trim: 2 / 24 })!.clips[0]).toMatchObject({ trim: 2 / 24, speed: 2 });
  });

  it("읽기 — v 1·v 2 · 속도는 v 2 의 영상 클립에만(v 1 에 있으면 그 문서를 읽지 않는다)", () => {
    const base = { v: 2, clips: [video({ speed: 1.5 })], tracksOff: [], tracksLocked: [] };
    expect(parseEditDoc(base)?.clips[0].speed).toBe(1.5);
    expect(parseEditDoc({ ...base, v: 1 })).toBeNull();
    expect(parseEditDoc({ ...base, clips: [video({ kind: "image", speed: 1.5 })] })).toBeNull();
    for (const speed of [0.1, 5, "2", null]) expect(parseEditDoc({ ...base, clips: [{ ...video(), speed }] })).toBeNull();
    expect(parseEditDoc({ ...base, clips: [video({ speed: 1 })] })!.clips[0]).not.toHaveProperty("speed");
    expect(parseEditDoc({ ...base, clips: [video()] })!.v).toBe(2); // 속도를 다 지워도 2
    expect([editDocVersion(docOf(video({ speed: 2 }))), editDocVersion(docOf(video()))]).toEqual([2, 1]);
  });

  it("정한 뒤 원본이 짧게 다시 재어져 0프레임이 되는 속도 클립 — 문서를 버리지 않고 한 프레임으로 둔다(속도가 없는 클립은 전과 같다)", () => {
    const shrunk = parseEditDoc({ v: 2, clips: [video({ dur: 2 / 24, speed: 4 })], tracksOff: [], tracksLocked: [] })!;
    expect(shrunk).not.toBeNull(); // 길이 재기가 적은 값 때문에 편집이 통째로 '읽지 못함'이 되지 않는다
    expect(clipLen(shrunk.clips[0])).toBe(1 / 24);
    expect(clipLen(video({ dur: 0.5 / 24 }))).toBe(0.5 / 24);
  });
});

describe("속도 — 저장 판·보관 파일", () => {
  beforeEach(() => localStorage.clear());

  it("한 번 v 2 가 된 문서는 v 1 문서를 적어도(되돌리기·옛 보관 파일) v 2 로 남는다 — 계정 DB 백업 복원은 받은 원문 그대로", () => {
    const key = "mvhub.editDoc:local:p9:s";
    const plain = docOf(video());
    expect(JSON.parse(writeEditDoc(key, plain)!).v).toBe(1); // 속도를 쓴 적이 없으면 옛 판 그대로(옛 빌드와 호환)
    writeEditDoc(key, setClipSpeed(plain, clipKey(plain.clips[0]), 2)!);
    expect(JSON.parse(writeEditDoc(key, plain)!)).toEqual({ ...plain, v: 2 }); // 되돌리기 — 속도가 없는 v 1 문서
    expect(readEditDoc(key).doc.v).toBe(2);
    const backup = JSON.stringify(plain); // 계정 DB 백업의 원문(v 1) — 복원 확인은 원문끼리 견준다
    expect(writeEditRaw(key, backup)).toBe(backup);
    expect(localStorage.getItem(key)).toBe(backup);
  });

  it("보관 파일 — 속도 칸을 받고(값 검사는 parseEditDoc), 느린 속도로 늘어난 길이도 한도에 센다", () => {
    const target = { projectId: "p1", seq: "e070" };
    const archive = (doc: EditDoc) => parseEditArchive(JSON.stringify(createEditArchive(doc, target, false)), target);
    const sped = setClipSpeed(docOf(video()), clipKey(video()), 0.5)!;
    const read = archive(sped);
    expect(read.ok && read.doc.clips[0].speed).toBe(0.5);
    expect(archive({ ...sped, v: 1 }).ok).toBe(false); // v 1 에 속도
    expect(archive(docOf(video({ dur: 30000 }))).ok).toBe(true);
    expect(archive({ ...docOf(video({ dur: 30000, speed: 0.25 })), v: 2 }).ok).toBe(false); // 타임라인 12만 초 — 하루 한도 밖
  });
});

describe("속도 — Resolve 계획 v3", () => {
  const gen = (id: string): Generation => ({
    id, job_id: `job-${id}`, status: "done", project_id: "p1", folder_path: "e070/c1",
    assets: [{ type: "video", file_path: `/media/${id}.mp4`, thumbnail_path: null }], params: {},
  } as unknown as Generation);
  const build = (doc: EditDoc, cuts: string[]) => buildTimelineExport({
    layout: buildLayout(cuts, doc), doc, name: "x",
    links: new Map<string, ExportLink>(doc.clips.map((clip) => [clipKey(clip), { state: "ok", gen: gen(clip.gen) }])),
  });

  it("속도 클립이 있으면 3 판 — 모든 클립에 head, 속도 클립에만 speed·src(보내는 프레임 ÷ 24 × 속도), 그 소리에 speed", () => {
    const doc: EditDoc = {
      ...emptyEditDoc(), v: 2, clips: [
        video({ gen: "low", dur: 8 }),
        video({ gen: "top", track: 2, dur: 4, head: 1, speed: 1.5 }), // 쓰는 원본 3초 ÷ 1.5 = 2초
        video({ cut: "e070/c2", gen: "off", dur: 10, speed: 0.5, off: true }), // 꺼 둠 — 20초지만 컷(3초)의 끝에서 잘린다
        video({ cut: "e070/c2", gen: "on", track: 2, dur: 3 }),
      ],
    };
    const out = build(doc, ["e070/c1", "e070/c2"]);
    expect(out.plan.version).toBe(3);
    expect(out.plan.clips.map(({ gen_id, start, end, head, speed, src, enabled }) => [gen_id, start, end, head, speed, src, enabled])).toEqual([
      ["low", 0, 192, 0, undefined, undefined, true],
      ["top", 0, 48, 24, 1.5, 3, true],
      ["off", 192, 264, 0, 0.5, 1.5, false], // 잘린 72프레임만큼의 원본(1.5초)
      ["on", 192, 264, 0, undefined, undefined, true],
    ]);
    // 받는 쪽 검사(floor(src × 24 ÷ speed + 1e-6) = 길이)와 같은 식이다
    for (const row of out.plan.clips.filter((item) => item.speed)) expect(Math.floor((row.src! * 24) / row.speed! + 1e-6)).toBe(row.end - row.start);
    // 소리의 영상 안 시각 = 시작점 + 컷 안 시각 × 속도(그 클립의 속도를 같이 싣는다)
    expect(out.plan.audio).toEqual([
      { gen_id: "top", start: 0, end: 48, offset: 1, track: 2, speed: 1.5 },
      { gen_id: "low", start: 48, end: 192, offset: 2, track: 1 },
      { gen_id: "on", start: 192, end: 264, offset: 0, track: 2 },
    ]);
    expect(build(docOf(video()), ["e070/c1"]).plan.version).toBe(1); // 속도·시작점이 없으면 옛 판 그대로
    expect(build(docOf(video({ head: 1 })), ["e070/c1"]).plan.version).toBe(2);
    // 0프레임이 된 속도 클립 — 앱의 길이와 같은 한 프레임으로 싣고, src 도 받는 쪽 식과 맞는다. 이 줄 그대로를 백엔드 시험
    //  (test_resolve_timeline.py 'a_speed_clip_whose_source_cannot_fill_one_frame') 이 받아, 원본(2프레임)이 400% 의 한 프레임을 못 채우므로
    //  타임라인을 만들지 않는다(source_shorter — 100% 클립의 '실제 영상이 적힌 길이보다 짧음'과 같은 규칙)
    const [tiny] = build({ ...docOf(video({ gen: "tiny", dur: 2 / 24, speed: 4 })), v: 2 }, ["e070/c1"]).plan.clips;
    expect(tiny).toEqual({ gen_id: "tiny", track: 1, start: 0, end: 1, enabled: true, kind: "video", head: 0, speed: 4, src: 4 / 24 });
    expect(Math.floor((tiny.src! * 24) / tiny.speed! + 1e-6)).toBe(1);
    //  같은 원본에 210% 도 앱은 한 프레임(floor(2 ÷ 2.1) = 0 → 1) — 이번에는 원본 2프레임이 그 한 프레임을 채워(floor(1 × 2.1) = 2) 백엔드가 짓는다
    //  (같은 백엔드 시험의 둘째 경우가 이 줄을 받는다)
    const [fills] = build({ ...docOf(video({ gen: "tiny", dur: 2 / 24, speed: 2.1 })), v: 2 }, ["e070/c1"]).plan.clips;
    expect([fills.end - fills.start, fills.speed, fills.src]).toEqual([1, 2.1, (1 / 24) * 2.1]); // 백엔드 시험의 sped() 와 같은 계산 순서
  });
});

describe("속도 막대 계산", () => {
  it("끌어서 정한 길이 → 정수 % 속도(25%~, 한 프레임은 남게) · 끝 끌기 → 원본 프레임(속도 그대로, 한 프레임은 남게)", () => {
    expect(speedForFrames(slotClip(), 60)).toBe(2); // 원본 120프레임 ÷ 60
    expect(speedForFrames(slotClip(), 94)).toBe(1.28); // 127.66% → 128%
    expect(speedForFrames(slotClip(), 10000)).toBe(0.25);
    expect(speedForFrames(slotClip({ dur: 2 / 24 }), 1)).toBe(2); // 원본 2프레임 — 한 프레임은 남게(최대 200%)
    expect(trimForFrames(slotClip({ speed: 2 }), 30)).toBe(60 / 24); // 30프레임 × 2 = 원본 60프레임
    expect(trimForFrames(slotClip({ speed: 2 }), 1000)).toBeNull(); // 원본 끝까지
    expect(trimForFrames(slotClip({ speed: 3 }), 0)).toBe(3 / 24); // 한 프레임이 되는 원본(3프레임)보다 짧게는 못 한다
    // 키 한 걸음 — 25% 에서는 원본 한 프레임이 타임라인 네 프레임이다: 479·478 프레임은 같은 길이라 건너뛰고 원본 119프레임(476)으로
    expect(trimStep(slotClip({ speed: 0.25 }), -1)).toBe(119 / 24);
    expect(trimStep(slotClip({ speed: 0.25 }), 1)).toBeUndefined(); // 원본 끝 — 더 갈 데가 없다
    // 91% · 131 — 타임라인 프레임으로 셈하면(round(130 × 0.91) = 118 → 129) 가장 가까운 130 을 건너뛴다(Codex 독립 리뷰 6차)
    expect(trimStep(slotClip({ speed: 0.91 }), -1)).toBe(119 / 24);
    expect(trimStep(slotClip({ speed: 0.91 }), -10)).toBe(111 / 24); // floor(111 ÷ 0.91) = 121 — 열 프레임 짧은 가장 가까운 길이
    expect(trimStep(slotClip({ speed: 3 }), -1)).toBe(119 / 24); // 빠른 속도 — 원본 117~119 가 모두 39프레임: 가장 적게 바뀌는 119(40 → 39)
    // 원본 끝이 프레임 사이(120.4프레임) · 25% — 481 에서 ← 는 그 안의 온전한 프레임 120(= 480), → 는 다시 원본 끝까지(Codex 독립 리뷰 7차)
    const ragged = slotClip({ dur: 120.4 / 24, speed: 0.25 });
    expect([Math.round(ragged.len * 24), trimStep(ragged, -1)]).toEqual([481, 120 / 24]);
    expect(trimStep(slotClip({ dur: 120.4 / 24, speed: 0.25, trim: 120 / 24 }), 1)).toBeNull();
    expect(trimStep(slotClip({ dur: 120.4 / 24, speed: 0.25, trim: 119 / 24 }), 1)).toBe(120 / 24); // 476 → 480(가장 가까운 것)
    expect(trimStep(slotClip({ dur: 120.4 / 24, speed: 0.25 }), 1)).toBeUndefined();
    expect(trimStep(slotClip({ speed: 2, trim: 1 }), 1000)).toBeNull(); // 범위를 넘는 걸음은 원본 끝까지
    expect(trimStep(slotClip({ speed: 2, trim: 1 }), -1000)).toBe(2 / 24); // 한 프레임(원본 2프레임)까지
  });

  it("키 한 걸음 = 그 방향의 가장 가까운 길이 — 모든 원본 후보(온전한 프레임 trim · 원본 끝)를 다 세어 본 것과 같다", () => {
    const frames = (clip: EditClip, trim: number | null) => {
      const shaped: EditClip = { ...clip };
      delete shaped.trim;
      if (trim !== null) shaped.trim = trim;
      return Math.round(clipLen(shaped, clip.dur) * 24);
    };
    let cases = 0;
    for (const speed of [0.25, 0.5, 0.91, 1, 1.27, 2, 3, 4]) {
      for (const dur of [5, 120.4 / 24, 37.3 / 24]) {
        for (const trim of [undefined, 30 / 24, 61 / 24]) {
          for (const head of [0, 7 / 24]) {
            const clip = slotClip({ dur, speed, trim, head });
            const now = Math.round(clip.len * 24);
            const top = Math.floor(dur * 24 + 1e-6) - Math.round(clip.head * 24);
            const lengths = [null, ...Array.from({ length: top }, (_, i) => (i + 1) / 24)].map((cand) => frames(clip, cand));
            for (const delta of [-1, -10, 1, 10]) {
              const toward = lengths.filter((len) => (delta < 0 ? len < now : len > now));
              const reach = toward.filter((len) => (delta < 0 ? len <= now + delta : len >= now + delta));
              const want = reach.length ? (delta < 0 ? Math.max(...reach) : Math.min(...reach))
                : toward.length ? (delta < 0 ? Math.min(...toward) : Math.max(...toward)) : undefined; // 범위를 넘으면 그 끝까지
              const got = trimStep(clip, delta);
              expect([speed, dur, trim, head, delta, got === undefined ? undefined : frames(clip, got)])
                .toEqual([speed, dur, trim, head, delta, want]);
              cases++;
            }
          }
        }
      }
    }
    expect(cases).toBe(576);
  });

  it("손잡이의 키·값은 범위를 지킨다 — 상한 밖의 지금 속도에서 늘리는 키는 줄이지 않고, 고를 속도가 없으면 키·끌기가 쉬며, 끄는 중의 값도 범위 안", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const onChange = vi.fn();
    const draw = (clip: ReturnType<typeof slotClip>) => act(() => root.render(
      <EditRetime clip={clip} start={0} zoom={10} name="x" onChange={onChange} onClose={() => {}} />,
    ));
    const grip = (kind: string) => host.querySelector<HTMLElement>(`.ed-rt-${kind}`)!;
    const key = (kind: string, keyName: string) => act(() => {
      grip(kind).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: keyName }));
    });
    const aria = (kind: string) => ["aria-valuemin", "aria-valuenow", "aria-valuemax", "aria-disabled"].map((name) => grip(kind).getAttribute(name));
    draw(slotClip({ dur: 12 / 24 })); // 100% · 원본 12프레임 → 상한은 1200% 가 아니라 400%
    expect(aria("speed")).toEqual(["25", "100", "400", null]);
    // 직접 입력한 소수 % 는 그대로 두고 1·10%p 를 더한다(Codex 독립 리뷰 8차 — 정수로 반올림하면 100.50% → 102%)
    draw(slotClip({ speed: 1.005 }));
    key("speed", "ArrowRight");
    expect(onChange).toHaveBeenLastCalledWith({ speed: 1.015 });
    act(() => grip("speed").dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowLeft", shiftKey: true })));
    expect(onChange).toHaveBeenLastCalledWith({ speed: 0.905 });
    onChange.mockClear();
    // 원본 반 프레임 + 100%(상한 50% 밖) — → 는 아무것도 안 하고, ← 는 상한(50%)으로 줄인다
    draw(slotClip({ dur: 1 / 48 }));
    expect(aria("speed")).toEqual(["25", "100", "100", null]);
    key("speed", "ArrowRight");
    expect(onChange).not.toHaveBeenCalled();
    key("speed", "ArrowLeft");
    expect(onChange).toHaveBeenLastCalledWith({ speed: 0.5 });
    // 원본이 25% 의 한 프레임도 못 채운다(상한 20%) — 고를 속도가 없다: 키는 쉬고(20% 를 보내지 않는다) 범위는 지금 값을 담는다
    onChange.mockClear();
    draw(slotClip({ dur: 0.2 / 24 }));
    expect(aria("speed")).toEqual(["25", "100", "100", "true"]);
    key("speed", "ArrowLeft");
    key("speed", "ArrowRight");
    expect(onChange).not.toHaveBeenCalled();
    // 5초 100% 를 끌어 느리게(25%) — 끄는 중 끝 손잡이의 값(480)이 그 속도의 범위(480) 안
    draw(slotClip());
    act(() => grip("speed").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 0 })));
    act(() => grip("speed").dispatchEvent(new MouseEvent("pointermove", { bubbles: true, cancelable: true, clientX: 100000 })));
    expect(aria("trim")).toEqual(["1", "480", "480", null]);
    expect(aria("speed")).toEqual(["25", "25", "400", null]);
    act(() => root.unmount());
    host.remove();
  });

  it("원본이 아주 짧게 다시 재어져 상한이 100% 밑이어도 100% 로 되돌리기는 된다(메뉴·직접 입력)", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const onChange = vi.fn();
    const clip = slotClip({ dur: 1 / 48, speed: 2 }); // 원본 반 프레임 — 가장 빠른 속도 50%
    act(() => root.render(<EditRetime clip={clip} start={0} zoom={100} name="x" onChange={onChange} onClose={() => {}} />));
    act(() => host.querySelector<HTMLButtonElement>(".ed-rt-foot")!.click());
    const item = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".ed-rt-menu .ed-tmenu-item")]
      .find((button) => button.textContent!.startsWith(label))!;
    expect([item("75%").disabled, item("100%").disabled, item("50%").disabled]).toEqual([true, false, false]);
    act(() => item("100%").click());
    expect(onChange).toHaveBeenLastCalledWith({ speed: 1 });
    act(() => host.querySelector<HTMLButtonElement>(".ed-rt-foot")!.click());
    act(() => item("속도 직접 입력").click());
    const field = document.querySelector<HTMLInputElement>(".ed-rt-input input")!;
    const apply = () => [...document.querySelectorAll<HTMLButtonElement>(".ed-rt-input button")][0];
    const type = (text: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    type("75");
    expect(apply().disabled).toBe(true);
    type("100");
    expect(apply().disabled).toBe(false);
    act(() => root.unmount());
    host.remove();
  });
});

describe("Ctrl+R 속도 막대", () => {
  const docKey = "mvhub.editDoc:local:p1:e070";
  let host: HTMLDivElement;
  let root: Root;
  const press = (init: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    act(() => { document.body.dispatchEvent(event); });
    return event;
  };
  const stored = () => JSON.parse(localStorage.getItem(docKey)!) as { v: number; clips: { gen: string; speed?: number; trim?: number }[] };
  const g1 = () => stored().clips.find((clip) => clip.gen === "g1")!;
  const pointer = (target: Element, type: string, clientX: number) => act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX }));
  });

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    localStorage.setItem("ch.editTimeline.last:local", JSON.stringify({ projectId: "p1", seq: "e070" }));
    localStorage.setItem(docKey, JSON.stringify({ v: 1, tracksOff: [], tracksLocked: [], clips: [
      { cut: "e070/c1", gen: "g1", track: 1, kind: "video", dur: 5 }, { cut: "e070/c1", gen: "g2", track: 2, kind: "image", dur: 5 },
    ] }));
    for (const method of ["load", "pause"] as const) vi.spyOn(HTMLMediaElement.prototype, method).mockImplementation(() => {});
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(
      <EditTab authKey="auth" authReady workspace={{ scope: "team", id: "w1", name: "W" }} keysActive flash={() => {}}
        onOpenCutFolder={() => {}} reloadSignal={0} peekPath={null} onPeekMarks={() => {}} cardMenuRef={{ current: null }} onPreview={() => {}} onCompare={() => {}}
        resolve={{ send: () => {}, busy: false, pendingCount: 0 }} />,
    ));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    keepUnsavedEditDoc(docKey, null);
    clearUndo(docKey);
  });

  it("고른 영상 클립에 켜고(새로고침 키를 막는다), ▾ 메뉴로 속도를 바꾼다 — Ctrl+Z 한 번에 돌아가도 판은 2 그대로", () => {
    const first = press({ key: "r", code: "KeyR", ctrlKey: true }); // 고른 클립이 없다 — 알리기만 한다
    expect([first.defaultPrevented, document.querySelector(".ed-rt")]).toEqual([true, null]);
    press({ key: "a", code: "KeyA", ctrlKey: true });
    press({ key: "r", code: "KeyR", ctrlKey: true });
    const bar = document.querySelector<HTMLElement>(".ed-rt")!;
    expect(bar.textContent).toContain("c1 · V1"); // 그림(V2)이 아니라 영상 클립에
    act(() => bar.querySelector<HTMLButtonElement>(".ed-rt-foot")!.click());
    const item = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".ed-rt-menu .ed-tmenu-item")]
      .find((button) => button.textContent!.startsWith(label))!;
    act(() => item("50%").click());
    expect([stored().v, g1().speed]).toEqual([2, 0.5]);
    expect(document.querySelector('.ed-clip[data-clip$="g1"]')!.textContent).toContain("10.0s · 50%");
    press({ key: "r", code: "KeyR", ctrlKey: true }); // 다시 누르면 끈다
    expect(document.querySelector(".ed-rt")).toBeNull();
    press({ key: "z", code: "KeyZ", ctrlKey: true });
    expect([stored().v, g1().speed]).toEqual([2, undefined]); // 옛 빌드가 v 1 로 읽고 속도를 버린 채 덮지 않게
  });

  it("잡는 곳은 키보드로도 쓴다 — 값·범위가 보이고 ←/→ 가 속도·끝을 바꾼다(누를 때마다 저장 · 재생헤드는 안 움직인다)", () => {
    press({ key: "a", code: "KeyA", ctrlKey: true });
    press({ key: "r", code: "KeyR", ctrlKey: true });
    const grip = (kind: string) => document.querySelector<HTMLElement>(`.ed-rt .ed-rt-${kind}`)!;
    const aria = (kind: string) => ["tabindex", "aria-valuenow", "aria-valuemin", "aria-valuemax"].map((name) => grip(kind).getAttribute(name));
    expect(aria("speed")).toEqual(["0", "100", "25", "400"]);
    expect(aria("trim")).toEqual(["0", "120", "1", "120"]); // 타임라인 프레임 — 원본 끝까지 늘리면 120
    const key = (target: Element, init: KeyboardEventInit) => {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      act(() => { target.dispatchEvent(event); });
      return event;
    };
    const timecode = document.querySelector(".ed-tc")!.textContent;
    const right = key(grip("speed"), { key: "ArrowRight", code: "ArrowRight" });
    expect([right.defaultPrevented, g1().speed]).toEqual([true, 1.01]);
    key(grip("speed"), { key: "ArrowLeft", code: "ArrowLeft", shiftKey: true }); // Shift = 10%
    expect([g1().speed, grip("speed").getAttribute("aria-valuenow")]).toEqual([0.91, "91"]);
    expect(document.querySelector(".ed-tc")!.textContent).toBe(timecode); // 화살표가 뒤의 편집 키(재생헤드 옮기기)로 가지 않았다
    expect(aria("trim")).toEqual(["0", "131", "1", "131"]); // floor(120 ÷ 0.91)
    key(grip("trim"), { key: "ArrowLeft", code: "ArrowLeft" }); // 원본 119프레임 → floor(119 ÷ 0.91) = 130 — 한 프레임 짧은 가장 가까운 길이
    expect([g1().speed, g1().trim, grip("trim").getAttribute("aria-valuenow")]).toEqual([0.91, 119 / 24, "130"]);
    key(grip("trim"), { key: "ArrowRight", code: "ArrowRight", shiftKey: true }); // 원본 끝을 넘으면 원본 끝까지(trim 을 지움)
    expect([g1().trim, grip("trim").getAttribute("aria-valuenow")]).toEqual([undefined, "131"]);
    expect(key(grip("trim"), { key: "ArrowRight", code: "ArrowRight" }).defaultPrevented).toBe(true); // 끝에 닿았다 — 저장할 것은 없고 막기만
    expect(g1().trim).toBeUndefined();
  });

  it("오른쪽 끝 위쪽 끌기 = 속도(놓을 때 한 번 저장) · 아래쪽 끌기 = 끝(속도 그대로) · Esc 로 끈다", () => {
    press({ key: "a", code: "KeyA", ctrlKey: true });
    press({ key: "r", code: "KeyR", ctrlKey: true });
    const grip = (kind: string) => document.querySelector<HTMLElement>(`.ed-rt .ed-rt-${kind}`)!;
    pointer(grip("speed"), "pointerdown", 5000);
    pointer(grip("speed"), "pointermove", -5000); // 한참 왼쪽 — 가장 빠른 400%
    expect(g1().speed).toBeUndefined(); // 끄는 동안은 화면만
    expect(document.querySelector(".ed-rt-foot")!.textContent).toContain("400%");
    pointer(grip("speed"), "pointerup", -5000);
    expect(g1().speed).toBe(4);
    pointer(grip("trim"), "pointerdown", 5000);
    pointer(grip("trim"), "pointermove", -5000);
    pointer(grip("trim"), "pointerup", -5000);
    expect(g1()).toMatchObject({ speed: 4, trim: 4 / 24 }); // 한 프레임이 되는 원본(4프레임)까지만
    pointer(grip("speed"), "pointerdown", 0);
    pointer(grip("speed"), "pointermove", 50);
    press({ key: "Escape", code: "Escape" }); // 끄는 중의 Esc = 그 끌기만 취소
    pointer(grip("speed"), "pointerup", 50);
    expect(g1().speed).toBe(4);
    press({ key: "Escape", code: "Escape" });
    expect(document.querySelector(".ed-rt")).toBeNull();
  });
});
