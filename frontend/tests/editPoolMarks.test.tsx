// @vitest-environment jsdom
// 편집 탭 미디어 풀(Jay 2026-10-23) — r/g/b 색·골드·비활성(회색)이 공유 탭처럼 세 보기 모두에서 구분된다.
//  썸네일 = 라이브러리 카드의 아래 색 띠 + 비활성 회색·빗금 · 메타데이터 = 그림 아래 띠 · 목록 = 줄 왼쪽 막대. 회색은 숨기기를 켜지 않아도 보인다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditCardMenu } from "../src/components/timeline/EditTab";
import type { EditTree } from "../src/lib/useEditSequence";
import type { Generation } from "../src/types";

const gen = (id: string, extra: Partial<Generation> = {}) => ({
  id, job_id: `job-${id}`, status: "done", params: {}, prompt: `prompt ${id}`, folder_path: "e070/c1", project_id: "p1",
  shared: true, is_final: false, is_held: false, is_mine: false, tags: [], auto_tags: [], color: null,
  creator_uid: "u-river", creator_name: "리버", model: "seedance",
  assets: [{ id: `a-${id}`, generation_id: id, type: "image", file_path: `/media/${id}.png`, thumbnail_path: null, source_url: null, cached: true }],
  ...extra,
} as unknown as Generation);

const world = vi.hoisted(() => ({ gens: [] as unknown[] }));
vi.mock("../src/lib/resolveTransfer", async () => ({
  ...(await vi.importActual<typeof import("../src/lib/resolveTransfer")>("../src/lib/resolveTransfer")),
  getResolveConnectionStatus: () => Promise.reject(new Error("안 물었다")),
}));
vi.mock("../src/lib/useEditSequence", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/useEditSequence")>("../src/lib/useEditSequence");
  const counts = { final: 1, held: 0, shared: 3 };
  const tree = { state: "ready", complete: true, note: null, roots: [{
    name: "e070", path: "e070", count: 4, newCount: 0, reviewCounts: counts, children: [
      { name: "c1", path: "e070/c1", count: 4, newCount: 0, reviewCounts: counts }] }] } as unknown as EditTree;
  return {
    ...actual,
    useEditProjects: () => ({
      projects: [{ id: "p1", name: "P1" }], projectsState: "ok", tree, reload: () => {}, reloadCounts: () => {}, freshByProject: {},
    }),
    useEditGenerations: () => ({ state: "ok", gens: world.gens, error: null, complete: true, known: true, reload: () => {} }),
  };
});
vi.mock("../src/lib/useDisabledFolders", () => ({ useDisabledFolders: () => ({}) }));

import { EditTab } from "../src/components/timeline/EditTab";
import { saveDisabledGen } from "../src/lib/deactivated";

let host: HTMLDivElement;
let root: Root;
const cardMenuRef: { current: EditCardMenu | null } = { current: null };
const mount = (view: "meta" | "list" | "thumb") => {
  localStorage.setItem("ch.editTimeline.ui", JSON.stringify({ view }));
  act(() => root.render(
    <EditTab authKey="auth" authReady workspace={{ scope: "team", id: "w1", name: "W" }} keysActive
      flash={() => {}} onOpenCutFolder={() => {}} reloadSignal={0}
      peekPath={null} onPeekMarks={() => {}} cardMenuRef={cardMenuRef} onPreview={() => {}} onCompare={() => {}}
      resolve={{ send: () => {}, sendTimeline: () => new Promise<never>(() => {}), busy: false, pendingCount: 0, timelineBusy: false }}
      onFolderAction={() => {}} />,
  ));
  act(() => [...document.querySelectorAll<HTMLButtonElement>(".ed-cutcell")].find((cell) => cell.textContent === "c1")!.click());
};
// 생성물 id → 그 줄(카드)
const byId = (selector: string) => new Map([...document.querySelectorAll<HTMLElement>(selector)].map((el) => [el.dataset.id!, el]));
// 그 줄의 색 표 — 없으면 null, 골드면 "gold", 아니면 배경색
const colorOf = (row: HTMLElement) => {
  const mark = row.querySelector<HTMLElement>(".ed-pcolor");
  return !mark ? null : mark.classList.contains("ed-pgold") ? "gold" : mark.style.background;
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem("ch.editTimeline.last:local", JSON.stringify({ projectId: "p1", seq: "e070" }));
  localStorage.setItem("mvhub.editDoc:local:p1:e070", JSON.stringify({ v: 1, tracksOff: [], tracksLocked: [], clips: [
    { cut: "e070/c1", gen: "a", track: 1, kind: "image", dur: 5 },
  ] }));
  for (const method of ["load", "pause"] as const) vi.spyOn(HTMLMediaElement.prototype, method).mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  world.gens = [
    gen("a", { color: "#ff5722" }),
    gen("b", { is_final: true, color: "#2196f3" }), // 최종이면 색보다 골드
    gen("c"),
    gen("d", { color: "#4caf50" }),
  ];
  saveDisabledGen(new Set(["c", "d"])); // d 키로 끈 것 — 숨기기는 켜지 않았다
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

it("메타데이터 보기 — 그림 아래 색 띠(최종은 골드), 끈 카드는 숨기기 없이도 회색", () => {
  mount("meta");
  const rows = byId(".ed-prow-meta");
  expect([...rows.keys()].sort()).toEqual(["a", "b", "c", "d"]);
  expect(["a", "b", "c", "d"].map((id) => colorOf(rows.get(id)!))).toEqual(["rgb(255, 87, 34)", "gold", null, "rgb(76, 175, 80)"]);
  expect(rows.get("a")!.querySelector(".ed-pthumb .ed-pcolor")).not.toBeNull(); // 그림 안(아래 변)
  expect(["a", "b", "c", "d"].map((id) => rows.get(id)!.classList.contains("ed-off"))).toEqual([false, false, true, true]);
});

it("목록 보기 — 줄 왼쪽 막대, 끈 줄은 회색", () => {
  mount("list");
  const rows = byId(".ed-prow-list[data-id]");
  expect(["a", "b", "c", "d"].map((id) => colorOf(rows.get(id)!))).toEqual(["rgb(255, 87, 34)", "gold", null, "rgb(76, 175, 80)"]);
  expect(rows.get("a")!.querySelector(":scope > .ed-pcolor")).not.toBeNull();
  expect(["a", "b", "c", "d"].map((id) => rows.get(id)!.classList.contains("ed-off"))).toEqual([false, false, true, true]);
});

it("썸네일 보기 — 라이브러리 카드의 색 띠·골드 그대로 + 끈 카드는 회색·빗금", () => {
  mount("thumb");
  const cards = byId(".ed-card");
  const bar = (id: string) => cards.get(id)!.querySelector<HTMLElement>(".card-colorbar");
  expect(bar("a")!.style.background).toBe("rgb(255, 87, 34)");
  expect(bar("b")!.classList.contains("final")).toBe(true);
  expect(bar("c")).toBeNull();
  expect(["a", "b", "c", "d"].map((id) => cards.get(id)!.classList.contains("ed-off"))).toEqual([false, false, true, true]);
});
