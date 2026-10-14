// @vitest-environment jsdom
// 편집 탭 — 영상 클립의 길이 재기(2026-10-13 격리 실측 ⑤):
//  · 영상 클립은 페이지를 열 때마다 다시 잰다 — 적힌 길이만 보고 '이미 쟀다'고 건너뛰지 않는다.
//  · 잰 값은 모아서 한 번에 적는다. 모으는 중에 문서가 바뀌거나 탭을 떠나면 그 자리에서 적고, 시퀀스를 바꾸면 버려지지만 돌아오면
//    다시 재어 적는다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditCardMenu } from "../src/components/timeline/EditTab";
import type { EditTree } from "../src/lib/useEditSequence";
import type { Generation } from "../src/types";

const gen = (id: string, cut: string, type: "image" | "video", duration?: number) => ({
  id, job_id: `job-${id}`, status: "done", params: duration ? { duration } : {}, prompt: `prompt ${id}`, folder_path: `e070/${cut}`,
  shared: true, is_final: false, is_held: false, is_mine: false, creator_name: "리버", model: "seedance",
  assets: [{ id: `a-${id}`, generation_id: id, type, file_path: `/media/${id}.${type === "video" ? "mp4" : "png"}`,
    thumbnail_path: null, source_url: null, cached: true }],
} as unknown as Generation);
const video = (id: string, cut: string, duration?: number) => gen(id, cut, "video", duration);

// 길이 재기(lib/videoDuration)의 대역 — 받는 중인 주소는 한 약속에 합류하고, 잰 값은 이 페이지에서 기억한다(known). 결과는 시험이 준다.
const probes = vi.hoisted(() => ({
  asked: [] as string[],
  inexact: new Set<string>(), // 서버가 그림 길이를 못 줘 video.duration 으로 잰 주소(기본은 그림 길이로 쟀다)
  known: new Map<string, number>(),
  inflight: new Map<string, Promise<number | null>>(),
  finish: new Map<string, (seconds: number | null) => void>(),
}));
vi.mock("../src/lib/videoDuration", () => ({
  knownVideoSeconds: (url: string | null | undefined) => (url && probes.known.get(url)) || null,
  measureVideoSeconds: (url: string) => {
    probes.asked.push(url);
    const cached = probes.known.get(url);
    if (cached) return Promise.resolve(cached);
    let pending = probes.inflight.get(url);
    if (!pending) {
      pending = new Promise<number | null>((resolve) => {
        probes.finish.set(url, (seconds) => {
          probes.inflight.delete(url);
          if (seconds) probes.known.set(url, seconds);
          resolve(seconds);
        });
      });
      probes.inflight.set(url, pending);
    }
    return pending;
  },
  dropQueuedVideoMeasures: () => {},
  measuredExactly: (url: string) => !probes.inexact.has(url),
}));
const world = vi.hoisted(() => ({ gens: [] as unknown[] }));
vi.mock("../src/lib/resolveTransfer", async () => ({
  ...(await vi.importActual<typeof import("../src/lib/resolveTransfer")>("../src/lib/resolveTransfer")),
  getResolveConnectionStatus: () => Promise.reject(new Error("안 물었다")),
}));
vi.mock("../src/lib/useEditSequence", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/useEditSequence")>("../src/lib/useEditSequence");
  const counts = { final: 0, held: 0, shared: 2 };
  const folder = (name: string, cuts: string[]) => ({
    name, path: name, count: 4, newCount: 0, reviewCounts: counts, children: cuts.map((cut) => (
      { name: cut, path: `${name}/${cut}`, count: 2, newCount: 0, reviewCounts: counts })) });
  const tree = { state: "ready", complete: true, note: null, roots: [folder("e070", ["c1", "c2"]), folder("e071", ["k1"])] } as unknown as EditTree;
  return {
    ...actual,
    useEditProjects: () => ({
      projects: [{ id: "p1", name: "P1" }], projectsState: "ok", tree, reload: () => {}, reloadCounts: () => {}, freshByProject: {},
    }),
    useEditGenerations: () => ({ state: "ok", gens: world.gens, error: null, complete: true, known: true, reload: () => {} }),
  };
});
vi.mock("../src/lib/useDisabledFolders", () => ({ useDisabledFolders: () => ({}) }));

import { EditTab, MEASURE_SAVE_MS } from "../src/components/timeline/EditTab";

