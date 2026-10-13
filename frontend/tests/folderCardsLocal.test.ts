// 폴더 카드를 목록에서 직접 묶기(lib/folderCardsLocal) — 걸러 보는 중과 옛 공유 서버에서 화면이 스스로 세는 규칙.
//  서버의 folder_cards 와 같은 답을 내야 한다(backend/tests/test_folder_cards.py 가 고정하는 것과 같은 규칙).
import { describe, expect, it } from "vitest";
import { fillFolderCards, groupGenerations, lacksCounts } from "../src/lib/folderCardsLocal";
import type { FolderCards, Generation } from "../src/types";

let clock = 100;
const gen = (id: string, folder: string, extra: Partial<Generation> = {}): Generation => ({
  id, project_id: "p1", folder_path: folder, sort_ts: clock--, creator_uid: "river", creator_name: "리버",
  assets: [{ id: "a-" + id, type: "video", file_path: `/m/${id}.mp4`, thumbnail_path: `/m/${id}.png` }],
  ...extra,
} as unknown as Generation);

describe("목록을 부모 바로 아래 폴더마다 카드 한 장으로", () => {
  // 목록은 최신 순이다 — 앞에 온 것이 더 최근
  const rows = [
    gen("n1", "e035/C0010", { is_final: true, shared_at: "2026-10-13 09:00:00" }),
    gen("n2", "e035/C0010", { creator_uid: "ozzy", creator_name: null, is_held: true }),
    gen("n3", "e035/C0020/takeB", { shared_at: "2026-10-12 00:00:00", assets: [{ id: "x", type: "image", file_path: "/m/n3.png", thumbnail_path: null }] } as Partial<Generation>),
    gen("n4", "e035/C0010", { is_final: true, is_held: true }), // 둘 다 켜진 옛 행 → 최종으로 한 번만
    gen("n5", "e035"), // 부모에 직접 든 것
    gen("n6", "E035/C0010"), // 글자만 같은 다른 폴더(서버 LIKE 가 섞어 준다)
    gen("n7", "e036/C0010"), // 다른 폴더
    gen("n8", "e035/C0010", { project_id: "other" }), // 다른 프로젝트
    gen("n9", "e035/C0010", { deleted: true }),
  ];

  it("건수·표지·검토 개수·영상 수·마지막 공유·작업자·생성물 띠 — 서버와 같은 규칙", () => {
    const cards = groupGenerations(rows, "p1", "e035", null);
    expect([cards.parent, cards.own_count, cards.folders.map((folder) => folder.path)]).toEqual(["e035", 1, ["e035/C0010", "e035/C0020"]]);
    const cut = cards.folders[0];
    expect([cut.name, cut.count, cut.subfolders, cut.rep, cut.cover.id]).toEqual(["C0010", 3, 0, false, "n1"]); // 대표를 모르면 가장 최근 것
    expect([cut.final_count, cut.held_count, cut.video_count]).toEqual([2, 1, 3]);
    expect([cut.last_shared_at, cut.last_shared_by]).toEqual(["2026-10-13 09:00:00", "리버"]);
    expect(cut.workers).toEqual([{ name: "리버", count: 2 }, { name: null, count: 1 }]); // 많은 순, 이름을 모르면 null
    expect(cut.takes!.map((take) => [take.cover.id, take.final, take.held, take.by])).toEqual([
      ["n1", true, false, "리버"], ["n2", false, true, null], ["n4", true, false, "리버"],
    ]);
    expect(Object.keys(cut.takes![0].cover).sort()).toEqual(["assets", "id"]); // 미리보기는 그림만
    // 하위 폴더가 있는 카드 — 컷 띠를 싣고 생성물 띠는 없다
    const nested = cards.folders[1];
    expect([nested.count, nested.subfolders, nested.video_count, nested.takes, nested.children!.map((child) => [child.path, child.count, child.cover.id])])
      .toEqual([1, 1, 0, [], [["e035/C0020/takeB", 1, "n3"]]]);
  });

  it("프로젝트 맨 위 — 폴더 없이 든 것은 own_count, 맨 위 폴더마다 카드", () => {
    const cards = groupGenerations([...rows, gen("root", null as unknown as string)], "p1", "", null);
    expect([cards.own_count, cards.folders.map((folder) => [folder.path, folder.count, folder.subfolders])])
      .toEqual([1, [["E035", 1, 1], ["e035", 5, 2], ["e036", 1, 1]]]);
  });

  it("팀이 정한 대표는 서버 카드에서 읽는다 — 지금 보이는 것 안에 있을 때만 표지·띠의 맨 앞", () => {
    const base = (coverId: string, rep: boolean): FolderCards => ({
      parent: "e035", own_count: 0, folders: [{ path: "e035/C0010", name: "C0010", count: 9, rep, cover: gen(coverId, "e035/C0010") }],
    });
    const picked = groupGenerations(rows, "p1", "e035", base("n4", true)).folders[0];
    expect([picked.rep, picked.cover.id, picked.takes!.map((take) => take.cover.id)]).toEqual([true, "n4", ["n4", "n1", "n2"]]);
    // 대표가 걸러져 안 보이면(목록에 없다) 가장 최근 것 — 대표 아님
    const hidden = groupGenerations(rows, "p1", "e035", base("gone", true)).folders[0];
    expect([hidden.rep, hidden.cover.id]).toEqual([false, "n1"]);
    // 서버 카드의 표지가 '가장 최근 것'일 뿐이면(rep 아님) 대표로 치지 않는다
    expect(groupGenerations(rows, "p1", "e035", base("n4", false)).folders[0].rep).toBe(false);
  });

  it("하위 폴더 수는 서버 카드가 알면 그 값 — 걸러 보는 중에도 '들어가는' 폴더는 들어가는 폴더다(생성물 띠 없음). 모르면 목록에서 센다", () => {
    const structure: FolderCards = {
      parent: "e035", own_count: 0,
      folders: [{ path: "e035/C0010", name: "C0010", count: 40, subfolders: 5, rep_count: 2, rep: false, cover: gen("x", "e035/C0010") }],
    };
    // 걸러진 것은 C0010 에 직접 든 셋뿐이지만 서버는 그 아래 폴더가 다섯이라고 안다. 대표를 정한 컷 수도 서버 값 그대로(서버만 안다)
    const known = groupGenerations(rows, "p1", "e035", structure).folders;
    expect([known[0].subfolders, known[0].count, known[0].takes, known[0].rep_count]).toEqual([5, 3, [], 2]);
    expect(known[1].subfolders).toBe(1); // 서버 카드에 없는 폴더는 목록에서 센다
  });

  it("컷 띠는 이름순 앞 일곱, 생성물 띠는 열 개까지", () => {
    const many = [
      ...Array.from({ length: 9 }, (_, index) => gen("s" + index, `e040/c00${9 - index}0/x`)),
      ...Array.from({ length: 12 }, (_, index) => gen("t" + index, "e041")),
    ];
    const [episode, leaf] = groupGenerations(many, "p1", "", null).folders;
    expect([episode.subfolders, episode.children!.map((child) => child.name)]).toEqual([9, ["c0010", "c0020", "c0030", "c0040", "c0050", "c0060", "c0070"]]);
    expect([leaf.count, leaf.takes!.length, leaf.takes![0].cover.id]).toEqual([12, 10, "t0"]);
  });
});

