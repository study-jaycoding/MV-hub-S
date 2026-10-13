// @vitest-environment jsdom
// 자리(탭·프로젝트·폴더)마다 마지막으로 본 모양 — 리스트/그리드와 '리스트 한 번 더'(Jay 2026-10-13 저녁: "각 폴더별로 내가 봤던 게 리스트인지
// 그리드인지도 기억하게 한다"). 순수 계산(lib/placeViews)과 훅(lib/usePlaceView). App 의 배선(폴더 창이 떠 있으면 그 창의 폴더가 보는 폴더)은
// tests/resolveSelectionRender.test.tsx 가 본다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PLACE_VIEWS_KEY, parsePlaceViews, placeViewKey, withPlaceView, type PlaceViews } from "../src/lib/placeViews";
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
  host: HTMLDivElement; root: Root; place: string; latest: ReturnType<typeof usePlaceView>; seen: string[]; draw: () => void;
}
let data: Record<string, string>;
const wins: Win[] = [];
function open(place: string): Win {
  const store = fakeStore(data);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const win = { host, root: createRoot(host), place, seen: [] as string[] } as Win;
  function Probe() {
    win.latest = usePlaceView(store, win.place);
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
});
