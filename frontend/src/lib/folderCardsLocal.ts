// 폴더 카드를 **목록에서 직접** 묶는다(순수) — 서버의 folder-cards 와 같은 규칙으로, 화면이 이미 받은 생성물 목록(최신 순)을 부모 바로 아래
//  폴더마다 한 장으로 센다. 쓰는 곳(App):
//   · **걸러 보는 중**(종류·작성자·태그·색·검색…) — 서버는 걸러진 범위를 세지 못한다(색·태그는 이 PC 에만 있다). 걸러진 목록이 곧 근거다
//     (Jay 2026-10-13: 묶인 상태에서 태그·작성자·종류를 눌러도 묶음이 풀리지 않게).
//   · **옛 공유 서버**(새 집계 칸이 없다) — 서버 카드의 건수·표지·대표는 그대로 두고, 없는 칸(영상 수·검토 개수·마지막 공유·작업자·생성물 띠)만
//     목록에서 세어 채운다(`fillFolderCards`).
//  서버 카드(base)가 있으면 팀이 정한 대표(rep)를 거기서 읽는다 — 대표는 공유 서버가 권위라 목록만으로는 알 수 없다.
import type { FolderCard, FolderCardChild, FolderCardTake, FolderCards, Generation } from "../types";

const STRIP = 7; // 묶음 카드가 싣는 바로 아래 폴더(컷) 미리보기 수 — 서버의 _STRIP
const TAKES = 10; // 컷 카드가 싣는 생성물 미리보기 수 — 서버의 _TAKES
const WORKERS = 4; // 카드마다 싣는 작업자 수 — 서버의 _WORKERS

// 이름순 — 서버의 (casefold, 원문) 정렬과 같게(대소문자만 다른 이름도 순서가 정해진다)
function byName(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
}

const isVideo = (g: Generation) => !!g.assets?.some((asset) => asset.type === "video");
const thumbOnly = (g: Generation): Pick<Generation, "id" | "assets"> => ({ id: g.id, assets: (g.assets ?? []).slice(0, 1) });

