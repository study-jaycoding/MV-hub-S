// @vitest-environment jsdom
// 컷 정보 창(휠 클릭)과 모아보기(개별·연결) — 목록을 끝까지 받아 세고, 재생기는 컷 이동·반복·길이를 모르는 동안의 잠금.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FolderCard, GenQuery, Generation } from "../src/types";

const listGenerations = vi.hoisted(() => vi.fn());
const generationMetrics = vi.hoisted(() => vi.fn());
vi.mock("../src/api", () => ({
  api: { listGenerations, generationMetrics, thumbOrRaw: (path: string) => path },
  GEN_PAGE: 200,
}));
// 모델 이름 카탈로그는 서버 조회 — 여기선 코드 그대로
vi.mock("../src/lib/modelCatalog", () => ({
  useModelDisplayName: () => (code?: string | null) => code ?? "—",
  modelDisplayName: (code?: string | null) => code ?? "—",
}));

import { CutInfoPopup } from "../src/components/CutInfoPopup";
import { CutReel, ReelPlayer } from "../src/components/CutReel";
import type { ReelClip } from "../src/lib/cutReel";

const gen = (id: string, extra: Partial<Generation> = {}): Generation => ({
  id, project_id: "p1", project_name: "뻘뻘뻘", folder_path: "e035/C0290", created_at: "2026-10-03 10:00:00", sort_ts: 1,
  model: "seedance-2.5", params: { duration: "5" }, prompt: `prompt ${id}`, creator_name: "리버", is_mine: false,
  assets: [{ type: "video", file_path: `/m/${id}.mp4`, thumbnail_path: `/m/${id}.png` }], tags: [], auto_tags: [], references: [],
  ...extra,
} as unknown as Generation);
const card = (name: string, rep = false, type: "image" | "video" = "video"): FolderCard => ({
  path: `e035/${name}`, name, count: 3, rep,
  cover: gen(`cover-${name}`, { folder_path: `e035/${name}`, assets: [{ type, file_path: `/m/${name}.${type === "video" ? "mp4" : "png"}`, thumbnail_path: null }] }),
});
const query: GenQuery = { tab: "team", project_id: "p1", folder_path: "e035/C0290", colors: [], tags: [], auto_tags: [] };

let root: Root;
let host: HTMLDivElement;
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  listGenerations.mockReset();
  generationMetrics.mockReset();
  generationMetrics.mockImplementation(async (id: string) => ({ real_credits: id === "b" ? null : 1.5, est_credits: null, credit_source: null, elapsed_seconds: null }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const rows = () => Object.fromEntries([...host.querySelectorAll(".info-row")].map((row) => [row.querySelector(".info-label")!.textContent, row.querySelector(".info-value")!.textContent]));

it("컷 정보 — 폴더 창과 같은 조회를 끝까지 받아(쪽 넘김) 대소문자가 다른 폴더를 빼고 센다. 많으면 크레딧은 안 세고 생성물 줄은 200장", async () => {
  // 첫 쪽 500건(한도) → 다음 쪽 2건. 서버 LIKE 가 섞어 준 'E035/C0290' 은 뺀다.
  const first = Array.from({ length: 500 }, (_, i) => gen(`g${i}`, { creator_name: i % 2 ? "오지짱" : "리버" }));
  const second = [gen("a", { created_at: "2026-10-07 18:15:00", is_final: true }), gen("b", { folder_path: "E035/C0290", created_at: "2026-10-09 00:00:00" })];
  listGenerations.mockImplementation(async (_q: GenQuery, cursor: { id: string } | null) => (cursor ? second : first));
  const folder = card("C0290");
  act(() => root.render(
    <CutInfoPopup folder={folder} x={10} y={10} query={query} savingRep={false} previewOpen={false} onClose={() => {}} onOpen={() => {}} onPreview={() => {}} onPickCover={() => {}} />,
  ));
  expect(rows()["건수"]).toBe("3 · 받는 중…");
  await settle();
  await settle();
  expect(listGenerations).toHaveBeenCalledTimes(2);
  expect(listGenerations.mock.calls[1][1]).toEqual({ ts: 1, id: "g499" }); // 커서 = 첫 쪽 마지막
  expect(rows()["건수"]).toBe("501영상 501 · 이미지 0");
  expect(rows()["작업자"]).toBe("리버 251 · 오지짱 250");
  expect(rows()["크레딧(실제)"]).toBe("건수가 많아 집계하지 않음");
  expect(generationMetrics).not.toHaveBeenCalled(); // 건마다 요청이라 많으면 안 보낸다
  expect(rows()["총 길이"]).toBe("2505.0s");
  expect(rows()["검토"]).toBe("공유 500보류 0 · 최종 1");
  expect(rows()["생성일"]).toContain("~");
  expect(host.querySelector(".cutinfo-tag")!.textContent).toBe("대표 미정 · 최신 것");
  expect(host.querySelector(".info-sources-head")!.textContent).toBe("이 컷의 생성물 501개최근 200개만 · 외 301건");
  expect(host.querySelectorAll(".cutinfo-item")).toHaveLength(200);
});

it("컷 정보 — 작은 컷은 크레딧(실제) 합계 + 미상 건수. ★ 로 대표, 누르면 크게 보기, [폴더 열기]", async () => {
  const gens = [gen("g0"), gen("a", { created_at: "2026-10-07 18:15:00", is_final: true }), gen("b", { creator_name: "오지짱" })];
  listGenerations.mockResolvedValue(gens);
  const folder = card("C0290");
  const onPickCover = vi.fn();
  const onOpen = vi.fn();
  const onPreview = vi.fn();
  act(() => root.render(
    <CutInfoPopup folder={folder} x={10} y={10} query={query} savingRep={false} previewOpen={false} onClose={() => {}} onOpen={onOpen} onPreview={onPreview} onPickCover={onPickCover} />,
  ));
  await settle();
  await settle();
  expect(listGenerations).toHaveBeenCalledTimes(1);
  expect(generationMetrics).toHaveBeenCalledTimes(3);
  expect(rows()["건수"]).toBe("3영상 3 · 이미지 0");
  expect(rows()["크레딧(실제)"]).toBe("3 credits · 1건 미상"); // b 는 실제값 없음
  expect(rows()["검토"]).toBe("공유 2보류 0 · 최종 1");
  expect(host.querySelector(".info-sources-head")!.textContent).toBe("이 컷의 생성물 3개");

  act(() => host.querySelector<HTMLButtonElement>(".cutinfo-item .cutinfo-rep")!.click());
  expect(onPickCover).toHaveBeenCalledWith(folder, expect.objectContaining({ id: "g0" }));
  act(() => host.querySelector<HTMLButtonElement>(".cutinfo-item .info-source")!.click());
  expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ url: "/m/g0.mp4", genId: "g0", index: 0, items: expect.any(Array) }));
  act(() => host.querySelector<HTMLButtonElement>(".info-board-btn")!.click());
  expect(onOpen).toHaveBeenCalledWith(folder);

  // 대표가 정해진 카드로 다시 그리면 표가 바뀌고 그 칸의 ★ 는 '지금 대표' 로 잠긴다
  const repFolder = { ...folder, rep: true, cover: gens[0] };
  act(() => root.render(
    <CutInfoPopup folder={repFolder} x={10} y={10} query={query} savingRep={false} previewOpen={false} onClose={() => {}} onOpen={onOpen} onPreview={onPreview} onPickCover={onPickCover} />,
  ));
  expect(host.querySelector(".cutinfo-tag")!.textContent).toBe("★ 대표");
  expect(host.querySelector<HTMLButtonElement>(".cutinfo-item.cur .cutinfo-rep")!.disabled).toBe(true);
});

