// @vitest-environment jsdom
// 자리(탭·프로젝트·폴더)마다 마지막으로 본 모양 — 리스트/그리드와 '리스트 한 번 더'(Jay 2026-10-13 저녁: "각 폴더별로 내가 봤던 게 리스트인지
// 그리드인지도 기억하게 한다"). 순수 계산(lib/placeViews)과 훅의 배선(lib/useLibraryFilters).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PLACE_VIEWS_KEY, parsePlaceViews, placeViewKey, withPlaceView, type PlaceViews } from "../src/lib/placeViews";
import type { Store } from "../src/lib/storage";
import { useLibraryFilters } from "../src/lib/useLibraryFilters";
import { FILTERS_FORMAT_KEY, FILTERS_KEY } from "../src/lib/useLibraryPersistence";

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

let host: HTMLDivElement;
let root: Root;
let latest: ReturnType<typeof useLibraryFilters>;
let store: Store;
let data: Record<string, string>;
const seen: string[] = []; // 렌더마다의 [폴더, 모양] — 자리를 옮긴 첫 렌더가 옛 모양으로 그려지지 않는지 본다
function Probe() {
  latest = useLibraryFilters(store);
  seen.push(`${latest.filters.folder_path ?? "-"}:${latest.layout}${latest.groupByDate ? "+" : ""}`);
  return null;
}
const render = () => act(() => root.render(<Probe />));
const go = (folder: string | undefined) => act(() => latest.patch({ folder_path: folder }));
const view = () => `${latest.layout}${latest.groupByDate ? "+" : ""}`;
const mount = () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  render();
};
const unmount = () => {
  act(() => root.unmount());
  host.remove();
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  data = { [FILTERS_KEY]: JSON.stringify({ tab: "my", project_id: "p1", folder_path: "e035", [FILTERS_FORMAT_KEY]: "2" }) };
  store = fakeStore(data);
  seen.length = 0;
  mount();
});
afterEach(unmount);

describe("자리마다 본 모양(useLibraryFilters)", () => {
  it("폴더마다 따로 기억한다 — 처음 들어간 폴더는 방금 보던 모양을 물려받고, 본 폴더는 그때 본 모양 그대로", () => {
    expect(view()).toBe("grid");
    act(() => latest.setLayout("list")); // e035 = 리스트
    expect(view()).toBe("list");
    go("e040"); // 처음 들어간 폴더 — 방금 보던 리스트를 물려받는다
    expect(view()).toBe("list");
    act(() => latest.setLayout("grid")); // e040 만 그리드로
    go("e035");
    expect(view()).toBe("list"); // e035 는 본 그대로
    go("e040");
    expect(view()).toBe("grid");
    go("e050"); // 처음 — 방금 보던 것(e040 의 그리드)
    expect(view()).toBe("grid");
    go("e035");
    go("e060"); // 처음 — 방금 보던 것(e035 의 리스트). 마지막으로 **누른** 모양(그리드)이 아니다
    expect(view()).toBe("list");
    // 본 폴더는 그 뒤 다른 폴더에서 모양을 바꿔도 그대로다(e050 은 그리드로 본 폴더)
    act(() => latest.setLayout("grid")); // e060 을 그리드로
    go("e050");
    expect(view()).toBe("grid");
    go("e060");
    act(() => latest.setLayout("list"));
    go("e050");
    expect(view()).toBe("grid");
  });

  it("'리스트 한 번 더'(날짜별 구분·표)도 자리마다다", () => {
    act(() => latest.setLayout("list"));
    act(() => latest.setGroupByDate((on) => !on)); // e035 = 리스트 + 한 번 더
    expect(view()).toBe("list+");
    go("e040");
    act(() => latest.setGroupByDate(false)); // e040 은 끈다
    expect(view()).toBe("list");
    go("e035");
    expect(view()).toBe("list+");
  });

  it("자리를 옮긴 첫 렌더부터 그 자리의 모양이다 — 옛 자리의 모양으로 한 번 그려지지 않는다", () => {
    act(() => latest.setLayout("list"));
    go("e040");
    act(() => latest.setLayout("grid"));
    seen.length = 0;
    go("e035");
    expect(seen.filter((line) => line.startsWith("e035:"))).toEqual(expect.arrayContaining(["e035:list"]));
    expect(seen).not.toContain("e035:grid");
    seen.length = 0;
    go("e040");
    expect(seen).not.toContain("e040:list");
  });

  it("이 브라우저에 남는다 — 다시 켜도 폴더마다 그대로, 탭이 다르면 다른 자리다", () => {
    act(() => latest.setLayout("list"));
    go("e040");
    act(() => latest.setLayout("grid"));
    expect(parsePlaceViews(JSON.parse(data[PLACE_VIEWS_KEY]))).toMatchObject({
      '["my","p1","e035"]': { layout: "list", group: false }, '["my","p1","e040"]': { layout: "grid", group: false },
    });
    unmount();
    store = fakeStore(data); // 새로 켠 앱 — 저장된 것만 남아 있다
    mount();
    expect([latest.filters.folder_path, view()]).toEqual(["e040", "grid"]);
    go("e035");
    expect(view()).toBe("list");
    act(() => latest.patch({ tab: "team" })); // 같은 폴더의 공유 탭 — 처음 보는 자리(방금 보던 리스트를 물려받아 적힌다)
    act(() => latest.setLayout("grid"));
    act(() => latest.patch({ tab: "my" }));
    expect(view()).toBe("list");
  });
});
