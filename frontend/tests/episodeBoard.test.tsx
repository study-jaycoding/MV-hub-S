// @vitest-environment jsdom
// 공유 & 리뷰 탭의 에피소드 화면 — 리스트 = 에피소드마다 가로 한 줄, 그리드 = 컷 띠가 붙은 카드(Jay 2026-10-13).
//  여기서 고정하는 것: 어느 단계가 에피소드 화면인가 · 번호·컷 띠·대표 진행·'얼마 전'의 규칙 · 서버가 새 집계를 안 주면 그 표시만 빠진다 ·
//  카드 안의 누름(컷 띠의 컷 = 그 컷으로, '+N'·[열기] = 그 에피소드로)에는 격자가 알아볼 표식(data-ep-action)이 붙는다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EpisodeCardBody } from "../src/components/EpisodeCardBody";
import { episodeNumber, isEpisodeLevel, repProgress, sharedAgo, stripOf } from "../src/lib/episodeBoard";
import type { FolderCard, FolderCardChild, Generation } from "../src/types";

vi.mock("../src/lib/i18n", () => ({ useT: () => (text: string) => text }));

const gen = (id: string, type: "image" | "video" = "image") =>
  ({ id, project_id: "p1", assets: [{ id: "a-" + id, type, file_path: `/media/${id}.${type === "video" ? "mp4" : "png"}`, thumbnail_path: null }] }) as unknown as Generation;
const cut = (name: string, count: number, rep = false): FolderCardChild =>
  ({ path: "e020/" + name, name, count, rep, cover: { id: "c-" + name, assets: gen("c-" + name).assets } });
const NAMES = ["c0010", "c0020", "c0030", "c0040", "c0050", "c0060", "c0070"];
const episode = (extra: Partial<FolderCard> = {}): FolderCard => ({
  path: "e020", name: "e020", count: 73, subfolders: 16, rep: true, cover: gen("cover", "video"),
  video_count: 9, rep_count: 3, last_shared_at: "2026-10-12 03:00:00", last_shared_by: "리버",
  children: NAMES.map((name, index) => cut(name, index + 1, index % 2 === 0)),
  ...extra,
});
const NOW = Date.parse("2026-10-13T04:30:00Z");

describe("에피소드 화면의 규칙", () => {
  it("하위 폴더를 가진 카드가 하나라도 있는 단계가 에피소드 화면이다", () => {
    expect(isEpisodeLevel([episode()])).toBe(true);
    expect(isEpisodeLevel([episode({ subfolders: 0 }), episode({ subfolders: undefined })])).toBe(false); // 컷 단계·옛 서버
    expect(isEpisodeLevel([])).toBe(false);
  });

  it("번호는 이름의 마지막 숫자 덩어리 — 두 자리로", () => {
    expect([episodeNumber("e003"), episodeNumber("e020"), episodeNumber("ep2_s035"), episodeNumber("e1000"), episodeNumber("intro")])
      .toEqual(["03", "20", "35", "1000", ""]);
  });

  it("컷 띠는 리스트 7칸·그리드 5칸, 못 실은 수는 '+N' — 미리보기가 없으면(옛 서버) 띠가 없다", () => {
    expect([stripOf(episode(), "list")!.cuts.length, stripOf(episode(), "list")!.more]).toEqual([7, 9]);
    expect([stripOf(episode(), "grid")!.cuts.map((one) => one.name), stripOf(episode(), "grid")!.more]).toEqual([NAMES.slice(0, 5), 11]);
    expect(stripOf(episode({ subfolders: 2, children: [cut("c0010", 1), cut("c0020", 1)] }), "list")!.more).toBe(0);
    expect(stripOf(episode({ children: undefined }), "list")).toBeNull();
  });

  it("대표 진행은 서버가 알려 주고 컷이 있을 때만", () => {
    expect(repProgress(episode())).toEqual({ done: 3, total: 16 });
    expect(repProgress(episode({ rep_count: 99 }))).toEqual({ done: 16, total: 16 }); // 컷 수를 넘지 않는다
    expect(repProgress(episode({ rep_count: undefined }))).toBeNull();
    expect(repProgress(episode({ subfolders: 0 }))).toBeNull();
  });

  it("마지막 공유는 서버의 UTC 시각을 '얼마 전'으로", () => {
    const ago = (utc: string | null) => sharedAgo(utc, NOW);
    expect(ago("2026-10-13 04:29:40")).toEqual({ unit: "now", n: 0 });
    expect(ago("2026-10-13 04:20:00")).toEqual({ unit: "min", n: 10 });
    expect(ago("2026-10-13 02:29:00")).toEqual({ unit: "hour", n: 2 });
    expect(ago("2026-10-12 03:00:00")).toEqual({ unit: "yesterday", n: 1 });
    expect(ago("2026-10-08T04:30:00Z")).toEqual({ unit: "day", n: 5 });
    expect(ago("2026-10-13 09:00:00")).toEqual({ unit: "now", n: 0 }); // 이 PC 의 시계가 늦어도 음수가 되지 않는다
    expect([ago(null), ago("언제")]).toEqual([null, null]);
  });
});

