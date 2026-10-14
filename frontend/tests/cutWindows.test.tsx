// @vitest-environment jsdom
// 컷 정보 창(휠 클릭)과 모아보기(개별·연결) — 목록을 끝까지 받아 세고, 재생기는 컷 이동·반복·길이를 모르는 동안의 잠금.
import { act, StrictMode } from "react";
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
  // 검토 줄 = 그 폴더 안의 개수(Jay 2026-10-13): 첫 카드는 서버가 수를 안 준 것(옛 공유 서버), 둘째는 공유·최종·보류가 다 있는 것, 셋째는 공유뿐
  const folders = [
    card("C0050", false, "image"),
    { ...card("C0080", true), count: 12, final_count: 2, held_count: 1 },
    { ...card("C0110"), count: 5, final_count: 0, held_count: 0 },
  ];
  const onModeChange = vi.fn();
  const onClose = vi.fn();
  const onPreview = vi.fn();
  const onEnter = vi.fn();
  act(() => root.render(<CutReel folders={folders} mode="grid" onModeChange={onModeChange} previewOpen={false} onClose={onClose} onPreview={onPreview} onEnter={onEnter} />));
  await settle();
  expect(host.querySelector(".reel-sub")!.textContent).toBe("3컷 · 대표 1 · 최신 2");
  const cards = [...host.querySelectorAll(".reel-card")];
  expect(cards.map((c) => c.querySelector(".reel-ttl > b")!.textContent)).toEqual(["C0050", "C0080", "C0110"]);
  expect(cards.map((c) => c.querySelector(".reel-rep")!.textContent)).toEqual(["최신 것", "★ 대표", "최신 것"]);
  expect(cards.map((c) => c.querySelector(".reel-order")!.textContent)).toEqual(["1", "2", "3"]);
  expect(cards[1].querySelector(".reel-info")!.textContent).toContain("1.5 credits");
  // 정보 줄의 순서 — 모델이 맨 위 한 줄(전엔 이름 오른쪽에 작게), 길이는 그 옆에
  const info = (c: Element) => [...c.querySelectorAll(".reel-info > .k")].map((k) => [k.textContent, k.nextElementSibling!.textContent]);
  expect(info(cards[1]).map(([k]) => k)).toEqual(["모델", "작업자", "크레딧", "생성일", "검토"]);
  expect([info(cards[1])[0][1]!.endsWith(" · 5.0s"), cards[1].querySelector(".reel-info i")!.textContent, cards[1].querySelector(".reel-ttl > span")]).toEqual([true, "5.0s", null]);
  // 검토 — 0 인 것은 감추고 끝에 전체. 수가 없으면(옛 서버) 전처럼 표지 한 장의 상태
  const review = (c: Element) => [...c.querySelectorAll(".reel-rv > span")].map((s) => `${s.className}|${s.textContent}`);
  expect(review(cards[1])).toEqual(["|공유 9", "fin|★ 최종 2", "held|R 1", "all|전체 12"]);
  expect(review(cards[2])).toEqual(["|공유 5", "all|전체 5"]);
  expect([cards[0].querySelector(".reel-rv"), info(cards[0])[4][1]]).toEqual([null, "공유"]);
  // [폴더로] — 그 컷 폴더를 넘긴다(크게 보기는 열지 않는다)
  act(() => cards[1].querySelector<HTMLButtonElement>(".reel-go")!.click());
  expect(onEnter).toHaveBeenCalledExactlyOnceWith(folders[1]);
  expect(onPreview).not.toHaveBeenCalled();
  act(() => cards[1].querySelector<HTMLButtonElement>(".reel-face")!.click());
  expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ url: "/m/C0080.mp4", index: 1 }));
  act(() => host.querySelector<HTMLButtonElement>(".reel-seg button:nth-child(2)")!.click());
  expect(onModeChange).toHaveBeenCalledWith("linked");
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
  expect(onClose).toHaveBeenCalledTimes(1);
  // 크게 보기가 위에 떠 있으면 Esc 는 그쪽 몫
  act(() => root.render(<CutReel folders={folders} mode="grid" onModeChange={onModeChange} previewOpen onClose={onClose} onPreview={onPreview} onEnter={onEnter} />));
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
    expect(host.querySelector(".reel-media:not(.spare)")!.getAttribute("src")).toBe("/m/b.mp4"); // 앞의 것
    // 재생 중 깨진 영상 — 3초 멈춘 안내 화면이 되고 길이를 알게 돼 타임바가 풀린다(3 + 3 + 3)
    act(() => { host.querySelector(".reel-media:not(.spare)")!.dispatchEvent(new Event("error")); });
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

