// @vitest-environment jsdom
// 자리(탭·프로젝트·폴더)마다 마지막으로 본 모양 — 리스트/그리드와 '리스트 한 번 더'(Jay 2026-10-13 저녁: "각 폴더별로 내가 봤던 게 리스트인지
// 그리드인지도 기억하게 한다"). 순수 계산(lib/placeViews)과 훅(lib/usePlaceView). App 의 배선(폴더 창이 떠 있으면 그 창의 폴더가 보는 폴더)은
// tests/resolveSelectionRender.test.tsx 가 본다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PLACE_VIEWS_KEY, parsePlaceViews, placeViewKey, withPlaceView, type PlaceView, type PlaceViews } from "../src/lib/placeViews";
import type { Store } from "../src/lib/storage";
import { usePlaceView } from "../src/lib/usePlaceView";

describe("lib/placeViews — 순수", () => {
  it("자리의 열쇠는 탭·프로젝트·폴더다 — 휴지통·찾는 조건은 같은 자리의 다른 보기", () => {
    expect(placeViewKey({ tab: "team", project_id: "p1", folder_path: "e035" })).toBe('["team","p1","e035"]');
    expect(placeViewKey({ tab: "team", project_id: "p1" })).toBe('["team","p1",null]');
    expect(placeViewKey({ tab: "my", project_id: "p1", folder_path: "e035" })).not.toBe(placeViewKey({ tab: "team", project_id: "p1", folder_path: "e035" }));
  });

  it("적으면 맨 뒤(가장 새것)로 가고, 같은 값이면 같은 객체를 돌려준다. 상한을 넘으면 오래된 것부터 버린다", () => {
    let views: PlaceViews = {};
    views = withPlaceView(views, "a", { layout: "list", group: false });
    views = withPlaceView(views, "b", { layout: "grid", group: false });
    expect(withPlaceView(views, "a", { layout: "list", group: false })).toBe(views); // 같은 값 — 다시 그리지도 저장하지도 않는다
    const changed = withPlaceView(views, "a", { layout: "list", group: true });
    expect([Object.keys(changed), changed.a]).toEqual([["b", "a"], { layout: "list", group: true }]);
    const capped = withPlaceView(changed, "c", { layout: "grid", group: false }, 2);
    expect(Object.keys(capped)).toEqual(["a", "c"]); // b 가 가장 오래됐다
  });

  it("저장된 것을 읽을 때 모양이 깨진 줄은 버린다", () => {
    expect(parsePlaceViews({ a: { layout: "list", group: true }, b: { layout: "wide" }, c: null, d: { layout: "grid" } }))
      .toEqual({ a: { layout: "list", group: true }, d: { layout: "grid", group: false } });
    for (const broken of [null, "x", 3, [1, 2]]) expect(parsePlaceViews(broken)).toEqual({});
  });

  it("선택한 context만 키 앞에 붙이고 기존 키는 유지한다", () => {
    const filters = { tab: "team" as const, project_id: "p", folder_path: "a" };
    expect(placeViewKey(filters)).toBe('["team","p","a"]');
    expect(placeViewKey(filters, "owner/server/workspace")).toBe('["owner/server/workspace","team","p","a"]');
    expect(placeViewKey(filters, "another")).not.toBe(placeViewKey(filters, "owner/server/workspace"));
  });

  it("새 설정을 검증하고 일부 설정만 바꿔도 기존 설정과 400개 상한을 보존한다", () => {
    expect(parsePlaceViews({ a: { layout: "grid", group: false, scale: 4, fill: false, folders: false },
      b: { layout: "list", scale: -3, fill: "true", folders: 1 }, c: { layout: "grid", scale: NaN } }))
      .toEqual({ a: { layout: "grid", group: false, scale: 1.7, fill: false, folders: false },
        b: { layout: "list", group: false, scale: 0.7 }, c: { layout: "grid", group: false } });
    const initial = { a: { layout: "grid" as const, group: false, scale: 1.4, fill: false, folders: false } };
    const changed = withPlaceView(initial, "a", { layout: "list", group: true });
    expect(changed.a).toEqual({ ...initial.a, layout: "list", group: true });
    expect(withPlaceView(changed, "a", changed.a)).toBe(changed);
    let many: PlaceViews = {};
    for (let n = 0; n <= 400; n++) many = withPlaceView(many, String(n), { layout: "grid", group: false });
    expect(Object.keys(many)).toHaveLength(400);
    expect(many["0"]).toBeUndefined();
  });
});