let host: HTMLDivElement;
let root: Root;
const flashed: string[] = [];
const cardMenuRef: { current: EditCardMenu | null } = { current: null };
// 길이 재기의 약속이 풀린 뒤의 일(모으기)까지 기다린다
const settle = () => act(async () => {});
const mount = () => act(async () => root.render(
  <EditTab authKey="auth" authReady workspace={{ scope: "team", id: "w1", name: "W" }} keysActive
    flash={(message: string) => { flashed.push(message); }} onOpenCutFolder={() => {}} reloadSignal={0}
    peekPath={null} onPeekMarks={() => {}} cardMenuRef={cardMenuRef} onPreview={() => {}} onCompare={() => {}}
    resolve={{ send: () => {}, sendTimeline: () => new Promise<never>(() => {}), busy: false, pendingCount: 0, timelineBusy: false }}
    onFolderAction={() => {}} />,
));
const docKey = (seq: string) => `mvhub.editDoc:local:p1:${seq}`;
const DOC_KEY = docKey("e070");
const seed = (clips: { cut: string; gen: string; track: number; dur?: number; durExact?: boolean; kind?: string }[]) =>
  localStorage.setItem(DOC_KEY, JSON.stringify({
    v: 1, tracksOff: [], tracksLocked: [], clips: clips.map((clip) => ({ kind: "video", ...clip, cut: `e070/${clip.cut}` })),
  }));
const durs = (): Record<string, number | undefined> => Object.fromEntries(
  (JSON.parse(localStorage.getItem(DOC_KEY) ?? "null")?.clips ?? []).map((clip: { gen: string; dur?: number }) => [clip.gen, clip.dur]));
// 그림 트랙으로 잰 표(durExact)가 달린 클립
const exacts = () => (JSON.parse(localStorage.getItem(DOC_KEY) ?? "null")?.clips ?? [])
  .filter((clip: { durExact?: boolean }) => clip.durExact).map((clip: { gen: string }) => clip.gen).sort();
// 재어 달라고 한 영상들(한 번이라도) — 효과가 다시 돌 때마다 또 묻는 것은 세지 않는다
const asked = () => [...new Set(probes.asked.map((url) => url.replace(/^\/media\/|\.mp4$/g, "")))].sort();
const arrive = (id: string, seconds: number | null) => act(async () => { probes.finish.get(`/media/${id}.mp4`)!(seconds); });
// 이 뒤로 편집 문서(e070)를 저장한 횟수
const countWrites = () => {
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  return () => setItem.mock.calls.filter(([key]) => key === DOC_KEY).length;
};
const pickSeq = (name: string) => act(async () => {
  [...document.querySelectorAll<HTMLButtonElement>(".folder-tree-row")]
    .find((row) => row.querySelector(".folder-tree-name")!.textContent === name)!.click();
});
const seqShown = () => document.querySelector(".folder-tree-row.selected .folder-tree-name")?.textContent;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem("ch.editTimeline.last:local", JSON.stringify({ projectId: "p1", seq: "e070" }));
  for (const method of ["load", "pause"] as const) vi.spyOn(HTMLMediaElement.prototype, method).mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  Object.assign(Element.prototype, { setPointerCapture() {}, hasPointerCapture: () => false, releasePointerCapture() {} });
  probes.asked.length = 0;
  probes.inexact.clear();
  for (const map of [probes.known, probes.inflight, probes.finish]) map.clear();
  flashed.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Codex 코드 리뷰(2026-10-14) — 한 창은 서버에서 그림 길이(97프레임)를, 다른 창은 서버가 잠깐 실패해 video.duration(소리까지 —
//  98·99프레임)을 쟀다. 그 값으로 덮으면 두 창이 저장을 받을 때마다 서로 되돌렸다(저장 반복·되돌리기 기록 초기화). '1프레임
//  안쪽만 막기'로는 소리가 2프레임 넘게 긴 파일(99 ↔ 97)에서 남았다 — 문서의 표(durExact)로 막는다.
it("그림 트랙으로 잰 길이는 표를 달고, video.duration 으로 잰 값은 그 표가 있는 클립을 차이와 상관없이 덮지 않는다", async () => {
  world.gens = [video("m", "c1", 4), video("d", "c2", 8), video("e", "c2", 4)];
  seed([
    { cut: "c1", gen: "m", track: 1, dur: 97 / 24, durExact: true }, // 다른 창이 그림 길이로 적었다
    { cut: "c2", gen: "d", track: 1, dur: 8 }, // 요청 길이
    { cut: "c2", gen: "e", track: 2, dur: 4.087 }, // 옛 '소리까지 친 길이'
  ]);
  probes.inexact.add("/media/m.mp4");
  probes.inexact.add("/media/d.mp4"); // e 는 이 창도 그림 길이로 잰다
  await mount();
  await arrive("m", 99 / 24); // 2프레임 길다 — 표가 있으니 덮지 않는다
  await arrive("d", 10); // 표가 없다 — 고친다(표는 안 단다)
  await arrive("e", 97 / 24); // 그림 길이 — 고치고 표를 단다
  act(() => { vi.advanceTimersByTime(MEASURE_SAVE_MS); });
  expect(durs()).toEqual({ m: 97 / 24, d: 10, e: 97 / 24 });
  expect(exacts()).toEqual(["e", "m"]);

  const writes = countWrites();
  act(() => { window.dispatchEvent(new StorageEvent("storage", { key: DOC_KEY })); }); // 다른 창이 저장했다
  await settle();
  act(() => { vi.advanceTimersByTime(MEASURE_SAVE_MS); });
  expect([writes(), durs(), exacts()]).toEqual([0, { m: 97 / 24, d: 10, e: 97 / 24 }, ["e", "m"]]);
  expect(flashed).toEqual([]);
});

// Codex 37회차 — 소스 판에서만 보는 영상(타임라인에 없다)을 video.duration 으로 쟀으면, 이미 잰 값이 있다고 건너뛰어 서버가 나은 뒤에도
//  그림 길이를 다시 묻지 않았다. 다시 띄우면 묻는다(1분 안이면 lib/videoDuration 이 기억한 값을 바로 준다). 그림 길이로 잰 것은 묻지 않는다.
it("소스 판: video.duration 으로 잰 영상은 다시 띄울 때 다시 묻는다 — 그림 길이로 잰 것은 묻지 않는다", async () => {
  localStorage.setItem("ch.editTimeline.ui", JSON.stringify({ dual: true, views: ["source", "timeline"] }));
  world.gens = [video("m", "c1", 4), video("s", "c1", 4), video("x", "c1", 4)];
  seed([{ cut: "c1", gen: "m", track: 1, dur: 4 }]);
  probes.known.set("/media/s.mp4", 98 / 24);
  probes.inexact.add("/media/s.mp4");
  probes.known.set("/media/x.mp4", 97 / 24); // 그림 길이로 쟀다
  await mount();
  probes.asked.length = 0;
  for (const card of document.querySelectorAll<HTMLButtonElement>(".ed-pool .ed-card")) {
    await act(async () => card.click());
    await settle();
  }
  expect(asked().filter((id) => id !== "m")).toEqual(["s"]);

  // 다른 판(또는 1분 뒤 다시 물음)이 그림 길이를 받아 공용 기억이 바뀌었으면, 이 판이 전에 받은 옛 값보다 그것이 먼저다(Codex 37회차)
  const pane = () => document.querySelector<HTMLElement>(".ed-top > .ed-view[data-view='source']")!;
  const showS = async () => {
    for (const card of document.querySelectorAll<HTMLButtonElement>(".ed-pool .ed-card")) {
      await act(async () => card.click());
      await settle();
      if (pane().querySelector(".ed-stage > video.ed-media")?.getAttribute("src") === "/media/s.mp4") return;
    }
  };
  await showS();
  expect(pane().querySelector(".ed-vtotal")!.textContent).toBe("00:00:04:02"); // 98프레임(소리까지)
  probes.known.set("/media/s.mp4", 97 / 24);
  probes.inexact.delete("/media/s.mp4");
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>(".ed-pool .ed-card")].at(-1)!.click()); // 다른 것을 띄웠다가
  await showS(); // 다시
  expect(pane().querySelector(".ed-vtotal")!.textContent).toBe("00:00:04:01"); // 97프레임(그림)
});