it("연결 재생기 — 영상 요소 둘: 뒤의 것이 다음 영상을 미리 받아 두고, 넘어갈 때 자리만 바꾼다(이미지 컷은 건너뛰어 그 뒤 영상을 준비)", () => {
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  const loadSpy = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const clips: ReelClip[] = [
    { path: "e/C1", name: "C1", url: "/m/a.mp4", type: "video", thumb: null, worker: "리버", rep: false },
    { path: "e/C2", name: "C2", url: "/m/b.mp4", type: "video", thumb: null, worker: "리버", rep: false },
    { path: "e/C3", name: "C3", url: "/m/c.png", type: "image", thumb: null, worker: "리버", rep: false },
    { path: "e/C4", name: "C4", url: "/m/a.mp4", type: "video", thumb: null, worker: "리버", rep: false },
  ];
  try {
    act(() => root.render(<ReelPlayer clips={clips} />));
    const frontEl = () => host.querySelector<HTMLVideoElement>(".reel-media:not(.spare)")!;
    const spareEl = () => host.querySelector<HTMLVideoElement>(".reel-media.spare")!;
    expect(host.querySelectorAll("video.reel-media")).toHaveLength(2); // 요소 둘, 떼지 않는다
    expect([frontEl().getAttribute("src"), spareEl().getAttribute("src")]).toEqual(["/m/a.mp4", "/m/b.mp4"]); // 앞 = 지금, 뒤 = 다음
    const first = frontEl();
    act(() => { frontEl().dispatchEvent(new Event("ended")); }); // 1 → 2: 뒤의 것이 b 를 들고 있다 — 자리만 바꾼다
    expect(frontEl()).not.toBe(first);
    expect(frontEl().getAttribute("src")).toBe("/m/b.mp4");
    expect(spareEl()).toBe(first);
    expect(spareEl().getAttribute("src")).toBe("/m/a.mp4"); // 이미지 C3 를 건너뛴 다음 영상 C4 = a — 이미 들고 있어 다시 안 받는다
    expect(host.querySelector(".reel-chip.l")!.textContent).toBe("2 / 4 · C2 · 리버");
    act(() => { spareEl().dispatchEvent(new Event("ended")); }); // 뒤의 것이 내는 ended 는 무시
    expect(host.querySelector(".reel-chip.l")!.textContent).toBe("2 / 4 · C2 · 리버");
    act(() => { frontEl().dispatchEvent(new Event("ended")); }); // 2 → 3(이미지): 영상은 숨고 뒤의 것은 그대로 a
    expect(host.querySelector(".reel-screen img")).not.toBeNull();
    expect([...host.querySelectorAll<HTMLVideoElement>("video.reel-media")].every((v) => v.hidden)).toBe(true);
    // 이미지 컷 동안 앞의 것이 내는 늦은 이벤트는 무시 — 이미지가 '깨진 영상' 이 되거나 컷이 넘어가지 않는다
    act(() => { frontEl().dispatchEvent(new Event("error")); frontEl().dispatchEvent(new Event("ended")); });
    expect(host.querySelector(".reel-broken")).toBeNull();
    expect(host.querySelector(".reel-chip.l")!.textContent).toBe("3 / 4 · C3 · 리버");
    act(() => host.querySelector<HTMLButtonElement>(".reel-t-next")!.click()); // 3 → 4(a): 자리 바꾸기
    expect(frontEl().getAttribute("src")).toBe("/m/a.mp4");
    expect(frontEl()).toBe(first);
    expect(spareEl().getAttribute("src")).toBe("/m/a.mp4"); // 반복 켜짐 → 다음은 처음(C1 = a) — 같은 주소라 그대로
    // 닫으면 두 요소의 주소를 뗀다(정리 때 ref 가 비어 있어도 — 효과를 걸 때 잡아 둔 요소로)
    const both = [...host.querySelectorAll<HTMLVideoElement>("video.reel-media")];
    act(() => root.render(null));
    expect(both.every((v) => !v.hasAttribute("src"))).toBe(true);
    // 개발 모드(StrictMode)의 거짓 정리 뒤에도 첫 영상이 올라온다
    act(() => root.render(<StrictMode><ReelPlayer clips={clips} /></StrictMode>));
    expect(host.querySelector<HTMLVideoElement>(".reel-media:not(.spare)")!.getAttribute("src")).toBe("/m/a.mp4");
    expect(host.querySelector<HTMLVideoElement>(".reel-media.spare")!.getAttribute("src")).toBe("/m/b.mp4");
  } finally {
    raf.mockRestore();
    loadSpy.mockRestore();
    pauseSpy.mockRestore();
  }
});