function fakeStore(data: Record<string, string>): Store {
  return {
    get: (key, fallback) => data[key] ?? fallback,
    set: (key, value) => void (data[key] = value),
    loadJSON: <T,>(key: string) => (key in data ? (JSON.parse(data[key]) as T) : null),
    setJSON: (key, value) => void (data[key] = JSON.stringify(value)),
    loadSet: (key) => new Set(key in data ? (JSON.parse(data[key]) as string[]) : []),
    setSet: (key, value) => void (data[key] = JSON.stringify([...value])),
  };
}

// 창 하나 = 훅 하나. 같은 저장소(data)를 두 창이 같이 쓸 수 있다.
interface Win {
  host: HTMLDivElement; root: Root; place: string; defaults?: Partial<PlaceView>; latest: ReturnType<typeof usePlaceView>; seen: string[]; draw: () => void;
}
let data: Record<string, string>;
const wins: Win[] = [];
function open(place: string, defaults?: Partial<PlaceView>): Win {
  const store = fakeStore(data);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const win = { host, root: createRoot(host), place, defaults, seen: [] as string[] } as Win;
  function Probe() {
    win.latest = usePlaceView(store, win.place, win.defaults);
    win.seen.push(`${win.place}:${win.latest.layout}${win.latest.groupByDate ? "+" : ""}`); // 렌더마다 — 자리를 옮긴 첫 렌더를 본다
    return null;
  }
  win.draw = () => act(() => win.root.render(<Probe />));
  win.draw();
  wins.push(win);
  return win;
}
const go = (win: Win, place: string) => { win.place = place; win.draw(); };
const view = (win: Win) => `${win.latest.layout}${win.latest.groupByDate ? "+" : ""}`;
const close = (win: Win) => { act(() => win.root.unmount()); win.host.remove(); wins.splice(wins.indexOf(win), 1); };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  data = {};
});
afterEach(() => { for (const win of [...wins]) close(win); });