describe("옛 공유 서버의 카드에 없는 칸 채우기", () => {
  const old: FolderCards = {
    parent: "e035", own_count: 2,
    folders: [
      { path: "e035/C0010", name: "C0010", count: 8, rep: true, cover: gen("server-cover", "e035/C0010") },
      { path: "e035/C0030", name: "C0030", count: 1, rep: false, cover: gen("only-on-server", "e035/C0030") },
    ],
  };
  const local = groupGenerations([gen("a", "e035/C0010", { is_final: true }), gen("b", "e035/C0010")], "p1", "e035", old);

  it("새 집계 칸이 하나라도 없으면 채울 것이 있다", () => {
    expect([lacksCounts(old), lacksCounts(local), lacksCounts({ parent: "", own_count: 0, folders: [] })]).toEqual([true, false, false]);
  });

  it("건수·표지·대표·자리는 서버 것 그대로, 없는 칸만 목록에서 센 값 — 목록에 없는 폴더는 그대로", () => {
    const filled = fillFolderCards(old, local);
    expect([filled.parent, filled.own_count, filled.folders.map((folder) => folder.path)]).toEqual(["e035", 2, ["e035/C0010", "e035/C0030"]]);
    const cut = filled.folders[0];
    expect([cut.count, cut.rep, cut.cover.id]).toEqual([8, true, "server-cover"]);
    expect([cut.final_count, cut.held_count, cut.video_count, cut.workers, cut.takes!.map((take) => take.cover.id)])
      .toEqual([1, 0, 2, [{ name: "리버", count: 2 }], ["a", "b"]]);
    expect(filled.folders[1]).toBe(old.folders[1]);
    // 서버가 이미 준 칸은 덮지 않는다
    const partly = fillFolderCards({ ...old, folders: [{ ...old.folders[0], final_count: 5, takes: [] }] }, local).folders[0];
    expect([partly.final_count, partly.takes, partly.held_count]).toEqual([5, [], 0]);
  });
});