// ── 10-09 Codex 코드 검토 — 다시 받기·닫은 뒤 요청·미리 읽기 ──
it("컷 정보 — 조회 조건이 같으면 카드 객체가 바뀌어도 다시 받지 않고, 닫으면 남은 요청(다음 쪽·metrics)을 보내지 않는다", async () => {
  const gens = [gen("g0"), gen("a"), gen("b")];
  listGenerations.mockResolvedValue(gens);
  const folder = card("C0290");
  const draw = (f: FolderCard) => act(() => root.render(
    <CutInfoPopup folder={f} x={0} y={0} query={query} savingRep={false} previewOpen={false} onClose={() => {}} onOpen={() => {}} onPreview={() => {}} onPickCover={() => {}} />,
  ));
  draw(folder);
  await settle();
  await settle();
  expect(listGenerations).toHaveBeenCalledTimes(1);
  expect(generationMetrics).toHaveBeenCalledTimes(3);
  draw({ ...folder, rep: true, cover: gens[1] }); // 카드가 다시 왔다(대표 바뀜) — 조건은 같다
  await settle();
  expect(listGenerations).toHaveBeenCalledTimes(1);
  expect(generationMetrics).toHaveBeenCalledTimes(3);

  // 목록 응답이 오기 전에 닫는다 → 응답이 와도 metrics 를 보내지 않는다
  let release!: (value: Generation[]) => void;
  listGenerations.mockImplementationOnce(() => new Promise<Generation[]>((resolve) => { release = resolve; }));
  generationMetrics.mockClear();
  draw({ ...card("C0300"), path: "e035/C0300" });
  await settle();
  act(() => root.render(null));
  await act(async () => { release(gens); });
  await settle();
  await settle();
  expect(generationMetrics).not.toHaveBeenCalled();
});

// 2026-10-13 밤(배포 전 점검, Codex): 생성물이 200건 이하면 크레딧 요청을 한꺼번에 보냈다 — 넷씩 보내고, 닫으면 남은 것은 보내지 않는다.
it("컷 정보 — 크레딧 요청은 한꺼번에 넷만, 끝나는 대로 다음. 닫으면 아직 안 보낸 것은 보내지 않는다", async () => {
  const gens = ["g0", "g1", "g2", "g3", "g4", "g5", "g6"].map((id) => gen(id));
  listGenerations.mockResolvedValue(gens);
  const waiting = new Map<string, (value: { real_credits: number }) => void>();
  generationMetrics.mockImplementation((id: string) => new Promise((resolve) => { waiting.set(id, resolve); }));
  const asked = () => generationMetrics.mock.calls.map((call) => call[0]);
  act(() => root.render(
    <CutInfoPopup folder={card("C0290")} x={0} y={0} query={query} savingRep={false} previewOpen={false} onClose={() => {}} onOpen={() => {}} onPreview={() => {}} onPickCover={() => {}} />,
  ));
  await settle();
  await settle();
  expect(asked()).toEqual(["g0", "g1", "g2", "g3"]);
  await act(async () => { waiting.get("g1")!({ real_credits: 1 }); });
  await settle();
  expect(asked()).toEqual(["g0", "g1", "g2", "g3", "g4"]);
  act(() => root.render(null)); // 닫았다
  await act(async () => { for (const id of ["g0", "g2", "g3", "g4"]) waiting.get(id)!({ real_credits: 1 }); });
  await settle();
  expect(asked()).toEqual(["g0", "g1", "g2", "g3", "g4"]); // g5·g6 은 나가지 않았다
});