// 적힌 길이만 보고 '이미 쟀다'고 건너뛰지 않는다(그렇게 넣었다가 뺐다 — Codex 코드 리뷰 4회째): dur 에는 요청 길이와 실측값이 구분 없이
//  적히고, 요청 길이는 동기화로 바뀔 수 있다. d 가 그 경우다 — 요청 8초로 넣어 8 이 적혔고 재지 못했는데(실패·그 전에 떠남), 그 뒤
//  요청 길이가 10초로 바뀌었다. '지금의 요청 길이(10)·기본 5초와 다르니 잰 값'으로 보면 실제 10초짜리 영상이 8초로 굳는다.
it("영상 클립은 페이지를 열 때마다 다시 잰다 — 적힌 길이가 지금의 요청 길이와 달라도 '이미 잰 값'으로 보지 않는다", async () => {
  world.gens = [video("m", "c1", 5), video("n", "c1", 5), gen("p", "c1", "image"), video("d", "c2", 10), video("f", "c2")];
  seed([
    { cut: "c1", gen: "m", track: 1, dur: 5.5 }, // 전에 잰 값
    { cut: "c1", gen: "n", track: 2, dur: 5.02 },
    { cut: "c1", gen: "p", track: 3, dur: 5, kind: "image" }, // 그림은 재지 않는다
    { cut: "c2", gen: "d", track: 1, dur: 8 }, // 옛 요청 길이 — 잰 적이 없다
    { cut: "c2", gen: "f", track: 2 }, // 길이가 안 적혔다
  ]);
  await mount();
  expect(asked()).toEqual(["d", "f", "m", "n"]);

  await arrive("m", 5.5);
  await arrive("n", 5.03); // 적힌 것과 한 프레임 안이어도 다르면 고쳐 적는다(2026-10-14 — 옛 '소리까지 친 길이'가 남지 않게)
  await arrive("d", 10.04);
  await arrive("f", 5.6);
  act(() => { vi.advanceTimersByTime(MEASURE_SAVE_MS); });
  expect(durs()).toEqual({ m: 5.5, n: 5.03, p: 5, d: 10.04, f: 5.6 });

  // 페이지를 새로 열었다(기억해 둔 값이 없다) — 잰 값이 적혀 있어도 다시 전부 묻는다
  act(() => root.unmount());
  root = createRoot(host);
  probes.asked.length = 0;
  for (const map of [probes.known, probes.inflight, probes.finish]) map.clear();
  await mount();
  expect(asked()).toEqual(["d", "f", "m", "n"]);
  expect(flashed).toEqual([]);
});