describe("자리마다 본 모양(usePlaceView)", () => {
  it("크기·맞춤·폴더 표시도 A→B→A와 새 창에서 복원하며 처음 본 자리는 직전 설정을 물려받는다", () => {
    const a = open("a", { scale: 1.2, fill: false, folders: false });
    act(() => { a.latest.setScale((n) => n + 0.2); a.latest.setLayout("list"); });
    go(a, "b");
    expect([a.latest.scale, a.latest.fill, a.latest.folders]).toEqual([1.4, false, false]);
    act(() => { a.latest.setScale(0.8); a.latest.setFill(true); a.latest.setFolders(true); a.latest.setLayout("grid"); });
    go(a, "a");
    expect([view(a), a.latest.scale, a.latest.fill, a.latest.folders]).toEqual(["list", 1.4, false, false]);
    close(a);
    const restored = open("b");
    expect([view(restored), restored.latest.scale, restored.latest.fill, restored.latest.folders]).toEqual(["grid", 0.8, true, true]);
    go(restored, "a");
    expect([view(restored), restored.latest.scale, restored.latest.fill, restored.latest.folders]).toEqual(["list", 1.4, false, false]);
  });

  it("새 설정을 쓰지 않는 기존 호출은 저장 모양 그대로이며 옛 행은 defaults를 물려받는다", () => {
    const old = open("old");
    expect([old.latest.scale, old.latest.fill, old.latest.folders]).toEqual([1, true, true]);
    expect(JSON.parse(data[PLACE_VIEWS_KEY]).old).toEqual({ layout: "grid", group: false });
    close(old);
    const migrated = open("old", { layout: "list", group: true, scale: 1.3, fill: false, folders: false });
    expect(view(migrated)).toBe("grid"); // 폴더의 기존 layout/group 우선
    expect([migrated.latest.scale, migrated.latest.fill, migrated.latest.folders]).toEqual([1.3, false, false]);
    expect(JSON.parse(data[PLACE_VIEWS_KEY]).old).toEqual({ layout: "grid", group: false, scale: 1.3, fill: false, folders: false });
  });

  it("손상된 크기는 무시하고 setter도 finite 범위만 저장한다", () => {
    const a = open("a", { scale: Infinity, fill: true });
    expect(a.latest.scale).toBe(1);
    act(() => a.latest.setScale(-5));
    expect(a.latest.scale).toBe(0.7);
    act(() => a.latest.setScale(5));
    expect(a.latest.scale).toBe(1.7);
    act(() => a.latest.setScale(NaN));
    expect(a.latest.scale).toBe(1.7);
  });

  it("같은 폴더에서 다른 창이 바꾼 추가 설정도 한 필드 저장이 지우지 않는다", () => {
    const a = open("a", { scale: 1.2 });
    const b = open("a");
    act(() => a.latest.setFill(false));
    act(() => b.latest.setFolders(false));
    act(() => b.latest.setLayout("list"));
    expect(JSON.parse(data[PLACE_VIEWS_KEY]).a).toEqual({ layout: "list", group: false, scale: 1.2, fill: false, folders: false });
    go(a, "b"); go(a, "a");
    expect([view(a), a.latest.fill, a.latest.folders]).toEqual(["list", false, false]);
  });

  it("한 이벤트에서 레이아웃과 그룹을 연달아 바꿔도 첫 변경을 덮지 않는다", () => {
    const a = open("a", { scale: 1.1, fill: false });
    act(() => { a.latest.setLayout("list"); a.latest.setGroupByDate(true); });
    expect(view(a)).toBe("list+");
    expect(JSON.parse(data[PLACE_VIEWS_KEY]).a).toEqual({ layout: "list", group: true, scale: 1.1, fill: false });
  });

  it("명시한 폴더 묶음은 그 자리에만 저장하고 새 자리의 암묵 기본값과 구분한다", () => {
    const a = open("a");
    act(() => { a.latest.setFolders(true); a.latest.setScale(1.3); });
    go(a, "b");
    expect([a.latest.folders, a.latest.scale]).toEqual([true, 1.3]);
    expect(JSON.parse(data[PLACE_VIEWS_KEY]).a.folders).toBe(true);
    expect(JSON.parse(data[PLACE_VIEWS_KEY]).b.folders).toBeUndefined();
    act(() => a.latest.setFolders(false));
    go(a, "a");
    expect(a.latest.folders).toBe(true);
    go(a, "b");
    expect(a.latest.folders).toBe(false);
  });

  it("전역에서 읽은 초기 folders 기본값은 이후 다른 폴더의 전역값 변경으로 바뀌지 않는다", () => {
    const a = open("a", { folders: false });
    a.defaults = { folders: true };
    go(a, "b");
    expect(a.latest.folders).toBe(false);
    expect(JSON.parse(data[PLACE_VIEWS_KEY]).b.folders).toBe(false);
  });

  it("전체 보기에서 처음 방문하는 부모는 false를 이어받고 초기 true 기본값이 이를 덮지 않는다", () => {
    const a = open("parent/child", { folders: true });
    act(() => a.latest.setFolders(false));
    go(a, "parent");
    expect(a.latest.folders).toBe(false);
    expect(JSON.parse(data[PLACE_VIEWS_KEY]).parent.folders).toBe(false);
    act(() => a.latest.setFolders(true));
    go(a, "parent/child");
    expect(a.latest.folders).toBe(false); // 이미 기억한 자리의 값이 초기값·직전 보기보다 우선
  });

  it("다른 context·새 탭 대상도 독립된 설정을 첫 렌더부터 읽는다", () => {
    const f = { tab: "team" as const, project_id: "p", folder_path: "a" };
    const ka = placeViewKey(f, "owner-a"); const kb = placeViewKey(f, "owner-b");
    const a = open(ka); act(() => { a.latest.setScale(1.6); a.latest.setFolders(false); });
    const b = open(kb, { scale: 0.9 });
    expect([b.latest.scale, b.latest.folders]).toEqual([0.9, true]);
    const tab = open(ka);
    expect([tab.latest.scale, tab.latest.folders]).toEqual([1.6, false]);
  });

  it("저장 실패 중 바꾼 추가 설정은 다른 폴더 방문과 나중 저장에도 보존한다", () => {
    const a = open("a");
    const saved = data[PLACE_VIEWS_KEY]; let full = true; let value = saved;
    Object.defineProperty(data, PLACE_VIEWS_KEY, { configurable: true, enumerable: true, get: () => value,
      set: (next: string) => { if (!full) value = next; } });
    act(() => { a.latest.setScale(1.5); a.latest.setFill(false); a.latest.setFolders(false); });
    go(a, "b"); go(a, "a");
    expect([a.latest.scale, a.latest.fill, a.latest.folders]).toEqual([1.5, false, false]);
    expect(data[PLACE_VIEWS_KEY]).toBe(saved);
    full = false;
    act(() => a.latest.setLayout("list"));
    expect(JSON.parse(data[PLACE_VIEWS_KEY]).a).toEqual({ layout: "list", group: false, scale: 1.5, fill: false, folders: false });
  });
  it("폴더마다 따로 기억한다 — 처음 들어간 폴더는 방금 보던 모양을 물려받고, 본 폴더는 그때 본 모양 그대로", () => {
    const win = open("e035");
    expect(view(win)).toBe("grid");
    act(() => win.latest.setLayout("list")); // e035 = 리스트
    expect(view(win)).toBe("list");
    go(win, "e040"); // 처음 들어간 폴더 — 방금 보던 리스트를 물려받는다
    expect(view(win)).toBe("list");
    act(() => win.latest.setLayout("grid")); // e040 만 그리드로
    go(win, "e035");
    expect(view(win)).toBe("list"); // e035 는 본 그대로
    go(win, "e040");
    expect(view(win)).toBe("grid");
    go(win, "e050"); // 처음 — 방금 보던 것(e040 의 그리드)
    expect(view(win)).toBe("grid");
    go(win, "e035");
    go(win, "e060"); // 처음 — 방금 보던 것(e035 의 리스트). 마지막으로 **누른** 모양(그리드)이 아니다
    expect(view(win)).toBe("list");
    // 본 폴더는 그 뒤 다른 폴더에서 모양을 바꿔도 그대로다(e050 은 그리드로 본 폴더)
    go(win, "e050");
    expect(view(win)).toBe("grid");
    go(win, "e060");
    act(() => win.latest.setLayout("grid"));
    act(() => win.latest.setLayout("list"));
    go(win, "e050");
    expect(view(win)).toBe("grid");
  });

  it("'리스트 한 번 더'(날짜별 구분·표)도 자리마다다", () => {
    const win = open("e035");
    act(() => win.latest.setLayout("list"));
    act(() => win.latest.setGroupByDate((on) => !on)); // e035 = 리스트 + 한 번 더
    expect(view(win)).toBe("list+");
    go(win, "e040");
    act(() => win.latest.setGroupByDate(false)); // e040 은 끈다
    expect(view(win)).toBe("list");
    go(win, "e035");
    expect(view(win)).toBe("list+");
  });

  it("자리를 옮긴 첫 렌더부터 그 자리의 모양이다 — 옛 자리의 모양으로 한 번 그려지지 않는다", () => {
    const win = open("e035");
    act(() => win.latest.setLayout("list"));
    go(win, "e040");
    act(() => win.latest.setLayout("grid"));
    win.seen.length = 0;
    go(win, "e035");
    expect(win.seen).toContain("e035:list");
    expect(win.seen).not.toContain("e035:grid");
    win.seen.length = 0;
    go(win, "e040");
    expect(win.seen).not.toContain("e040:list");
  });

  it("이 브라우저에 남는다 — 다시 켜도 폴더마다 그대로, 방금 보던 모양은 전과 같은 저장 키에", () => {
    const win = open("e035");
    act(() => win.latest.setLayout("list"));
    go(win, "e040");
    act(() => win.latest.setLayout("grid"));
    act(() => win.latest.setGroupByDate(true));
    expect(parsePlaceViews(JSON.parse(data[PLACE_VIEWS_KEY]))).toEqual({ e035: { layout: "list", group: false }, e040: { layout: "grid", group: true } });
    expect([data.layout, data.groupByDate]).toEqual(["grid", "1"]); // 처음 들어가는 자리가 물려받을 '방금 보던 모양'
    close(win);
    const again = open("e040"); // 새로 켠 앱 — 저장된 것만 남아 있다
    expect(view(again)).toBe("grid+");
    go(again, "e035");
    expect(view(again)).toBe("list");
  });

  // Codex 코드 리뷰: 창마다 자기 사본을 통째로 저장해, 다른 창이 그사이 적은 **다른 폴더**의 기억을 지웠다.
  it("두 창이 같은 저장소를 쓴다 — 한 창이 적어도 다른 창이 적은 다른 폴더의 기억을 덮지 않는다", () => {
    const a = open("e035");
    const b = open("e040"); // 둘 다 켜진 뒤(둘 다 e035·e040 을 그리드로 알고 있다)
    act(() => a.latest.setLayout("list")); // 창 A: e035 = 리스트
    act(() => b.latest.setGroupByDate(true)); // 창 B: e040 = 한 번 더 — B 의 사본에는 A 의 변경이 없다
    expect(parsePlaceViews(JSON.parse(data[PLACE_VIEWS_KEY]))).toEqual({ e035: { layout: "list", group: false }, e040: { layout: "grid", group: true } });
    go(b, "e035"); // B 도 그 폴더에 가면 A 가 적은 모양을 본다(적을 때 최신 저장을 읽어 왔다)
    expect(view(b)).toBe("list");
  });

  // Codex 코드 리뷰: B 가 아무것도 바꾸지 않은 채 처음 가면 낡은 사본에 그 자리가 없어 '처음 본 자리'로 여기고 A 의 모양을 덮었다.
  it("다른 창이 먼저 적어 둔 폴더를 아무것도 바꾸지 않고 처음 가도 그 모양이다 — 처음 본 자리인지는 저장된 것으로 본다(덮지 않는다)", () => {
    const a = open("e035");
    const b = open("e040"); // 둘 다 켜진 뒤 — B 의 사본에는 e050 이 없다
    go(a, "e050");
    act(() => a.latest.setLayout("list")); // 창 A: e050 = 리스트
    go(b, "e050");
    expect(view(b)).toBe("list");
    expect(parsePlaceViews(JSON.parse(data[PLACE_VIEWS_KEY])).e050).toEqual({ layout: "list", group: false });
    go(b, "e070"); // 그다음 처음 가는 폴더는 방금 본 것(리스트)을 물려받는다
    expect(view(b)).toBe("list");
  });

  // Codex 재검토 P3: 저장이 실패하면(용량) 바꾼 모양은 이 창의 기억에만 있다. 폴더를 옮기며 저장된 것을 다시 읽을 때 그 옛 값이
  //  방금 바꾼 모양을 덮었다 — 다른 폴더에 다녀오면 모양이 되돌아갔다.
  it("저장에 실패한 자리의 모양은 폴더를 옮겼다 돌아와도 이 창에 남는다 — 저장이 되면 그때 적힌다", () => {
    const win = open("e035");
    go(win, "e040"); // 둘 다 그리드로 적혀 있다
    go(win, "e035");
    const saved = data[PLACE_VIEWS_KEY];
    const full = { on: true };
    const real = Object.getOwnPropertyDescriptor(data, PLACE_VIEWS_KEY)!;
    Object.defineProperty(data, PLACE_VIEWS_KEY, { configurable: true, enumerable: true, get: () => real.value as string,
      set: (value: string) => { if (!full.on) real.value = value; } }); // 저장소가 꽉 찼다 — 쓰기가 말없이 버려진다
    act(() => win.latest.setLayout("list"));
    expect([view(win), data[PLACE_VIEWS_KEY] === saved]).toEqual(["list", true]);
    go(win, "e040");
    go(win, "e035");
    expect(view(win)).toBe("list"); // 저장소의 옛 그리드로 돌아가지 않는다
    full.on = false; // 용량이 풀렸다 — 다음에 바꿀 때 적힌다
    act(() => win.latest.setGroupByDate(true));
    expect(parsePlaceViews(JSON.parse(data[PLACE_VIEWS_KEY])).e035).toEqual({ layout: "list", group: true });
  });
});