// Codex 재검토(10-13 밤): 정보 창의 크레딧 요청에 시간 제한·취소가 없었다 — 앞의 넷이 멎으면 나머지가 출발하지 못해 '집계 중…'에 머물고,
//  그 상태에서 다른 컷의 정보 창을 열면 멎은 넷을 남긴 채 새 요청이 더 나갔다.
it("컷 정보 — 멎은 크레딧 요청은 20초 뒤 끊고 미상으로 둔 채 다음으로 간다. 닫으면 받는 중인 요청도 끊는다", async () => {
  vi.useFakeTimers();
  try {
    const gens = ["g0", "g1", "g2", "g3", "g4", "g5"].map((id) => gen(id));
    listGenerations.mockResolvedValue(gens);
    const aborted: string[] = [];
    generationMetrics.mockImplementation((id: string, signal?: AbortSignal) => {
      signal?.addEventListener("abort", () => aborted.push(id));
      return id === "g4" ? Promise.resolve({ real_credits: 2, est_credits: null, credit_source: null, elapsed_seconds: null }) : new Promise(() => {});
    });
    const asked = () => generationMetrics.mock.calls.map((call) => call[0]);
    act(() => root.render(
      <CutInfoPopup folder={card("C0290")} x={0} y={0} query={query} savingRep={false} previewOpen={false} onClose={() => {}} onOpen={() => {}} onPreview={() => {}} onPickCover={() => {}} />,
    ));
    await settle();
    await settle();
    expect([asked(), rows()["크레딧(실제)"]]).toEqual([["g0", "g1", "g2", "g3"], "집계 중…"]);
    await act(async () => { vi.advanceTimersByTime(20_000); });
    await settle();
    await settle();
    expect([asked(), aborted]).toEqual([["g0", "g1", "g2", "g3", "g4", "g5"], ["g0", "g1", "g2", "g3"]]); // 멎은 넷을 끊고 다음 둘이 나갔다
    act(() => root.render(null)); // 닫았다 — 받는 중이던 g5 도 끊는다
    await settle();
    expect(aborted).toEqual(["g0", "g1", "g2", "g3", "g5"]);
  } finally {
    vi.useRealTimers();
  }
});

it("모아보기 연결 — 같은 주소의 영상은 길이를 한 번만 읽고, 내용이 같은 카드 배열이 다시 와도 다시 읽지 않으며, 닫으면 주소를 뗀다", () => {
  const created: HTMLVideoElement[] = [];
  const realCreate = document.createElement.bind(document);
  const createSpy = vi.spyOn(document, "createElement").mockImplementation(((tag: string, options?: ElementCreationOptions) => {
    const el = realCreate(tag, options);
    if (tag === "video") created.push(el as HTMLVideoElement);
    return el;
  }) as typeof document.createElement);
  const loadSpy = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  try {
    const dup = card("C0090");
    dup.cover = gen("cover-C0090", { folder_path: "e035/C0090", assets: [{ type: "video", file_path: "/m/C0080.mp4", thumbnail_path: null }] });
    const folders = [card("C0080"), dup, card("C0110")];
    const draw = (list: FolderCard[]) => act(() => root.render(
      <CutReel folders={list} mode="linked" onModeChange={() => {}} previewOpen={false} onClose={() => {}} onPreview={() => {}} onEnter={() => {}} />,
    ));
    draw(folders);
    const probes = created.filter((v) => !v.isConnected); // 화면에 붙지 않은 것 = 미리 읽기
    expect(probes.map((v) => v.getAttribute("src"))).toEqual(["/m/C0080.mp4", "/m/C0110.mp4"]); // 같은 주소(C0080·C0090)는 하나
    const before = created.length;
    draw(folders.map((f) => ({ ...f }))); // 내용이 같은 새 배열 — 다시 읽지 않는다
    expect(created.length).toBe(before);
    act(() => root.render(null));
    expect(probes.every((v) => !v.hasAttribute("src") && v.onloadedmetadata === null)).toBe(true);
    expect(loadSpy).toHaveBeenCalled();
  } finally {
    createSpy.mockRestore();
    loadSpy.mockRestore();
  }
});