it("잰 값은 모아서 한 번에 적는다 — 클립마다 저장하지 않는다", async () => {
  world.gens = [video("m", "c1", 5), video("n", "c1", 5), video("d", "c2", 5)];
  seed([{ cut: "c1", gen: "m", track: 1, dur: 5 }, { cut: "c1", gen: "n", track: 2, dur: 5 }, { cut: "c2", gen: "d", track: 1, dur: 5 }]);
  await mount();
  const writes = countWrites();
  await arrive("m", 5.5);
  await arrive("n", 6.5);
  expect([writes(), durs()]).toEqual([0, { m: 5, n: 5, d: 5 }]); // 아직 모으는 중
  act(() => { vi.advanceTimersByTime(MEASURE_SAVE_MS - 1); });
  await arrive("d", 7.5); // 그 사이에 온 것은 같이 간다
  expect(writes()).toBe(0);
  act(() => { vi.advanceTimersByTime(1); });
  expect([writes(), durs()]).toEqual([1, { m: 5.5, n: 6.5, d: 7.5 }]);
  await settle();
  act(() => { vi.advanceTimersByTime(MEASURE_SAVE_MS * 4); }); // 적은 뒤에 또 적지 않는다
  expect(writes()).toBe(1);
});

it("모으는 중에 문서가 바뀌면 그 자리에서 적는다 — 잰 값이 그 편집에 밀려 사라지지 않고, 같은 값을 또 적지도 않는다", async () => {
  world.gens = [video("m", "c1", 5)];
  seed([{ cut: "c1", gen: "m", track: 1, dur: 5 }]);
  await mount();
  const writes = countWrites();
  await arrive("m", 5.5);
  expect(durs()).toEqual({ m: 5 });
  await act(async () => document.querySelector<HTMLButtonElement>(".ed-hbtn.ed-mute")!.click()); // 사용자의 편집(소리 끄기)
  expect(durs()).toEqual({ m: 5.5 });
  expect(JSON.parse(localStorage.getItem(DOC_KEY)!).muted).toBe(true);
  expect(writes()).toBe(2); // 그 편집 + 모으던 길이
  act(() => { vi.advanceTimersByTime(MEASURE_SAVE_MS * 4); });
  expect(writes()).toBe(2);
});

it("모으는 중에 탭을 떠나도 잰 값은 버려지지 않는다 — 떠나는 자리에서 적는다", async () => {
  world.gens = [video("m", "c1", 5)];
  seed([{ cut: "c1", gen: "m", track: 1, dur: 5 }]);
  await mount();
  await arrive("m", 5.5);
  expect(durs()).toEqual({ m: 5 });
  act(() => root.unmount()); // 다른 탭으로
  expect(durs()).toEqual({ m: 5.5 });
  root = createRoot(host);
});

it("모으는 중에 시퀀스를 바꾸면 그 값은 버려진다(다른 문서에 적지 않는다) — 돌아오면 다시 재어 적는다", async () => {
  world.gens = [video("m", "c1", 5)];
  seed([{ cut: "c1", gen: "m", track: 1, dur: 5 }]);
  await mount();
  await arrive("m", 5.5);
  await pickSeq("e071");
  expect(seqShown()).toBe("e071");
  act(() => { vi.advanceTimersByTime(MEASURE_SAVE_MS * 2); });
  expect(durs()).toEqual({ m: 5 }); // 옛 문서는 안 잰 값 그대로다 — 그래서 다음에 다시 잰다
  expect(localStorage.getItem(docKey("e071"))).toBeNull(); // 새로 연 문서에 섞여 들어가지도 않았다

  probes.asked.length = 0;
  await pickSeq("e070");
  expect(asked()).toEqual(["m"]);
  act(() => { vi.advanceTimersByTime(MEASURE_SAVE_MS); });
  expect(durs()).toEqual({ m: 5.5 });
  expect(flashed).toEqual([]);
});