describe("에피소드 카드의 안쪽 그림", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  const draw = (layout: "list" | "grid", folder: FolderCard) => {
    const onEnter = vi.fn();
    const onEnterCut = vi.fn();
    act(() => root.render(<EpisodeCardBody folder={folder} layout={layout} thumbSize={512} fill now={NOW} onEnter={onEnter} onEnterCut={onEnterCut} />));
    return { onEnter, onEnterCut };
  };
  const text = (selector: string) => host.querySelector(selector)?.textContent ?? null;
  const texts = (selector: string) => [...host.querySelectorAll(selector)].map((one) => one.textContent);

  it("리스트 = 번호 · 표지 · 이름과 숫자 · 컷 띠(7칸 + '+N')", () => {
    draw("list", episode());
    expect([text(".ep-num"), text(".ep-name"), text(".ep-sub"), text(".ep-line"), text(".ep-rep")])
      .toEqual(["20", "e020", "마지막 공유 어제 · 리버", "컷 16 · 73건 · 영상 9", "대표 정한 컷 3 / 16"]);
    expect((host.querySelector(".ep-bar > i") as HTMLElement).style.width).toBe("19%");
    expect(host.querySelector(".ep-poster .play-badge")).not.toBeNull(); // 표지가 영상이면 재생 표시
    expect(texts(".ep-cut-name")).toEqual(NAMES);
    expect(texts(".ep-cut.rep .ep-cut-name")).toEqual(["c0010", "c0030", "c0050", "c0070"]); // 대표를 정한 컷은 테두리·★
    expect(text(".ep-cut.more")).toBe("+9");
    expect(text(".ep-enter")).toBe("열기 ▸");
  });

  it("그리드 = 큰 표지(번호·대표 표시·이름) + 컷 띠(5칸 + '+N') + 진행 막대", () => {
    draw("grid", episode());
    expect([text(".ep-cover .ep-num"), text(".ep-chip"), text(".ep-cap > b"), text(".ep-cap > span")])
      .toEqual(["20", "★ 대표 3/16", "e020", "컷 16 · 73건 · 영상 9"]);
    expect(texts(".ep-cut-name")).toEqual(NAMES.slice(0, 5));
    expect(text(".ep-cut.more")).toBe("+11");
    expect(texts(".ep-foot > span:not(.ep-bar)")).toEqual(["대표 3 / 16", "어제 · 리버"]);
    expect(host.querySelector(".ep-enter")).toBeNull(); // 그리드에는 [열기] 가 없다 — 두 번 클릭·'+N' 으로 들어간다
  });

  it("대표를 정한 컷이 없으면 그리드의 표시는 '대표 미정'", () => {
    draw("grid", episode({ rep_count: 0 }));
    expect([text(".ep-chip"), host.querySelector(".ep-chip")!.className]).toEqual(["대표 미정", "ep-chip none"]);
  });

  it("옛 서버(새 집계 없음) — 표지·이름·컷 수·건수만, 띠·진행·마지막 공유는 빠진다", () => {
    const old = episode({ video_count: undefined, rep_count: undefined, last_shared_at: undefined, last_shared_by: undefined, children: undefined });
    draw("list", old);
    expect([text(".ep-name"), text(".ep-line")]).toEqual(["e020", "컷 16 · 73건"]);
    expect([".ep-sub", ".ep-bar", ".ep-rep", ".ep-strip"].map((selector) => host.querySelector(selector))).toEqual([null, null, null, null]);
    expect(text(".ep-enter")).toBe("열기 ▸"); // 들어가는 길은 남는다
    draw("grid", old);
    expect([text(".ep-cap > span"), host.querySelector(".ep-chip"), host.querySelector(".ep-strip"), host.querySelector(".ep-foot")])
      .toEqual(["컷 16 · 73건", null, null, null]);
  });

  it("카드 안의 누름 — 컷 띠의 컷은 그 컷으로, '+N'·[열기] 는 그 에피소드로. 모두 격자가 알아볼 표식을 단다", () => {
    const { onEnter, onEnterCut } = draw("list", episode());
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.length).toBe(9); // 컷 7 + '+N' + [열기]
    expect(buttons.every((button) => button.hasAttribute("data-ep-action") && button.tabIndex === -1 && button.type === "button")).toBe(true);
    act(() => host.querySelectorAll<HTMLButtonElement>(".ep-cut")[2].click());
    expect(onEnterCut).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path: "e020/c0030", name: "c0030" }));
    expect(onEnter).not.toHaveBeenCalled();
    act(() => host.querySelector<HTMLButtonElement>(".ep-cut.more")!.click());
    act(() => host.querySelector<HTMLButtonElement>(".ep-enter")!.click());
    expect(onEnter).toHaveBeenCalledTimes(2);
  });
});