it("연결 재생기 — 타임바로 컷을 넘긴 뒤 늦게 도는 옛 컷의 시간 틱은 새 자리를 덮지 않는다(이미지 컷을 건너뛰지 않는다)", () => {
  // 2026-10-10 실측: 재생 중 타임바를 끌어 다른 컷으로 가면(mousemove 는 React 가 바로 다시 그리지 않는다) 옛 컷의 틱이 한 번 더 돌아
  //  그 시각을 써 넣었고, 이미지 컷은 곧바로 '끝'으로 보고 다음 컷으로 넘어갔다. 여기서는 옛 틱을 잡아 두었다가 옮긴 뒤에 돌린다.
  const ticks: FrameRequestCallback[] = [];
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => ticks.push(callback));
  const still = (name: string): ReelClip => ({ path: `e035/${name}`, name, url: `/m/${name}.png`, type: "image", thumb: null, worker: "리버", rep: false });
  try {
    act(() => root.render(<ReelPlayer clips={[still("C0010"), still("C0020"), still("C0030")]} />)); // 3초 × 3, 재생 중
    const chip = () => host.querySelector(".reel-chip.l")!.textContent;
    expect(chip()).toBe("1 / 3 · C0010 · 리버");
    const oldTick = ticks[ticks.length - 1];
    expect(oldTick, "첫 컷의 시간 틱").toBeTruthy();
    const track = host.querySelector<HTMLElement>(".reel-track")!;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 900, bottom: 10, width: 900, height: 10, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    act(() => { track.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 450 })); }); // 4.5초 = 두 번째 컷의 1.5초
    act(() => { window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); });
    expect(chip()).toBe("2 / 3 · C0020 · 리버");
    act(() => { oldTick(performance.now() + 5000); }); // 늦게 도는 옛 틱 — 5초가 흘렀다고 본다
    expect(chip()).toBe("2 / 3 · C0020 · 리버");
  } finally {
    raf.mockRestore();
  }
});

it("연결 재생기 — Tab 으로 찾아간 단추의 Space 는 그 단추를 누르는 키다. 마우스로 눌러 초점이 남은 단추에서는 여전히 재생/정지", () => {
  // 2026-10-11 격리 실측(dist_b46): Tab 으로 간 [반복]·[다음 컷]·[닫기]에서 Space 18/18 이 재생/정지로 갔고 단추는 0/18 눌렸다.
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  const still = (name: string): ReelClip => ({ path: `e035/${name}`, name, url: `/m/${name}.png`, type: "image", thumb: null, worker: "리버", rep: false });
  try {
    act(() => root.render(<ReelPlayer clips={[still("C0010"), still("C0020")]} />));
    const playing = () => host.querySelectorAll(".reel-play rect").length === 2; // 정지 그림(막대 둘) = 재생 중
    const loop = host.querySelector<HTMLButtonElement>(".reel-t-loop")!;
    const space = (target: EventTarget) => {
      const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
      act(() => { target.dispatchEvent(event); });
      return event.defaultPrevented;
    };
    expect(playing()).toBe(true);
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })); loop.focus(); }); // Tab 으로 옮겨 온 초점
    expect(space(loop)).toBe(false); // 가져가지 않는다 — 브라우저가 그 단추를 누른다
    expect(playing()).toBe(true);
    act(() => { loop.dispatchEvent(new Event("pointerdown", { bubbles: true })); }); // 마우스로 눌러 남은 초점
    expect(space(loop)).toBe(true);
    expect(playing()).toBe(false);
    // 길게 눌린 Space(반복 keydown)는 막기만 한다 — 재생/정지가 반복마다 뒤집히지 않는다(조작 규칙 38)
    const held = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true, repeat: true });
    act(() => { loop.dispatchEvent(held); });
    expect([held.defaultPrevented, playing()]).toEqual([true, false]);
  } finally {
    raf.mockRestore();
  }
});

it("연결 재생기 — mouseup 을 놓친 타임바 끌기는 단추를 뗀 마우스를 따라오지 않는다", () => {
  // 2026-10-11 격리 실측(dist_b46) 3/3: 끌기 끝 50% 뒤 단추 없는 움직임에 60·70·80·20·10% 로 따라왔다(세로로 300px 벗어나도).
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  const still = (name: string): ReelClip => ({ path: `e035/${name}`, name, url: `/m/${name}.png`, type: "image", thumb: null, worker: "리버", rep: false });
  try {
    act(() => root.render(<ReelPlayer clips={[still("C0010"), still("C0020"), still("C0030")]} />)); // 3초 × 3
    const chip = () => host.querySelector(".reel-chip.l")!.textContent;
    const track = host.querySelector<HTMLElement>(".reel-track")!;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 900, bottom: 10, width: 900, height: 10, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    const move = (clientX: number, buttons: number) => act(() => { window.dispatchEvent(new MouseEvent("mousemove", { clientX, buttons })); });
    act(() => { track.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 100 })); });
    move(450, 1); // 두 번째 컷
    expect(chip()).toBe("2 / 3 · C0020 · 리버");
    move(800, 0); // mouseup 을 놓쳤다 — 세 번째 컷 자리지만 따라가지 않는다
    move(850, 0);
    move(820, 1); // 다른 것을 누른 채의 움직임도
    expect(chip()).toBe("2 / 3 · C0020 · 리버");
  } finally {
    raf.mockRestore();
  }
});