/** 목록(최신 순)을 `parent` 바로 아래 폴더마다 카드 한 장으로 — 서버의 folder_cards 와 같은 모양. `base` = 같은 자리의 서버 카드(대표의 근거). */
export function groupGenerations(
  gens: readonly Generation[], projectId: string, parent: string, base: FolderCards | null,
): FolderCards {
  const prefix = parent ? parent + "/" : "";
  const baseBy = new Map((base?.folders ?? []).map((folder) => [folder.path, folder]));
  const entries = new Map<string, { rows: Generation[]; subs: Map<string, Generation[]> }>();
  let own = 0;
  for (const g of gens) {
    if (g.deleted || g.project_id !== projectId) continue;
    const folder = g.folder_path ?? "";
    if (folder !== parent && !folder.startsWith(prefix)) continue; // 글자 그대로 — 대소문자만 다른 폴더를 합치지 않는다(서버와 같은 기준)
    const rest = folder === parent ? "" : folder.slice(prefix.length);
    if (!rest) {
      own += 1; // 부모에 직접 든 것 — 어느 카드에도 들지 않는다
      continue;
    }
    const cut = rest.indexOf("/");
    const path = prefix + (cut < 0 ? rest : rest.slice(0, cut));
    let entry = entries.get(path);
    if (!entry) entries.set(path, (entry = { rows: [], subs: new Map() }));
    entry.rows.push(g);
    if (cut >= 0) {
      const name = rest.slice(cut + 1).split("/", 1)[0];
      const sub = entry.subs.get(name);
      if (sub) sub.push(g);
      else entry.subs.set(name, [g]);
    }
  }

  const folders: FolderCard[] = [...entries.keys()].sort(byName).map((path) => {
    const { rows, subs } = entries.get(path)!;
    const known = baseBy.get(path);
    // 팀이 정한 대표가 지금 보이는 것 안에 있으면 그것이 표지다. 아니면 가장 최근 것(대표 아님).
    const repRow = known?.rep ? rows.find((g) => g.id === known.cover.id) : undefined;
    const cover = repRow ?? rows[0];
    let last: Generation | null = null;
    const by = new Map<string, { name: string | null; count: number }>();
    let finals = 0;
    let held = 0;
    for (const g of rows) {
      if (g.shared_at && (!last || g.shared_at > (last.shared_at ?? ""))) last = g;
      if (g.is_final) finals += 1;
      else if (g.is_held) held += 1; // 최종이 먼저 — 둘 다 켜진 옛 행을 두 번 세지 않는다
      const who = g.creator_uid ?? `name:${g.creator_name ?? ""}`;
      const seen = by.get(who);
      if (seen) seen.count += 1;
      else by.set(who, { name: g.creator_name ?? null, count: 1 });
    }
    const knownChildren = new Map((known?.children ?? []).map((child) => [child.path, child]));
    const children: FolderCardChild[] = [...subs.keys()].sort(byName).slice(0, STRIP).map((name) => {
      const list = subs.get(name)!;
      const childPath = `${path}/${name}`;
      const knownChild = knownChildren.get(childPath);
      const childRep = knownChild?.rep ? list.find((g) => g.id === knownChild.cover.id) : undefined;
      return { path: childPath, name, count: list.length, rep: !!childRep, cover: thumbOnly(childRep ?? list[0]) };
    });
    // 하위 폴더 수는 서버 카드가 알면 그 값 그대로다(구조 — 걸러 보는 중에도 '들어가는' 폴더는 들어가는 폴더다. 이 값이 두 번 클릭의
    //  들어가기/모아보기와 줄의 모양(컷 띠/생성물 띠)을 가른다). 서버가 모르면(옛 서버·서버 카드에 없는 폴더) 목록에서 센다.
    const subfolders = known?.subfolders ?? subs.size;
    const takeRows = subfolders > 0 ? [] : [...(repRow ? [repRow] : []), ...rows.filter((g) => g !== repRow)].slice(0, TAKES);
    const takes: FolderCardTake[] = takeRows.map((g) => ({
      cover: thumbOnly(g), final: !!g.is_final, held: !g.is_final && !!g.is_held, by: g.creator_name ?? null,
    }));
    return {
      path, name: path.slice(prefix.length), count: rows.length, subfolders, rep: !!repRow, cover,
      video_count: rows.filter(isVideo).length,
      last_shared_at: last?.shared_at ?? null, last_shared_by: last?.creator_name ?? null,
      // 대표를 정한 컷 수는 서버만 안다(대표는 공유 서버가 권위) — 서버 카드의 값을 그대로 싣는다(걸러도 바뀌지 않는 구조 쪽 숫자)
      rep_count: known?.rep_count,
      children, final_count: finals, held_count: held,
      workers: [...by.values()].sort((a, b) => b.count - a.count || byName(a.name ?? "", b.name ?? "")).slice(0, WORKERS),
      takes,
    };
  });
  return { parent, own_count: own, folders };
}

/** 옛 공유 서버의 카드에 없는 칸만 목록에서 센 값으로 채운다 — 건수·표지·대표·하위 폴더 수는 서버 것 그대로. 목록에 없는 폴더는 그대로 둔다. */
export function fillFolderCards(base: FolderCards, local: FolderCards): FolderCards {
  const localBy = new Map(local.folders.map((folder) => [folder.path, folder]));
  return {
    ...base,
    folders: base.folders.map((folder) => {
      const counted = localBy.get(folder.path);
      if (!counted) return folder;
      return {
        ...folder,
        video_count: folder.video_count ?? counted.video_count,
        last_shared_at: folder.last_shared_at === undefined ? counted.last_shared_at : folder.last_shared_at,
        last_shared_by: folder.last_shared_by === undefined ? counted.last_shared_by : folder.last_shared_by,
        children: folder.children ?? counted.children,
        final_count: folder.final_count ?? counted.final_count,
        held_count: folder.held_count ?? counted.held_count,
        workers: folder.workers ?? counted.workers,
        // 생성물 띠는 하위 폴더가 없는 카드만(서버와 같다) — 옛 서버가 하위 폴더 수를 모르면(undefined) 목록에서 센 것을 따른다
        takes: folder.takes ?? ((folder.subfolders ?? counted.subfolders ?? 0) > 0 ? [] : counted.takes),
      };
    }),
  };
}

/** 서버 카드에 새 집계 칸이 없는가(옛 공유 서버) — 하나라도 없으면 목록에서 채울 것이 있다. */
export function lacksCounts(cards: FolderCards): boolean {
  return cards.folders.some((folder) => folder.final_count === undefined || folder.workers === undefined || folder.takes === undefined);
}