it("컷 정보 — 2000건을 넘으면 '최근 2000건 기준'. 목록을 못 받으면 그 까닭", async () => {
  listGenerations.mockImplementation(async () => Array.from({ length: 500 }, (_, i) => gen(`g${i}`)));
  act(() => root.render(
    <CutInfoPopup folder={card("C0290")} x={0} y={0} query={query} savingRep={false} previewOpen={false} onClose={() => {}} onOpen={() => {}} onPreview={() => {}} onPickCover={() => {}} />,
  ));
  await settle();
  await settle();
  expect(listGenerations).toHaveBeenCalledTimes(4);
  expect(rows()["건수"]).toContain("최근 2000건 기준");

  listGenerations.mockRejectedValue(new Error("network"));
  act(() => root.render(
    <CutInfoPopup folder={card("C0300")} x={0} y={0} query={query} savingRep={false} previewOpen={false} onClose={() => {}} onOpen={() => {}} onPreview={() => {}} onPickCover={() => {}} />,
  ));
  await settle();
  expect(rows()["건수"]).toContain("목록을 받지 못했습니다 — network");
});

it("모아보기 — 개별은 큰 카드 + 정보(크레딧은 표지마다), 연결은 재생기. 토글·닫기", async () => {
  const folders = [card("C0050", false, "image"), card("C0080", true), card("C0110")];
  const onModeChange = vi.fn();
  const onClose = vi.fn();
  const onPreview = vi.fn();
  act(() => root.render(<CutReel folders={folders} mode="grid" onModeChange={onModeChange} previewOpen={false} onClose={onClose} onPreview={onPreview} />));
  await settle();
  expect(host.querySelector(".reel-sub")!.textContent).toBe("3컷 · 대표 1 · 최신 2");
  const cards = [...host.querySelectorAll(".reel-card")];
  expect(cards.map((c) => c.querySelector(".reel-ttl > b")!.textContent)).toEqual(["C0050", "C0080", "C0110"]);
  expect(cards.map((c) => c.querySelector(".reel-rep")!.textContent)).toEqual(["최신 것", "★ 대표", "최신 것"]);
  expect(cards.map((c) => c.querySelector(".reel-order")!.textContent)).toEqual(["1", "2", "3"]);
  expect(cards[1].querySelector(".reel-info")!.textContent).toContain("1.5 credits");
  act(() => cards[1].querySelector<HTMLButtonElement>(".reel-face")!.click());
  expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ url: "/m/C0080.mp4", index: 1 }));
  act(() => host.querySelector<HTMLButtonElement>(".reel-seg button:nth-child(2)")!.click());
  expect(onModeChange).toHaveBeenCalledWith("linked");
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
  expect(onClose).toHaveBeenCalledTimes(1);
  // 크게 보기가 위에 떠 있으면 Esc 는 그쪽 몫
  act(() => root.render(<CutReel folders={folders} mode="grid" onModeChange={onModeChange} previewOpen onClose={onClose} onPreview={onPreview} />));
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("연결 재생기 — 컷 이동(단추·↑↓·이름)·반복·길이를 다 알기 전엔 타임바 잠금·이미지 컷 3초", () => {
  // jsdom 은 영상 메타데이터를 못 읽는다 — 영상 길이는 영영 0(= 아직 모름) 이고, 이미지만 3초
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  const clips: ReelClip[] = [
    { path: "e035/C0050", name: "C0050", url: "/m/a.png", type: "image", thumb: null, worker: "리버", rep: false },
    { path: "e035/C0080", name: "C0080", url: "/m/b.mp4", type: "video", thumb: "/m/b.png", worker: "오지짱", rep: true },
    { path: "e035/C0110", name: "C0110", url: "/m/c.png", type: "image", thumb: null, worker: "리버", rep: false },
  ];
  try {
    act(() => root.render(<ReelPlayer clips={clips} />));
    const chip = () => host.querySelector(".reel-chip.l")!.textContent;
    const vtc = () => host.querySelector(".reel-vtc")!.textContent;
    expect(chip()).toBe("1 / 3 · C0050 · 리버");
    expect(host.querySelector(".reel-screen img")).not.toBeNull();
    expect(vtc()).toBe("0:00.0 / …"); // 영상 길이를 아직 모른다
    expect(host.querySelector(".reel-scrub")!.classList.contains("wait")).toBe(true);
    expect([...host.querySelectorAll(".reel-labels button")].map((b) => b.textContent)).toEqual(["C0050", "C0080", "C0110"]);
    act(() => host.querySelector<HTMLButtonElement>(".reel-t-next")!.click());
    expect(chip()).toBe("2 / 3 · C0080 · 오지짱");
    expect(host.querySelector(".reel-chip.r")!.textContent).toBe("★ 대표");
    expect(host.querySelector(".reel-screen video")!.getAttribute("src")).toBe("/m/b.mp4");
    // 재생 중 깨진 영상 — 3초 멈춘 안내 화면이 되고 길이를 알게 돼 타임바가 풀린다(3 + 3 + 3)
    act(() => { host.querySelector(".reel-screen video")!.dispatchEvent(new Event("error")); });
    expect(host.querySelector(".reel-broken")!.textContent).toBe("재생할 수 없는 영상");
    expect(vtc()).toBe("0:03.0 / 0:09.0");
    expect(host.querySelector(".reel-scrub")!.classList.contains("wait")).toBe(false);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" })); });
    expect(chip()).toBe("3 / 3 · C0110 · 리버");
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" })); }); // 끝에서 더는 안 간다
    expect(chip()).toBe("3 / 3 · C0110 · 리버");
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" })); });
    expect(chip()).toBe("2 / 3 · C0080 · 오지짱");
    act(() => host.querySelector<HTMLButtonElement>(".reel-labels button:first-child")!.click());
    expect(chip()).toBe("1 / 3 · C0050 · 리버");
    act(() => host.querySelector<HTMLButtonElement>(".reel-t-last")!.click());
    expect(chip()).toBe("3 / 3 · C0110 · 리버");
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" })); });
    expect(chip()).toBe("1 / 3 · C0050 · 리버");
    // 반복 단추는 켜진 채 시작 — 누르면 끈다
    const loop = host.querySelector<HTMLButtonElement>(".reel-t-loop")!;
    expect(loop.classList.contains("on")).toBe(true);
    act(() => loop.click());
    expect(loop.classList.contains("on")).toBe(false);
    // 입력칸에 초점이 있으면 키를 먹지 않는다
    const input = document.createElement("input");
    host.appendChild(input);
    act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    expect(chip()).toBe("1 / 3 · C0050 · 리버");
    // 재생/정지
    const play = host.querySelector<HTMLButtonElement>(".reel-play")!;
    act(() => play.click());
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: " " })); });
    expect(play.getAttribute("aria-label")).toBe("재생/정지 (Space)");
  } finally {
    raf.mockRestore();
  }
  // 이미지만이면 길이를 다 안다 — 타임바가 풀리고 총 길이 = 3초 × 2
  act(() => root.render(<ReelPlayer key="two" clips={[clips[0], clips[2]]} />)); // 클립이 바뀌면 모아보기가 key 로 다시 올린다
  expect(host.querySelector(".reel-vtc")!.textContent).toBe("0:00.0 / 0:06.0");
  expect(host.querySelector(".reel-scrub")!.classList.contains("wait")).toBe(false);
  expect(host.querySelectorAll(".reel-track > i")).toHaveLength(1); // 컷 경계 눈금
});
